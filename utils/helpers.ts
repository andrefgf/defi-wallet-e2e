import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { connect, dashboard, modal, nav } from './selectors'
import * as mm from './metamask-actions'
import { BASE_SEPOLIA, addChainParams } from './networks'

/**
 * Behaviour-level helpers. Specs read as user intent; the DOM lives in
 * `selectors.ts` and the wallet popups in `metamask-actions.ts`.
 */

/**
 * Attach a named screenshot to the HTML report.
 *
 * Playwright's trace already snapshots every action, but that's a firehose of
 * DOM diffs. These are the handful of moments a human actually wants to see —
 * "wallet connected", "supply confirmed" — so the report reads as the user's
 * journey rather than a log. Run `pnpm run report` to page through them.
 */
export async function capture(page: Page, name: string): Promise<void> {
  await test
    .info()
    .attach(name, { body: await page.screenshot(), contentType: 'image/png' })
    .catch(() => {}) // a screenshot must never fail the test it documents
}

// --- Network ----------------------------------------------------------------

/** Ask the connected wallet which chain it is on (EIP-1193). */
async function currentChainId(page: Page): Promise<string | null> {
  return page
    .evaluate(async () => {
      const eth = (window as unknown as { ethereum?: { request(a: unknown): Promise<string> } })
        .ethereum
      if (!eth) return null
      return eth.request({ method: 'eth_chainId' })
    })
    .catch(() => null)
}

/**
 * Guarantee MetaMask is on the market's network, adding it if necessary.
 *
 * Not book-keeping — load-bearing. MetaMask doesn't ship with Base Sepolia, and
 * Aave's own switch attempt is unreliable ("We couldn't switch the network
 * automatically"). On the wrong chain the dApp still reports a *connected*
 * account while silently disabling every action, so tests connect happily and
 * then fail somewhere far away. `wallet_addEthereumChain` both adds and offers
 * to switch, so it covers the already-added case too.
 */
export async function ensureNetwork(
  page: Page,
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  if ((await currentChainId(page)) === BASE_SEPOLIA.chainIdHex) return

  // Don't await yet: this promise doesn't settle until the MetaMask prompts it
  // raises are answered, which is what we do next.
  const request = page
    .evaluate(async (params) => {
      const eth = (window as unknown as { ethereum?: { request(a: unknown): Promise<unknown> } })
        .ethereum
      await eth?.request({ method: 'wallet_addEthereumChain', params: [params] }).catch(() => {})
    }, addChainParams())
    .catch(() => {})

  await mm.approveFollowUpRequests(context, extensionId)
  await request

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if ((await currentChainId(page)) === BASE_SEPOLIA.chainIdHex) return
    await page.waitForTimeout(1000)
  }

  throw new Error(
    `Wallet is not on ${BASE_SEPOLIA.chainName} — it reports ${await currentChainId(page)}. ` +
      'Aave will show "Wrong Network" and disable every action.',
  )
}

/** Assert the wallet is on the market's network. */
export async function expectOnBaseSepolia(page: Page): Promise<void> {
  expect(await currentChainId(page), `wallet should be on ${BASE_SEPOLIA.chainName}`).toBe(
    BASE_SEPOLIA.chainIdHex,
  )
}

// --- Connection -------------------------------------------------------------

/** Dismiss Aave's first-load analytics consent prompt, if shown. */
export async function dismissAnalyticsPrompt(page: Page): Promise<void> {
  const optOut = connect.analyticsOptOut(page)
  if (await optOut.isVisible().catch(() => false)) {
    await optOut.click().catch(() => {})
  }
}

/**
 * Connect the wallet, but do NOT force the network.
 *
 * Aave lands the wallet on whatever chain it fancies (we've watched it add
 * Avalanche Fuji), so this leaves the dApp in its natural wrong-network state —
 * which is precisely what the wrong-network edge case needs to observe.
 */
export async function connectWalletWithoutNetworkSwitch(
  page: Page,
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')
  await dismissAnalyticsPrompt(page)

  await connect.connectWalletButton(page).click()

  const mmOption = connect.metaMaskOption(page)
  await mmOption.waitFor({ state: 'visible', timeout: 20_000 })
  await mmOption.click()

  await mm.connectToDapp(context, extensionId)
  await mm.approveFollowUpRequests(context, extensionId)
}

/** Connect the wallet to the dApp and land on the market's network. */
export async function connectWallet(
  page: Page,
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await test.step('Connect MetaMask to Aave', async () => {
    await connectWalletWithoutNetworkSwitch(page, context, extensionId)
  })

  await test.step(`Switch the wallet to ${BASE_SEPOLIA.chainName}`, async () => {
    // Approving the connection is not the end of the handshake: Aave immediately
    // asks the wallet to add Base Sepolia and switch to it.
    await ensureNetwork(page, context, extensionId)
  })

  await capture(page, '1. Wallet connected on Base Sepolia')
}

/** Assert the dApp shows a connected account. */
export async function expectConnected(page: Page): Promise<void> {
  await expect(connect.accountChip(page)).toBeVisible({ timeout: 30_000 })
}

// --- Transaction flows ------------------------------------------------------

/**
 * Run a modal action to completion: click it, approve every MetaMask screen it
 * raises (an ERC-20 flow is approve-then-act: two transactions), and wait for
 * Aave's terminal state.
 *
 * Fails loudly on "Transaction failed" rather than waiting out the timeout, so
 * a reverted transaction reads as a reverted transaction.
 */
