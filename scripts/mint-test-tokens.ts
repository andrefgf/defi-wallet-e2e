import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits } from 'viem'
import { baseSepolia } from 'viem/chains'
import { mnemonicToAccount } from 'viem/accounts'
import 'dotenv/config'

/**
 * Mint Aave test tokens directly from the faucet contract.
 *
 * The dApp's faucet UI is the "official" route, but it is flaky, and the tests
 * need tokens as a PRECONDITION — not as the thing under test. Minting here
 * keeps the suite's setup deterministic and independent of Aave's faucet page.
 *
 * Testnet play-money only.
 */
// Addresses taken verbatim from the transaction Aave's own faucet page hands to
// MetaMask (captured off eth_sendTransaction), so they can't drift from what
// the dApp actually uses. Lowercase on purpose — these are not checksummed.
const FAUCET = '0xd9145b5f45ad4519c7accd6e0a4a82e83bb8a6dc' as const
const TOKENS = {
  USDC: { address: '0xba50cd2a20f6da35d788639e581bca8d0b5d4d5f', decimals: 6 },
} as const

const FAUCET_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const seedPhrase = process.env.SEED_PHRASE
if (!seedPhrase) {
  console.error('SEED_PHRASE is not set.')
  process.exit(1)
}

const rpc = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://base-sepolia-rpc.publicnode.com'
const account = mnemonicToAccount(seedPhrase.trim())

const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpc) })
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpc) })

const symbol = (process.argv[2] ?? 'USDC').toUpperCase() as keyof typeof TOKENS
const token = TOKENS[symbol]
if (!token) {
  console.error(`Unknown token "${symbol}". Known: ${Object.keys(TOKENS).join(', ')}`)
  process.exit(1)
}

const amount = parseUnits(process.argv[3] ?? '10000', token.decimals)

console.log(`\nwallet : ${account.address}`)
console.log(`faucet : ${FAUCET}`)
console.log(`mint   : ${process.argv[3] ?? '10000'} ${symbol}\n`)

const data = encodeFunctionData({
  abi: FAUCET_ABI,
  functionName: 'mint',
  args: [token.address as `0x${string}`, account.address, amount],
})

try {
  const hash = await wallet.sendTransaction({ to: FAUCET, data })
  console.log(`tx sent: ${hash}`)
  const receipt = await pub.waitForTransactionReceipt({ hash })
  console.log(`status : ${receipt.status}`)
  console.log(`explorer: https://sepolia.basescan.org/tx/${hash}\n`)
  if (receipt.status !== 'success') process.exit(1)
} catch (error) {
  console.error(`\nFAILED: ${(error as Error).message.split('\n').slice(0, 6).join('\n')}\n`)
  process.exit(1)
}
