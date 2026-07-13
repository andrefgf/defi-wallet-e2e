import fs from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'

/**
 * Shared plumbing for the MetaMask browser profile — used by both the cache
 * builder (scripts/build-cache.ts) and the test fixture (fixtures/metamask.ts)
 * so the two can never drift apart.
 */

export const METAMASK_VERSION = process.env.METAMASK_VERSION ?? '13.13.1'
export const CACHE_DIR = path.join(process.cwd(), '.cache-synpress')

/** Path to the unpacked MetaMask extension. */
export function metamaskExtensionPath(): string {
  const dir = path.join(CACHE_DIR, `metamask-chrome-${METAMASK_VERSION}`)
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error(`MetaMask not found at ${dir}. Run: pnpm run fetch:metamask`)
  }
  return dir
}

/** The cached browser profile for a given wallet-setup hash. */
export function walletProfilePath(hash: string): string {
  return path.join(CACHE_DIR, hash)
}

/**
 * Chromium args needed to load MetaMask.
 *
 * `--load-extension` is required on every launch: MetaMask is an *unpacked*
 * extension, and Chromium will not resurrect it from a copied profile on its
 * own. Set HEADLESS=true to run without a visible browser (what CI does).
 */
export function browserArgs(): string[] {
  const ext = metamaskExtensionPath()
  const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  if (process.env.HEADLESS) args.push('--headless=new')
  return args
}

/**
 * Open MetaMask's home page, tolerating its blank first paint.
 *
 * MetaMask routinely renders an empty document on first load — reliably so in
 * headless — which makes every locator silently match nothing. Reload until the
 * app actually renders.
 */
export async function openMetaMaskHome(page: Page, extensionId: string): Promise<Page> {
  // `load` never fires on MetaMask's pages, so waiting for it just burns the
  // timeout. domcontentloaded is what we actually need.
  await page
    .goto(`chrome-extension://${extensionId}/home.html`, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    })
    .catch(() => {})

  // MetaMask is slow to boot in headless (tens of seconds) and renders an empty
  // shell meanwhile. Poll patiently; reload only if it's still blank, since a
  // reload restarts the boot it's in the middle of.
  const deadline = Date.now() + 60_000
  let lastReload = Date.now()

  while (Date.now() < deadline) {
    const rendered = await page
      .locator('[data-testid]')
      .count()
      .catch(() => 0)
    if (rendered > 0) return page

    await page.waitForTimeout(1000)

    if (Date.now() - lastReload > 20_000) {
      await page
        .reload({ waitUntil: 'domcontentloaded', timeout: 15_000 })
        .catch(() => {})
      lastReload = Date.now()
    }
  }

  throw new Error('MetaMask never rendered — its page stayed blank for 60s.')
}

/**
 * Unlock the cached wallet.
 *
 * Synpress's own `unlockForFixture` hangs here in headless: it hits the blank
 * page above, never types the password, and the test dies with
 * `Test timeout exceeded while setting up "page"`. This does it explicitly and
 * waits for the unlock screen to actually go away.
 */
export async function unlockMetaMask(page: Page, password: string): Promise<void> {
  const passwordInput = page.getByTestId('unlock-password')

  if (!(await passwordInput.isVisible().catch(() => false))) {
    return // already unlocked
  }

  await passwordInput.fill(password)
  await page.getByTestId('unlock-submit').click()

  // Unlocked once the password field is gone. If it's still there, the password
  // is wrong — say so plainly instead of timing out somewhere else later.
  await passwordInput
    .waitFor({ state: 'hidden', timeout: 30_000 })
    .catch(() => {
      throw new Error(
        'MetaMask did not unlock. Does WALLET_PASSWORD match the one the cache was built with? ' +
          'If you changed it, rebuild the cache: pnpm run build:cache',
      )
    })
}
