import { test } from '../../fixtures/rabby'
import { connect } from '../../utils/selectors'
import { capture, dismissAnalyticsPrompt } from '../../utils/helpers'
import * as rabby from '../../utils/rabby-actions'
import { BASE_SEPOLIA } from '../../utils/networks'
import { recoverMessageAddress, stringToHex } from 'viem'
import type { Page } from '@playwright/test'
import {
  rabbyDriver,
  connectWallet as sharedConnectWallet,
  ensureNetwork as sharedEnsureNetwork,
  currentChainId as sharedCurrentChainId,
} from '../../utils/connect-flow'

/**
 * MATRIX RUNNER — Rabby × Aave (Base Sepolia).
 *
 * Same verdict model as `aave.metamask.spec.ts`:
 *   pass / fail  — we measured the cell. Test stays GREEN either way; a `fail`
 *                  is a finding, not a broken test.
 *   blocked      — we could NOT measure. The flow throws, runCell prints one
 *                  honest blocked line, the test goes red. Never a `fail`.
 *
 * FIRST RUN EXPECTATIONS. This has never executed. The connect and reject paths
 * use selectors verified by `scripts/probe-rabby-approval.ts` ("Connect" /
 * "Cancel" on notification.html#/approval). The SIGN path has never been
 * observed in Rabby — `rabby-actions.CONFIRM_LABELS` carries "Sign"/"Confirm"
 * as candidates from the shipped locale file. If sign comes back `blocked`,
 * that is the expected failure, not a surprise: probe it, then prune the list.
 *
 * Transcribe:  node record.mjs --dapp Aave --wallet Rabby --flow X --result Y
 */

const CHAIN = 'base-sepolia'

/**
 * Rabby's EIP-6963 identity, verified by console probe 2026-07-26.
 *
 * This is why the matrix resolves providers by rdns. On André's own machine
 * `window.ethereum` reported isMetaMask AND isRabby simultaneously — a cell
 * trusting the legacy slot would silently measure whichever extension won the
 * injection race.
 */
const RDNS = 'io.rabby'

async function runCell(flow: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')
    console.log(`MATRIX: Aave/Rabby/${flow} = blocked (${message.slice(0, 160)})`)
    throw error
  }
}

function verdict(flow: string, result: 'pass' | 'fail', detail: string): void {
  console.log(`MATRIX: Aave/Rabby/${flow} = ${result} (${detail})`)
}

/**
 * Account the EIP-6963 provider is authorised for — read from it, not the DOM.
 *
 * FIXED 2026-07-30. This function read `window.ethereum` while its own docblock,
 * the file header, and `matrix/METHODOLOGY.md` §1 all state that verdicts are
 * read from the provider whose `rdns` matches the wallet under test. Every
 * other resolver in this file (`currentChainId`, `ensureNetwork`, the sign
 * cell) already did the rdns dance; this one did not.
 *
 * It went unnoticed while the two happened to agree. `probe-rabby-connect-event`
 * then reported `SAME_OBJECT: false` on app.aave.com — the announced provider
 * and the legacy slot are DIFFERENT objects — at which point "which one did we
 * ask" stops being a detail and becomes the whole question. The CI #14 `fail`
 * note quoted an account read from the legacy slot and labelled it "provider
 * account", which is a claim the harness had not actually measured.
 *
 * Returns both, so a divergence is recorded rather than silently resolved.
 */
async function authorisedAccounts(
  page: Page,
): Promise<{ rdns: string | null; legacy: string | null }> {
  return page
    .evaluate(
      `(() => new Promise(function (resolve) {
        var chosen = null
        window.addEventListener('eip6963:announceProvider', function (e) {
          if (e.detail && e.detail.info && e.detail.info.rdns === ${JSON.stringify(RDNS)}) chosen = e.detail.provider
        })
        window.dispatchEvent(new Event('eip6963:requestProvider'))
        setTimeout(function () {
          function first(p) {
            if (!p) return Promise.resolve(null)
            return p.request({ method: 'eth_accounts' })
              .then(function (a) { return (a && a[0]) || null })
              .catch(function () { return null })
          }
          Promise.all([first(chosen), first(window.ethereum)]).then(function (r) {
            resolve({ rdns: r[0], legacy: r[1] })
          })
        }, 800)
      }))()`,
    )
    .then((v) => (v as { rdns: string | null; legacy: string | null }) ?? { rdns: null, legacy: null })
    .catch(() => ({ rdns: null, legacy: null }))
}

/**
 * The account, from the provider the matrix says it measures.
 *
 * The sign and reconnect cells call this. They were reading `window.ethereum`
 * too, via the old implementation — so this wrapper is not sugar, it is the fix
 * arriving at three more call sites.
 */
