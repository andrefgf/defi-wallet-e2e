import type { BrowserContext, Page } from '@playwright/test'

/**
 * Rabby notification-popup actions — the Rabby half of `metamask-actions.ts`.
 *
 * Deliberately mirrors that module's public API (`getNotificationPage`,
 * `connectToDapp`, `rejectConnection`, `approveFollowUpRequests`) so a matrix
 * spec can swap wallets without changing its shape.
 *
 * EVERY SELECTOR IS EITHER VERIFIED OR MARKED UNVERIFIED. Rabby ships zero
 * `data-testid` attributes, so all of this is label text. Verified selectors
 * came from `scripts/probe-rabby-approval.ts` against Rabby 0.93.100 on
 * 2026-07-26; anything not observed there says so in a comment. Three separate
 * failures during this build came from extending past what was probed, so the
 * distinction is kept explicit rather than tidied away.
 */

const NOTIFICATION = 'notification.html'

/**
 * Never await a wallet promise without a ceiling.
 *
 * `provider.request(...)` for anything needing approval settles ONLY when a
 * human (or us) answers the dialog. If the approval is missed, the promise
 * hangs forever — and `page.evaluate` puts no timeout on a returned promise.
 *
 * CI run #11 died exactly here: the add-chain dialog wasn't matched, `await add`
 * blocked, and the job was killed at the 60-minute ceiling with no artifacts and
 * no logs. Every provider promise the harness awaits goes through this.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ])
}

/** VERIFIED: `input[placeholder="Enter the Password to Unlock"]` at #/unlock. */
const UNLOCK_PLACEHOLDER = /enter the password to unlock/i

/**
 * VERIFIED on the connect approval: the primary is "Connect", the dismiss is
 * "Cancel".
 *
 * UNVERIFIED: the transaction and signature screens. The shipped locale file
 * gives `page.signFooterBar.signAndSubmitButton = "Sign"` and
 * `global.confirmButton = "Confirm"`, so those are included as candidates —
 * but no probe has yet driven a signature through Rabby. When one does, prune
 * this list to what actually appears.
 */
const CONFIRM_LABELS = [
  /^connect$/i,
  /^confirm$/i,
  /^sign$/i,
  /^approve$/i,
  /^next$/i,
  // VERIFIED 2026-07-28: `wallet_addEthereumChain` renders "Add Custom Network
  // to Rabby" and its primary button is **"Add"**, not Confirm. Its absence
  // from this list is why CI run #9 blocked three Rabby cells: the chain was
  // never added, the wallet stayed on 0x1, and Aave never showed an account.
  /^add$/i,
  /^switch/i,
]
const CANCEL_LABELS = [/^cancel$/i, /^reject$/i]

/** Click the first label that is present and enabled. */
async function clickFirstLabel(page: Page, labels: RegExp[], timeoutMs = 8000): Promise<boolean> {
  for (const label of labels) {
    const button = page.getByRole('button', { name: label }).first()
    const visible = await button
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false)
    if (!visible) continue
    if (!(await button.isEnabled().catch(() => false))) continue
    if (
      await button
        .click({ timeout: 8000 })
        .then(() => true)
        .catch(() => false)
    ) {
      return true
    }
  }
  return false
}

/**
 * Unlock Rabby if it is showing its lock screen.
 *
 * The cache builder reports the profile reopens LOCKED, so this is on the
 * critical path of every run — not an edge case.
 *
 * Submits with Enter rather than clicking "Unlock": the screen also offers
 * "Unlock with biometrics", and Enter avoids picking the wrong one entirely.
 */
export async function unlockIfLocked(page: Page): Promise<boolean> {
  const field = page.getByPlaceholder(UNLOCK_PLACEHOLDER)
  if (!(await field.isVisible({ timeout: 3000 }).catch(() => false))) return false

  const password = process.env.RABBY_WALLET_PASSWORD
  if (!password) throw new Error('Rabby is locked but RABBY_WALLET_PASSWORD is not set.')

  await field.fill(password)
  await field.press('Enter')
  await field.waitFor({ state: 'hidden', timeout: 20_000 }).catch(() => {})
  return true
}

/**
 * Return Rabby's approval page.
 *
 * Rabby opens `notification.html` itself when a request arrives — confirmed by
 * probe, where it appeared as a fourth page without being asked for.
 *
 * IMPORTANT, and the opposite of MetaMask: do NOT pre-open this page. With
 * nothing pending, Rabby's approval surface closes itself immediately. Three
 * probes logged that as "target closed" before it was understood as correct
 * behaviour. So wait for it rather than creating it.
 */
