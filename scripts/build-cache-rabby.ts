import { chromium, type BrowserContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import 'dotenv/config'
import { rabbyExtensionPath, browserArgsFor, CACHE_DIR, RABBY_VERSION } from '../utils/wallet-cache'
import { importWallet, openOnboarding } from '../utils/rabby-onboarding'

/**
 * Build the Rabby wallet cache: a Chromium profile with Rabby installed and the
 * burner wallet imported. Matrix specs then run against a copy of it.
 *
 * Sibling of scripts/build-cache.ts (MetaMask). Same contract, same
 * self-verification, and the same hard-won lesson driving that verification: a
 * profile that "built successfully" but never flushed its vault surfaces later
 * as every test failing on an onboarding screen, which is an expensive and
 * confusing way to learn you have no wallet.
 *
 *   pnpm run build:cache:rabby
 *   HEADLESS=true pnpm run build:cache:rabby     # what CI will do
 */

const SEED_PHRASE = process.env.RABBY_SEED_PHRASE
const WALLET_PASSWORD = process.env.RABBY_WALLET_PASSWORD

if (!SEED_PHRASE) {
  throw new Error(
    'RABBY_SEED_PHRASE is not set. Rabby uses its OWN burner, deliberately separate ' +
      'from SEED_PHRASE, so matrix work can never touch the funded MetaMask wallet.',
  )
}
if (!WALLET_PASSWORD) {
  throw new Error('RABBY_WALLET_PASSWORD is not set. See .env.example.')
}

/**
 * Profile key. Changing the seed, the password or the Rabby build must produce
 * a different cache — otherwise a stale profile silently outlives its inputs.
 * Hash only; never write the secret itself to disk or to a path name.
 */
const hash = crypto
  .createHash('sha256')
  .update(`${SEED_PHRASE}::${WALLET_PASSWORD}::${RABBY_VERSION}`)
  .digest('hex')
  .slice(0, 16)

const PROFILE = path.join(CACHE_DIR, `rabby-profile-${hash}`)

async function launch(profile: string): Promise<{ context: BrowserContext; id: string }> {
  const context = await chromium.launchPersistentContext(profile, {
    headless: false, // headlessness comes from --headless=new in browserArgsFor
    args: browserArgsFor(rabbyExtensionPath()),
  })

  let [worker] = context.serviceWorkers()
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })

  return { context, id: new URL(worker.url()).host }
}

async function main() {
  console.log(`extension : ${rabbyExtensionPath()}`)
  console.log(`cache dir : ${PROFILE}`)

  fs.rmSync(PROFILE, { recursive: true, force: true })
  fs.mkdirSync(PROFILE, { recursive: true })

  // --- build ---
  {
    const { context, id } = await launch(PROFILE)
    try {
      console.log('running Rabby onboarding (import + set password)...')
      const page = await openOnboarding(context, id)
      await importWallet(page, SEED_PHRASE!, WALLET_PASSWORD!)

      // Let Rabby flush its vault. Closing too early yields a profile that
      // looks built and contains no wallet — the exact failure the MetaMask
      // builder was hardened against.
      await page.waitForTimeout(8000)
    } finally {
      await context.close()
    }
  }

  // --- verify ---
  //
  // Deliberately NOT "does the unlock screen appear". Rabby's lock behaviour
  // across a browser restart is still unmeasured (the probe never locked it),
  // so asserting on it would be asserting something we have not observed.
  // What we DO know: a fresh install lands on #/new-user/guide. So the honest
  // check is that we are no longer being onboarded, and the dashboard's action
  // row — which only renders with a wallet present — is there.
  console.log('verifying cache (reopening the profile)...')
  {
    const { context, id } = await launch(PROFILE)
    try {
      const page = await context.newPage()
      await page
        .goto(`chrome-extension://${id}/index.html`, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        })
        .catch(() => {})
      await page.waitForTimeout(5000)

      if (page.url().includes('/new-user/')) {
        throw new Error(
          `cache verification failed — Rabby is still showing onboarding (${page.url()}). ` +
            'The wallet did not persist into the profile.',
        )
      }

      const dashboard = await page
        .getByRole('button', { name: /^(swap|send|receive)$/i })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => true)
        .catch(() => false)

      // A locked wallet is a PASS: the vault exists, it just wants a password.
      // Only "no wallet at all" is a failure.
      const locked = await page
        .getByRole('button', { name: /unlock/i })
        .first()
        .isVisible()
        .catch(() => false)

      if (!dashboard && !locked) {
        throw new Error(
          'cache verification failed — neither the dashboard nor an unlock prompt appeared. ' +
            `Currently at ${page.url()}`,
        )
      }
      console.log(locked ? '  profile reopened LOCKED (vault present)' : '  profile reopened unlocked')
    } finally {
      await context.close()
    }
  }

  console.log(`\n✅ Rabby cache built and verified: ${path.basename(PROFILE)}`)
  console.log('   note the profile name — the matrix fixture will need it.')
}

main().catch((error: Error) => {
  console.error(`\n❌ ${error.message}`)
  process.exit(1)
})
