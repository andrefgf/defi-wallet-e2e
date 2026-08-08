import { chromium, type Page, type BrowserContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import 'dotenv/config'
import { rabbyExtensionPath, browserArgsFor, rabbyProfilePath } from '../utils/wallet-cache'
import {
  unlockIfLocked,
  connectToDapp,
  approveChainDialog,
  approveFollowUpRequests,
  withTimeout,
} from '../utils/rabby-actions'
import { connect } from '../utils/selectors'
import { BASE_SEPOLIA, addChainParams } from '../utils/networks'

/**
 * WHICH LAYER DROPS THE CONNECTION?
 *
 * CI #14 recorded: Rabby authorises 0xe59c45… on chain 0x14a34 (correct), and
 * Aave renders no account. After a page reload the same session shows the
 * account fine. MetaMask shows it immediately.
 *
 * Run 1 of this probe returned `SAME_OBJECT: false`. That is NOT yet hypothesis
 * D. Different object identity is ordinary — a wallet may announce a wrapper
 * over the same underlying transport, in which case both objects answer
 * identically and provider identity explains nothing.
 *
 * D is confirmed only if the two objects DISAGREE. So this run measures
 * `eth_accounts` and `eth_chainId` on BOTH providers, before and after the
 * connect, and records which object the events fired on:
 *
 *   both report the account   → different wrappers, same state. D does not
 *                               explain the missing chip. Back to A / B / C.
 *   they disagree             → D CONFIRMED. The finding is about provider
 *                               identity, and neither vendor has a bug.
 *
 *   pnpm run probe:rabby:event
 */

const OUT = path.join(process.cwd(), 'matrix-out', 'rabby-connect-event')
const DAPP = process.env.DAPP_URL ?? 'https://app.aave.com/?marketName=proto_base_sepolia_v3'

/**
 * Resolve both providers, fingerprint them, and install listeners on each —
 * all BEFORE the connect, so nothing can fire unobserved.
 */
const INSTALL_LISTENERS = `(() => {
  window.__evt = []
  function log(src, name, payload) {
    window.__evt.push({ at: Date.now(), src: src, name: name, payload: JSON.stringify(payload).slice(0, 160) })
  }
  function fingerprint(p) {
    if (!p) return null
    var keys = []
    try { for (var k in p) keys.push(k) } catch (e) {}
    return {
      ctor: (p.constructor && p.constructor.name) || 'unknown',
      isRabby: !!p.isRabby,
      isMetaMask: !!p.isMetaMask,
      hasProvidersArray: Array.isArray(p.providers),
      providersLen: Array.isArray(p.providers) ? p.providers.length : 0,
      keyCount: keys.length
    }
  }
  return new Promise(function (resolve) {
    var chosen = null
    var announced = []
    window.addEventListener('eip6963:announceProvider', function (e) {
      if (!e.detail || !e.detail.info) return
      announced.push(e.detail.info.rdns)
      if (e.detail.info.rdns === 'io.rabby') chosen = e.detail.provider
    })
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(function () {
      var legacy = window.ethereum
      window.__rdns = chosen
      window.__legacy = legacy
      window.__t0 = Date.now()
      var names = ['connect', 'accountsChanged', 'chainChanged', 'disconnect', 'message']
      if (chosen && chosen.on) names.forEach(function (n) { chosen.on(n, function (p) { log('rdns', n, p) }) })
      if (legacy && legacy.on && legacy !== chosen) names.forEach(function (n) { legacy.on(n, function (p) { log('legacy', n, p) }) })
      resolve({
        announcedRdns: announced,
        rdnsFound: !!chosen,
        legacyFound: !!legacy,
        SAME_OBJECT: chosen === legacy,
        rdnsFingerprint: fingerprint(chosen),
        legacyFingerprint: fingerprint(legacy)
      })
    }, 2000)
  })
})()`

/**
 * Ask BOTH providers the same two questions. This is the decisive measurement:
 * different objects only matter if they give different answers.
 */
const POLL_BOTH = `(() => {
  function ask(p, method) {
    if (!p) return Promise.resolve('NO PROVIDER')
    return p.request({ method: method }).catch(function (e) { return 'ERR ' + (e && e.message) })
  }
  return Promise.all([
    ask(window.__rdns, 'eth_accounts'),
    ask(window.__legacy, 'eth_accounts'),
    ask(window.__rdns, 'eth_chainId'),
    ask(window.__legacy, 'eth_chainId')
  ]).then(function (r) {
    return { rdnsAccounts: r[0], legacyAccounts: r[1], rdnsChainId: r[2], legacyChainId: r[3] }
  })
})()`

/**
 * Events fired, plus whatever wagmi persisted about the connection.
 *
 * `wagmiSummary` is parsed in-page, not regexed out of a stringified blob.
 * Run 4's verdict said "wagmi holds the account" while the store actually read
 * `connections: []` — the regex was matching escaped quotes and silently
 * returning nothing, and the branch never checked. Parse the structure.
 */
const FINAL_STATE = `(() => {
  // ALL keys, not a filtered subset. Aave requests chain 43113 while displaying
  // the Base Sepolia market; before that can be called a dApp defect we have to
  // rule out a stale market/chain persisted in THIS profile. A filter that hides
  // the key holding the answer is worse than no dump at all.
  var store = {}
  try {
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i)
      store[k] = (localStorage.getItem(k) || '').slice(0, 260)
    }
  } catch (e) { store = { error: String(e) } }

  var summary = { parsed: false }
  try {
    var raw = localStorage.getItem('wagmi.store')
    if (raw) {
      var o = JSON.parse(raw)
      var st = (o && o.state) || {}
      var conns = (st.connections && st.connections.value) || []
      var accounts = []
      for (var j = 0; j < conns.length; j++) {
        var entry = conns[j] && conns[j][1]
        if (entry && entry.accounts) accounts = accounts.concat(entry.accounts)
      }
      summary = {
        parsed: true,
        connectionCount: conns.length,
        current: st.current === null ? null : String(st.current),
        chainId: st.chainId,
        accounts: accounts,
        connectorIds: conns.map(function (c) { return c[1] && c[1].connector && c[1].connector.id })
      }
    }
  } catch (e) { summary = { parsed: false, error: String(e) } }

  var evts = (window.__evt || []).map(function (e) {
    return { src: e.src, name: e.name, payload: e.payload, msAfterInstall: e.at - (window.__t0 || e.at) }
  })
  return { events: evts, wagmiStorage: store, wagmiSummary: summary }
})()`

async function snap(page: Page, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {})
}

