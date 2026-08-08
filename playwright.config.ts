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
  // These specs drive a real MetaMask against a live dApp, and MetaMask is
  // punishingly slow headless — its popup takes ~30s to boot for EACH
  // interaction. A full lending flow is five of them (connect, add network,
  // switch, ERC-20 approve, then the action itself), so ten minutes is not
  // padding, it's the real cost. A tight timeout here just fails tests that are
  // working, only slowly. The bounded action/navigation timeouts below are what
  // catch a genuine hang.
  timeout: 600_000,
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
    // CORRECTED 2026-08-06: this used to claim "Aave's only live testnet market
    // is Base Sepolia". That is false and it nearly killed the Ethereum Sepolia
    // plan on the strength of a comment. Aave V3 ships testnet markets on
    // Ethereum Sepolia (proto_sepolia_v3), Arbitrum Sepolia, Base Sepolia,
    // Scroll Sepolia, Optimism Sepolia and Avalanche Fuji.
    //
    // Testnet mode is a localStorage flag, NOT the `?testnet=true` query param —
    // set by the fixtures (fixtures/metamask.ts, fixtures/rabby.ts). Without it
    // Aave ignores marketName entirely and renders the Ethereum MAINNET market.
    // The Phantom probe hit exactly that on 2026-08-06: it navigated to
    // ?marketName=proto_base_sepolia_v3 with a raw context and no flag, and the
    // screenshot shows "Core Instance V3 — Main Ethereum market", $20.43B TVL.
    // Any probe that does not go through a fixture must set the flag itself.
    baseURL: process.env.DAPP_URL ?? 'https://app.aave.com/?marketName=proto_base_sepolia_v3',

    // In CI: always on, not just on failure. These specs ARE the deliverable —
    // a record of a real wallet driving a real DeFi protocol. The trace carries
    // a DOM snapshot for every action, so `pnpm run report` lets you scrub the
    // whole user journey — connect, sign, supply, borrow — step by step.
    //
    // Locally: only kept for failures. A full trace snapshots the DOM on EVERY
    // action, and against a real MetaMask plus Aave over a 20-minute run that
    // memory pressure is enough to get Chrome to reap MetaMask's MV3 service
    // worker — which returns LOCKED and strands the pending request. That is
    // not a theory: on 2026-07-26 the same commit went all-red locally and
    // all-green in CI, with the laptop screenshots showing the lock screen.
    // CI has the headroom; a laptop does not.
    trace: process.env.CI ? 'on' : 'retain-on-failure',
    screenshot: 'on',

    // `video` is deliberately NOT set here: it has no effect on the persistent
    // context our fixture builds (see fixtures/metamask.ts). Video is opt-in via
    // `pnpm run test:demo` — it films every MetaMask popup too and more than
    // doubles the runtime, which is a bad trade on every CI run.

    actionTimeout: 30_000,
    // Bound navigation explicitly — Playwright's default is NO limit, and a
    // `goto`/`reload` on a MetaMask page with nothing to render never fires
    // `load`, which silently ate the whole test budget. 60s rather than 30s:
    // Aave is a heavy SPA on a testnet RPC and genuinely takes its time.
    navigationTimeout: 60_000,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
})