async function authorisedAccount(page: Page): Promise<string | null> {
  return (await authorisedAccounts(page)).rdns
}

/** Does the dApp's truncated chip (0xb1…c171, head length varies) refer to `account`? */
function chipMatches(chipText: string, account: string): boolean {
  const acc = account.toLowerCase().replace(/^0x/, '')
  const parts = chipText.toLowerCase().replace(/0x/g, '').match(/[0-9a-f]+/g) || []
  const head = parts[0]
  const tail = parts[parts.length - 1]
  if (!head || !tail) return false
  return acc.startsWith(head) && acc.endsWith(tail)
}

/**
 * Connect Rabby to Aave.
 *
 * Not reusing `helpers.connectWallet` — that one calls into `metamask-actions`
 * throughout. Kept local and explicit until both wallets are green, at which
 * point the shared parts can be lifted with tests standing behind the change.
 */
// --- THE THREE SHARED FUNCTIONS ------------------------------------------
//
// These were three LOCAL implementations that diverged from the MetaMask
// column's in six ways (see utils/connect-flow.ts for the audit). That
// divergence is why `Aave x Rabby x connect` sits at `blocked` rather than
// carrying a verdict: a per-wallet code path is a per-wallet measurement bias,
// and chain-policy.ts's rule already covers it —
//
//   ANY harness policy that can change a verdict must be identical across
//   every column.
//
// Kept as thin wrappers so every call site below is untouched: the diff is the
// implementation, not the spec. The wallet-specific parts live in `rabbyDriver`.
async function currentChainId(page: Page): Promise<string | null> {
  return sharedCurrentChainId(page, rabbyDriver)
}

async function ensureNetwork(
  page: Page,
  context: import('@playwright/test').BrowserContext,
  extensionId: string,
): Promise<void> {
  return sharedEnsureNetwork(page, context, extensionId, rabbyDriver)
}

async function connectWallet(
  page: Page,
  context: import('@playwright/test').BrowserContext,
  extensionId: string,
): Promise<void> {
  return sharedConnectWallet(page, context, extensionId, rabbyDriver)
}

/**
 * NO RETRIES on matrix cells.
 *
 * A cell verdict is a measurement, not a flaky assertion. Retrying a `blocked`
 * cell doubles the runtime and produces the same answer — and in CI #11 that
 * doubling is what turned a slow run into a 60-minute job kill. If a cell is
 * unstable, that instability IS the finding and belongs in the notes.
 */
test.describe.configure({ retries: 0 })

