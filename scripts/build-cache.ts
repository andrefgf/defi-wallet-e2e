import { chromium, type BrowserContext } from '@playwright/test'
import fs from 'node:fs'
import 'dotenv/config'
import walletSetup from '../wallet-setup/basic.setup'
import {
  browserArgs,
  metamaskExtensionPath,
  openMetaMaskHome,
  walletProfilePath,
} from '../utils/wallet-cache'

/**
 * Builds the wallet cache: a Chromium profile with MetaMask installed and the
 * test wallet imported. Every test then runs against a copy of it.
 *
 * WHY NOT `synpress wallet-setup`
 * The Synpress CLI refuses to run on Windows outright, and under WSL it
 * hot-loops at ~96% CPU and never launches a browser. What it ultimately
 * produces is just this profile, so we produce it directly.
 *
 * The script VERIFIES its own output by reopening the finished profile and
 * asserting MetaMask shows the unlock screen. Without that, a profile that
 * built "successfully" but never flushed its vault would surface later as every
 * single test failing on a "Create a new wallet" screen — which is exactly the
 * dead end this cost us once already.
 */

async function launch(profile: string): Promise<{ context: BrowserContext; id: string }> {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false, // headlessness comes from --headless=new in browserArgs()
    // PW_CHANNEL=chrome → drive the system-installed Chrome instead of
    // Playwright's Chromium (see fixtures/metamask.ts for why).
    channel: process.env.PW_CHANNEL || undefined,
    args: browserArgs(),
  })

  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })

  return { context, id: new URL(worker.url()).host }
}

async function main() {
  const profile = walletProfilePath(walletSetup.hash)

  console.log(`extension : ${metamaskExtensionPath()}`)
  console.log(`cache dir : ${profile}`)

  fs.rmSync(profile, { recursive: true, force: true })
  fs.mkdirSync(profile, { recursive: true })

  // --- build ---
  {
    const { context, id } = await launch(profile)
    try {
      const page = await openMetaMaskHome(context.pages()[0] ?? (await context.newPage()), id)
      console.log('running wallet setup (import + finish onboarding)...')
      await walletSetup.fn(context, page)

      // Let MetaMask flush its vault to disk. Closing too early yields a profile
      // that looks built but contains no wallet.
      await page.waitForTimeout(8000)
    } finally {
      await context.close()
    }
  }

  // --- verify ---
  console.log('verifying cache (reopening the profile)...')
  {
    const { context, id } = await launch(profile)
    try {
      const page = await openMetaMaskHome(await context.newPage(), id)

      const hasVault = (await page.getByTestId('unlock-password').count()) > 0
      const isFresh = (await page.getByTestId('onboarding-create-wallet').count()) > 0

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
