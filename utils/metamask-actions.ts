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

/**
 * MetaMask uses TWO different button families depending on the screen:
 *
 *   - `confirm-btn` / `cancel-btn`
 *       the permissions screens (connect a dApp)
 *   - `confirm-footer-button` / `confirm-footer-cancel-button`
 *       the newer confirmation screens (transactions, add/switch network)
 *
 * A single flow crosses BOTH: approving a connection to a chain MetaMask
 * doesn't know rolls straight from `confirm-btn` (Connect) into
 * `confirm-footer-button` (add/switch network). Matching only the first family
 * meant we confirmed step one, never found step two, and the dApp waited on
 * "Requesting Connection" forever.
 */
const CONFIRM_TEST_IDS = ['confirm-btn', 'confirm-footer-button'] as const
const CANCEL_TEST_IDS = ['cancel-btn', 'confirm-footer-cancel-button'] as const

function selectorFor(testIds: readonly string[]): string {
  return testIds.map((id) => `[data-testid="${id}"]`).join(', ')
}

function actionButton(page: Page, kind: 'confirm' | 'cancel') {
  const ids = kind === 'confirm' ? CONFIRM_TEST_IDS : CANCEL_TEST_IDS
  return page.locator(selectorFor(ids)).first()
}

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
      .locator(selectorFor(CONFIRM_TEST_IDS))
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
 * Clear MetaMask's "Malicious address" security alert, if it's blocking us.
 *
 * MetaMask's Blockaid scanner has no reputation data for TESTNET contracts, so
 * it flags Aave's perfectly legitimate approval/pool contracts as malicious:
 *
 *   "If you confirm this request, you will probably lose your assets to a
 *    scammer."
 *
 * It then swaps the Confirm button for "Review alert" and refuses to proceed
 * until the risk is explicitly acknowledged — which silently stalls every
 * automated transaction. We tick the acknowledgement and carry on.
 *
 * (This is a false positive on a testnet, with play-money. Do NOT copy this
 * pattern into anything that touches mainnet: there, the alert may well be
 * telling the truth.)
 */
async function dismissSecurityAlert(page: Page): Promise<boolean> {
  // There are TWO gates, back to back:
  //
  //  1. "Malicious address"        → an informational modal with a "Got it".
  //  2. "Your assets may be at risk" → tick an acknowledgement, then press the
  //     Confirm INSIDE that modal. Pressing the footer Confirm just reopens it.
  const gotIt = page.getByRole('button', { name: /got it/i })
  if (await gotIt.isVisible().catch(() => false)) {
    const box = page.locator('input[type="checkbox"]').first()
    if (await box.isVisible().catch(() => false)) await box.check().catch(() => {})

    await gotIt.click().catch(() => {})
    await page.waitForTimeout(1000).catch(() => {})
    return true
  }

  const acknowledge = page
    .locator('[data-testid="alert-modal-acknowledge-checkbox"], input[type="checkbox"]')
    .first()

  if (await acknowledge.isVisible().catch(() => false)) {
    await acknowledge.check().catch(() => {})
    await page.waitForTimeout(500).catch(() => {})

    const submit = page.locator('[data-testid="confirm-alert-modal-submit-button"]')
    if (await submit.isVisible().catch(() => false)) {
      await submit.click().catch(() => {})
    } else {
      // Fall back to the Confirm rendered inside the alert (the modal is
      // portalled last, so it's the final match — not the footer button).
      await page
        .getByRole('button', { name: /^confirm$/i })
        .last()
        .click()
        .catch(() => {})
    }
    await page.waitForTimeout(1500).catch(() => {})
    return true
  }

  return false
}

/**
 * If MetaMask is showing its lock screen, unlock it.
 *
 * The extension can re-lock between the fixture unlocking it and the dApp
 * firing a request, in which case the notification page shows a password prompt
 * instead of the confirmation — and we'd wait forever for a button that is
 * never going to appear.
 */
