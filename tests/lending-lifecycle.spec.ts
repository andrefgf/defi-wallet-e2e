import { test, expect } from '../fixtures/metamask'
import { dashboard } from '../utils/selectors'
import {
  connectWallet,
  expectConnected,
  expectOnBaseSepolia,
  supply,
  borrow,
  repay,
  withdraw,
  readHealthFactor,
} from '../utils/helpers'
import { nativeBalance, tokenBalance } from '../utils/onchain'

/**
 * The lending lifecycle against the live Aave v3 market on Base Sepolia:
 * supply collateral → borrow against it → repay → withdraw.
 *
 * Every step is a real on-chain transaction, signed in a real MetaMask popup.
 *
 * SERIAL, and deliberately ONE file: each step depends on the on-chain state the
 * previous one created, and Playwright runs spec *files* alphabetically — split
 * across `supply-borrow` and `repay-withdraw`, the repay would run first and
 * fail on a position that didn't exist yet.
 *
 * Test tokens are a PRECONDITION, not the thing under test. Aave's faucet
 * enforces a mint timelock ("Mint timelock exceeded"), so driving it every run
 * would guarantee flakes. Top up out-of-band instead:
 *
 *     pnpm run wallet:balance     # check
 *     pnpm run mint:tokens        # mint test USDC (subject to the timelock)
 */
const COLLATERAL = 'USDC'
const DEBT = process.env.BORROW_ASSET ?? 'USDT'
const SUPPLY_AMOUNT = process.env.SUPPLY_AMOUNT ?? '100'
const BORROW_AMOUNT = process.env.BORROW_AMOUNT ?? '10'
const WITHDRAW_AMOUNT = process.env.WITHDRAW_AMOUNT ?? '25'

test.beforeAll(async () => {
  // Fail fast, with an actionable message, rather than deep inside a wallet flow.
  const gas = await nativeBalance()
  expect(gas, 'test wallet needs Base Sepolia ETH for gas — see README').toBeGreaterThan(0.0005)

  const usdc = await tokenBalance('USDC')
  expect(
    usdc,
    `test wallet needs ${COLLATERAL} to supply — run: pnpm run mint:tokens`,
  ).toBeGreaterThan(Number(SUPPLY_AMOUNT))
})

test.describe.serial('Lending lifecycle (Aave v3, Base Sepolia)', () => {
  test('supplies collateral and opens a position', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)
    await expectOnBaseSepolia(page)

    const before = await tokenBalance('USDC')

    await supply(page, context, extensionId, COLLATERAL, SUPPLY_AMOUNT)

    // UI effect: the asset now shows as a supplied position (aTokens received).
    await expect(dashboard.suppliedRow(page, COLLATERAL)).toBeVisible({ timeout: 60_000 })

    // ON-CHAIN effect: the collateral actually left the wallet. A row in the DOM
    // only proves the frontend rendered; this proves the money moved.
    const after = await tokenBalance('USDC')
    expect(after, 'supplying must reduce the wallet balance on-chain').toBeLessThan(before)

    // Deliberately no health-factor assertion here. It depends on DEBT, not on
    // collateral, and the chain is persistent — a wallet that borrowed in an
    // earlier run still carries a position. Asserting "no health factor" would
    // be asserting the wallet is pristine, which is not what this test is about.
  })

  test('borrows against collateral, lowering the health factor', async ({
    page,
    context,
    extensionId,
  }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    const before = await readHealthFactor(page)

    await borrow(page, context, extensionId, DEBT, BORROW_AMOUNT)

    await expect(dashboard.borrowedRow(page, DEBT)).toBeVisible({ timeout: 60_000 })

    // Debt is what CREATES a health factor — the protocol now has a liquidation
    // threshold to track. This is the number that decides whether a user gets
    // liquidated, so it must exist and the position must be solvent (> 1).
    const after = await readHealthFactor(page)
    expect(after, 'borrowing must produce a health factor').not.toBeNull()
    expect(after!, 'a solvent position must sit above the liquidation threshold').toBeGreaterThan(1)

    // And taking on MORE debt against the same collateral must make the position
    // riskier, not safer. (Only comparable if the wallet already had debt — the
    // chain is persistent, so it might not have.)
    if (before !== null) {
      expect(after!, 'more debt must lower the health factor').toBeLessThan(before)
    }
  })

  test('repays the debt, raising the health factor', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    const before = await readHealthFactor(page)
    expect(before, 'there should be an open debt position to repay').not.toBeNull()

    await repay(page, context, extensionId, DEBT)

    // Repaying REDUCES the debt, which raises the health factor — the position
    // gets safer. That's the property worth asserting.
    //
    // Note we do NOT assert the debt hits exactly zero. Interest accrues from
    // the moment you borrow, so the debt is always a hair larger than the amount
    // received; repaying with the borrowed tokens alone can never quite clear it.
    // A test demanding a zero balance here would be asserting something the
    // protocol cannot do.
    const after = await readHealthFactor(page)

    if (after === null) {
      await expect(dashboard.borrowedRow(page, DEBT)).toBeHidden({ timeout: 60_000 })
    } else {
      expect(after, 'repaying must raise the health factor').toBeGreaterThan(before!)
    }
  })

  test('withdraws collateral back to the wallet', async ({ page, context, extensionId }) => {
    await connectWallet(page, context, extensionId)
    await expectConnected(page)

    const before = await tokenBalance('USDC')

    await withdraw(page, context, extensionId, COLLATERAL, WITHDRAW_AMOUNT)

    // The collateral actually comes back on-chain — read from the node, not the
    // dApp. A partial withdraw, because any outstanding debt caps how much
    // collateral Aave will release (it must stay secured).
    const after = await tokenBalance('USDC')
    expect(after, 'withdrawing must return collateral to the wallet').toBeGreaterThan(before)
  })
})
