import { chromium, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import walletSetup from '../wallet-setup/basic.setup'

/**
 * Builds the Synpress wallet cache WITHOUT the `synpress` CLI.
 *
 * Why not the CLI: `synpress wallet-setup` refuses to run on Windows at all,
 * and under WSL it hot-loops at ~96% CPU and never launches a browser. What it
 * ultimately produces is simple — a Chromium persistent-context profile at
 * `.cache-synpress/<walletSetupHash>` with MetaMask installed and the wallet
 * imported — so we produce it directly, mirroring Synpress's own
 * `createCacheForWalletSetupFunction`. The directory name must be
 * `walletSetup.hash`: that's the key the runtime fixture looks up.
 *
 * The script verifies its own output by reopening the finished profile and
 * asserting MetaMask shows the unlock screen (i.e. the vault really persisted).
 * Without that check a subtly-broken cache only surfaces later as every test
 * failing on a "Create a new wallet" screen.
 */

const CACHE_DIR = path.join(process.cwd(), '.cache-synpress')
const METAMASK_VERSION = process.env.METAMASK_VERSION ?? '13.13.1'

function extensionPath(): string {
  const dir = path.join(CACHE_DIR, `metamask-chrome-${METAMASK_VERSION}`)
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error(`MetaMask not found at ${dir}. Run: pnpm run fetch:metamask`)
  }
  return dir
}

async function launch(userDataDir: string): Promise<{ context: BrowserContext; id: string }> {
  const ext = extensionPath()
  const args = [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
  if (process.env.HEADLESS) args.push('--headless=new')

  const context = await chromium.launchPersistentContext(userDataDir, { headless: false, args })

  let sw = context.serviceWorkers()[0]
  if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 60_000 })
  return { context, id: new URL(sw.url()).host }
}

/**
 * Open MetaMask's home page. It routinely paints blank on first load, so reload
 * until the app actually renders — otherwise every locator silently sees an
 * empty document.
 */
async function openMetaMaskHome(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(`chrome-extension://${id}/home.html`)

  for (let attempt = 0; attempt < 6; attempt++) {
    await page.waitForTimeout(2000)
    if ((await page.locator('[data-testid]').count()) > 0) return page
    await page.reload().catch(() => {})
  }
  return page
}

async function main() {
  const cachePath = path.join(CACHE_DIR, walletSetup.hash)
  console.log(`extension : ${extensionPath()}`)
  console.log(`cache dir : ${cachePath}`)

  fs.rmSync(cachePath, { recursive: true, force: true })
  fs.mkdirSync(cachePath, { recursive: true })

  // --- build ---
  {
    const { context, id } = await launch(cachePath)
    try {
      const page = await openMetaMaskHome(context, id)
      console.log('running wallet setup (import + finish onboarding)...')
      await walletSetup.fn(context, page)
      // Give MetaMask time to flush its vault to the profile on disk. Closing
      // too early leaves a profile that looks built but has no wallet in it.
      await page.waitForTimeout(8000)
    } finally {
      await context.close()
    }
  }

  // --- verify: reopen the profile and confirm the wallet is really there ---
  console.log('verifying cache (reopening profile)...')
  {
    const { context, id } = await launch(cachePath)
    try {
      const page = await openMetaMaskHome(context, id)
      const hasVault = (await page.locator('[data-testid="unlock-password"]').count()) > 0
      const isFresh = (await page.locator('[data-testid="onboarding-create-wallet"]').count()) > 0

      if (isFresh || !hasVault) {
        throw new Error(
          'cache verification failed — MetaMask did not show the unlock screen after reopening ' +
            `(fresh onboarding: ${isFresh}). The wallet did not persist into the profile.`,
        )
      }
    } finally {
      await context.close()
    }
  }

  console.log(`\n✅ cache built and verified: .cache-synpress/${walletSetup.hash}`)
}

main().catch((error: Error) => {
  console.error(`\n❌ ${error.message}`)
  process.exit(1)
})
