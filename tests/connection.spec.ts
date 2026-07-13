import { test, expect } from '../fixtures/metamask'
import { connect } from '../utils/selectors'
import { connectWallet, expectConnected, dismissAnalyticsPrompt } from '../utils/helpers'
import * as mm from '../utils/metamask-actions'

/**
 * Phase 1 — wallet connection.
 *
 * Each test starts from the cached, pre-imported wallet (basic.setup.ts), which
 * the fixture unlocks — so these are independent: nothing depends on a previous
 * test's state.
 *
 * Wallet popups go through `utils/metamask-actions` rather than Synpress's
 * MetaMask class, whose selectors are broken against MetaMask 13.13.1.
 */
test.describe('Wallet connection', () => {
  test('cold connect: connects MetaMask to the dApp', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)

    // The dApp reflects a connected account (an 0x… address in the header).
    await expectConnected(page)
  })

  test('rejecting the connection leaves the dApp disconnected', async ({
    page,
    context,
    extensionId,
  }) => {
    await page.goto('/')
    await dismissAnalyticsPrompt(page)

    await connect.connectWalletButton(page).click()
    await connect.metaMaskOption(page).click()

    // Reject in MetaMask instead of approving.
    await mm.rejectConnection(context, extensionId)

    // The dApp must stay disconnected: the "Connect wallet" CTA is still there.
    await expect(connect.connectWalletButton(page)).toBeVisible()
  })

  test('disconnect removes the connected account', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    await connect.openAccountMenu(page).click()
    await connect.disconnectButton(page).click()

    // After disconnect, the "Connect wallet" entry point is back.
    await expect(connect.connectWalletButton(page)).toBeVisible()
  })
})
