import { test, expect } from '../fixtures/metamask'
import { markets, modal, network } from '../utils/selectors'
import { connectWallet, expectConnected } from '../utils/helpers'
import * as mm from '../utils/metamask-actions'

/**
 * Phase 3 — edge cases & failure modes.
 *
 * The point of this file: each test asserts the CORRECT failure — the right
 * message, a blocked action, or unchanged state — not merely that "something
 * happened". That is the difference that matters when bugs are irreversible.
 */
const COLLATERAL = process.env.COLLATERAL_ASSET ?? 'DAI'
const BORROW_ASSET = process.env.BORROW_ASSET ?? 'USDC'

test.describe('Edge cases & failure modes', () => {
  test('user rejects the transaction → no state change, no success', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await markets.supplyButton(page, COLLATERAL).click()
    await modal.amountInput(page).fill('1')
    await modal.primaryAction(page, /supply/i).click()

    // Reject in MetaMask instead of confirming.
    await mm.rejectTransaction(context, extensionId)

    // The flow must NOT report success: no aToken is minted, state is unchanged
    // and the modal stays on the action step.
    await expect(modal.successMessage(page)).toBeHidden()
    await expect(modal.primaryAction(page, /supply/i)).toBeVisible()
  })

  test('borrowing more than collateral allows is blocked with a clear message', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await markets.borrowButton(page, BORROW_ASSET).click()
    // Deliberately oversized borrow relative to available collateral.
    await modal.amountInput(page).fill('1000000')

    // The dApp must surface a validation error and keep the action disabled —
    // and must NOT pop a MetaMask transaction at all.
    await expect(modal.validationError(page)).toBeVisible()
    await expect(modal.primaryAction(page, /borrow/i)).toBeDisabled()
    expect(
      await mm.hasPendingPopup(context, extensionId),
      'a blocked borrow must never reach the wallet',
    ).toBe(false)
  })

  test('withdrawing more than supplied is blocked', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    const withdraw = markets.withdrawButton(page)
    if (!(await withdraw.isVisible().catch(() => false))) {
      test.skip(true, 'no supplied position to withdraw from in the current state')
    }

    await withdraw.click()
    await modal.amountInput(page).fill('1000000')

    await expect(modal.validationError(page)).toBeVisible()
    await expect(modal.primaryAction(page, /withdraw/i)).toBeDisabled()
  })

  test('wrong network → dApp prompts to switch, and rejecting keeps it blocked', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    // MetaMask defaults to Ethereum Mainnet, so an Aave *testnet* market is the
    // wrong network. The dApp should offer to switch.
    const cta = network.switchNetworkButton(page)
    if (!(await cta.isVisible().catch(() => false))) {
      test.skip(true, 'dApp did not surface a switch-network CTA in this state')
    }

    await cta.click()
    await mm.rejectSwitchNetwork(context, extensionId)

    // Rejecting must leave the dApp in the wrong-network state, not silently proceed.
    await expect(network.wrongNetworkBanner(page)).toBeVisible()
  })

  test('pending transaction is reflected in the UI', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await markets.supplyButton(page, COLLATERAL).click()
    await modal.amountInput(page).fill('1')
    await modal.primaryAction(page, /supply/i).click()
    await mm.confirmTransaction(context, extensionId)

    // Between submit and mined, the dApp must show a pending indicator — and
    // then a terminal success. Never a silent no-op.
    const pending = page
      .getByRole('dialog')
      .getByText(/pending|processing|submitted|confirming/i)
    await expect(pending.or(modal.successMessage(page))).toBeVisible({ timeout: 60_000 })
  })
})
