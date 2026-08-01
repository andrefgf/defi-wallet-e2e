/**
 * In-page provider resolution — ONE implementation, every wallet.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 *
 * "Resolve the provider by EIP-6963 `rdns`, never by `window.ethereum`" is the
 * first rule in the published methodology. It was also, until today, applied
 * inconsistently — the rule was written in four places and implemented in three
 * different ways:
 *
 *   - the Rabby spec's `currentChainId`      → rdns  ✓
 *   - the Rabby spec's `authorisedAccount`   → window.ethereum  ✗ (fixed)
 *   - `helpers.currentChainId`               → window.ethereum  ✗
 *   - `helpers.ensureNetwork`'s add-chain    → window.ethereum  ✗
 *
 * None of that failed. The two providers agreed often enough that nothing went
 * red, and the wrong ones were only caught when a probe showed they are
 * DIFFERENT OBJECTS on the dApp under test — at which point "which one did we
 * ask" stopped being a detail.
 *
 * A rule stated in prose and implemented per-call-site is not a rule, it is a
 * hope. These builders exist so there is exactly one way to reach a provider,
 * and so a wallet column cannot quietly measure something the other doesn't.
 *
 * ---------------------------------------------------------------------------
 * WHY STRINGS AND NOT FUNCTIONS
 * ---------------------------------------------------------------------------
 *
 * `page.evaluate` bodies are passed as plain strings on purpose. tsx/esbuild
 * injects a `__name` helper into named arrow functions, which is not defined in
 * the page context, and the evaluate dies with `__name is not defined`. Strings
 * are immune. Do not "tidy" these into arrow functions.
 */

/** Every wallet the matrix knows how to drive, by its announced identity. */
export const RDNS = {
  metamask: 'io.metamask',
  rabby: 'io.rabby',
  onekey: 'so.onekey.app.wallet',
  phantom: 'app.phantom',
  brave: 'com.brave.wallet',
} as const

export type WalletRdns = (typeof RDNS)[keyof typeof RDNS]

/**
 * Resolve the announced provider for `rdns`, then hand it to `body`.
 *
 * `body` is a JS expression using `p` (the provider, possibly null) and must
 * resolve the outer promise via `resolve(...)`.
 */
function withProvider(rdns: string, body: string, settleMs = 800): string {
  return `(() => new Promise(function (resolve) {
    var chosen = null
    window.addEventListener('eip6963:announceProvider', function (e) {
      if (e.detail && e.detail.info && e.detail.info.rdns === ${JSON.stringify(rdns)}) chosen = e.detail.provider
    })
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(function () {
      var p = chosen
      ${body}
    }, ${settleMs})
  }))()`
}

/**
 * `eth_chainId` from the announced provider.
 *
 * NO `window.ethereum` FALLBACK — deliberately. A fallback is how a cell ends up
 * measuring a provider it did not select while the results file names a wallet.
 * If the wallet under test did not announce, that is a finding, not something to
 * paper over: `null` propagates and the caller reports it.
 */
export function evalChainId(rdns: string): string {
  return withProvider(
    rdns,
    `if (!p) { resolve(null); return }
     p.request({ method: 'eth_chainId' }).then(resolve).catch(function () { resolve(null) })`,
  )
}

/**
 * `eth_accounts` from BOTH the announced provider and the legacy slot.
 *
 * Returns both so a divergence is recorded rather than silently resolved. The
 * verdict must be read from `.rdns`; `.legacy` is evidence.
 */
export function evalAccounts(rdns: string): string {
  return withProvider(
    rdns,
    `function first(x) {
       if (!x) return Promise.resolve(null)
       return x.request({ method: 'eth_accounts' })
         .then(function (a) { return (a && a[0]) || null })
         .catch(function () { return null })
     }
     Promise.all([first(p), first(window.ethereum)]).then(function (r) {
       resolve({ rdns: r[0], legacy: r[1] })
     })`,
  )
}

/**
 * Fire `wallet_addEthereumChain` at the announced provider.
 *
 * Does NOT settle until the wallet dialog is answered — so the caller must
 * approve/decline in parallel and must bound the await. An unbounded await here
 * is what killed CI #11 at the 60-minute job ceiling.
 */
export function evalAddChain(rdns: string, params: unknown): string {
  return withProvider(
    rdns,
    `if (!p) { resolve('no provider'); return }
     p.request({ method: 'wallet_addEthereumChain', params: [${JSON.stringify(params)}] })
       .then(function () { resolve('ok') })
       .catch(function (e) { resolve('rejected: ' + (e && e.message)) })`,
  )
}
