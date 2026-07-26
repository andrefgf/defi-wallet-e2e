import { test } from '../../fixtures/metamask'
import { connect } from '../../utils/selectors'
import {
  capture,
  connectWallet,
  expectConnected,
  dismissAnalyticsPrompt,
} from '../../utils/helpers'
import * as mm from '../../utils/metamask-actions'
import { recoverMessageAddress, stringToHex } from 'viem'
import type { Page } from '@playwright/test'

/**
 * MATRIX RUNNER — MetaMask × Aave (Base Sepolia).
 *
 * Verdict model (matches matrix/flows.md and record.mjs):
 *   pass / fail  — we measured the cell. Test stays GREEN either way; a `fail`
 *                  is a real finding, not a broken test. The MATRIX line carries
 *                  the verdict. Exactly ONE line per cell.
 *   blocked      — we could NOT measure (harness/env). The flow throws; the
 *                  runCell wrapper prints the single blocked line and the
 *                  test goes red. Never recorded as a fail.
 *
 * Transcribe:  node record.mjs --dapp Aave --wallet MetaMask --flow X --result Y
 */

const CHAIN = 'base-sepolia'

/**
 * EIP-6963 identity of the wallet under test.
 *
 * Every cell should resolve its provider by `rdns`, NOT via `window.ethereum`.
 * The legacy slot belongs to whichever extension won the injection race, and it
 * lies: on André's daily browser `window.ethereum` reports `isMetaMask: true`
 * AND `isOneKey: true` at the same time. Today the test profile loads only
 * MetaMask so the two agree — but the moment Rabby joins the matrix they won't,
 * and a cell that trusted the legacy slot would silently measure the wrong
 * wallet. See matrix/data/wallets.csv.
 */
const RDNS = 'io.metamask'

/** Wrap a flow: any throw becomes a single honest `blocked` line + red test. */
async function runCell(flow: string, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ')
    console.log(`MATRIX: Aave/MetaMask/${flow} = blocked (${message.slice(0, 160)})`)
    throw error
  }
}

function verdict(flow: string, result: 'pass' | 'fail', detail: string): void {
  console.log(`MATRIX: Aave/MetaMask/${flow} = ${result} (${detail})`)
}

/** Account the injected provider is authorised for — read from it, not the DOM. */
async function authorisedAccount(page: Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      const eth = (window as unknown as { ethereum?: { request(a: unknown): Promise<string[]> } }).ethereum
      if (!eth) return null
      const accounts = await eth.request({ method: 'eth_accounts' })
      return accounts?.[0] ?? null
    })
    .catch(() => null)
}

/** Does the dApp's truncated chip (e.g. 0xf3…2266, head length varies) refer to `account`? */
function chipMatches(chipText: string, account: string): boolean {
  const acc = account.toLowerCase().replace(/^0x/, '')
  const parts = chipText.toLowerCase().replace(/0x/g, '').match(/[0-9a-f]+/g) || []
  const head = parts[0]
  const tail = parts[parts.length - 1]
  if (!head || !tail) return false
  return acc.startsWith(head) && acc.endsWith(tail)
}