/**
 * WHICH MARKET DID WE ACTUALLY GET?
 *
 * Added after a multi-market run produced three byte-identical results that
 * looked like strong corroboration and proved nothing. `marketName` values were
 * guessed from a pattern; only `proto_base_sepolia_v3` was ever verified. An
 * invalid value makes Aave fall back to its default market — so "identical
 * behaviour across three markets" and "the same page three times" are the same
 * observation, and the probe could not tell them apart.
 *
 * Never again run a comparison without recording what was actually compared.
 */
const MARKET_LABEL = `(() => {
  var best = 'UNKNOWN'
  var els = document.querySelectorAll('h1,h2,h3,h4,button,span,div')
  for (var i = 0; i < els.length; i++) {
    var t = (els[i].textContent || '').replace(/\\s+/g, ' ').trim()
    if (/\\bmarket\\b/i.test(t) && t.length > 3 && t.length < 40) { best = t; break }
  }
  return { label: best, url: window.location.href, testnets: localStorage.getItem('testnetsEnabled') }
})()`

/** `waitFor`, never `isVisible` — the latter ignores its timeout. */
async function chipVisible(page: Page, timeout: number): Promise<boolean> {
  return connect
    .accountChip(page)
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false)
}

// --- instrumentation --------------------------------------------------------

const T0 = Date.now()

/** Every line carries elapsed seconds, so a hang is visible in the gap. */
function step(msg: string): void {
  const s = ((Date.now() - T0) / 1000).toFixed(1).padStart(6)
  console.log(`[${s}s] ${msg}`)
}

