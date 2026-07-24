import { test } from '../../fixtures/metamask'
import { connect } from '../../utils/selectors'
import {
  capture,
  connectWallet,
  expectConnected,
  dismissAnalyticsPrompt,
} from '../../utils/helpers'
import * as mm from '../../utils/metamask-actions'
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
        throw new Error(`reconnect: neither chip nor connect CTA within 45s (before=${before})`)
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
