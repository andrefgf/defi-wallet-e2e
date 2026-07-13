import { test, expect } from '../fixtures/metamask'
import { dashboard, markets, modal } from '../utils/selectors'
import { connectWallet, expectConnected, supply, borrow, readHealthFactor } from '../utils/helpers'
import * as mm from '../utils/metamask-actions'

/**
 * Phase 2 — happy path: supply collateral, then borrow against it.
 *
 * PRECONDITIONS (real on-chain state, not mocked):
 *   - the test wallet holds Sepolia ETH for gas
 *   - it holds Aave faucet tokens (the first test mints them)
 *   - MetaMask is on Sepolia (Aave prompts the switch; we approve it)
 *
 * Serial, because borrow depends on collateral supplied by the preceding test.
 */
const COLLATERAL = process.env.COLLATERAL_ASSET ?? 'DAI'
const BORROW_ASSET = process.env.BORROW_ASSET ?? 'USDC'
const SUPPLY_AMOUNT = process.env.SUPPLY_AMOUNT ?? '100'
const BORROW_AMOUNT = process.env.BORROW_AMOUNT ?? '10'

test.describe.serial('Supply & borrow (Aave v3, Sepolia)', () => {
  test('acquires test tokens from the faucet', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await markets.faucetNavLink(page).click()
    await markets.faucetMintButton(page, COLLATERAL).click()
    await mm.confirmTransaction(context, extensionId)

    await expect(modal.successMessage(page)).toBeVisible({ timeout: 60_000 })
  })

  test('supplies collateral and receives aTokens', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await supply(page, context, extensionId, COLLATERAL, SUPPLY_AMOUNT)

    // On-chain effect: a supplied position (aToken receipt) is now listed.
    await expect(dashboard.yourSupplies(page)).toBeVisible()
    await expect(dashboard.suppliedRow(page, COLLATERAL)).toBeVisible()

    // Supplying collateral establishes a health factor.
    expect(
      await readHealthFactor(page),
      'health factor should exist after supplying collateral',
    ).not.toBeNull()
  })

  test('borrows against collateral and the health factor drops', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    const before = await readHealthFactor(page)

    await borrow(page, context, extensionId, BORROW_ASSET, BORROW_AMOUNT)

    // On-chain effect: a borrowed position is now listed.
    await expect(dashboard.yourBorrows(page)).toBeVisible()
    await expect(dashboard.borrowedRow(page, BORROW_ASSET)).toBeVisible()

    // Borrowing must LOWER the health factor (more debt, same collateral).
    const after = await readHealthFactor(page)
    expect(after, 'health factor should exist after borrowing').not.toBeNull()
    if (before !== null && after !== null) {
      expect(after).toBeLessThan(before)
    }
  })
})