/**
 * NEVER `await page.evaluate` DIRECTLY IN THIS FILE.
 *
 * Every evaluate here talks to a wallet, and a wallet promise settles only when
 * the wallet answers. `page.evaluate` puts NO timeout on a returned promise, so
 * one unanswered request hangs the entire run with nothing on stdout.
 *
 * This is the THIRD time that pattern has cost a run:
 *   - CI #11 died at the 60-minute job ceiling on an unbounded add-chain await.
 *   - helpers.ts carried the same latent bug (fixed 2026-07-30).
 *   - run 8 of this probe hung silently at "BOTH PROVIDERS, BEFORE CONNECT",
 *     which is what prompted this wrapper.
 *
 * Fixing the instance is not fixing the pattern. Everything goes through here:
 * a ceiling, a label, and a printed elapsed time on both sides of the call.
 */
async function bounded<T>(
  page: Page,
  label: string,
  body: string,
  ms = 30_000,
): Promise<T | 'TIMEOUT'> {
  step(`  → ${label}`)
  const started = Date.now()
  const result = await withTimeout<T | 'TIMEOUT'>(
    page
      .evaluate(body)
      .then((v) => v as T)
      .catch((e: Error) => `ERR ${e.message}` as unknown as T),
    ms,
    'TIMEOUT',
  )
  const took = ((Date.now() - started) / 1000).toFixed(1)
  if (result === 'TIMEOUT') {
    step(`  ✕ ${label} TIMED OUT after ${took}s — wallet never answered`)
    await snap(page, `TIMEOUT-${label.replace(/\W+/g, '_')}`)
  } else {
    step(`  ← ${label} ok (${took}s)`)
  }
  return result
}

/**
 * Aave's analytics consent can sit over the connect button.
 *
 * NOT using helpers.dismissAnalyticsPrompt: it gates on `isVisible()`, which
 * ignores its timeout and returns false the instant it is called. If the prompt
 * has not painted yet it is never dismissed, and the connect click then times
 * out against an overlay — which is exactly how run 1 of this probe died.
 * (Same defect §7 of METHODOLOGY.md already records us fixing elsewhere.)
 */
async function dismissConsent(page: Page): Promise<boolean> {
  const optOut = connect.analyticsOptOut(page)
  const shown = await optOut
    .waitFor({ state: 'visible', timeout: 15_000 })
    .then(() => true)
    .catch(() => false)
  if (!shown) return false
  await optOut.click().catch(() => {})
  await page.waitForTimeout(1000)
  return true
}

/**
 * Force a COLD connect.
 *
 * Run 2 found the profile already authorised for app.aave.com: the chip was
 * rendered on load, `eth_accounts` was non-empty before we touched anything,
 * and there was no "Connect wallet" button to click. That is the reconnect
 * path, which we already know passes — it measures nothing we don't have.
 *
 * The connect EVENT only fires on a cold connect, so tear the session down on
 * the dApp side first: disconnect through Aave's own menu, drop wagmi's
 * persisted state, reload.
 *
 * Deliberately NOT revoking Rabby's site permission. Leaving the wallet still
 * authorised while Aave's own state is cleared is the sharper experiment: if
 * `eth_accounts` stays non-empty and Aave still cannot get an account into its
 * UI, the wallet's authorisation was never the missing piece.
 */
async function ensureDisconnected(page: Page): Promise<string> {
  const chip = connect.accountChip(page)
  const connected = await chip
    .waitFor({ state: 'visible', timeout: 10_000 })
    .then(() => true)
    .catch(() => false)

  if (!connected) return 'already disconnected'

  await chip.click().catch(() => {})
  await page.waitForTimeout(1200)

  const disconnect = connect.disconnectButton(page)
  const sawButton = await disconnect
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false)

  if (sawButton) {
    await disconnect.click().catch(() => {})
    await page.waitForTimeout(2000)
  } else {
    await page.keyboard.press('Escape').catch(() => {})
  }

  // Belt and braces: whatever the menu did, clear wagmi's own persistence.
  await page
    .evaluate(
      `(() => {
        var removed = []
        try {
          for (var i = localStorage.length - 1; i >= 0; i--) {
            var k = localStorage.key(i)
            if (/wagmi|recent|connect/i.test(k)) { removed.push(k); localStorage.removeItem(k) }
          }
        } catch (e) {}
        return removed
      })()`,
    )
    .catch(() => [])

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  await dismissConsent(page)

  const stillThere = await connect
    .accountChip(page)
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false)

  return sawButton
    ? `disconnected via menu${stillThere ? ' — BUT CHIP CAME BACK' : ''}`
    : `no Disconnect in menu; cleared storage${stillThere ? ' — BUT CHIP CAME BACK' : ''}`
}

