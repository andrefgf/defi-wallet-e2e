import { test, expect } from '../fixtures/metamask'
import { dashboard, modal, nav, network } from '../utils/selectors'
import {
  connectWallet,
  connectWalletWithoutNetworkSwitch,
  expectConnected,
} from '../utils/helpers'
import * as mm from '../utils/metamask-actions'
import { tokenBalance } from '../utils/onchain'

/**
 * Edge cases & failure modes — the part that signals real QA.
 *
 * Each test asserts the CORRECT failure: the right message, a blocked action,
 * or unchanged state. Not merely that "something happened". On flows where a
 * mistake is irreversible and expensive, that distinction is the whole job.
 */
const COLLATERAL = process.env.COLLATERAL_ASSET ?? 'USDC'

test.describe('Edge cases & failure modes', () => {
  test('rejecting the transaction in MetaMask leaves state unchanged', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await nav.dashboard(page).click()
    await dashboard.supplyButton(page, COLLATERAL).click()
    await modal.amountInput(page).fill('1')
    await modal.actionButton(page).click()

    // Reject in the wallet instead of confirming.
    await mm.rejectTransaction(context, extensionId)

    // The dApp must NOT claim success. No aTokens are minted; the modal stays
    // on its action step rather than advancing to "All done".
    await expect(modal.success(page)).toBeHidden()
    await expect(modal.actionButton(page)).toBeVisible()
  })

  test('supplying more than the wallet holds is capped at the balance', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    const walletBalance = await tokenBalance('USDC')

    await nav.dashboard(page).click()
    await dashboard.supplyButton(page, COLLATERAL).click()

    // Ask for wildly more than the wallet holds.
    await modal.amountInput(page).fill('999999999')

    // Aave doesn't reject this with an error — it CLAMPS the field to the
    // wallet balance, so an impossible amount can never be submitted in the
    // first place. That's the guard, and it's the thing worth asserting: a UI
    // that accepted the number and let the chain revert would have cost the
    // user gas to learn what the frontend already knew.
    const entered = Number((await modal.amountInput(page).inputValue()).replace(/,/g, ''))

    expect(entered, 'the amount must be capped, not zeroed').toBeGreaterThan(0)
    expect(
      entered,
      'the field must be capped at the wallet balance, never above it',
    ).toBeLessThanOrEqual(walletBalance + 1) // +1 absorbs display rounding

    // And nothing reached the wallet: no transaction was ever offered to sign.
    expect(
      await mm.hasPendingRequest(context, extensionId),
      'clamping happens in the dApp — the wallet must never be asked',
    ).toBe(false)
  })

  test('on the wrong network the dApp disables actions instead of letting them fail', async ({
    page,
    context,
    extensionId,
  }) => {
    // Connect WITHOUT forcing the network: Aave leaves the wallet on whatever
    // chain it picked (we've watched it choose Avalanche Fuji), which is not
    // this market's chain.
    await connectWalletWithoutNetworkSwitch(page, context, extensionId)
    await expectConnected(page)

    await nav.faucet(page).click()
    await page.locator(`[data-cy="faucetListItem_${COLLATERAL}"] button`).first().click()

    // Aave must surface the wrong network AND refuse to act — not submit a
    // transaction that would fail on-chain and cost the user gas.
    await expect(network.wrongNetworkBanner(page)).toBeVisible({ timeout: 30_000 })
    await expect(modal.actionButton(page)).toBeDisabled()
  })
})
