import { test, expect } from '../../fixtures/metamask'
import { connect } from '../../utils/selectors'
import {
  connectWallet,
  expectConnected,
  dismissAnalyticsPrompt,
} from '../../utils/helpers'
import * as mm from '../../utils/metamask-actions'

/**
 * MATRIX RUNNER — first cells. MetaMask × Aave (Base Sepolia).
 *
 * Each test emits exactly one line for the matrix:
 *
 *     MATRIX: Aave/MetaMask/<flow> = pass | fail | blocked (...)
 *
 * pass/fail are VERDICTS about the dApp×wallet cell, asserted on ground truth
 * (matrix/flows.md). `blocked` means the harness or environment died before a
 * verdict was earned — never record it as fail. This mirrors record.mjs, which
 * treats blocked as "couldn't run", not "wallet broke".
 *
 * Transcribe with:  node record.mjs --dapp Aave --wallet MetaMask --flow X --result Y
 * then:             node build.mjs
 */

const CHAIN = 'base-sepolia'

/** Print an honest `blocked` line when the harness fails before any verdict. */
function matrixCell(flow: string, body: () => Promise<void>) {
  return async () => {
    try {
      await body()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.log(
        `MATRIX: Aave/MetaMask/${flow} = blocked (harness/env, no verdict: ${message.slice(0, 140).replace(/\s+/g, ' ')})`,
      )
      throw error
    }
  }
}

/** Read the account the injected provider is actually authorised for (not the DOM). */
async function authorisedAccount(page: import('@playwright/test').Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      const eth = (window as unknown as { ethereum?: { request(a: unknown): Promise<string[]> } }).ethereum
      if (!eth) return null
      const accounts = await eth.request({ method: 'eth_accounts' })
      return accounts?.[0] ?? null
    })
    .catch(() => null)
}

/**
 * Does the dApp's truncated chip refer to `account`?
 *
 * Aave truncates as `0x<head>…<tail>` and the head length varies by build —
 * observed `0xf3…2266` (2 hex) on Aave/Base Sepolia 2026-07-23. So don't assume
 * a fixed width: pull the hex runs out of the chip and check the full account
 * starts with the first and ends with the last. Robust to any truncation shape.
 */
function chipMatches(chipText: string, account: string): boolean {
  const acc = account.toLowerCase().replace(/^0x/, '')
  const parts = chipText.toLowerCase().replace(/0x/g, '').match(/[0-9a-f]+/g) || []
  const head = parts[0]
  const tail = parts[parts.length - 1]
  // Explicit undefined guard: satisfies noUncheckedIndexedAccess and covers a
  // chip with no hex at all.
  if (!head || !tail) return false
  return acc.startsWith(head) && acc.endsWith(tail)
}

test.describe('Matrix — Aave × MetaMask', () => {
  test('connect', async ({ page, context, extensionId }) => {
    await matrixCell('connect', async () => {
      await connectWallet(page, context, extensionId)
      await expectConnected(page)

      // Ground truth: the dApp's connected account must equal the account the
      // wallet actually authorised — read from the provider, not inferred.
      const account = await authorisedAccount(page)
      expect(account, 'provider reports an authorised account').toBeTruthy()

      const chip = await connect.accountChip(page).innerText().catch(() => '')
      const ok = !!account && chipMatches(chip, account)
      console.log(
        `MATRIX: Aave/MetaMask/connect = ${ok ? 'pass' : 'fail'} (chip="${chip}", account=${account}, chain=${CHAIN})`,
      )
      expect(ok, `dApp chip "${chip}" should reflect authorised account ${account}`).toBe(true)
    })()
  })

  test('reject', async ({ page, context, extensionId }) => {
    await matrixCell('reject', async () => {
      await page.goto('/')
      await dismissAnalyticsPrompt(page)
      await connect.connectWalletButton(page).click()
      await connect.metaMaskOption(page).click()

      await mm.rejectConnection(context, extensionId)

      // PASS = dApp handled the rejection: still disconnected, connect CTA
      // present, no hang, not treated as success.
      const stillDisconnected = await connect
        .connectWalletButton(page)
        .isVisible({ timeout: 15_000 })
        .catch(() => false)
      console.log(`MATRIX: Aave/MetaMask/reject = ${stillDisconnected ? 'pass' : 'fail'} (chain=${CHAIN})`)
      expect(stillDisconnected, 'connect CTA should return after a rejection').toBe(true)
    })()
  })

  test('reconnect', async ({ page, context, extensionId }) => {
    await matrixCell('reconnect', async () => {
      await connectWallet(page, context, extensionId)
      await expectConnected(page)
      const before = await authorisedAccount(page)

      // The whole flow: reload and see whether the dApp restores the session
      // WITHOUT a modal — the Safe #8307 class of bug.
      await page.reload({ waitUntil: 'domcontentloaded' })
      await dismissAnalyticsPrompt(page)

      const reconnected = await connect
        .accountChip(page)
        .isVisible({ timeout: 20_000 })
        .catch(() => false)
      const after = reconnected ? await authorisedAccount(page) : null
      const sameAccount = !!before && before === after

      // pass only if it came back on its own AND to the same account.
      const result = reconnected && sameAccount ? 'pass' : 'fail'
      console.log(
        `MATRIX: Aave/MetaMask/reconnect = ${result} (reconnected=${reconnected}, before=${before}, after=${after}, chain=${CHAIN})`,
      )
      expect(reconnected, 'session should survive a reload with no modal').toBe(true)
      expect(sameAccount, 'reconnect must land on the same account').toBe(true)
    })()
  })
})
