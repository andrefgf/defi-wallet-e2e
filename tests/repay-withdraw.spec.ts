import { test, expect } from '../fixtures/metamask'
import { dashboard, modal } from '../utils/selectors'
import { connectWallet, expectConnected, readHealthFactor } from '../utils/helpers'
import * as mm from '../utils/metamask-actions'

/**
 * Phase 2 — happy path: repay the loan, then withdraw collateral.
 *
 * Serial, and assumes the open position created by supply-borrow.spec.ts.
 * Repaying raises the health factor; a full repay + withdraw returns the wallet
 * to a clean state.
 */
const COLLATERAL = process.env.COLLATERAL_ASSET ?? 'DAI'
const BORROW_ASSET = process.env.BORROW_ASSET ?? 'USDC'

test.describe.serial('Repay & withdraw (Aave v3, Sepolia)', () => {
  test('repays the loan and the health factor improves', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    const before = await readHealthFactor(page)

    await dashboard
      .borrowedRow(page, BORROW_ASSET)
      .getByRole('button', { name: /repay/i })
      .click()

    // Repay the full debt.
    await modal.maxButton(page).click()

    // Repaying may need an ERC-20 allowance first.
    const approve = modal.approveButton(page)
    if (await approve.isEnabled().catch(() => false)) {
      await approve.click()
      await mm.confirmTransaction(context, extensionId)
    }

    await modal.primaryAction(page, /repay/i).click()
    await mm.confirmTransaction(context, extensionId)
    await expect(modal.successMessage(page)).toBeVisible({ timeout: 60_000 })

    // Less debt → higher health factor.
    const after = await readHealthFactor(page)
    if (before !== null && after !== null) {
      expect(after).toBeGreaterThan(before)
    }
  })

  test('withdraws collateral and the position closes', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await dashboard
      .suppliedRow(page, COLLATERAL)
      .getByRole('button', { name: /withdraw/i })
      .click()

    await modal.maxButton(page).click()
    await modal.primaryAction(page, /withdraw/i).click()
    await mm.confirmTransaction(context, extensionId)
    await expect(modal.successMessage(page)).toBeVisible({ timeout: 60_000 })

    // After a full withdraw the supplied row for that asset is gone.
    await expect(dashboard.suppliedRow(page, COLLATERAL)).toBeHidden()
  })
})