async function unlockIfLocked(page: Page): Promise<void> {
  const password = page.getByTestId('unlock-password')
  if (!(await password.isVisible().catch(() => false))) return

  const secret = process.env.WALLET_PASSWORD
  if (!secret) throw new Error('MetaMask is locked but WALLET_PASSWORD is not set.')

  await password.fill(secret)
  await page.getByTestId('unlock-submit').click().catch(() => {})
  await password.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
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

    // MetaMask can present its lock screen here instead of the request. Unlock
    // in place rather than waiting for a confirm button that will never come.
    await unlockIfLocked(page)

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
  kind: 'confirm' | 'cancel',
  timeoutMs?: number,
): Promise<void> {
  const page = await getNotificationPage(context, extensionId, timeoutMs)
  const button = actionButton(page, kind)

  // MetaMask's flows are MULTI-STEP: approving a connection to a chain it
  // doesn't know rolls straight into "add this network" and "switch network",
  // all in the same page. So walk the steps, clicking until nothing is left.
  //
  // Two rules, both learned by breaking them:
  //
  //  * NEVER close this page while a request is still pending. Closing the
  //    notification window is how a user *rejects* — treating a transient
  //    button-disappears-between-steps as "done" and closing the page silently
  //    cancelled the whole handshake, leaving the dApp on "Requesting
  //    Connection" forever.
  //  * NEVER swallow the failure. Reporting success when nothing was confirmed
  //    just moves the error somewhere far away and much harder to read.
  //
  // MetaMask also renders these buttons before React wires up their handlers,
  // so a click can land on a live-looking button and do nothing — hence looping
  // rather than clicking once.
  for (let step = 0; step < 6; step++) {
    if (page.isClosed()) return // MetaMask closed it: the flow is complete

    // Blockaid's false-positive "Malicious address" alert hijacks the footer
    // button ("Review alert") and blocks confirmation until acknowledged.
    await dismissSecurityAlert(page)

    const appeared = await button
      .waitFor({ state: 'visible', timeout: step === 0 ? 15_000 : 10_000 })
      .then(() => true)
      .catch(() => false)

    if (!appeared) {
      if (page.isClosed()) return

      // Nothing pending on this page any more → the request is resolved. Only
      // now is it safe to close it.
      if (!(await showsRequest(page))) {
        await page.close().catch(() => {})
        return
      }
      continue
    }

    await button.click({ timeout: 10_000 }).catch(() => {})
    // Give MetaMask a moment to either close the popup or render the next step
    // (which may well use the OTHER button family — hence re-resolving above).
    await page.waitForTimeout(3000).catch(() => {})

    // After the first click we always want the "confirm" family: a rejection is
    // a single act, but the screens that FOLLOW an approval must be approved
    // too, or the dApp is left hanging.
    if (kind === 'cancel') {
      if (page.isClosed()) return
      if (!(await showsRequest(page))) {
        await page.close().catch(() => {})
        return
      }
    }
  }

  if (page.isClosed()) return

  throw new Error(
    `MetaMask did not act on "${kind}" — a request is still pending after 6 steps.`,
  )
}

/** Approve the dApp's "connect wallet" request. */
export async function connectToDapp(context: BrowserContext, extensionId: string): Promise<void> {
  await resolveRequest(context, extensionId, 'confirm')
}

/** Reject the dApp's "connect wallet" request. */
export async function rejectConnection(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'cancel')
}

/** Confirm a pending transaction. */
export async function confirmTransaction(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'confirm')
}

/** Reject a pending transaction (the user clicks "Cancel"). */
export async function rejectTransaction(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'cancel')
}

/** Approve a `wallet_switchEthereumChain` request from the dApp. */
export async function approveSwitchNetwork(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'confirm')
}

/**
 * Approve any follow-up prompts the dApp fires right after connecting.
 *
 * Connecting is not the end of the handshake. Aave's market is on Base Sepolia,
 * which MetaMask does not ship with, so the dApp immediately asks the wallet to
 * ADD the network and then SWITCH to it — two more popups. Leave them unanswered
 * and the dApp sits on "Requesting Connection" forever, which looks for all the
 * world like the connect itself failed.
 *
 * Returns how many prompts were approved. Absence is not an error: if the wallet
 * is already on the right network, there is simply nothing to approve.
 */
export async function approveFollowUpRequests(
  context: BrowserContext,
  extensionId: string,
  max = 3,
): Promise<number> {
  let approved = 0

  for (let i = 0; i < max; i++) {
    try {
      // Deliberately short. This is a "is there ANOTHER one?" probe, not a wait
      // for a request we know is coming — and by now MetaMask's popup is already
      // booted, so a genuine follow-up shows up quickly. A long budget here just
      // burns ~45s of dead time on every single action, which is what pushed the
      // lending tests over their timeout.
      await resolveRequest(context, extensionId, 'confirm', 20_000)
      approved++
    } catch {
      break // nothing left pending
    }
  }

  return approved
}

/** Reject a `wallet_switchEthereumChain` request from the dApp. */
export async function rejectSwitchNetwork(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  await resolveRequest(context, extensionId, 'cancel')
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
