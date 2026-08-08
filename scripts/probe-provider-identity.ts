import { chromium } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import {
  metamaskExtensionPath,
  rabbyExtensionPath,
  phantomExtensionPath,
  browserArgsForAll,
} from '../utils/wallet-cache'

/**
 * Who owns `window.ethereum`, and does load order decide it?
 *
 * WHY THIS EXISTS — a claim was made that the evidence did not support
 * On 2026-08-06 the write-up said: *"anything gating on
 * window.ethereum.isMetaMask is reading install order, not intent."*
 *
 * That sentence bundles TWO separate propositions, and only one of them had
 * been measured:
 *
 *   P1  A wallet sets `isMetaMask: true` on its OWN provider.
 *       MEASURED, cleanly. The Phantom probe ran a single-extension profile
 *       (--disable-extensions-except) and the app.phantom ANNOUNCED provider
 *       still carried isMetaMask. One extension, no neighbours, no ambiguity.
 *       But this is impersonation. It says nothing about install order.
 *
 *   P2  `window.ethereum` is won by whichever extension loads first/last, so
 *       the slot's identity depends on install order.
 *       NOT MEASURED. The 07-21 (MetaMask+OneKey) and 07-26 (five wallets)
 *       observations both show the slot carrying isMetaMask plus another
 *       vendor's flag — but neither run ever VARIED THE ORDER. With order held
 *       constant you cannot learn whether order matters. Two explanations fit
 *       every observation so far: order decides, or it is a startup race.
 *
 * P2 was asserted on P1's evidence. This script measures P2 properly.
 *
 * DESIGN — one variable moves
 *   Same two wallets, two load orders, fresh profile each time, N repeats.
 *   Baselines for each wallet alone establish what its own flags are, so a
 *   combined run can be attributed rather than guessed at.
 *
 *   The repeats are the point. If A,B and B,A give stable and DIFFERENT
 *   answers, order decides (P2 true). If they give the same answer, order does
 *   not decide. If either config flips between repeats, it is a RACE — which is
 *   a third finding, more interesting than both, and invisible to a single run.
 *
 * NEUTRAL ORIGIN by default. A dApp's own JS touches window.ethereum (wagmi
 * enumerates and may re-wrap it), and that would contaminate the measurement.
 * Override with PROBE_ORIGIN if a dApp-specific reading is ever wanted.
 *
 *   pnpm run fetch:metamask && pnpm run fetch:rabby && pnpm run fetch:phantom
 *   pnpm run probe:identity
 *   PROBE_REPEATS=5 pnpm run probe:identity
 */

const OUT = path.join(process.cwd(), 'matrix-out', 'provider-identity')
const ORIGIN = process.env.PROBE_ORIGIN ?? 'https://example.com'
const REPEATS = Number(process.env.PROBE_REPEATS ?? 3)

/**
 * Read the slot AND the announcements. String, not a function — tsx/esbuild
 * injects a `__name` helper into named arrows that does not exist in the page.
 */
const IDENTITY_JS = `(() => new Promise(function (resolve) {
  var announced = []
  function onA (e) {
    var d = e.detail || {}, i = d.info || {}
    announced.push({
      rdns: i.rdns, name: i.name,
      flags: d.provider ? Object.keys(d.provider).filter(function (k) { return /^is[A-Z]/.test(k) }).sort() : []
    })
  }
  window.addEventListener('eip6963:announceProvider', onA)
  window.dispatchEvent(new Event('eip6963:requestProvider'))

  setTimeout(function () {
    window.removeEventListener('eip6963:announceProvider', onA)
    var eth = window.ethereum
    var slot = null
    if (eth) {
      slot = {
        flags: Object.keys(eth).filter(function (k) { return /^is[A-Z]/.test(k) }).sort(),
        hasProvidersArray: Array.isArray(eth.providers),
        // If a multiplexer is present, the array is the real story: it says who
        // is queued behind the slot and in what order.
        providers: Array.isArray(eth.providers)
          ? eth.providers.map(function (p) {
              return Object.keys(p).filter(function (k) { return /^is[A-Z]/.test(k) }).sort()
            })
          : null
      }
    }
    resolve({
      announced: announced.sort(function (a, b) { return (a.rdns || '').localeCompare(b.rdns || '') }),
      announcedCount: announced.length,
      slot: slot
    })
  }, 3000)
}))()`

type Reading = {
  announced: { rdns?: string; name?: string; flags: string[] }[]
  announcedCount: number
  slot: { flags: string[]; hasProvidersArray: boolean; providers: string[][] | null } | null
}

async function readOnce(paths: string[], label: string, run: number): Promise<Reading | null> {
  const context = await chromium.launchPersistentContext('', {
    // Fresh profile every time — a reused one carries prior state and this
    // experiment is about a cold start.
    headless: false,
    args: browserArgsForAll(paths),
    viewport: { width: 1100, height: 800 },
  })
  try {
    // Extensions need a beat to register their service workers before a page
    // load will see any injection at all.
    await new Promise((r) => setTimeout(r, 4000))
    const page = await context.newPage()
    await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})

    const reading = (await Promise.race([
      page.evaluate(IDENTITY_JS),
      new Promise((r) => setTimeout(() => r(null), 20_000)),
    ])) as Reading | null

    await page
      .screenshot({ path: path.join(OUT, `${label}-run${run}.png`) })
      .catch(() => {})
    return reading
  } finally {
    await context.close().catch(() => {})
  }
}

