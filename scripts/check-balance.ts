import { createPublicClient, http, formatEther } from 'viem'
import { baseSepolia, sepolia } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import 'dotenv/config'

/**
 * Prints the test wallet's native balance on both testnets.
 *
 * Aave's only live testnet market is BASE Sepolia, so that is the balance that
 * actually matters for the supply/borrow specs — Ethereum Sepolia ETH cannot
 * pay for gas there.
 */
const seedPhrase = process.env.SEED_PHRASE
if (!seedPhrase) {
  console.error('SEED_PHRASE is not set. Copy .env.example to .env first.')
  process.exit(1)
}

const account = mnemonicToAccount(seedPhrase.trim())
console.log(`\nwallet: ${account.address}\n`)

const chains = [
  { chain: baseSepolia, rpc: process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org', needed: true },
  { chain: sepolia, rpc: 'https://ethereum-sepolia-rpc.publicnode.com', needed: false },
]

for (const { chain, rpc, needed } of chains) {
  const client = createPublicClient({ chain, transport: http(rpc) })
  try {
    const balance = await client.getBalance({ address: account.address })
    const eth = formatEther(balance)
    const tag = needed ? '  <-- the one Aave needs' : ''
    console.log(`${chain.name.padEnd(18)} ${eth.padStart(12)} ETH${tag}`)
  } catch (error) {
    console.log(`${chain.name.padEnd(18)} (query failed: ${(error as Error).message.split('\n')[0]})`)
  }
}
console.log()
