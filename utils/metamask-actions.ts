import type { BrowserContext, Page } from '@playwright/test'

/**
 * MetaMask notification-popup actions, written against the selectors MetaMask
 * 13.13.1 actually ships.
 *
 * WHY THIS FILE EXISTS
 * Synpress 4.1.2 pins MetaMask 13.13.1 but its page objects predate MetaMask's
 * redesign, so several of its APIs are broken against the very build it
 * downloads — e.g. `connectToDapp()` clicks `page-container-footer-next`, which
 * no longer exists (it's `confirm-btn` now), and the home-page network/address
 * elements it depends on were deleted outright.
 *
 * HEADED vs HEADLESS
 * MetaMask shows confirmations in a popup *window*. Under `--headless=new` that
 * window is never created, so waiting for it hangs forever — which is exactly
 * why this suite passed locally (headed) and failed in CI (headless). The
 * pending request is still rendered at `notification.html`, so if no popup shows
 * up we simply open that page ourselves. `getNotificationPage` handles both.
 *
 * If MetaMask changes again, this is the ONE file to fix.
 */

function notificationUrl(extensionId: string): string {
  return `chrome-extension://${extensionId}/notification.html`
}

/**
 * MetaMask frequently paints a blank document on first load (reliably so in
 * headless), which makes every locator silently match nothing. Reload until the
 * app actually renders.
 *
 * Every navigation here is explicitly bounded. `page.reload()` with no timeout
 * hangs indefinitely on this page when MetaMask has nothing to show — which ate
 * the entire test budget and looked like a mysterious timeout.
 */
async function waitUntilRendered(page: Page, attempts = 6): Promise<Page> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.waitForTimeout(500)
    if ((await page.locator('[data-testid]').count()) > 0) return page
    await page.reload({ timeout: 5_000 }).catch(() => {})
  }
  return page
}

/** True once MetaMask is showing a request that can be confirmed or rejected. */
async function showsRequest(page: Page): Promise<boolean> {
  return (
    (await page
      .getByTestId('confirm-btn')
      .count()
      .catch(() => 0)) > 0
  )
}

/** False while MetaMask is still an empty shell (no UI rendered yet). */
async function hasRendered(page: Page): Promise<boolean> {
  return (
    (await page
      .locator('[data-testid]')
      .count()
      .catch(() => 0)) > 0
  )
}

/**
 * Return MetaMask's notification page, showing the pending request.
 *
 * Headed: MetaMask opens the popup window itself, so we wait for it.
 * Headless: no window is ever created, so we open `notification.html` directly —
 * MetaMask renders the same pending request there.
 */
export async function getNotificationPage(
  context: BrowserContext,
  extensionId: string,
  timeoutMs = 90_000,
): Promise<Page> {
  const url = notificationUrl(extensionId)

  // Give MetaMask a beat to register the request the dApp just fired.
  await new Promise((resolve) => setTimeout(resolve, 2000))

  // Headed: MetaMask opens the popup window itself.
  const popupDeadline = Date.now() + 5000
  while (Date.now() < popupDeadline) {
    const popup = context.pages().find((p) => p.url().startsWith(url))
    if (popup) {
      const rendered = await waitUntilRendered(popup)
      if (await showsRequest(rendered)) return rendered
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  // Headless: no popup window is ever created, so open the page ourselves.
  //
  // Two traps here, both learned the hard way:
  //
  // 1. `load` NEVER fires on this page, so a default `goto` just burns its
  //    timeout. Wait for `domcontentloaded` instead.
  // 2. MetaMask's notification UI takes ~30s to boot in headless, sitting as an
  //    empty shell first. Reloading while it boots RESTARTS that boot, so an
  //    eager retry loop guarantees it never finishes. Be patient, and only
  //    reload if it's still blank after a long while.
  //
  // Also: never close-and-reopen this page to retry. Closing MetaMask's
  // notification window is how a user *rejects* a request — it would silently
  // kill the very request we're waiting for.
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {})

  const deadline = Date.now() + timeoutMs
  let lastReload = Date.now()

  while (Date.now() < deadline) {
    if (await showsRequest(page)) return page

    await page.waitForTimeout(1000)

    // Only nudge it if it's still an empty shell well past the normal boot time.
    if (Date.now() - lastReload > 45_000 && !(await hasRendered(page))) {
      await page
        .reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
        .catch(() => {})
      lastReload = Date.now()
    }
  }

  await page.close().catch(() => {})
  throw new Error(
    'MetaMask never showed a pending request. Did the dApp actually trigger a wallet request?',
  )
}

/**
 * Click a button in the notification page and wait for the request to resolve.
 *
 * MetaMask closes its own popup window, but a page WE opened (headless) may
 * linger — so close it explicitly. Leaving it open would make the next call
 * think a stale request is still pending.
 */
async function resolveRequest(
  context: BrowserContext,
  extensionId: string,
  testId: 'confirm-btn' | 'cancel-btn',
): Promise<void> {
  const page = await getNotificationPage(context, extensionId)
  const button = page.getByTestId(testId)

  await button.waitFor({ state: 'visible', timeout: 15_000 })
  await button.click()

  // Resolved once MetaMask closes the popup, or the request UI goes away.
  await Promise.race([
    page.waitForEvent('close', { timeout: 15_000 }).catch(() => {}),
    button.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {}),
  ])

  if (!page.isClosed()) await page.close().catch(() => {})
}

/** Approve the dApp's "connect wallet" request. */
export async function connectToDapp(context: BrowserContext, extensionId: string): Promise<void> {
  await resolveRequest(context, extensionId, 'confirm-btn')
}

/** Reject the dApp's "connect wallet" request. */
export async function rejectConnection(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'cancel-btn')
}

/** Confirm a pending transaction. */
export async function confirmTransaction(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'confirm-btn')
}

/** Reject a pending transaction (the user clicks "Cancel"). */
export async function rejectTransaction(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'cancel-btn')
}

/** Approve a `wallet_switchEthereumChain` request from the dApp. */
export async function approveSwitchNetwork(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'confirm-btn')
}

/** Reject a `wallet_switchEthereumChain` request from the dApp. */
export async function rejectSwitchNetwork(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'cancel-btn')
}

/**
 * Does MetaMask have a request waiting for the user?
 *
 * Used to assert the negative: a blocked action must never reach the wallet.
 * Checking `context.pages()` alone would be a false negative in headless (where
 * no popup window is ever created), so we also look at `notification.html`.
 */
export async function hasPendingRequest(
  context: BrowserContext,
  extensionId: string,
): Promise<boolean> {
  const url = notificationUrl(extensionId)

  if (context.pages().some((p) => p.url().startsWith(url))) return true

  const page = await context.newPage()
  try {
    await page.goto(url)
    await waitUntilRendered(page, 3)
    return await showsRequest(page)
  } finally {
    await page.close().catch(() => {})
  }
}