/** A short, comparable signature — this is what gets compared across runs. */
function signature(r: Reading | null): string {
  if (!r) return 'NO READING'
  const slot = r.slot ? r.slot.flags.join('+') || '(no is* flags)' : 'NO window.ethereum'
  const arr = r.slot?.providers ? ` providers=[${r.slot.providers.map((p) => p.join('+')).join(' | ')}]` : ''
  return `slot=${slot}${arr} announced=${r.announced.map((a) => a.rdns).join(',') || 'none'}`
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true })

  // A LIST of resolved wallets, not a Record keyed by name.
  //
  // The first draft used `Record<string, string>` and indexed straight into it.
  // Under this repo's `noUncheckedIndexedAccess: true` that yields
  // `string | undefined`, and tsc produced 14 errors — all one root cause.
  // Casting them away with `as string` would have silenced the exact flag that
  // exists to catch "I assumed this key was there", which is the same shape of
  // assumption this whole probe was written to test. So: carry the path with
  // the name, and let `find` narrow honestly.
  type Wallet = { name: string; path: string }
  const available: Wallet[] = []
  for (const [name, resolve] of [
    ['metamask', metamaskExtensionPath],
    ['rabby', rabbyExtensionPath],
    ['phantom', phantomExtensionPath],
  ] as const) {
    try {
      available.push({ name, path: resolve() })
    } catch {
      console.log(`  (${name} not fetched — skipping any config that needs it)`)
    }
  }

  const find = (n: string): Wallet | undefined => available.find((w) => w.name === n)
  const configs: { label: string; paths: string[]; note: string }[] = []

  // Baselines first. Without them a combined reading cannot be attributed.
  for (const w of available) {
    configs.push({ label: `solo-${w.name}`, paths: [w.path], note: `${w.name} alone` })
  }

  // Then the ordered pairs. Same two wallets, order reversed: the whole point.
  const addPair = (aName: string, bName: string, label: string, note: string): void => {
    const a = find(aName)
    const b = find(bName)
    if (a && b) configs.push({ label, paths: [a.path, b.path], note })
  }
  addPair('metamask', 'phantom', 'pair-mm-then-phantom', 'MetaMask listed FIRST')
  addPair('phantom', 'metamask', 'pair-phantom-then-mm', 'Phantom listed FIRST')
  addPair('metamask', 'rabby', 'pair-mm-then-rabby', 'MetaMask listed FIRST')
  addPair('rabby', 'metamask', 'pair-rabby-then-mm', 'Rabby listed FIRST')

  if (!configs.some((c) => c.label.startsWith('pair-'))) {
    console.error('\nNeed at least TWO wallets fetched to test order. Run the fetch scripts first.')
    process.exit(1)
  }

  console.log(`origin=${ORIGIN}  repeats=${REPEATS}  configs=${configs.length}\n`)
  // A Map, for the same reason: `.get()` returns `T | undefined` and the code
  // has to say what it does about that, rather than indexing and hoping.
  const results = new Map<string, string[]>()

  for (const cfg of configs) {
    console.log(`=== ${cfg.label} — ${cfg.note}`)
    const sigs: string[] = []
    results.set(cfg.label, sigs)
    for (let run = 1; run <= REPEATS; run++) {
      const reading = await readOnce(cfg.paths, cfg.label, run)
      const sig = signature(reading)
      sigs.push(sig)
      console.log(`  run ${run}: ${sig}`)
      fs.writeFileSync(
        path.join(OUT, `${cfg.label}-run${run}.json`),
        JSON.stringify(reading, null, 2),
      )
    }
    const distinct = new Set(sigs)
    console.log(distinct.size === 1 ? '  -> STABLE across repeats' : `  -> UNSTABLE: ${distinct.size} different answers`)
    console.log('')
  }

  fs.writeFileSync(
    path.join(OUT, 'summary.json'),
    JSON.stringify(Object.fromEntries(results), null, 2),
  )

  // ---- the verdict, stated so it cannot be misremembered -------------------
  console.log('================ VERDICT ================')
  const unstable = [...results.entries()].filter(([, v]) => new Set(v).size > 1)
  if (unstable.length) {
    console.log('RACE, not order.')
    console.log(`  ${unstable.map(([k]) => k).join(', ')} gave different answers across identical runs.`)
    console.log('  A configuration that changes its own answer cannot be evidence that ORDER decides.')
    console.log('  Report this as non-deterministic, which is a stronger finding than either.')
  }
  // `as const` so destructuring yields `string`, not `string | undefined`.
  const orderedPairs = [
    ['pair-mm-then-phantom', 'pair-phantom-then-mm'],
    ['pair-mm-then-rabby', 'pair-rabby-then-mm'],
  ] as const
  for (const [a, b] of orderedPairs) {
    const ra = results.get(a)
    const rb = results.get(b)
    if (!ra || !rb) continue
    const sa = new Set(ra)
    const sb = new Set(rb)
    if (sa.size === 1 && sb.size === 1) {
      const same = [...sa][0] === [...sb][0]
      console.log(`\n${a}  vs  ${b}`)
      console.log(`  ${[...sa][0]}`)
      console.log(`  ${[...sb][0]}`)
      console.log(
        same
          ? '  -> SAME. Load order does NOT decide the slot. The "install order" claim is\n' +
            '     NOT supported for this pair and must not be published as written.'
          : '  -> DIFFERENT. Load order DOES change who owns window.ethereum. P2 supported.',
      )
    }
  }
  console.log(`\nEvidence: ${OUT}`)
  console.log('P1 (a wallet setting isMetaMask on its own provider) is settled separately by')
  console.log('the solo-* baselines above and does not depend on any of this.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
