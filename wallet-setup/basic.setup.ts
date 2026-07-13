import { defineWalletSetup } from '@synthetixio/synpress'
import { MetaMask } from '@synthetixio/synpress/playwright'
import 'dotenv/config'

/**
 * Basic wallet setup: import the throwaway test wallet and finish onboarding.
 * Synpress runs this once and caches the resulting browser profile (keyed by a
 * hash of this function + the password), so every test starts from an
 * identical, pre-imported wallet.
 *
 * Secrets are read from the environment only — nothing is hardcoded. The seed
 * phrase must belong to a dedicated, fund-free test wallet (see README).
 *
 * NOTE (Synpress 4.1.2 vs MetaMask 13.13.1):
 * Synpress's `importWallet` stops after the analytics opt-out, leaving MetaMask
 * parked on the "Your wallet is ready!" screen (#onboarding/completion). Until
 * that screen is dismissed, onboarding is not marked complete and the wallet
 * home never renders — every later action fails. Synpress defines the selector
 * but never clicks it, so we finish the flow here.
 *
 * We deliberately do NOT call `metamask.addNetwork()` / `switchNetwork()`:
 * MetaMask 13.13.1's redesigned home page has no `[data-testid="network-display"]`
 * element, which those APIs depend on. Sepolia is built into MetaMask, and the
 * dApp requests the network switch itself (approved via the MetaMask popup),
 * which is both the realistic user flow and the one path that still works.
 */
const SEED_PHRASE = process.env.SEED_PHRASE
const WALLET_PASSWORD = process.env.WALLET_PASSWORD

if (!SEED_PHRASE) {
  throw new Error(
    'SEED_PHRASE is not set. Copy .env.example to .env and provide a throwaway test wallet seed phrase before building the cache.',
  )
}

if (!WALLET_PASSWORD) {
  throw new Error(
    'WALLET_PASSWORD is not set. Copy .env.example to .env and provide a throwaway test wallet password before building the cache.',
  )
}

export default defineWalletSetup(WALLET_PASSWORD, async (context, walletPage) => {
  const metamask = new MetaMask(context, walletPage, WALLET_PASSWORD)

  await metamask.importWallet(SEED_PHRASE)

  // Dismiss "Your wallet is ready!" — this is what actually marks onboarding
  // complete and persists it into the cached profile.
  const openWallet = walletPage.getByTestId('onboarding-complete-done')
  if (await openWallet.isVisible().catch(() => false)) {
    await openWallet.click()
    await walletPage.waitForTimeout(2000)
  }

  // MetaMask sometimes follows up with "pin the extension" screens.
  for (const testId of ['pin-extension-next', 'pin-extension-done']) {
    const button = walletPage.getByTestId(testId)
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {})
      await walletPage.waitForTimeout(500)
    }
  }
})