/** Click whichever action button Aave currently has enabled. */
async function clickEnabledAction(page: Page): Promise<boolean> {
  const buttons = modal.actionButtons(page)
  const count = await buttons.count().catch(() => 0)

  for (let i = 0; i < count; i++) {
    const button = buttons.nth(i)
    const usable =
      (await button.isVisible().catch(() => false)) && (await button.isEnabled().catch(() => false))
    if (usable) {
      await button.click()
      return true
    }
  }
  return false
}

/** Wait until Aave enables an action, or reaches a terminal state. */
async function waitForEnabledAction(page: Page, timeoutMs = 90_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await modal.success(page).isVisible().catch(() => false)) return false
    if (await modal.failure(page).isVisible().catch(() => false)) return false

    const buttons = modal.actionButtons(page)
    const count = await buttons.count().catch(() => 0)
    for (let i = 0; i < count; i++) {
      const button = buttons.nth(i)
      if (
        (await button.isVisible().catch(() => false)) &&
        (await button.isEnabled().catch(() => false))
      ) {
        return true
      }
    }
    await page.waitForTimeout(1000)
  }
  return false
}

async function submitModalAction(
  page: Page,
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  // An ERC-20 flow is TWO on-chain transactions, and Aave renders them as two
  // buttons stacked in the same modal — "Approve USDC to continue" (enabled) and
  // "Supply USDC" (disabled until the allowance lands). Only one is ever usable
  // at a time, and the enabled one is NOT necessarily the last in the DOM.
  // So: click whichever is live, sign it, wait for the next to wake up, repeat.
  for (let step = 0; step < 3; step++) {
    if (!(await waitForEnabledAction(page))) break

    await clickEnabledAction(page)
    await mm.approveFollowUpRequests(context, extensionId)
  }

  await expect(modal.success(page).or(modal.failure(page))).toBeVisible({ timeout: 180_000 })
  await expect(modal.failure(page), 'the transaction reverted on-chain').toBeHidden()
}

async function closeModal(page: Page): Promise<void> {
  const close = modal.closeButton(page)
  if (await close.isVisible().catch(() => false)) {
    await close.click().catch(() => {})
  }
}


/** Supply an asset as collateral. */
export async function supply(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  asset: string,
  amount: string,
): Promise<void> {
  await test.step(`Supply ${amount} ${asset} as collateral`, async () => {
    await nav.dashboard(page).click()
    await dashboard.supplyButton(page, asset).click()
    await modal.amountInput(page).fill(amount)
    await capture(page, `2. Supply ${amount} ${asset} — before signing`)

    await submitModalAction(page, context, extensionId)
    await capture(page, `3. Supply ${asset} — confirmed on-chain`)
    await closeModal(page)
  })
}

/** Borrow an asset against existing collateral. */
export async function borrow(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  asset: string,
  amount: string,
): Promise<void> {
  await test.step(`Borrow ${amount} ${asset}`, async () => {
    await nav.dashboard(page).click()
    await dashboard.borrowButton(page, asset).click()
    await modal.amountInput(page).fill(amount)
    await capture(page, `4. Borrow ${amount} ${asset} — before signing`)

    await submitModalAction(page, context, extensionId)
    await capture(page, `5. Borrow ${asset} — confirmed on-chain`)
    await closeModal(page)
  })
}

/** Repay borrowed debt. */
export async function repay(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  asset: string,
): Promise<void> {
  await test.step(`Repay the ${asset} debt`, async () => {
    await nav.dashboard(page).click()
    await dashboard.repayButton(page, asset).click()
    await modal.maxButton(page).click()
    await capture(page, `6. Repay ${asset} — before signing`)

    await submitModalAction(page, context, extensionId)
    await capture(page, `7. Repay ${asset} — confirmed on-chain`)
    await closeModal(page)
  })
}

/**
 * Withdraw supplied collateral.
 *
 * Takes an explicit amount rather than clicking MAX: while any debt is
 * outstanding, Aave caps what may be withdrawn (pulling all the collateral
 * would leave the loan unsecured), so a MAX withdraw is not generally
 * available mid-position.
 */
export async function withdraw(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  asset: string,
  amount: string,
): Promise<void> {
  await test.step(`Withdraw ${amount} ${asset}`, async () => {
    await nav.dashboard(page).click()
    await dashboard.withdrawButton(page, asset).click()
    await modal.amountInput(page).fill(amount)
    await capture(page, `8. Withdraw ${amount} ${asset} — before signing`)

    await submitModalAction(page, context, extensionId)
    await capture(page, `9. Withdraw ${asset} — confirmed on-chain`)
    await closeModal(page)
  })
}

/**
 * Health factor from the dashboard, or `null` when there isn't one.
 *
 * `null` is a real state, not a failure: with no debt the health factor is
 * infinite, and Aave simply doesn't render it. It only appears once you borrow —
 * which is exactly what makes it worth asserting on either side of a borrow.
 *
 * Read from the page text rather than a hook: the panel's `data-cy` only exists
 * while a position does, so a locator-based read can't distinguish "no health
 * factor" from "selector is wrong".
 */
export async function readHealthFactor(page: Page): Promise<number | null> {
  const text = await page.locator('body').innerText().catch(() => '')
  const match = text.match(/health factor[^\d]*(\d+(?:\.\d+)?)/i)
  if (!match?.[1]) return null

  const value = Number.parseFloat(match[1])
  return Number.isFinite(value) ? value : null
}
