import { chromium, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import { phantomExtensionPath, phantomVersion, browserArgsFor } from '../utils/wallet-cache'

/**
 * Phantom reconnaissance — close the unknowns BEFORE writing any automation.
 *
 * WHY THIS EXISTS
 * The Rabby column cost roughly 6x the MetaMask column, and almost all of that
 * was unknowns discovered late: no test hooks, every testnet a "custom network",
 * a security alert silently disabling the primary button. The prep probe written
 * ahead of Rabby (see tests/matrix/STATUS.md, 2026-07-26) closed three unknowns
 * without touching the harness and was the cheapest hour in the project.
 *
 * This is that, for Phantom. It does not write a spec and does not guess a
 * selector.
 *
 * THE ONE QUESTION THAT DECIDES WHETHER THIS COLUMN EXISTS
 * Phantom's own help centre states it does NOT support adding custom networks:
 * the supported list is fixed (Solana, Ethereum, Polygon, Base, Bitcoin, Sui,
 * Monad, HyperEVM, Robinhood Chain) and there is no manual-add path. If that is
 * accurate for the extension's EVM provider, then `wallet_addEthereumChain` —
 * which is how EVERY other column reaches Base Sepolia (84532) — has no
 * counterpart here, and Aave x Phantom cannot be measured on Base Sepolia at all.
 *
 * That is NOT a failing cell. Recording `fail` would blame Phantom for a choice
 * the harness made when it pinned the matrix to one chain. Per chain-policy.ts:
 * any harness policy that can change a verdict must be identical across every
 * column — and the CHAIN PIN is exactly such a policy. The honest outcome is
 * either an `unsupported` cell with the reason, or moving the column to a chain
 * Phantom actually ships. Phantom does have a Testnet Mode (Settings →
 * Developer Settings) exposing Ethereum Sepolia; whether it also exposes Base
 * Sepolia is UNKNOWN and is what phase 4 is for.
 *
 * Do not write "Phantom cannot do X" into the matrix on the strength of a help
 * article. Help articles go stale. Phases 3 and 4 measure it on the shipped
 * extension. (See the `fill()` retraction in STATUS.md for why this rule exists.)
 *
 *   pnpm run fetch:phantom && pnpm run probe:phantom
 *   PROBE_HOLD=1 pnpm run probe:phantom   # keep the browser open 90s at the end
 */

const OUT = path.join(process.cwd(), 'matrix-out', 'phantom-probe')
const ORIGIN = process.env.DAPP_URL ?? 'https://app.aave.com/?marketName=proto_base_sepolia_v3'
const BASE_SEPOLIA_HEX = '0x14a34' // 84532

/**
 * Inventory as a STRING, not a function.
 *
 * `page.evaluate(fn)` serialises the function, and tsx/esbuild rewrites named
 * arrows to add its `__name` helper, which does not exist in the page —
 * `ReferenceError: __name is not defined`. A string passes through untouched.
 * This bit the Rabby probe on its first run and the connect-event probe twice.
 */
const INVENTORY_JS = `(() => {
  var vis = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  var txt = function (el) { return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) }
  var hook = function (el) { return el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null }

  var buttons = Array.prototype.slice.call(
    document.querySelectorAll('button, [role="button"], a[href]')
  ).filter(vis).map(function (el) {
    return { text: txt(el), testId: hook(el),
             cls: (el.getAttribute('class') || '').slice(0, 70) }
  }).filter(function (b) { return b.text || b.testId })

  var inputs = Array.prototype.slice.call(
    document.querySelectorAll('input, textarea')
  ).filter(vis).map(function (el) {
    return { type: el.getAttribute('type') || el.tagName.toLowerCase(),
             placeholder: el.getAttribute('placeholder'), id: el.getAttribute('id'), testId: hook(el) }
  })

  return {
    url: location.href,
    title: document.title,
    bodyChars: (document.body ? document.body.innerText || '' : '').trim().length,
    headings: Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).filter(vis).map(txt).slice(0, 12),
    buttons: buttons.slice(0, 40),
    inputs: inputs,
    totalTestIds: document.querySelectorAll('[data-testid],[data-test-id]').length
  }
})()`

/**
 * EIP-6963 announcement + per-provider fingerprint.
 *
 * Reads the ANNOUNCED providers, never window.ethereum — on 2026-07-26 the
 * legacy slot on this machine reported isMetaMask AND isRabby simultaneously,
 * and five days earlier isMetaMask AND isOneKey. The slot reports install order,
 * not intent. window.phantom is captured separately as an observation, because
 * Phantom documents it as its own namespace and it is worth knowing whether the
 * EVM provider hangs off it.
 */
const ANNOUNCE_JS = `(() => new Promise(function (resolve) {
  var found = []
  function onAnnounce (e) {
    var d = e.detail || {}
    var info = d.info || {}
    found.push({
      rdns: info.rdns, name: info.name,
      hasRequest: !!(d.provider && typeof d.provider.request === 'function'),
      flags: d.provider ? Object.keys(d.provider).filter(function (k) { return /^is[A-Z]/.test(k) }) : []
    })
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  setTimeout(function () {
    window.removeEventListener('eip6963:announceProvider', onAnnounce)
    var eth = window.ethereum
    resolve({
      announced: found,
      legacy: eth ? { flags: Object.keys(eth).filter(function (k) { return /^is[A-Z]/.test(k) }),
                      hasProviders: Array.isArray(eth.providers) } : null,
      phantomNamespace: window.phantom ? Object.keys(window.phantom) : null
    })
  }, 2500)
}))()`

/**
 * Every evaluate gets a ceiling.
 *
 * `page.evaluate` puts NO timeout on a returned promise. A provider call that
 * only settles when a dialog is answered will hang until the whole job is
 * killed — that is CI run #11, cancelled at 60 minutes. Three separate probes
 * have been bitten by this. Label every call and print the elapsed time.
 */
async function bounded<T>(label: string, ms: number, work: Promise<T>): Promise<T | { timeout: true }> {
  const started = Date.now()
  const result = await Promise.race([
    work,
    new Promise<{ timeout: true }>((resolve) => setTimeout(() => resolve({ timeout: true }), ms)),
  ])
  const elapsed = Date.now() - started
  const timedOut = (result as { timeout?: boolean })?.timeout === true
  console.log(`    [${label}] ${timedOut ? `TIMED OUT after ${ms}ms` : `ok in ${elapsed}ms`}`)
  return result
}

async function waitForContent(page: Page, budgetMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const painted = await page
      .evaluate(`!!document.body && document.body.innerText.trim().length > 0`)
      .catch(() => false)
    if (painted) return true
    await page.waitForTimeout(1000).catch(() => {})
  }
  return false
}

