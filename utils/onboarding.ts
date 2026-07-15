import type { Page } from '@playwright/test'

/**
 * Drives MetaMask's onboarding to import a wallet from a seed phrase.
 *
 * WHY WE DO THIS OURSELVES
 * Synpress's `MetaMask.importWallet()` targets MetaMask 13.13.1 — the version it
 * pins — and that build has a fatal flaw for this suite: **it cannot broadcast
 * transactions on Base Sepolia.** It mangles the RPC payload
 * (`failed to decode param in array[0] invalid JSON input`) on an endpoint that
 * viem talks to happily, so the dApp just reports "Transaction failed". Every
 * supply/borrow/repay/withdraw test was dead on arrival.
 *
 * MetaMask 13.39.x broadcasts fine, so we run that instead — but Synpress's
 * import flow doesn't work on it:
 *   - the SRP field ignores `fill()` (React never sees the change) and must be
 *     typed key by key;
 *   - a passkey/biometrics gate was added, and skipping it leaves onboarding
 *     unfinished and the wallet locked forever;
 *   - the `#metametrics-opt-in` step Synpress waits for no longer exists.
 *
 * Handily, MetaMask's *popup* selectors are unchanged between the two versions,
 * so `utils/metamask-actions.ts` needed no changes at all.
 */

/** Wait for MetaMask's UI to actually render (it paints blank first). */
async function settle(page: Page, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    await page.waitForTimeout(700)
    const rendered = await page
      .locator('[data-testid]')
      .count()
      .catch(() => 0)
    if (rendered > 0) return
  }
  throw new Error('MetaMask never rendered during onboarding.')
}

/** Click a control if it happens to be on screen. */
async function clickIfPresent(page: Page, testId: string): Promise<boolean> {
  const el = page.getByTestId(testId)
  if (!(await el.isVisible().catch(() => false))) return false
  await el.click().catch(() => {})
  return true
}

export async function importWallet(
  page: Page,
  seedPhrase: string,
  password: string,
): Promise<void> {
  await settle(page)

  await page.getByTestId('onboarding-import-wallet').click()
  await page.getByTestId('onboarding-import-with-srp-button').click()

  // The SRP box is a controlled React input: `fill()` sets the value without
  // firing the events it listens for, leaving "Continue" disabled forever.
  const srp = page.getByTestId('srp-input-import__srp-note')
  await srp.waitFor({ state: 'visible', timeout: 30_000 })
  await srp.click()
  await srp.pressSequentially(seedPhrase.trim(), { delay: 12 })
  await page.waitForTimeout(800)

  await page.getByTestId('import-srp-confirm').click()

  const newPassword = page
    .locator('[data-testid="create-password-new"], [data-testid="create-password-new-input"]')
    .first()
  await newPassword.waitFor({ state: 'visible', timeout: 40_000 })
  await newPassword.fill(password)

  const confirmPassword = page
    .locator(
      '[data-testid="create-password-confirm"], [data-testid="create-password-confirm-input"]',
    )
    .first()
  if (await confirmPassword.isVisible().catch(() => false)) {
    await confirmPassword.fill(password)
  }
  await clickIfPresent(page, 'create-password-terms')
  await page.getByTestId('create-password-submit').click()

  // Walk whatever MetaMask puts between here and the wallet: the passkey gate,
  // the analytics prompt, "Open wallet", the pin-the-extension nudge. Skipping
  // any of them leaves onboarding unfinished and the wallet permanently locked.
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1800)
    const clicked =
      (await clickIfPresent(page, 'passkey-maybe-later-button')) ||
      (await clickIfPresent(page, 'metametrics-i-agree')) ||
      (await clickIfPresent(page, 'metametrics-no-thanks')) ||
      (await clickIfPresent(page, 'onboarding-complete-done')) ||
      (await clickIfPresent(page, 'pin-extension-next')) ||
      (await clickIfPresent(page, 'pin-extension-done'))
    if (!clicked) break
  }
}
