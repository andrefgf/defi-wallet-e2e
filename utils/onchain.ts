import { createPublicClient, http, formatUnits } from 'viem'
import { baseSepolia } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import { BASE_SEPOLIA } from './networks'

/**
 * On-chain reads, straight from the node — independent of the dApp's UI.
 *
 * Asserting a supply worked because a row appeared in the DOM proves the
 * frontend rendered something. Reading the balance from the chain proves the
 * money moved. Where it matters, we do both.
 */

/** Aave's Base Sepolia test tokens, taken from the transactions the dApp signs. */
export const TOKENS = {
  USDC: { address: '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f', decimals: 6 },
} as const

export type TokenSymbol = keyof typeof TOKENS

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const client = createPublicClient({
  chain: baseSepolia,
  transport: http(BASE_SEPOLIA.rpcUrls[0]),
})

/** The test wallet's address, derived from the seed (offline). */
export function testWalletAddress(): `0x${string}` {
  const seedPhrase = process.env.SEED_PHRASE
  if (!seedPhrase) throw new Error('SEED_PHRASE is not set.')
  return mnemonicToAccount(seedPhrase.trim()).address
}

/** Native (gas) balance of the test wallet, in ETH. */
export async function nativeBalance(): Promise<number> {
  const wei = await client.getBalance({ address: testWalletAddress() })
  return Number(formatUnits(wei, 18))
}

/** ERC-20 balance of the test wallet, in whole tokens. */
export async function tokenBalance(symbol: TokenSymbol): Promise<number> {
  const token = TOKENS[symbol]
  const raw = await client.readContract({
    address: token.address as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [testWalletAddress()],
  })
  return Number(formatUnits(raw, token.decimals))
}