export async function getNotificationPage(
  context: BrowserContext,
  extensionId: string,
  timeoutMs = 60_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    const found = context
      .pages()
      .find((p) => p.url().includes(NOTIFICATION) && p.url().includes(extensionId))
    if (found) {
      await found.waitForLoadState('domcontentloaded').catch(() => {})
      // The service worker can restart and re-lock mid-run (Rabby is MV3, like
      // MetaMask), so the approval may open onto a lock screen.
      await unlockIfLocked(found).catch(() => {})
      return found
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw new Error(
    `Rabby never opened ${NOTIFICATION} within ${timeoutMs}ms — no approval was raised.`,
  )
}

/**
 * Approve a chain dialog ONLY if it is offering the chain we asked for.
 *
 * CI run #10 taught this the expensive way. Aave fires its own
 * `wallet_addEthereumChain` for **Avalanche Fuji (43113)** at the same moment
 * the harness fires one for Base Sepolia (84532). Blind approval clicked "Add"
 * on whichever dialog surfaced first, Rabby dutifully added Fuji, and the
 * wallet ended up on `0xa869` — a *different* wrong network from the `0x1` it
 * started on. Progress, but still wrong.
 *
 * So: read the Chain ID out of the form. Approve on a match, CANCEL on a
 * mismatch, and keep looking. Never approve a chain dialog blind again.
 */
export async function approveChainDialog(
  context: BrowserContext,
  extensionId: string,
  expectedChainIdDec: number,
  attempts = 4,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    const page = await getNotificationPage(context, extensionId, i === 0 ? 30_000 : 8000).catch(
      () => null,
    )
    if (!page) return false

    const body = await page.evaluate(`document.body ? document.body.innerText : ''`).catch(() => '')
    const text = String(body)

    // Not a chain dialog at all (e.g. a leftover connect prompt) — approve it
    // and move on; it isn't the thing we're guarding against.
    if (!/custom network|chain id/i.test(text)) {
      await clickFirstLabel(page, CONFIRM_LABELS, 8000)
      await new Promise((r) => setTimeout(r, 1500))
      continue
    }

    const offered = await page
      .locator('input')
      .first()
      .inputValue()
      .catch(() => '')
    const matches = offered.trim() === String(expectedChainIdDec)

    if (matches) {
      const ok = await clickFirstLabel(page, [/^add$/i, /^confirm$/i, /^switch/i], 8000)
      if (ok) return true
      return false
    }

    // Wrong chain — refuse it. This is Aave's Fuji request, not ours.
    console.log(`  [rabby] declining chain dialog offering ${offered || '?'}, want ${expectedChainIdDec}`)
    await clickFirstLabel(page, CANCEL_LABELS, 8000)
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/** Approve a pending connection request. */
export async function connectToDapp(context: BrowserContext, extensionId: string): Promise<void> {
  const page = await getNotificationPage(context, extensionId)
  if (!(await clickFirstLabel(page, CONFIRM_LABELS, 15_000))) {
    throw new Error(
      `Rabby showed an approval but none of ${CONFIRM_LABELS.map((r) => r.source).join(', ')} was clickable.`,
    )
  }
}

/** Reject a pending connection request. */
export async function rejectConnection(
  context: BrowserContext,
  extensionId: string,
): Promise<void> {
  const page = await getNotificationPage(context, extensionId)
  if (!(await clickFirstLabel(page, CANCEL_LABELS, 15_000))) {
    throw new Error('Rabby showed an approval but no Cancel/Reject control was clickable.')
  }
}

/**
 * Approve any further requests the dApp raises after connecting.
 *
 * Aave immediately asks the wallet to add and switch to Base Sepolia — the
 * probe confirmed Rabby defaults the connect approval to **Ethereum**, so this
 * is required, not optional.
 *
 * Best effort by design: it stops as soon as no further approval appears, so
 * over-calling it is safe.
 */
export async function approveFollowUpRequests(
  context: BrowserContext,
  extensionId: string,
  maxRequests = 3,
  firstTimeoutMs = 20_000,
): Promise<number> {
  let approved = 0

  for (let i = 0; i < maxRequests; i++) {
    const page = await getNotificationPage(context, extensionId, i === 0 ? firstTimeoutMs : 6000)
      .then((p) => p)
      .catch(() => null)
    if (!page) break

    if (!(await clickFirstLabel(page, CONFIRM_LABELS, 8000))) break
    approved += 1
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }

  return approved
}
