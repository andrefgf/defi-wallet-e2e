import { expect, type BrowserContext, type Page } from '@playwright/test'
import { connect, dashboard, markets, modal } from './selectors'
import * as mm from './metamask-actions'

/**
 * Cross-cutting helpers shared by the specs. Anything dApp-specific that is
 * more than a single locator lives here so specs read as behaviour, not DOM.
 *
 * Note: wallet popups go through `utils/metamask-actions`, not Synpress's
 * MetaMask class — see that file for why.
 */

/** Dismiss Aave's first-load analytics consent prompt, if shown. */
export async function dismissAnalyticsPrompt(page: Page): Promise<void> {
  const optOut = connect.analyticsOptOut(page)
  if (await optOut.isVisible().catch(() => false)) {
    await optOut.click().catch(() => {})
  }
}

/**
 * Connect the wallet to the dApp from a fresh page load: open the wallet
 * picker, choose MetaMask, and approve in the extension popup.
 */
export async function connectWallet(
  page: Page,
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await page.goto('/')
  await page.waitForLoadState('domcontentloaded')

  await dismissAnalyticsPrompt(page)

  await connect.connectWalletButton(page).click()

  const mmOption = connect.metaMaskOption(page)
  await mmOption.waitFor({ state: 'visible', timeout: 15_000 })
  await mmOption.click()

  await mm.connectToDapp(context, extensionId)
}

/** Assert the dApp shows a connected account (a 0x… address in the header). */
export async function expectConnected(page: Page): Promise<void> {
  await expect(connect.accountChip(page)).toBeVisible({ timeout: 30_000 })
}

/**
 * Open the supply modal for an asset, enter an amount, and confirm — handling
 * the optional ERC-20 approval step and the MetaMask confirmation popup.
 */
export async function supply(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  asset: string,
  amount: string,
): Promise<void> {
  await markets.supplyButton(page, asset).click()
  await fillAmount(page, amount)

  // Optional approval step (first-time allowance for this token).
  const approve = modal.approveButton(page)
  if (await approve.isEnabled().catch(() => false)) {
    await approve.click()
    await mm.confirmTransaction(context, extensionId)
  }

  await modal.primaryAction(page, /supply/i).click()
  await mm.confirmTransaction(context, extensionId)
  await expect(modal.successMessage(page)).toBeVisible({ timeout: 60_000 })
  await closeModal(page)
}

/** Borrow an amount of an asset against existing collateral. */
export async function borrow(
  page: Page,
  context: BrowserContext,
  extensionId: string,
  asset: string,
  amount: string,
): Promise<void> {
  await markets.borrowButton(page, asset).click()
  await fillAmount(page, amount)
  await modal.primaryAction(page, /borrow/i).click()
  await mm.confirmTransaction(context, extensionId)
  await expect(modal.successMessage(page)).toBeVisible({ timeout: 60_000 })
  await closeModal(page)
}

async function fillAmount(page: Page, amount: string): Promise<void> {
  const input = modal.amountInput(page)
  await expect(input).toBeVisible()
  await input.fill(amount)
}

async function closeModal(page: Page): Promise<void> {
  const close = modal.closeButton(page)
  if (await close.isVisible().catch(() => false)) {
    await close.click()
  }
}

/**
 * Read the health-factor number from the dashboard, or `null` if absent.
 * Useful for asserting a borrow lowered the factor / a repay raised it.
 */
export async function readHealthFactor(page: Page): Promise<number | null> {
  const el = dashboard.healthFactor(page)
  if (!(await el.isVisible().catch(() => false))) return null
  const text = (await el.innerText()).replace(/[^\d.]/g, '')
  const value = Number.parseFloat(text)
  return Number.isFinite(value) ? value : null
}
