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
  // Each wallet/on-chain flow is slow; give specs generous budgets.
  timeout: 120_000,
  expect: { timeout: 30_000 },

  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // On-chain state makes flakiness common; retry in CI only.
  retries: process.env.CI ? 2 : 0,
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
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
