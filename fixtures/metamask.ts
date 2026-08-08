import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import walletSetup from '../wallet-setup/basic.setup'
import {
  browserArgs,
  openMetaMaskHome,
  unlockMetaMask,
  walletProfilePath,
} from '../utils/wallet-cache'
import { CHAIN_REQUEST_HOOK } from '../utils/connect-flow'

/**
 * The `testWithMetaMask` fixture: every test starts with a real MetaMask,
 * pre-imported from the cached profile and unlocked, plus a fresh dApp page.
 *
 * WHY THIS ISN'T SYNPRESS'S `metaMaskFixtures`
 * Synpress's fixture unlocks the wallet via `unlockForFixture`, which hangs in
 * headless mode: MetaMask's page renders blank on first paint, Synpress never
 * types the password, and the test dies with
 *   `Test timeout exceeded while setting up "page"`
 * — passing headed, failing in CI. We do the unlock ourselves (see
 * `utils/wallet-cache.ts`), which also removes the last runtime dependency on
 * Synpress's broken page objects.
 *
 * Each test gets its own COPY of the cached profile, so tests stay isolated and
 * never mutate the cache.
 *
 * Fixtures provided:
 *   context      — persistent Chromium context with MetaMask loaded
 *   extensionId  — MetaMask's extension id (needed to find its popups)
 *   metamaskPage — MetaMask's own home page, unlocked
 *   page         — a blank page for the dApp
 */
type MetaMaskFixtures = {
  metamaskPage: Page
  extensionId: string
}

export const test = base.extend<MetaMaskFixtures>({
  context: async ({}, use, testInfo) => {
    const cachePath = walletProfilePath(walletSetup.hash)

    if (!fs.existsSync(cachePath)) {
      throw new Error(
        `No wallet cache at ${cachePath}.\nBuild it first: pnpm run build:cache`,
      )
    }

    // Work on a throwaway copy so tests never mutate the cache.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'metamask-profile-'))
    fs.cpSync(cachePath, profile, { recursive: true })

    // Video is OPT-IN (`RECORD_VIDEO=1`, or `pnpm run test:demo`).
    //
    // Note it must be configured HERE, not via `video:` in playwright.config.ts —
    // that option only applies to contexts Playwright creates itself, and we build
    // our own, so it silently records nothing.
    //
    // Why opt-in: Playwright films EVERY page in the context, which here means
    // every MetaMask popup as well as the dApp — 30+ clips per run, and it pushed
    // a 3.8-minute test to 9 minutes. The trace already carries a scrubable
    // per-action filmstrip, so paying that on every CI run buys almost nothing.
    // Turn it on when you want footage to show someone.
    const recordVideo = process.env.RECORD_VIDEO
      ? { dir: testInfo.outputDir, size: { width: 1280, height: 720 } }
      : undefined

    const context = await chromium.launchPersistentContext(profile, {
      headless: false, // headlessness is driven by --headless=new in browserArgs()
      // PW_CHANNEL=chrome uses the system-installed Chrome instead of
      // Playwright's downloaded Chromium. Escape hatch for machines where
      // `playwright install` wedges (Defender fighting the unzip). Unset =
      // default Chromium, unchanged behaviour.
      channel: process.env.PW_CHANNEL || undefined,
      args: browserArgs(),
      viewport: { width: 1280, height: 720 },
      recordVideo,
    })

    // Aave only reveals its testnet markets (and the Faucet) when testnet mode
    // is on, and that flag lives in localStorage — the `?testnet=true` query
    // param does NOT do it. Without this the app quietly serves the MAINNET
    // market instead, where there is no faucet and no test tokens.
    //
    // Guarded by hostname: init scripts run on EVERY page in the context,
    // including MetaMask's own chrome-extension:// pages, where touching
    // localStorage trips LavaMoat and leaves the extension rendering blank.
    await context.addInitScript(() => {
      try {
        if (window.location.hostname.endsWith('aave.com')) {
          window.localStorage.setItem('testnetsEnabled', 'true')
        }
      } catch {
        // never let this break the page under test
      }
    })

    // Chain-request ordering trace — added 2026-08-08, after run #16.
    //
    // The hook went into fixtures/rabby.ts only, which made the comparison the
    // whole refactor exists for IMPOSSIBLE: even had MetaMask's connect cell
    // passed that run, there would have been no MetaMask timeline to compare
    // the Rabby one against. An instrument fitted to one arm of a controlled
    // comparison measures nothing.
    //
    // Worth having here even while this column still runs the OLD connect path
    // (helpers.connectWallet). That path is the one that produces a GREEN cell,
    // so its ordering is the reference: it shows what "working" looks like
    // before anything is changed to match it.
    await context.addInitScript(CHAIN_REQUEST_HOOK)

    await use(context)

    // Closing the context is what finalises the .webm files.
    await context.close()

    // Attach any footage to the report. Playwright auto-attaches video only for
    // contexts it owns; ours it doesn't, so we do it ourselves.
    if (recordVideo) {
      try {
        const videos = fs.readdirSync(testInfo.outputDir).filter((f) => f.endsWith('.webm'))
        for (const [index, file] of videos.entries()) {
          await testInfo.attach(`video ${index + 1} — browser recording`, {
            path: path.join(testInfo.outputDir, file),
            contentType: 'video/webm',
          })
        }
      } catch {
        // never fail a passing test over its own documentation
      }
    }

    fs.rmSync(profile, { recursive: true, force: true })
  },

  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })

    await use(new URL(worker.url()).host)
  },

  metamaskPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage()

    await openMetaMaskHome(page, extensionId)
    await unlockMetaMask(page, walletSetup.walletPassword)

    await use(page)
  },

  // Depends on `metamaskPage` so the wallet is always unlocked before a spec
  // touches the dApp — otherwise the dApp's connect request hits a locked wallet.
  page: async ({ context, metamaskPage }, use) => {
    void metamaskPage
    await use(await context.newPage())
  },
})

export const expect = test.expect
