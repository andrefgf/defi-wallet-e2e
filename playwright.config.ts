import { defineConfig, devices } from '@playwright/test'
import 'dotenv/config'

/**
 * Playwright configuration for the Synpress + MetaMask E2E suite.
 *
 * `baseURL` comes from DAPP_URL so specs can `page.goto('/')` and stay
 * dApp-agnostic. Synpress launches a persistent Chromium context with the
 * MetaMask extension via the `metaMaskFixtures` fixture, so we don't declare
 * browser projects here beyond Chromium.
 *
 * @see https://docs.synpress.io
 * @see https://playwright.dev/docs/test-configuration
 */
export default defineConfig({
  testDir: './tests',
  // These specs drive a real MetaMask against a live dApp. MetaMask is
  // punishingly slow in headless — its UI takes ~30s to boot for EACH
  // interaction — so a full connect flow runs 4-5 minutes in CI. A tight
  // timeout here fails tests that are working, just slowly. Budget generously:
  // the bounded action/navigation timeouts below are what catch a genuine hang.
  timeout: 360_000,
  expect: { timeout: 30_000 },

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retry in CI only. Just one: these tests are slow (minutes each), and three
  // attempts apiece overran the job's time limit and got the whole run cancelled.
  retries: process.env.CI ? 1 : 0,
  // Synpress caches one wallet browser and supports parallel workers, but
  // shared on-chain state (a single test wallet) means serial is safer.
  workers: 1,

  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['html', { open: 'never' }], ['list']],

  use: {
    baseURL: process.env.DAPP_URL ?? 'https://app.aave.com/?testnet=true',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 30_000,
    // Bound navigation explicitly. Playwright's default is no limit, and a
    // `goto`/`reload` on a MetaMask page with nothing to render never fires
    // `load` — which silently ate the whole test budget.
    navigationTimeout: 30_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