async function capture(page: Page, name: string): Promise<Record<string, unknown>> {
  const painted = await waitForContent(page)
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {})
  const data = (await page.evaluate(INVENTORY_JS).catch((e) => ({ error: String(e) }))) as Record<
    string,
    unknown
  >
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2))

  if (data.error) {
    console.log(`    inventory failed: ${String(data.error).slice(0, 140)}`)
    return data
  }
  console.log(
    `    painted=${painted} title="${data.title}" testIds=${data.totalTestIds} bodyChars=${data.bodyChars}`,
  )
  const headings = data.headings as string[]
  if (headings?.length) console.log(`    headings: ${headings.join(' | ')}`)
  for (const b of ((data.buttons as { text: string; testId: string | null }[]) ?? []).slice(0, 16)) {
    console.log(`      [button] "${b.text}"${b.testId ? `  testId=${b.testId}` : ''}`)
  }
  for (const i of (data.inputs as { type: string; placeholder: string | null }[]) ?? []) {
    console.log(`      [input ] type=${i.type} placeholder=${JSON.stringify(i.placeholder)}`)
  }
  return data
}

/** Each capture gets its OWN page — a shared one closing killed the first Rabby probe. */
async function captureUrl(context: BrowserContext, name: string, url: string): Promise<void> {
  console.log(`\n--- ${name} → ${url}`)
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    await capture(page, name)
  } catch (error) {
    console.log(`    capture failed: ${(error as Error).message.slice(0, 140)}`)
  } finally {
    await page.close().catch(() => {})
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })

  const extensionPath = phantomExtensionPath()
  const version = phantomVersion()
  const manifest = JSON.parse(
    fs.readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'),
  ) as Record<string, unknown>

  console.log('=== PHASE 0 — what did we actually load ===')
  console.log(`  path            ${extensionPath}`)
  console.log(`  version         ${version}   <-- RECORD THIS in wallet_version`)
  console.log(`  manifest_version ${manifest.manifest_version}`)
  console.log(
    `  MV3?            ${manifest.manifest_version === 3 ? 'YES — expect service-worker death on long runs, as MetaMask and Rabby' : 'no'}`,
  )

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: browserArgsFor(extensionPath),
    viewport: { width: 1280, height: 900 },
  })

  try {
    // Give the service worker a moment to register, then find the extension id.
    await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => null)
    const worker = context.serviceWorkers()[0]
    const extensionId = worker?.url().split('/')[2] ?? null
    console.log(`  extension id    ${extensionId ?? 'NOT FOUND — everything below will fail'}`)
    if (!extensionId) return

    // ---- PHASE 1: onboarding surface -------------------------------------
    // No seed entered. We are reading routes and vocabulary, nothing more.
    // Phantom's entry points are unknown; try the conventional MV3 names and
    // let the inventory tell us which one actually paints.
    console.log('\n=== PHASE 1 — onboarding + UI surface (no seed) ===')
    for (const page of ['onboarding.html', 'popup.html', 'index.html', 'notification.html']) {
      await captureUrl(context, `1-${page.replace('.html', '')}`, `chrome-extension://${extensionId}/${page}`)
    }

    // ---- PHASE 2: EIP-6963 from a real origin ----------------------------
    // RDNS.phantom = 'app.phantom' is already in utils/provider-eval.ts and the
    // five-wallet probe on 2026-07-26 saw Phantom announce synchronously. This
    // re-confirms it for THIS build and captures the EVM provider's shape.
    console.log('\n=== PHASE 2 — EIP-6963 announcement from the dApp origin ===')
    const dapp = await context.newPage()
    await dapp.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
    const announce = await bounded('announce', 15_000, dapp.evaluate(ANNOUNCE_JS) as Promise<unknown>)
    fs.writeFileSync(path.join(OUT, '2-announce.json'), JSON.stringify(announce, null, 2))
    console.log(`    ${JSON.stringify(announce).slice(0, 600)}`)

    // ---- PHASE 3: THE GATE -----------------------------------------------
    // What does Phantom do with wallet_addEthereumChain for Base Sepolia?
    //
    // Three outcomes, and they are NOT the same finding:
    //   a) a dialog opens          -> custom networks work; the help centre is
    //                                 out of date; the column proceeds as normal
    //   b) rejects with an error   -> RECORD THE CODE AND MESSAGE VERBATIM. That
    //                                 is the publishable artefact, not a summary
    //   c) resolves doing nothing  -> the worst case for a dApp: silent no-op
    //
    // Locked wallets answer some of these differently, so the state is printed
    // alongside. This runs WITHOUT onboarding on purpose: if it errors the same
    // way locked and unlocked, that is stronger evidence, and it costs nothing.
    // CONTROL, added 2026-08-06 after run 1.
    //
    // Run 1 returned code 4901 "The Provider is not connected to the requested
    // chain" for Base Sepolia — on a wallet that had NEVER BEEN ONBOARDED. Per
    // EIP-1193, 4901 means the provider knows the chain but is disconnected from
    // it *while connected to others*; 4902 is the "unrecognised, go add it" code.
    // Getting 4901 from an add request is odd, and it is tempting to read it as
    // "Phantom refuses custom chains".
    //
    // It cannot be read that way yet, because a wallet with zero accounts is
    // plausibly "disconnected" from EVERYTHING, and 4901 may just be its generic
    // no-wallet answer with nothing to do with Base Sepolia at all.
    //
    // So: fire the SAME request for a chain Phantom definitely DOES ship (Base
    // MAINNET, 0x2105 — from its own supported list) against the SAME state.
    //   same 4901 for both  -> 4901 means "no wallet". Run 1 measured NOTHING
    //                          about chain support. Re-run onboarded.
    //   different answers   -> the code really is about the requested chain.
    //
    // One variable moves: the chainId. This is the control the `fill()` run
    // didn't have, and not having it nearly published a false claim about a
    // vendor's product. Reading a chain id is not a transaction and touches no
    // funds — naming a mainnet here is safe and the run never leaves the dialog.
    console.log('\n=== PHASE 3 — THE GATE: wallet_addEthereumChain, target vs control ===')
    const askAddChain = (chainIdHex: string, chainName: string, rpc: string) =>
      `(() => new Promise(function (resolve) {
          var p = null
          function onA (e) { if (e.detail && e.detail.info && e.detail.info.rdns === 'app.phantom') p = e.detail.provider }
          window.addEventListener('eip6963:announceProvider', onA)
          window.dispatchEvent(new Event('eip6963:requestProvider'))
          setTimeout(function () {
            window.removeEventListener('eip6963:announceProvider', onA)
            if (!p) return resolve({ error: 'app.phantom did not announce — cannot ask it anything' })
            p.request({ method: 'eth_chainId' })
             .then(function (before) {
               return p.request({ method: 'wallet_addEthereumChain', params: [{
                 chainId: '${chainIdHex}',
                 chainName: '${chainName}',
                 nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                 rpcUrls: ['${rpc}']
               }] })
               .then(function (r) { resolve({ requested: '${chainIdHex}', before: before, outcome: 'resolved', returned: r === undefined ? 'undefined' : String(r) }) })
               .catch(function (err) { resolve({ requested: '${chainIdHex}', before: before, outcome: 'rejected',
                 code: err && err.code, message: err && err.message, raw: String(err).slice(0, 400) }) })
             })
             .catch(function (err) { resolve({ requested: '${chainIdHex}', outcome: 'eth_chainId failed', message: String(err).slice(0, 300) }) })
          }, 2500)
        }))()`

    console.log('  [target ] Base Sepolia 0x14a34 — NOT on Phantom\'s published list')
    const addChain = await bounded(
      'addChain:base-sepolia',
      45_000,
      dapp.evaluate(askAddChain(BASE_SEPOLIA_HEX, 'Base Sepolia', 'https://sepolia.base.org')) as Promise<unknown>,
    )
    console.log(`    ${JSON.stringify(addChain)}`)

    console.log('  [control] Base MAINNET 0x2105 — IS on Phantom\'s published list')
    const addChainControl = await bounded(
      'addChain:base-mainnet-CONTROL',
      45_000,
      dapp.evaluate(askAddChain('0x2105', 'Base', 'https://mainnet.base.org')) as Promise<unknown>,
    )
    console.log(`    ${JSON.stringify(addChainControl)}`)

    // THE ONE THAT DECIDES THE ETHEREUM SEPOLIA MIGRATION.
    //
    // Run 2 established that Phantom answers wallet_addEthereumChain from a
    // static allowlist — Base mainnet resolved, Base Sepolia rejected 4901, with
    // NO wallet onboarded and no dialog shown. The decision is made before a user
    // exists.
    //
    // The Sepolia plan rests on Phantom shipping "Ethereum". But its testnets sit
    // behind a Testnet Mode TOGGLE in Settings, which is UI state, not something
    // an RPC can reach. So "supports Ethereum" may well mean mainnet only, and
    // Ethereum Sepolia may be refused exactly like Base Sepolia.
    //
    //   resolves -> Sepolia is reachable by RPC. The migration unlocks Phantom
    //               and the column runs like the others.
    //   4901     -> it does NOT. Phantom would need Testnet Mode toggled in the
    //               UI during cache-build, which is a different piece of work
    //               entirely, and the migration's Phantom rationale collapses.
    //
    // Cheap to ask, and the answer changes the plan. Ask it before moving a
    // single chain constant.
    console.log('  [sepolia] Ethereum Sepolia 0xaa36a7 — DECIDES THE MIGRATION')
    const addChainSepolia = await bounded(
      'addChain:ethereum-sepolia',
      45_000,
      dapp.evaluate(
        askAddChain('0xaa36a7', 'Ethereum Sepolia', 'https://ethereum-sepolia-rpc.publicnode.com'),
      ) as Promise<unknown>,
    )
    console.log(`    ${JSON.stringify(addChainSepolia)}`)

    const a = addChain as { code?: number; outcome?: string; before?: string }
    const b = addChainControl as { code?: number; outcome?: string }
    const describe = (r: { code?: number; outcome?: string }) =>
      r?.outcome === 'resolved' ? 'resolved (no error)' : `rejected ${r?.code ?? '?'}`
    console.log('\n  >>> READ THIS BEFORE CONCLUDING ANYTHING:')
    if (a?.code !== undefined && a.code === b?.code) {
      console.log(`      Both returned ${a.code}. The code is NOT about the chain — it is the`)
      console.log('      wallet state. This run measured NOTHING about custom-network support.')
      console.log('      Onboard a burner and re-run before writing a word about Phantom.')
    } else {
      // Say what happened, not just the codes. A resolved call has no `code`, and
      // the first version printed "control=undefined", which reads like a failure
      // when it is the opposite. STATUS.md already carries this lesson from the
      // reconnect message: the line that gets pasted into a diagnosis must be true.
      console.log(`      target ${describe(a)}  vs  control ${describe(b)} — they DIFFER,`)
      console.log('      so the response really does depend on the requested chain. Still worth')
      console.log('      confirming onboarded, but this is now a real signal.')
    }
    // ⚠ ORDER CONFOUND, seen on run 3 and left standing deliberately.
    //
    // These three requests share one provider and run in sequence, so state
    // carries. Run 3 showed the Base-mainnet control ACTUALLY SWITCHING the
    // wallet: Base Sepolia was asked at before=0x1, Ethereum Sepolia at
    // before=0x2105. Different starting states, so they are not strictly
    // independent trials.
    //
    // The conclusion probably survives — both rejections returned the same 4901
    // from different starting chains, which is what you would expect if the code
    // is about the REQUESTED chain rather than the current one. "Probably" is
    // enough to make a planning decision (the cost of wrongly cancelling a
    // migration is one CI run) and NOT enough to publish a claim about a vendor.
    //
    // Before any of this reaches the matrix: re-run each request in its own fresh
    // context, and randomise the order.
    const s = addChainSepolia as { code?: number; outcome?: string; before?: string }
    if (s?.before && s.before !== '0x1') {
      console.log(`\n  ⚠ CONFOUND: Sepolia was asked with the wallet already on ${s.before}`)
      console.log('    (the control switched it). Fine for deciding the plan, NOT for publishing.')
    }
    console.log('\n  >>> ETHEREUM SEPOLIA VERDICT — read before touching the chain constant:')
    if (s?.outcome === 'resolved') {
      console.log('      RESOLVED. Sepolia is reachable over RPC. The migration unlocks the')
      console.log('      Phantom column and it can run like MetaMask and Rabby.')
    } else {
      console.log(`      ${s?.outcome ?? 'unknown'}${s?.code !== undefined ? ` (${s.code})` : ''}.`)
      console.log('      Sepolia is NOT reachable over RPC. Moving the matrix to Sepolia does')
      console.log('      NOT unlock Phantom — it would need Testnet Mode toggled in the UI at')
      console.log('      cache-build time. The migration may still be right for other reasons,')
      console.log('      but its Phantom rationale is gone. Do not move the constant on it.')
    }
    fs.writeFileSync(
      path.join(OUT, '3-add-chain.json'),
      JSON.stringify(
        { target: addChain, control: addChainControl, ethereumSepolia: addChainSepolia },
        null,
        2,
      ),
    )
    await dapp.screenshot({ path: path.join(OUT, '3-after-add-chain.png'), fullPage: true }).catch(() => {})

    // A dialog may have opened in a NEW page rather than resolving inline —
    // Rabby does exactly this and it cost three probes to notice.
    console.log(`    open pages now: ${context.pages().length}`)
    for (const [i, p] of context.pages().entries()) {
      console.log(`      page[${i}] ${p.url().slice(0, 120)}`)
    }

    // ---- PHASE 4: what chains does it actually ship? ---------------------
    // Only meaningful once a wallet exists, so it is guarded rather than
    // assumed. Reads the settings surface to find Testnet Mode and enumerate
    // the EVM testnets — specifically whether Base Sepolia is among them.
    console.log('\n=== PHASE 4 — Testnet Mode + supported chain list ===')
    if (!process.env.PHANTOM_SEED_PHRASE) {
      console.log('    SKIPPED — no PHANTOM_SEED_PHRASE set.')
      console.log('    Phase 4 needs an onboarded wallet to open Settings. Add a BURNER seed')
      console.log('    to .env (never one that has held value) and re-run.')
      console.log('    Until then the chain question is answered ONLY by phase 3.')
    } else {
      console.log('    A wallet exists, but the onboarding route is not yet known — that is')
      console.log('    what phase 1 is establishing. Read 1-*.json, write the onboarding')
      console.log('    sequence into utils/phantom-onboarding.ts EXACTLY as observed, then')
      console.log('    extend this phase. Do not port a guess: the Rabby onboarding broke')
      console.log('    three times from extending a verified path instead of copying it.')
    }

    if (process.env.PROBE_HOLD) {
      console.log('\nPROBE_HOLD set — holding the browser open for 90s. Click around.')
      await new Promise((r) => setTimeout(r, 90_000))
    }
  } finally {
    await context.close().catch(() => {})
  }

  console.log(`\n=== done. Evidence in ${OUT} ===`)
  console.log('Read the JSON before writing a single selector.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
