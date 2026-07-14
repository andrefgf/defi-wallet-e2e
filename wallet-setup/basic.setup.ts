import { defineWalletSetup } from '@synthetixio/synpress'
import 'dotenv/config'
import { importWallet } from '../utils/onboarding'

/**
 * Import the throwaway test wallet and finish MetaMask's onboarding.
 *
 * Synpress runs this once and caches the resulting browser profile (keyed by a
 * hash of this function), so every test starts from an identical, pre-imported
 * wallet. `defineWalletSetup` is now the ONLY part of Synpress's runtime we
 * still use — it computes that cache key. The wallet driving itself lives in
 * `utils/onboarding.ts` and `utils/metamask-actions.ts`.
 *
 * We do not use Synpress's `MetaMask.importWallet()`: it targets MetaMask
 * 13.13.1, which cannot broadcast transactions on Base Sepolia (see
 * utils/onboarding.ts for the full story).
 *
 * Secrets come from the environment only. The seed phrase must belong to a
 * dedicated, fund-free test wallet — see the README's security notes.
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
    'WALLET_PASSWORD is not set. Copy .env.example to .env and provide a wallet password before building the cache.',
  )
}

export default defineWalletSetup(WALLET_PASSWORD, async (_context, walletPage) => {
  await importWallet(walletPage, SEED_PHRASE, WALLET_PASSWORD)
})
