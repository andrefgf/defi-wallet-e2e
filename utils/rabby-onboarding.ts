import type { BrowserContext, Page } from '@playwright/test'

/**
 * Import the throwaway test wallet into Rabby and finish onboarding.
 *
 * Sibling of `utils/onboarding.ts` (MetaMask). Every selector below was
 * VERIFIED against Rabby 0.93.100 by `scripts/probe-rabby.ts` on 2026-07-26 —
 * none of it is inferred. Re-run that probe after a version bump; it is much
 * cheaper than debugging a changed flow through failing tests.
 *
 * WHY THIS IS TEXT-BASED AND MetaMask'S IS NOT
 * Rabby ships **zero** `data-testid` attributes — confirmed at runtime, not
 * just by grepping the bundle. MetaMask gives us `confirm-btn` and
 * `unlock-password`; here the only stable handles are visible labels and two
 * input placeholders. That makes this file more fragile by construction, and
 * it is a property of the wallet, not of the harness.
 *
 * Locale defaults to English, so English labels are safe. If a future run lands
 * in another language, that is the first thing to check.
 */

/**
 * How long to let Rabby's debounced seed validation settle before clicking Next.
 *
 * 3s is what the controlled run used and it worked; the true minimum is unknown
 * and there is no signal to poll for, since Next stays enabled either way. This
 * runs once per cache build, not per test, so erring high costs nothing.
 */
const SEED_VALIDATION_SETTLE_MS = 3000

/** The verified onboarding routes, in order. */
export const RABBY_ROUTES = {
  guide: '#/new-user/guide',
  importType: '#/new-user/import-wallet-type',
  seedOrKey: '#/new-user/import/seed-or-key',
  setPassword: '#/new-user/import/seed-phrase/set-password',
  success: '#/new-user/success',
} as const

/**
 * Click a control by its visible label.
 *
 * Tries the accessible role first (Rabby's controls really are `<button>`),
 * then falls back to any element carrying the text — the import-method screen
 * renders its options as clickable cards, not buttons.
 */
async function clickLabel(page: Page, label: RegExp, timeoutMs = 15_000): Promise<void> {
  const byRole = page.getByRole('button', { name: label }).first()
  if (
    await byRole
      .waitFor({ state: 'visible', timeout: timeoutMs })
      .then(() => true)
      .catch(() => false)
  ) {
    await byRole.click({ timeout: 10_000 })
    return
  }

  const byText = page.locator('button, [role="button"], div, span').filter({ hasText: label }).last()
  await byText.waitFor({ state: 'visible', timeout: 10_000 })
  await byText.click({ timeout: 10_000 })
}

/** Wait for a route, tolerating Rabby's blank first paint. */
async function waitForRoute(page: Page, fragment: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (page.url().includes(fragment)) return
    await page.waitForTimeout(500)
  }
  throw new Error(`Rabby never reached ${fragment} — currently at ${page.url()}`)
}

/**
 * Open Rabby's onboarding.
 *
 * Rabby pops its own tab on install, but WHEN is a race — it appeared within 6s
 * on one probe and not at all on the next, same machine and build. So take the
 * tab if it is there and navigate ourselves if it is not.
 */
export async function openOnboarding(
  context: BrowserContext,
  extensionId: string,
  timeoutMs = 15_000,
): Promise<Page> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const existing = context.pages().find((p) => p.url().includes(RABBY_ROUTES.guide))
    if (existing) return existing
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const page = await context.newPage()
  await page
    .goto(`chrome-extension://${extensionId}/index.html${RABBY_ROUTES.guide}`, {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    })
    .catch(() => {})
  return page
}

/**
 * Drive the full import: seed → password → open wallet.
 *
 * THE SETTLE BEFORE "NEXT" IS LOAD-BEARING. Do not remove it.
 *
 * Rabby validates the seed **asynchronously** — debounced across all twelve
 * fields — and `Next` is enabled the whole time regardless of validity. So a
 * click that lands before validation completes does nothing at all: no
 * navigation, no error, no clue. The button gives you no signal to wait on,
 * which is why this is a fixed settle rather than a poll.
 *
 * Established by a controlled run on 2026-07-26 (`scripts/probe-rabby.ts`):
 *   A  fill() + click immediately          → did not advance
 *   B  fill() + settle 3s + click          → ADVANCED
 * A and B differed only in the wait. An earlier theory that Rabby ignores
 * programmatic values and needs real keystrokes was tested and is FALSE —
 * `fill()` is fine.
 */
