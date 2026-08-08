import { test, type BrowserContext, type Locator, type Page } from '@playwright/test'
import { connect } from './selectors'
import { dismissAnalyticsPrompt, capture } from './helpers'
import { BASE_SEPOLIA, addChainParams } from './networks'
import { RDNS, evalAddChain, evalChainId } from './provider-eval'
import * as mm from './metamask-actions'
import * as rabby from './rabby-actions'

/**
 * ONE connect path, for every wallet column.
 *
 * WHY THIS EXISTS
 * `matrix/data/results.csv` carries Aave x Rabby x connect as **blocked**, and
 * its note names the reason:
 *
 *   > The shared chain-dialog POLICY is now symmetric (utils/chain-policy.ts),
 *   > but the two wallet columns still run DIFFERENT connect implementations —
 *   > MetaMask goes through helpers.connectWallet, Rabby through a local one —
 *   > and the ORDER in which each fires its Base Sepolia add-chain relative to
 *   > the dApp's own mid-connect chain-switch request has never been
 *   > established. If MetaMask's lands before the dApp's request and Rabby's
 *   > lands after, that is a sequencing artifact of our harness wearing a
 *   > wallet's name.
 *
 * Auditing the two paths on 2026-08-07 found **six** structural differences, not
 * one. Any of them can move a verdict:
 *
 *  1. **An extra approval step.** MetaMask ran
 *     `connectToDapp -> approveFollowUpRequests -> ensureNetwork`. Rabby ran
 *     `connectToDapp -> ensureNetwork`. That middle call is a chance to consume
 *     Aave's own mid-connect Fuji request BEFORE our add-chain goes out. One
 *     column had it; the other did not.
 *  2. **Different settle budgets.** MetaMask polled for 60s, Rabby for 45s.
 *  3. **A legacy fallback on one side only.** MetaMask used
 *     `evalAddChain(RDNS.metamask, …)` from provider-eval, which has **no
 *     `window.ethereum` fallback by design**. Rabby used a hand-inlined string
 *     in the spec doing `var p = chosen || window.ethereum`. Three separate
 *     vendors have now been observed claiming `isMetaMask` on the legacy slot
 *     (OneKey, Rabby, Phantom), so that fallback can silently target the wrong
 *     wallet. Same defect class already found and fixed once in
 *     `authorisedAccount`.
 *  4. **Different provider-resolution waits** before the request is fired.
 *  5. **Different option selectors** — a shared `connect.metaMaskOption` vs an
 *     inline `getByRole(/rabby/i)`.
 *  6. **Two `currentChainId` implementations**, one per spec.
 *
 * THE RULE THIS SERVES — utils/chain-policy.ts, already load-bearing:
 *   ANY harness policy that can change a verdict must be identical across every
 *   column. A per-wallet code path IS a per-wallet measurement bias.
 *
 * MIGRATION ORDER — deliberate, and it matters
 * This module reproduces **the MetaMask path's behaviour**, because that column
 * is 4/4 green and is the only connect implementation known to work end to end.
 * Move Rabby onto it first (its connect cell is already blocked, so there is
 * nothing to lose), read the ordering trace, and only then move MetaMask across
 * as a no-op refactor verified by CI staying 4/4. Changing both at once would
 * leave no way to attribute a regression.
 *
 * Adopting the green column's behaviour is a starting point, NOT a claim that
 * the extra approval step is correct. That is what the trace is for.
 */

// ---------------------------------------------------------------------------
// The driver — the only thing that may differ per wallet
// ---------------------------------------------------------------------------

export interface WalletDriver {
  /** For log lines and verdict notes. */
  readonly name: string
  /** EIP-6963 rdns. Never `window.ethereum` — see provider-eval. */
  readonly rdns: string
  /** How this wallet appears in Aave's wallet list. */
  option(page: Page): Locator
  /** Approve the connection request in the wallet UI. */
  connectToDapp(context: BrowserContext, extensionId: string): Promise<void>
  /**
   * Answer whatever requests are pending.
   *
   * NO chain id parameter, deliberately. Both wallets' `approveFollowUpRequests`
   * have the signature `(context, extensionId, max = 3, firstTimeoutMs = 20_000)`
   * — the third argument is a REQUEST COUNT, not a chain. The first draft of this
   * interface passed `BASE_SEPOLIA.chainId` there, which would have set the loop
   * ceiling to 84,532. Caught by reading the signatures instead of assuming them.
   *
   * The chain guard lives one level down: both implementations call
   * `decideChainDialog(reading, expectedChainIdDec = TARGET_CHAIN_ID)` from
   * utils/chain-policy.ts, and `TARGET_CHAIN_ID === BASE_SEPOLIA.chainId`. So the
   * policy is already shared and already correct — passing it again from here
   * would be a second source of truth for the same value.
   */
  approveFollowUp(context: BrowserContext, extensionId: string): Promise<void>
}

