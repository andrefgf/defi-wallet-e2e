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
  context: async ({}, use) => {
    const cachePath = walletProfilePath(walletSetup.hash)

    if (!fs.existsSync(cachePath)) {
      throw new Error(
        `No wallet cache at ${cachePath}.\nBuild it first: pnpm run build:cache`,
      )
    }

    // Work on a throwaway copy so tests never mutate the cache.
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'metamask-profile-'))
    fs.cpSync(cachePath, profile, { recursive: true })

    const context = await chromium.launchPersistentContext(profile, {
      headless: false, // headlessness is driven by --headless=new in browserArgs()
      args: browserArgs(),
    })

    await use(context)

    await context.close()
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