export async function importWallet(
  page: Page,
  seedPhrase: string,
  password: string,
): Promise<void> {
  const words = seedPhrase.trim().split(/\s+/)
  if (words.length !== 12 && words.length !== 24) {
    throw new Error(`expected a 12 or 24 word seed phrase, got ${words.length} words`)
  }

  await waitForRoute(page, RABBY_ROUTES.guide)
  await clickLabel(page, /i already have an address/i)

  await waitForRoute(page, RABBY_ROUTES.importType)
  await clickLabel(page, /seed phrase/i)

  await waitForRoute(page, RABBY_ROUTES.seedOrKey)

  // A 24-word seed needs the "My seed phrase has N words" selector changed
  // first. Fail loudly rather than silently importing the wrong thing.
  if (words.length === 24) {
    throw new Error(
      '24-word seeds need the word-count selector switched first — not yet implemented ' +
        '(see matrix-out/rabby-probe/w2-seed-phrase-form.png)',
    )
  }

  const boxes = page.locator('input[type="password"]')
  await boxes.first().waitFor({ state: 'visible', timeout: 20_000 })

  const count = await boxes.count()
  if (count < words.length) {
    throw new Error(`Rabby showed ${count} word inputs, need ${words.length}`)
  }

  /**
   * Enter all twelve words, focusing each box first.
   *
   * The `click()` and the `fill('')` are NOT ceremony. The verified probe run
   * did exactly this; a "tidied" version that just called `fill(word)` on each
   * box failed to advance even with a 9s settle. Rabby's grid appears to want
   * focus before it registers a value, so match the sequence that is known to
   * work rather than the one that reads more nicely.
   */
  async function enterSeed(): Promise<void> {
    for (let i = 0; i < words.length; i++) {
      const box = boxes.nth(i)
      await box.click()
      await box.fill('')
      await box.fill(words[i] ?? '')
    }
  }

  const onPasswordRoute = () => page.url().includes(RABBY_ROUTES.setPassword.slice(1))

  // The probe only advanced on its SECOND pass over the grid, so a single
  // attempt is not the verified path — two are. Enter, settle, click; if we're
  // still here, re-enter, settle longer, click again.
  for (const settle of [SEED_VALIDATION_SETTLE_MS, SEED_VALIDATION_SETTLE_MS * 2]) {
    await enterSeed()
    await page.waitForTimeout(settle)
    await clickLabel(page, /^next$/i)
    await page.waitForTimeout(2000)
    if (onPasswordRoute()) break
  }

  await waitForRoute(page, RABBY_ROUTES.setPassword)

  // These two placeholders are the only real selector handles in the whole
  // flow — everything else is a label. Verified against 0.93.100.
  await page.getByPlaceholder(/password \(8 characters min\)/i).fill(password)
  await page.getByPlaceholder(/confirm password/i).fill(password)
  await clickLabel(page, /^confirm$/i)

  // Reaching the success route IS the import. Everything past this point is
  // navigation, not wallet state.
  await waitForRoute(page, RABBY_ROUTES.success, 60_000)

  // "Open Wallet" is BEST EFFORT and deliberately not awaited for a result.
  //
  // The probe stopped at this screen and never pressed it, so what it does —
  // navigate in place, open the popup, close the tab — is unmeasured. An
  // earlier version waited for the dashboard on this same page afterwards and
  // timed out at 30s. Do not assert on unprobed behaviour; that is the third
  // time this pattern has cost a run.
  await clickLabel(page, /open wallet/i, 10_000).catch(() => {})

  // Give Rabby time to flush the vault to disk. The builder verifies
  // persistence properly by reopening the profile in a fresh context, which is
  // a stronger check than anything we can do from inside this tab.
  await page.waitForTimeout(5000)
}