export const metamaskDriver: WalletDriver = {
  name: 'MetaMask',
  rdns: RDNS.metamask,
  option: (page) => connect.metaMaskOption(page),
  connectToDapp: (context, extensionId) => mm.connectToDapp(context, extensionId),
  approveFollowUp: async (context, extensionId) => {
    await mm.approveFollowUpRequests(context, extensionId)
  },
}

export const rabbyDriver: WalletDriver = {
  name: 'Rabby',
  rdns: RDNS.rabby,
  // Aave lists wallets by announced name; Rabby announces as "Rabby Wallet".
  option: (page) => page.getByRole('button', { name: /rabby/i }).first(),
  connectToDapp: (context, extensionId) => rabby.connectToDapp(context, extensionId),
  approveFollowUp: async (context, extensionId) => {
    await rabby.approveFollowUpRequests(context, extensionId)
  },
}

// ---------------------------------------------------------------------------
// The ordering trace — the measurement the blocked cell is waiting on
// ---------------------------------------------------------------------------

/**
 * Wrap every announced provider's `request` so that chain calls are logged.
 *
 * MUST be installed with `page.addInitScript` so it runs BEFORE the dApp's own
 * scripts and sees the announcement first — listeners fire in registration
 * order, so registering at document start puts us ahead of wagmi.
 *
 * Wrapping mutates `e.detail.provider` in place, which is the same object
 * reference wagmi receives, so both Aave's calls and ours land in one log with
 * one clock. That is the point: "who asked for which chain, in what order" has
 * been guessed at twice and measured never.
 *
 * A string, not a function — tsx/esbuild rewrites named arrows to add a
 * `__name` helper that does not exist in the page. Three probes have hit this.
 */
export const CHAIN_REQUEST_HOOK = `(() => {
  window.__chainLog = []
  var t0 = Date.now()
  window.addEventListener('eip6963:announceProvider', function (e) {
    var d = e.detail || {}
    var p = d.provider
    if (!p || p.__chainLogWrapped || typeof p.request !== 'function') return
    p.__chainLogWrapped = true
    var rdns = (d.info && d.info.rdns) || 'unknown'
    var orig = p.request.bind(p)
    p.request = function (args) {
      try {
        var m = args && args.method
        if (m === 'wallet_addEthereumChain' || m === 'wallet_switchEthereumChain') {
          var stack = ''
          try { stack = (new Error()).stack || '' } catch (err) { stack = '' }
          window.__chainLog.push({
            ms: Date.now() - t0,
            method: m,
            rdns: rdns,
            chainId: (args.params && args.params[0] && args.params[0].chainId) || null,
            chainName: (args.params && args.params[0] && args.params[0].chainName) || null,
            // HEURISTIC, and labelled as one. Our calls arrive via
            // page.evaluate, which shows as an eval frame; the dApp's arrive
            // from bundled app code. Good enough to read a timeline, NOT good
            // enough to publish an attribution.
            likelyCaller: /\\beval\\b|<anonymous>/.test(stack) ? 'harness?' : 'dapp?'
          })
        }
      } catch (err) { /* never let logging break a request */ }
      return orig(args)
    }
  })
})()`

export type ChainLogEntry = {
  ms: number
  method: string
  rdns: string
  chainId: string | null
  chainName: string | null
  likelyCaller: string
}

/** Read the timeline back out and print it. Safe on a page without the hook. */
export async function readChainLog(page: Page, label: string): Promise<ChainLogEntry[]> {
  const log = (await page
    .evaluate(`window.__chainLog || []`)
    .catch(() => [])) as ChainLogEntry[]

  console.log(`[chain-order] ${label} — ${log.length} chain request(s)`)
  for (const e of log) {
    console.log(
      `  +${String(e.ms).padStart(6)}ms  ${e.method}  chainId=${e.chainId ?? '-'}` +
        `${e.chainName ? ` (${e.chainName})` : ''}  rdns=${e.rdns}  caller~${e.likelyCaller}`,
    )
  }
  if (!log.length) {
    console.log('  (none — either the hook was not installed via addInitScript, or nothing asked)')
  }
  return log
}

