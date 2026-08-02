import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import 'dotenv/config'
import { browserArgsFor, rabbyExtensionPath, rabbyProfilePath } from '../utils/wallet-cache'
import { unlockIfLocked } from '../utils/rabby-actions'

/**
 * The Rabby fixture — sibling of `fixtures/metamask.ts`.
 *
 * Every test starts with a real Rabby, pre-imported from the cached profile and
 * unlocked, plus a fresh dApp page. Each test gets its own COPY of the cache, so
 * tests stay isolated and never mutate it.
 *
 * DIFFERENCES FROM THE METAMASK FIXTURE — all verified, none assumed:
 *
 * - **Unlock is required.** `build-cache-rabby.ts` reports the profile reopens
 *   LOCKED, so this is on the critical path of every run rather than an edge
 *   case. Rabby's lock screen lives at `index.html#/unlock`.
 * - **No `PW_CHANNEL` escape hatch.** Branded Chrome dropped `--load-extension`
 *   from stable, which is what broke the MetaMask bring-up. Not repeating that.
 * - **Rabby pops its own tabs.** On a fresh profile it opens onboarding; on a
 *   built cache it may still open something. The dApp page is created
 *   explicitly rather than reusing `context.pages()[0]`.
 */
type RabbyFixtures = {
  rabbyPage: Page
  extensionId: string
}

export const test = base.extend<RabbyFixtures>({
  context: async ({}, use, testInfo) => {
    const cachePath = rabbyProfilePath()

    if (!fs.existsSync(cachePath)) {
      throw new Error(
        `No Rabby cache at ${cachePath}.\nBuild it first: pnpm run build:cache:rabby`,
      )
    }

    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rabby-profile-'))
    fs.cpSync(cachePath, profile, { recursive: true })

    const recordVideo = process.env.RECORD_VIDEO
      ? { dir: testInfo.outputDir, size: { width: 1280, height: 720 } }
      : undefined

    const context = await chromium.launchPersistentContext(profile, {
      headless: false, // headlessness comes from --headless=new in browserArgsFor
      args: browserArgsFor(rabbyExtensionPath()),
      viewport: { width: 1280, height: 720 },
      recordVideo,
    })

    // Same Aave testnet flag as the MetaMask fixture: the markets and faucet only
    // appear with `testnetsEnabled` in localStorage — the `?testnet=true` query
    // param does not do it. Hostname-guarded, because init scripts run on every
    // page in the context including the extension's own chrome-extension:// pages.
    await context.addInitScript(() => {
      try {
        if (window.location.hostname.endsWith('aave.com')) {
          window.localStorage.setItem('testnetsEnabled', 'true')
        }
      } catch {
        // never let this break the page under test
      }
    })

    await use(context)

    await context.close()

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

  rabbyPage: async ({ context, extensionId }, use) => {
    const page = await context.newPage()

    await page
      .goto(`chrome-extension://${extensionId}/index.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      })
      .catch(() => {})

    // Rabby, like MetaMask, can paint an empty shell before its MV3 worker boots.
    await page.waitForTimeout(3000)
    await unlockIfLocked(page)

    await use(page)
  },

  // Depends on `rabbyPage` so the wallet is unlocked before a spec touches the
  // dApp — otherwise the connect request lands on a lock screen.
  page: async ({ context, rabbyPage }, use) => {
    void rabbyPage
    await use(await context.newPage())
  },
})

export const expect = test.expect
