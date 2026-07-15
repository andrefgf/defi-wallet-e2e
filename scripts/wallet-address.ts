import { mnemonicToAccount } from 'viem/accounts'
import 'dotenv/config'

/**
 * Prints the address of the test wallet derived from SEED_PHRASE.
 *
 * Useful for funding: paste this into a Sepolia faucet. Derivation is the
 * standard BIP-44 path (m/44'/60'/0'/0/0) — the same account MetaMask shows as
 * "Account 1", regardless of which wallet app generated the phrase.
 *
 * Runs entirely offline. It prints ONLY the public address, never the seed.
 */
const seedPhrase = process.env.SEED_PHRASE

if (!seedPhrase) {
  console.error('SEED_PHRASE is not set. Copy .env.example to .env first.')
  process.exit(1)
}

const account = mnemonicToAccount(seedPhrase.trim())

console.log('\nTest wallet (Account 1)')
console.log(`  address: ${account.address}`)
console.log('\nFund it with free Sepolia ETH, then get Aave test tokens in-app.\n')