// ---------------------------------------------------------------------------
// The shared flow
// ---------------------------------------------------------------------------

/** Chain id from the ANNOUNCED provider for this wallet. Never the legacy slot. */
export async function currentChainId(page: Page, driver: WalletDriver): Promise<string | null> {
  return (await page.evaluate(evalChainId(driver.rdns)).catch(() => null)) as string | null
}

/**
 * Put the wallet on the target chain.
 *
 * Identical for every wallet. The only per-wallet part is which UI answers the
 * dialog, and that is behind `driver.approveFollowUp`, which already routes
 * through the shared chain policy.
 */
export async function ensureNetwork(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  driver: WalletDriver,
): Promise<void> {
  if ((await currentChainId(page, driver)) === BASE_SEPOLIA.chainIdHex) return

  // Not awaited yet — it settles only once the wallet prompt is answered, which
  // is the next thing we do.
  //
  // evalAddChain resolves the provider by rdns and has NO window.ethereum
  // fallback. The Rabby spec's inlined copy had `chosen || window.ethereum`,
  // which with three vendors now claiming isMetaMask could target any wallet.
  const request = page.evaluate(evalAddChain(driver.rdns, addChainParams())).catch(() => 'failed')

  await driver.approveFollowUp(context, extensionId)

  // BOUNDED. `evaluate` puts no timeout on a returned promise; an unbounded
  // await here is what killed CI #11 at the 60-minute job ceiling with no
  // artifacts. Same 20s on both columns — it used to be 20s vs 20s but the
  // POLL below differed, which is the bit that actually moved verdicts.
  await Promise.race([request, new Promise((r) => setTimeout(r, 20_000))])

  // ONE budget for every column. Was 60s on MetaMask and 45s on Rabby — a 15s
  // difference in how long a column is allowed to succeed is a measurement bias
  // wearing a wallet's name. 60s, the more generous of the two, so the change
  // cannot make a previously-green cell fail for want of time.
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await currentChainId(page, driver)) === BASE_SEPOLIA.chainIdHex) return
    await page.waitForTimeout(1000)
  }

  throw new Error(
    `${driver.name} is not on ${BASE_SEPOLIA.chainName} — it reports ` +
      `${await currentChainId(page, driver)}. Aave shows "Wrong Network" and never ` +
      'renders an account.',
  )
}

/**
 * Connect the wallet to the dApp and land on the target chain.
 *
 * Install `CHAIN_REQUEST_HOOK` with `page.addInitScript` in the fixture before
 * calling this, or the trace will be empty.
 */
export async function connectWallet(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  driver: WalletDriver,
): Promise<void> {
  await test.step(`Connect ${driver.name} to Aave`, async () => {
    await page.goto('/')
    await page.waitForLoadState('domcontentloaded')
    await dismissAnalyticsPrompt(page)

    await connect.connectWalletButton(page).click()

    const option = driver.option(page)
    await option.waitFor({ state: 'visible', timeout: 20_000 })
    await option.click()

    await driver.connectToDapp(context, extensionId)

    // THE STEP RABBY NEVER HAD.
    //
    // Approving the connection is not the end of the handshake: Aave
    // immediately asks the wallet to switch chain, and on a clean profile it
    // asks for Avalanche Fuji (43113) because that is the FIRST entry in its own
    // testnet list and wagmi defaults to it. This consumes that request under
    // the shared chain policy, which declines anything that is not the target.
    //
    // The MetaMask column had this call and was green. The Rabby column did not
    // and its connect cell is blocked. That is the leading hypothesis for the
    // divergence — and it is a HYPOTHESIS until the trace shows the ordering.
    await driver.approveFollowUp(context, extensionId)
  })

  await test.step(`Switch ${driver.name} to ${BASE_SEPOLIA.chainName}`, async () => {
    await ensureNetwork(page, context, extensionId, driver)
  })

  await readChainLog(page, `${driver.name} connect`)
  await capture(page, `1. ${driver.name} connected on ${BASE_SEPOLIA.chainName}`)
}