test.describe('Matrix — Aave × MetaMask', () => {
  test('connect', async ({ page, context, extensionId }) => {
    await runCell('connect', async () => {
      await connectWallet(page, context, extensionId)
      await expectConnected(page)

      const account = await authorisedAccount(page)
      const chip = await connect.accountChip(page).innerText().catch(() => '')
      const ok = !!account && chipMatches(chip, account)
      verdict('connect', ok ? 'pass' : 'fail', `chip="${chip}", account=${account}, chain=${CHAIN}`)
    })
  })

  test('sign', async ({ page, context, extensionId }) => {
    await runCell('sign', async () => {
      await connectWallet(page, context, extensionId)
      await expectConnected(page)

      const account = await authorisedAccount(page)
      if (!account) throw new Error('sign: no authorised account after connect')

      // A FRESH message every run, carrying a timestamp nonce.
      //
      // This is the part a mocked provider cannot survive, and it's the whole
      // reason the flow exists. A stub hands back a canned signature; because
      // the message is new on every run and the address is recovered from the
      // signature itself, a canned value recovers to the wrong address (or to
      // nothing) and the cell reads `fail`. The assertion and the signature do
      // not share an assumption — which is exactly what mocked suites cannot say.
      const message = `Prumada wallet-layer matrix — Aave/MetaMask sign check @ ${new Date().toISOString()}`
      const hexMessage = stringToHex(message)

      // personal_sign does not settle until the wallet approves, so DON'T await
      // it yet — the approval is the next step.
      const pending = page.evaluate(
        async ({ rdns, hex, from }) => {
          type Provider = { request(args: unknown): Promise<string> }
          type Announce = { info?: { rdns?: string }; provider?: Provider }

          // Ask every installed wallet to announce itself, then pick ours by rdns.
          const discovered = await new Promise<Provider | null>((resolve) => {
            const onAnnounce = (event: Event) => {
              const detail = (event as CustomEvent).detail as Announce | undefined
              if (detail?.info?.rdns === rdns) resolve(detail.provider ?? null)
            }
            window.addEventListener('eip6963:announceProvider', onAnnounce)
            window.dispatchEvent(new Event('eip6963:requestProvider'))
            setTimeout(() => resolve(null), 2000)
          })

          const legacy = (window as unknown as { ethereum?: Provider }).ethereum
          const provider = discovered ?? legacy
          if (!provider) throw new Error('no injected provider on the page')

          const signature = await provider.request({
            method: 'personal_sign',
            params: [hex, from],
          })
          return { signature, via: discovered ? 'eip6963' : 'window.ethereum' }
        },
        { rdns: RDNS, hex: hexMessage, from: account },
      )

      // Generous budget: the popup has to boot, and MV3 may have to restart and
      // unlock the service worker first (see tests/matrix/STATUS.md).
      await mm.approveFollowUpRequests(context, extensionId, 3, 90_000)
      await capture(page, 'sign — after wallet approval')

      const { signature, via } = await pending

      // GROUND TRUTH: who actually signed, computed from the signature itself.
      // Not "the modal closed", not "a toast appeared".
      const recovered = await recoverMessageAddress({
        message: { raw: hexMessage },
        signature: signature as `0x${string}`,
      })

      const ok = recovered.toLowerCase() === account.toLowerCase()
      verdict(
        'sign',
        ok ? 'pass' : 'fail',
        `recovered=${recovered}, account=${account}, via=${via}, chain=${CHAIN}`,
      )
    })
  })

  test('reject', async ({ page, context, extensionId }) => {
    await runCell('reject', async () => {
      await page.goto('/')
      await dismissAnalyticsPrompt(page)
      await connect.connectWalletButton(page).click()
      await connect.metaMaskOption(page).click()

      await mm.rejectConnection(context, extensionId)

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
      await expectConnected(page)
      const before = await authorisedAccount(page)

      await page.reload({ waitUntil: 'domcontentloaded' })
      await dismissAnalyticsPrompt(page)

      // The account chip is the DEFINITIVE "reconnected" signal. Aave (a wagmi
      // dApp) shows the "Connect wallet" CTA transiently while wagmi rehydrates,
      // then swaps in the chip — so catching the CTA first does NOT mean the
      // session dropped, only that reconnect hasn't finished. Wait for the chip;
      // conclude `dropped` only if it never returns while the CTA is present.
      //
      // Why this matters: two identical CI runs disagreed (restored vs dropped)
      // because the old race broke on whichever of chip/CTA appeared first. The
      // chip is the ground truth; the CTA is noise during rehydration.
      // Actually WAIT for the chip. `isVisible()` ignores its timeout and
      // returns immediately (a point-in-time check) — that no-op made every run
      // read "neither" right after reload, before anything had rendered.
      // `waitFor` blocks until the chip is visible or 30s elapse, which is what
      // "did the session come back?" actually needs.
      const restored = await connect
        .accountChip(page)
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false)
      let outcome: 'restored' | 'dropped' | 'unknown'
      if (restored) {
        outcome = 'restored'
      } else if (await connect.connectWalletButton(page).isVisible().catch(() => false)) {
        // Chip never returned in 30s and the Connect CTA is up → session dropped.
        outcome = 'dropped'
      } else {
        outcome = 'unknown'
      }

      // Always record what the dApp showed after reload (into the HTML report).
      await capture(page, 'reconnect — after reload')

      if (outcome === 'unknown') {
        throw new Error(`reconnect: neither chip nor connect CTA within 30s (before=${before})`)
      }

      const after = outcome === 'restored' ? await authorisedAccount(page) : null
      const sameAccount = !!before && before === after
      const ok = outcome === 'restored' && sameAccount
      verdict(
        'reconnect',
        ok ? 'pass' : 'fail',
        `outcome=${outcome}, before=${before}, after=${after}, chain=${CHAIN}`,
      )
    })
  })
})
