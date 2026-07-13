import type { BrowserContext, Page } from '@playwright/test'

/**
 * MetaMask notification-popup actions, written against the selectors MetaMask
 * 13.13.1 actually ships.
 *
 * WHY THIS FILE EXISTS
 * Synpress 4.1.2 pins MetaMask 13.13.1 but its page objects predate MetaMask's
 * redesign, so several of its APIs are broken against the very build it
 * downloads:
 *
 *   - `connectToDapp()` clicks `[data-testid="page-container-footer-next"]`,
 *     which no longer exists. The confirm button is now `confirm-btn`.
 *   - `switchNetwork()` / `addNetwork()` / `getAccountAddress()` depend on
 *     home-page elements (`network-display`, `address-copy-button-text`) that
 *     the multichain redesign removed entirely.
 *
 * Everything here drives the notification popup (`notification.html`), which is
 * the surface a real user actually confirms things on. MetaMask's modern
 * confirmation UI uses a consistent `confirm-btn` / `cancel-btn` pair across
 * connect, signature, transaction and network-switch prompts.
 *
 * If MetaMask changes again, this is the ONE file to fix.
 */

/** Wait for the MetaMask notification popup and return it, fully rendered. */
export async function getNotificationPage(
  context: BrowserContext,
  extensionId: string,
  timeoutMs = 30_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const page = context
      .pages()
      .find((p) => p.url().startsWith(`chrome-extension://${extensionId}/notification.html`))

    if (page) {
      await page.waitForLoadState('domcontentloaded').catch(() => {})
      // The popup can paint blank on first load; wait for it to actually render.
      for (let attempt = 0; attempt < 10; attempt++) {
        if ((await page.locator('[data-testid]').count()) > 0) return page
        await page.waitForTimeout(500)
      }
      return page
    }

    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  throw new Error(
    'MetaMask notification popup never appeared. Did the dApp actually trigger a wallet request?',
  )
}

/**
 * Click a button in the popup and wait for the popup to close, which is what
 * signals MetaMask has accepted/rejected the request.
 */
async function resolvePopup(
  context: BrowserContext,
  extensionId: string,
  testId: 'confirm-btn' | 'cancel-btn',
): Promise<void> {
  const page = await getNotificationPage(context, extensionId)
  const button = page.getByTestId(testId)

  await button.waitFor({ state: 'visible', timeout: 15_000 })
  await button.click()

  // The popup closes itself once the request is resolved.
  await page.waitForEvent('close', { timeout: 30_000 }).catch(() => {})
}

/** Approve the dApp's "connect wallet" request. */
export async function connectToDapp(context: BrowserContext, extensionId: string): Promise<void> {
  await resolvePopup(context, extensionId, 'confirm-btn')
}

/** Reject the dApp's "connect wallet" request. */
export async function rejectConnection(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolvePopup(context, extensionId, 'cancel-btn')
}

/** Confirm a pending transaction. */
export async function confirmTransaction(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolvePopup(context, extensionId, 'confirm-btn')
}

/** Reject a pending transaction (the user clicks "Cancel"). */
export async function rejectTransaction(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolvePopup(context, extensionId, 'cancel-btn')
}

/** Approve a `wallet_switchEthereumChain` request from the dApp. */
export async function approveSwitchNetwork(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolvePopup(context, extensionId, 'confirm-btn')
}

/** Reject a `wallet_switchEthereumChain` request from the dApp. */
export async function rejectSwitchNetwork(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolvePopup(context, extensionId, 'cancel-btn')
}

/** True if MetaMask currently has a pending request popup open. */
export async function hasPendingPopup(
  context: BrowserContext,
  extensionId: string,
): Promise<boolean> {
  return context
    .pages()
    .some((p) => p.url().startsWith(`chrome-extension://${extensionId}/notification.html`))
}
