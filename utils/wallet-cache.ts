import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Page } from '@playwright/test'

/**
 * Shared plumbing for the MetaMask browser profile — used by both the cache
 * builder (scripts/build-cache.ts) and the test fixture (fixtures/metamask.ts)
 * so the two can never drift apart.
 */

export const METAMASK_VERSION = process.env.METAMASK_VERSION ?? '13.39.1'
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
  return browserArgsFor(metamaskExtensionPath())
}

// --- second wallet: Rabby -----------------------------------------------------
//
// Deliberately ADDITIVE rather than a refactor of the MetaMask helpers above.
// The MetaMask column is green (CI run #8, 4/4) and a Sunday-night rewrite of
// shared plumbing is the cheapest possible way to lose that. Once Rabby's cells
// are also green, the two can be collapsed into one wallet-parameterised module
// with the tests standing behind the change.

export const RABBY_VERSION = process.env.RABBY_VERSION ?? '0.93.100'

/**
 * Path to the unpacked Rabby extension.
 *
 * Unlike MetaMask's archive, Rabby's is not guaranteed flat — `fetch-rabby.mjs`
 * resolves manifest.json at the root or one level down, so mirror that here
 * rather than assuming.
 */
export function rabbyExtensionPath(): string {
  const base = path.join(CACHE_DIR, `rabby-chrome-${RABBY_VERSION}`)
  if (fs.existsSync(path.join(base, 'manifest.json'))) return base

  if (fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base)) {
      const nested = path.join(base, entry)
      if (
        fs.statSync(nested).isDirectory() &&
        fs.existsSync(path.join(nested, 'manifest.json'))
      ) {
        return nested
      }
    }
  }
  throw new Error(`Rabby not found at ${base}. Run: pnpm run fetch:rabby`)
}

/**
 * The cached Rabby profile for the current burner + build.
 *
 * Keyed on seed + password + extension version, so changing any of them yields
 * a different profile and a stale cache can never outlive its inputs. Only the
 * hash reaches disk — never the secret.
 */
export function rabbyProfilePath(): string {
  const seed = process.env.RABBY_SEED_PHRASE
  const password = process.env.RABBY_WALLET_PASSWORD
  if (!seed || !password) {
    throw new Error('RABBY_SEED_PHRASE and RABBY_WALLET_PASSWORD must be set (see .env.example)')
  }
  const hash = crypto
    .createHash('sha256')
    .update(`${seed}::${password}::${RABBY_VERSION}`)
    .digest('hex')
    .slice(0, 16)
  return path.join(CACHE_DIR, `rabby-profile-${hash}`)
}

// ---------------------------------------------------------------------------
// Phantom
//
// Phantom is the first wallet in this repo that CANNOT be version-pinned: it
// ships through the Chrome Web Store only and publishes no downloadable build,
// so `fetch-phantom.mjs` pulls the current one from Google's CRX endpoint. The
// cache directory is therefore named `-latest` rather than carrying a version,
// and the version has to be READ at run time and recorded per cell.
//
// Read `scripts/fetch-phantom.mjs`'s header before changing any of this.
// ---------------------------------------------------------------------------

/** Path to the unpacked Phantom extension. Root or one level down, as Rabby. */
export function phantomExtensionPath(): string {
  const base = path.join(CACHE_DIR, 'phantom-chrome-latest')
  if (fs.existsSync(path.join(base, 'manifest.json'))) return base

  if (fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base)) {
      const nested = path.join(base, entry)
      if (
        fs.statSync(nested).isDirectory() &&
        fs.existsSync(path.join(nested, 'manifest.json'))
      ) {
        return nested
      }
    }
  }
  throw new Error(`Phantom not found at ${base}. Run: pnpm run fetch:phantom`)
}

/**
 * The Phantom build actually on disk.
 *
 * This is not decoration. Phantom cannot be pinned, so this string is the ONLY
 * thing that makes a Phantom cell reproducible after the fact — it must be
 * written into `wallet_version` in matrix/data/results.csv for every cell.
 */
export function phantomVersion(): string {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(phantomExtensionPath(), 'manifest.json'), 'utf8'),
  ) as { version?: string }
  return manifest.version ?? 'unknown'
}

/**
 * The cached Phantom profile.
 *
 * Keyed on seed + password + the RESOLVED build version, so a Web Store update
 * silently invalidates the cache instead of leaving a profile built by an older
 * Phantom in place. That matters more here than for the pinned wallets, because
 * the version can change underneath us without anyone editing a file.
 */
export function phantomProfilePath(): string {
  const seed = process.env.PHANTOM_SEED_PHRASE
  const password = process.env.PHANTOM_WALLET_PASSWORD
  if (!seed || !password) {
    throw new Error('PHANTOM_SEED_PHRASE and PHANTOM_WALLET_PASSWORD must be set (see .env.example)')
  }
  const hash = crypto
    .createHash('sha256')
    .update(`${seed}::${password}::${phantomVersion()}`)
    .digest('hex')
    .slice(0, 16)
  return path.join(CACHE_DIR, `phantom-profile-${hash}`)
}

/** Chromium args to load a specific unpacked extension. */
export function browserArgsFor(extensionPath: string): string[] {
  return browserArgsForAll([extensionPath])
}

/**
 * Chromium args to load SEVERAL unpacked extensions, in a stated order.
 *
 * Chromium takes a comma-separated list. Whether that list order actually
 * determines injection order is NOT something to assume — it is the thing
 * `scripts/probe-provider-identity.ts` exists to measure. Load order and
 * injection order are different claims, and conflating them is how you end up
 * asserting "install order decides window.ethereum" without ever having varied
 * the order.
 */
export function browserArgsForAll(extensionPaths: string[]): string[] {
  const joined = extensionPaths.join(',')
  const args = [`--disable-extensions-except=${joined}`, `--load-extension=${joined}`]
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
