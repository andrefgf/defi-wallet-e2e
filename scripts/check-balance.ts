import 'dotenv/config'
import { nativeBalance, tokenBalance, testWalletAddress } from '../utils/onchain'
import { BASE_SEPOLIA } from '../utils/networks'

/**
 * Report the test wallet's balances — and, with `--check`, fail if the suite
 * couldn't actually run.
 *
 * CI uses `--check` as a preflight: a wallet out of gas or out of test tokens
 * should say so in ten seconds, not twenty minutes later from somewhere deep
 * inside a wallet popup.
 */

// Enough for a full lending run (supply, borrow, repay, withdraw). The suite
// nets about -75 USDC per run, so this leaves plenty of headroom.
const MIN_GAS = 0.0005
const MIN_USDC = 200

const enforce = process.argv.includes('--check')

const gas = await nativeBalance()
const usdc = await tokenBalance('USDC')

console.log(`\nwallet : ${testWalletAddress()}`)
console.log(`chain  : ${BASE_SEPOLIA.chainName}\n`)
console.log(`  gas (ETH) : ${gas}`)
console.log(`  USDC      : ${usdc}\n`)

if (!enforce) {
  console.log('Top up: https://www.alchemy.com/faucets/base-sepolia  ·  pnpm run mint:tokens\n')
  process.exit(0)
}

const problems: string[] = []
if (gas < MIN_GAS) {
  problems.push(
    `Out of gas: ${gas} ETH on ${BASE_SEPOLIA.chainName} (need >= ${MIN_GAS}). ` +
      'Top up at https://www.alchemy.com/faucets/base-sepolia',
  )
}
if (usdc < MIN_USDC) {
  problems.push(
    `Not enough test USDC: ${usdc} (need >= ${MIN_USDC}). Run: pnpm run mint:tokens ` +
      "(Aave's faucet enforces a mint timelock, so this may need a retry later).",
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`)
  process.exit(1)
}

console.log('Wallet is funded — the suite can run.\n')