async function openWalletPicker(page: Page): Promise<void> {
  const btn = connect.connectWalletButton(page)
  const ok = await btn
    .waitFor({ state: 'visible', timeout: 45_000 })
    .then(() => true)
    .catch(() => false)

  if (!ok) {
    await snap(page, 'ERROR-no-connect-button')
    const heading = await page.title().catch(() => '?')
    const buttons = await page
      .getByRole('button')
      .allInnerTexts()
      .catch(() => [] as string[])
    throw new Error(
      `"Connect wallet" never appeared. title="${heading}", buttons=${JSON.stringify(
        buttons.slice(0, 15),
      )}. Screenshot: ERROR-no-connect-button.png`,
    )
  }
  await btn.click()
}

async function main() {
  const cache = rabbyProfilePath()
  if (!fs.existsSync(cache)) throw new Error('no Rabby cache — run: pnpm run build:cache:rabby')
  fs.mkdirSync(OUT, { recursive: true })

  /**
   * WORK ON A COPY. NEVER ON THE CACHE.
   *
   * This probe used to open `rabbyProfilePath()` directly. Every run therefore
   * wrote its site authorisation for app.aave.com back into the shared cache —
   * and the test fixture copies that cache for every cell.
   *
   * Result: after five probe runs, every Rabby spec loaded Aave ALREADY
   * CONNECTED. No "Connect wallet" button existed, all four cells timed out at
   * 30s, and the suite reported `blocked` for reasons that had nothing to do
   * with Rabby, Aave, or the code under test. A diagnostic tool had quietly
   * become the thing being diagnosed.
   *
   * The fixture had this right (`mkdtemp` + `cpSync`); the probe did not. Any
   * tool that opens a wallet profile mutates it — so read-only intent is not
   * enough, the copy has to be real.
   */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rabby-probe-'))
  fs.cpSync(cache, profile, { recursive: true })
  console.log(`profile: working copy at ${profile}`)

  const context: BrowserContext = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: browserArgsFor(rabbyExtensionPath()),
    viewport: { width: 1280, height: 800 },
  })
  await context.addInitScript(() => {
    try {
      if (window.location.hostname.endsWith('aave.com')) {
        window.localStorage.setItem('testnetsEnabled', 'true')
      }
    } catch {}
  })

  try {
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })
    const id = new URL(worker.url()).host

    const wallet = await context.newPage()
    await wallet
      .goto(`chrome-extension://${id}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch(() => {})
    await wallet.waitForTimeout(3000)
    await unlockIfLocked(wallet)

    const page = await context.newPage()
    await page.goto(DAPP, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})

    const consent = await dismissConsent(page)
    console.log(`\nanalytics consent dismissed: ${consent}`)
    await snap(page, '0-loaded')

    // Record what we actually loaded, before measuring anything against it.
    step(`requested: ${DAPP}`)
    const market = (await bounded(page, 'identify market', MARKET_LABEL, 15_000)) as {
      label?: string
      url?: string
      testnets?: string
    }
    step(`landed on : ${market.url ?? '?'}`)
    step(`market UI : ${market.label ?? '?'}   (testnetsEnabled=${market.testnets ?? '?'})`)
    if (DAPP.includes('marketName=') && market.url && !market.url.includes('marketName=')) {
      step('  ⚠ marketName was DROPPED from the URL — Aave fell back to a default market.')
      step('    Any cross-market comparison from this run is meaningless.')
    }

    // The connect EVENT only fires on a cold connect. Run 2 landed on an
    // already-authorised session and measured the reconnect path by accident.
    step('=== 0. TEAR DOWN ANY EXISTING SESSION ===')
    const teardown = await ensureDisconnected(page)
    console.log(`  ${teardown}`)
    await snap(page, '0b-after-disconnect')

    step('=== 1. PROVIDER IDENTITY ===')
    const identity = (await bounded(page, 'install listeners', INSTALL_LISTENERS, 20_000)) as Record<string, unknown>
    console.log(JSON.stringify(identity, null, 2))

    step('=== 2. BOTH PROVIDERS, BEFORE CONNECT ===')
    const before = (await bounded(page, 'poll both (before connect)', POLL_BOTH, 25_000)) as Record<string, unknown>
    console.log(JSON.stringify(before, null, 2))

    // ---------------------------------------------------------------------
    // PRECONDITION GATE — abort rather than measure a broken wallet.
    //
    // Run 8 produced a confident, WRONG verdict: "no events fired, the wallet
    // never notified anyone — notify Rabby". Every provider call had in fact
    // returned `ERR wallet must has at least one account`. The profile was
    // EMPTY. Nothing could connect, so of course nothing fired, and the
    // verdict function read that silence as a finding about a vendor.
    //
    // Both providers "agreed" — on an error string. Zero events "fired" —
    // because zero happened. Every downstream signal was consistent with a
    // real defect and every one of them was an artifact.
    //
    // This is the same class of error as the retracted matrix cell, committed
    // by the tool built to prevent it. A verdict function must be able to say
    // "this run measured nothing", or it will eventually accuse someone.
    // ---------------------------------------------------------------------
    const acctProbe = JSON.stringify([
      (before as { rdnsAccounts?: unknown }).rdnsAccounts,
      (before as { legacyAccounts?: unknown }).legacyAccounts,
      (before as { rdnsChainId?: unknown }).rdnsChainId,
    ])
    if (/ERR |NO PROVIDER|must has at least one account/i.test(acctProbe)) {
      await snap(page, 'INVALID-no-account')
      console.log('\n================ RUN INVALID ================')
      console.log('  The wallet has no usable account. This run measures NOTHING.')
      console.log(`  provider said: ${acctProbe}`)
      console.log('')
      console.log('  NO VERDICT WILL BE EMITTED. Silence from an empty wallet is not')
      console.log('  evidence about Rabby, about Aave, or about anything else.')
      console.log('')
      console.log('  Fix the profile, then re-run:')
      console.log('    Remove-Item -Recurse -Force .\\.wallet-cache\\rabby')
      console.log('    pnpm run build:cache:rabby      # must print: connected: ["0x..."]')
      console.log('    pnpm probe:rabby:event')
      console.log('=============================================')
      throw new Error('INVALID RUN — wallet has no account; refusing to emit a verdict')
    }

    step('=== 3. CONNECT ===')
    await openWalletPicker(page)
    await page.waitForTimeout(1500)
    const rabbyOption = page.getByRole('button', { name: /rabby/i }).first()
    await rabbyOption.waitFor({ state: 'visible', timeout: 20_000 })
    await rabbyOption.click()
    await connectToDapp(context, id).catch((e: Error) => console.log(`  approve failed: ${e.message}`))
    await page.waitForTimeout(10_000)
    await snap(page, '1-after-connect')

    step('=== 4. BOTH PROVIDERS, AFTER CONNECT ===')
    const after = (await bounded(page, 'poll both (after connect)', POLL_BOTH, 25_000)) as Record<string, unknown>
    console.log(JSON.stringify(after, null, 2))

    // --- reproduce CI conditions -------------------------------------------
    //
    // Run 3 connected on chain 0x1 and showed no chip. That is NOT the CI #14
    // failure: there the wallet was correctly on Base Sepolia (0x14a34) and the
    // chip was still absent. "No account chip while on the wrong network" may
    // be Aave behaving perfectly reasonably, and reading it as the same defect
    // would be a false match.
    //
    // So put the wallet where CI had it, then ask again. This is the step that
    // separates "Aave ignores a correct connection" from "Aave declines to
    // render an account on an unsupported chain".
    step('=== 4b. SWITCH TO BASE SEPOLIA (reproduce CI #14) ===')
    const beforeSwitch = await chipVisible(page, 3000)
    console.log(`  chip before switch: ${beforeSwitch}`)

    const switchReq = page
      .evaluate(
        `(() => {
          var params = ${JSON.stringify(addChainParams())}
          var p = window.__rdns || window.ethereum
          if (!p) return Promise.resolve('no provider')
          return p.request({ method: 'wallet_addEthereumChain', params: [params] })
            .then(function () { return 'ok' })
            .catch(function (e) { return 'rejected: ' + (e && e.message) })
        })()`,
      )
      .catch(() => 'evaluate failed')

    // SYMMETRY MODE. The MetaMask path calls `approveFollowUpRequests`, which
    // blind-approves whatever prompt appears — including Aave's Avalanche Fuji
    // request. The Rabby path calls `approveChainDialog`, which DECLINES any
    // dialog that isn't 84532. That asymmetry is ours, added after CI #10
    // landed on 0xa869, and it means the two connect cells have not been
    // measuring the same thing.
    //
    //   APPROVE_ANY_CHAIN=1 → behave like the MetaMask path.
    //
    // If the chip appears under that flag and not otherwise, the `fail` is an
    // artifact of the harness, not a difference between the wallets.
    const mirrorMetaMask = process.env.APPROVE_ANY_CHAIN === '1'
    console.log(`  mode: ${mirrorMetaMask ? 'APPROVE ANY CHAIN (mirrors MetaMask path)' : 'chain-checked (declines != 84532)'}`)

    const approved = mirrorMetaMask
      ? (await approveFollowUpRequests(context, id).catch(() => 0)) > 0
      : await approveChainDialog(context, id, BASE_SEPOLIA.chainId).catch(() => false)
    const switchResult = await withTimeout(switchReq, 25_000, 'timed out')
    console.log(`  add/switch chain: dialog approved=${approved}, request=${switchResult}`)

    const deadline = Date.now() + 45_000
    let onTarget = false
    while (Date.now() < deadline) {
      const now = (await bounded(page, 'chain poll', POLL_BOTH, 15_000)) as { rdnsChainId?: string }
      if (now.rdnsChainId === BASE_SEPOLIA.chainIdHex) {
        onTarget = true
        break
      }
      await page.waitForTimeout(1500)
    }
    console.log(`  wallet on ${BASE_SEPOLIA.chainIdHex}: ${onTarget}`)
    await page.waitForTimeout(6000)
    await snap(page, '2-after-chain-switch')

    step('=== 4c. BOTH PROVIDERS, ON BASE SEPOLIA ===')
    const onChain = (await bounded(page, 'poll both (on base sepolia)', POLL_BOTH, 25_000)) as Record<string, unknown>
    console.log(JSON.stringify(onChain, null, 2))

    step('=== 5. EVENTS + WAGMI STORAGE ===')
    const state = (await bounded(page, 'final state + storage', FINAL_STATE, 25_000)) as Record<string, unknown>
    const events = state.events as { src: string; name: string; payload: string; msAfterInstall: number }[]
    console.log(`  events observed: ${events.length}`)
    events.forEach((e) => console.log(`    +${e.msAfterInstall}ms [${e.src}] ${e.name} ${e.payload}`))
    console.log('  storage:')
    Object.entries(state.wagmiStorage as Record<string, string>).forEach(([k, v]) =>
      console.log(`    ${k} = ${v}`),
    )

    const chip = await chipVisible(page, 20_000)
    console.log(`\n  Aave account chip visible (on Base Sepolia): ${chip}`)

    // --- verdict -----------------------------------------------------------
    const fmt = (v: unknown) => JSON.stringify(v)
    const rdnsAcc = fmt((after as { rdnsAccounts: unknown }).rdnsAccounts)
    const legacyAcc = fmt((after as { legacyAccounts: unknown }).legacyAccounts)
    const agree = rdnsAcc === legacyAcc

    const beforeRdns = fmt((before as { rdnsAccounts: unknown }).rdnsAccounts)
    const preAuthorised = beforeRdns !== '[]' && beforeRdns !== '"NO PROVIDER"'

    console.log('\n================ VERDICT ================')
    console.log(`  teardown           : ${teardown}`)
    console.log(`  SAME_OBJECT        : ${identity.SAME_OBJECT}`)
    console.log(`  rdns   eth_accounts: ${rdnsAcc}`)
    console.log(`  legacy eth_accounts: ${legacyAcc}`)
    console.log(`  providers agree    : ${agree}`)
    console.log(
      `  chain rdns/legacy  : ${fmt((after as { rdnsChainId: unknown }).rdnsChainId)} / ` +
        `${fmt((after as { legacyChainId: unknown }).legacyChainId)}  (Base Sepolia = "0x14a34")`,
    )
    console.log(`  chip visible       : ${chip}`)
    console.log('')
    if (preAuthorised) {
      console.log('  NOTE: the wallet still had this origin authorised BEFORE the connect')
      console.log(`        (${beforeRdns}). Aave-side state was cleared, wallet-side was not.`)
      console.log('        So authorisation was never the missing piece.')
      console.log('')
    }
    const wagmi = (state.wagmiSummary ?? { parsed: false }) as {
      parsed: boolean
      connectionCount?: number
      current?: string | null
      chainId?: number
      accounts?: string[]
      connectorIds?: string[]
    }
    const wagmiHolds = (wagmi.connectionCount ?? 0) > 0
    console.log(
      `  wagmi              : connections=${wagmi.connectionCount ?? '?'}, ` +
        `current=${wagmi.current ?? 'null'}, chainId=${wagmi.chainId ?? '?'}, ` +
        `connectors=${JSON.stringify(wagmi.connectorIds ?? [])}`,
    )
    console.log('')

    if (!agree) {
      console.log('  → D CONFIRMED. The two providers disagree about who is connected.')
      console.log('    This is a provider-identity finding. Neither vendor is at fault.')
      console.log('    Do NOT notify Rabby or Aave. Rewrite the cell.')
    } else if (events.length === 0) {
      console.log('  → A. Providers agree, but NO events fired. The wallet never')
      console.log('    notified anyone. Notify Rabby (primary), Aave (informational).')
    } else if (!onTarget) {
      console.log('  → INCONCLUSIVE. The wallet never reached Base Sepolia, so this run')
      console.log('    did not reproduce CI #14 and the missing chip proves nothing.')
      console.log('    Fix the chain switch before drawing any conclusion.')
    } else if (chip) {
      console.log('  → CHIP RENDERS on Base Sepolia.')
      if (mirrorMetaMask) {
        console.log('    Under APPROVE_ANY_CHAIN — i.e. behaving like the MetaMask path.')
        console.log('    If the default mode fails and this one passes, the Rabby `connect`')
        console.log('    FAIL IS A HARNESS ARTIFACT, not a wallet difference. Retract the cell.')
      } else {
        console.log('    CI #14 is NOT "Aave ignores the connection". Something else')
        console.log('    differs in CI (headless, timing, cold profile). Notify nobody.')
      }
    } else if (!wagmiHolds) {
      console.log('  → CONNECTION TORN DOWN. Not C — wagmi holds NOTHING:')
      console.log(`    connections=[], current=null, chainId=${wagmi.chainId ?? '?'}.`)
      console.log('')
      console.log('    Sequence: cold connect succeeds and wagmi records it. Aave then')
      console.log('    requests a chain switch. We declined it (approved=' + approved + ').')
      console.log('    wagmi treats the rejection as fatal and DROPS the connection.')
      console.log('    Our own switch to Base Sepolia then succeeds, but too late.')
      console.log('')
      console.log('    TWO separate things to establish before naming anyone:')
      console.log('    1. WHICH chain did Aave ask for? If it asked for a chain other than')
      console.log('       the market it is displaying, that is the finding — and it is')
      console.log('       wallet-independent.')
      console.log('    2. Does MetaMask only pass because our harness blind-approves that')
      console.log('       same request? Re-run with APPROVE_ANY_CHAIN=1. If the chip then')
      console.log('       appears, the cells were never comparable.')
    } else {
      console.log('  → C. Wallet on the correct chain, events fired promptly,')
      console.log(`    wagmi HOLDS the connection (${wagmi.connectionCount} conn, `)
      console.log(`    accounts=${JSON.stringify(wagmi.accounts)}, chainId=${wagmi.chainId}),`)
      console.log('    and Aave renders no account. The dApp has everything it needs.')
      console.log('    Notify Aave (primary), Rabby (informational).')
      console.log('    BEFORE WRITING: check aave/interface wagmi version. "wagmi has it"')
      console.log('    is not "Aave mishandled it" — the defect may be in wagmi itself.')
    }
    console.log('=========================================')

    fs.writeFileSync(
      path.join(OUT, 'result.json'),
      JSON.stringify(
        { identity, before, after, onChain, state, chipBeforeSwitch: beforeSwitch, onTarget, chipVisible: chip, agree },
        null,
        2,
      ),
    )
    console.log(`\n✅ ${OUT}`)
  } finally {
    await context.close()
  }
}

main().catch((e: Error) => {
  console.error(`\n❌ ${e.message}`)
  process.exit(1)
})