test.describe('Matrix — Aave × Rabby', () => {
  test('connect', async ({ page, context, extensionId }) => {
    await runCell('connect', async () => {
      await connectWallet(page, context, extensionId)

      // MEASURE THE PROVIDER FIRST, then the dApp. Order matters.
      //
      // The earlier version waited on the account chip and THREW when it never
      // appeared, so every run recorded `blocked` — "we couldn't measure". That
      // was wrong. We *can* measure: if the provider reports an authorised
      // account on the correct chain and Aave still shows no account, that is a
      // real, measured divergence between wallet and dApp, and `fail` is the
      // honest verdict. `blocked` would be hiding a finding behind a harness
      // complaint.
      const accounts = await authorisedAccounts(page)
      const account = accounts.rdns
      const chainId = await currentChainId(page)

      const chipAppeared = await connect
        .accountChip(page)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false)

      const chip = chipAppeared
        ? await connect.accountChip(page).innerText().catch(() => '')
        : ''

      await capture(page, 'rabby connect — final dApp state')

      // Do the two providers agree? On app.aave.com they are different objects
      // (probe-rabby-connect-event, 2026-07-30). If they also report different
      // accounts, the story is provider identity — not the wallet, not the dApp
      // — and any note naming a vendor would be wrong. Record it either way.
      const divergent = accounts.rdns !== accounts.legacy
      const providers =
        `rdns[${RDNS}]=${accounts.rdns ?? 'none'}, window.ethereum=${accounts.legacy ?? 'none'}` +
        (divergent ? ' — PROVIDERS DISAGREE' : '')

      if (!account) {
        // No authorised account on the provider we actually selected.
        throw new Error(
          `connect: ${RDNS} provider reports no authorised account (${providers}, chain=${chainId})`,
        )
      }

      const ok = chipAppeared && chipMatches(chip, account)
      verdict(
        'connect',
        ok ? 'pass' : 'fail',
        ok
          ? `chip="${chip}", account=${account}, ${providers}, chain=${CHAIN}`
          : `WALLET AUTHORISED BUT DAPP SHOWS NO ACCOUNT — ${providers}, ` +
            `chainId=${chainId} (expected ${BASE_SEPOLIA.chainIdHex}), chipVisible=${chipAppeared}, chain=${CHAIN}`,
      )
    })
  })

  test('sign', async ({ page, context, extensionId }) => {
    await runCell('sign', async () => {
      await connectWallet(page, context, extensionId)
      // Chip is not a precondition for signing — the provider is. Don't block a
      // measurable cell on the dApp's UI.
      await connect
        .accountChip(page)
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {})

      const account = await authorisedAccount(page)
      if (!account) throw new Error('sign: no authorised account after connect')

      // Fresh message per run. A canned signature from a mocked provider
      // recovers to the wrong address, so this cell cannot be faked.
      const message = `Prumada wallet-layer matrix — Aave/Rabby sign check @ ${new Date().toISOString()}`
      const hexMessage = stringToHex(message)

      const pending = page.evaluate(
        `(() => {
          var rdns = ${JSON.stringify(RDNS)}
          var hex = ${JSON.stringify(hexMessage)}
          var from = ${JSON.stringify(account)}
          return new Promise(function (resolve) {
            var chosen = null
            function onAnnounce(e) {
              if (e.detail && e.detail.info && e.detail.info.rdns === rdns) chosen = e.detail.provider
            }
            window.addEventListener('eip6963:announceProvider', onAnnounce)
            window.dispatchEvent(new Event('eip6963:requestProvider'))
            setTimeout(function () {
              var provider = chosen || window.ethereum
              if (!provider) { resolve({ error: 'no provider' }); return }
              provider.request({ method: 'personal_sign', params: [hex, from] })
                .then(function (sig) { resolve({ signature: sig, via: chosen ? 'eip6963' : 'window.ethereum' }) })
                .catch(function (e) { resolve({ error: (e && e.message) || String(e) }) })
            }, 1500)
          })
        })()`,
      )

      await rabby.approveFollowUpRequests(context, extensionId, 3, 60_000)
      await capture(page, 'rabby sign — after approval')

      const result = (await pending) as { signature?: string; via?: string; error?: string }
      if (result.error) throw new Error(`sign: provider rejected or failed — ${result.error}`)
      if (!result.signature) throw new Error('sign: no signature returned')

      const recovered = await recoverMessageAddress({
        message: { raw: hexMessage },
        signature: result.signature as `0x${string}`,
      })

      const ok = recovered.toLowerCase() === account.toLowerCase()
      verdict(
        'sign',
        ok ? 'pass' : 'fail',
        `recovered=${recovered}, account=${account}, via=${result.via}, chain=${CHAIN}`,
      )
    })
  })

  test('reject', async ({ page, context, extensionId }) => {
    await runCell('reject', async () => {
      await page.goto('/')
      await dismissAnalyticsPrompt(page)
      await connect.connectWalletButton(page).click()
      await page.getByRole('button', { name: /rabby/i }).first().click()

      await rabby.rejectConnection(context, extensionId)

      const stillDisconnected = await connect
        .connectWalletButton(page)
        .waitFor({ state: 'visible', timeout: 15_000 })
        .then(() => true)
        .catch(() => false)
      verdict('reject', stillDisconnected ? 'pass' : 'fail', `chain=${CHAIN}`)
    })
  })

  test('reconnect', async ({ page, context, extensionId }) => {
    await runCell('reconnect', async () => {
      await connectWallet(page, context, extensionId)
      await connect
        .accountChip(page)
        .waitFor({ state: 'visible', timeout: 15_000 })
        .catch(() => {})
      const before = await authorisedAccount(page)

      await page.reload({ waitUntil: 'domcontentloaded' })
      await dismissAnalyticsPrompt(page)

      // Chip-first, never isVisible(). Two identical MetaMask CI runs once
      // disagreed (restored vs dropped) because isVisible() ignores its timeout
      // and returns a point-in-time answer during wagmi's rehydration.
      const restored = await connect
        .accountChip(page)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false)

      let outcome: 'restored' | 'dropped' | 'unknown'
      if (restored) {
        outcome = 'restored'
      } else if (await connect.connectWalletButton(page).isVisible().catch(() => false)) {
        outcome = 'dropped'
      } else {
        outcome = 'unknown'
      }

      await capture(page, 'rabby reconnect — after reload')

      if (outcome === 'unknown') {
        throw new Error(`reconnect: neither chip nor connect CTA within 30s (before=${before})`)
      }

      const after = outcome === 'restored' ? await authorisedAccount(page) : null
      const ok = outcome === 'restored' && !!before && before === after
      verdict(
        'reconnect',
        ok ? 'pass' : 'fail',
        `outcome=${outcome}, before=${before}, after=${after}, chain=${CHAIN}`,
      )
    })
  })
})
