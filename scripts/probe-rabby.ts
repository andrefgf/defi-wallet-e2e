import { chromium, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import { rabbyExtensionPath, browserArgsFor } from '../utils/wallet-cache'

/**
 * Rabby reconnaissance — look before writing a line of automation.
 *
 * WHY THIS EXISTS
 * Rabby ships **no test hooks**: zero `data-testid` across its whole bundle,
 * where MetaMask gives us `confirm-btn`, `unlock-password` and friends. Every
 * selector will be role- or text-based, and the text is localised (16 locales).
 * Guessing that vocabulary from a 53 MB minified bundle is how you lose an
 * evening debugging a fiction — so this opens the real pages and writes down
 * what is actually there.
 *
 * It does NOT import a wallet, touch a chain, or need a seed phrase. It looks.
 *
 *   pnpm run probe:rabby            # headed, watch it
 *   PROBE_HOLD=1 pnpm run probe:rabby   # keep the browser open 90s at the end
 */

const OUT = path.join(process.cwd(), 'matrix-out', 'rabby-probe')

/**
 * Inventory as a STRING, not a function.
 *
 * `page.evaluate(fn)` serialises the function — but tsx/esbuild rewrites named
 * arrow functions to add its `__name` helper, which does not exist in the page.
 * That's the `ReferenceError: __name is not defined` this script hit on its
 * first run. A string is passed through untouched.
 */
const INVENTORY_JS = `(() => {
  var vis = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  var txt = function (el) { return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60) }
  var hook = function (el) { return el.getAttribute('data-testid') || el.getAttribute('data-test-id') || null }

  var buttons = Array.prototype.slice.call(
    document.querySelectorAll('button, [role="button"], a[href]')
  ).filter(vis).map(function (el) {
    return { tag: el.tagName.toLowerCase(), text: txt(el),
             cls: (el.getAttribute('class') || '').slice(0, 70), testId: hook(el) }
  }).filter(function (b) { return b.text || b.testId })

  var inputs = Array.prototype.slice.call(
    document.querySelectorAll('input, textarea')
  ).filter(vis).map(function (el) {
    return { type: el.getAttribute('type') || el.tagName.toLowerCase(),
             placeholder: el.getAttribute('placeholder'), id: el.getAttribute('id'), testId: hook(el) }
  })

  return {
    url: location.href,
    title: document.title,
    bodyChars: (document.body ? document.body.innerText || '' : '').trim().length,
    headings: Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).filter(vis).map(txt).slice(0, 10),
    buttons: buttons.slice(0, 40),
    inputs: inputs,
    totalTestIds: document.querySelectorAll('[data-testid],[data-test-id]').length
  }
})()`

/** Wait until the page has actually painted something. */
async function waitForContent(page: Page, budgetMs = 25_000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    const painted = await page
      .evaluate(`!!document.body && document.body.innerText.trim().length > 0`)
      .catch(() => false)
    if (painted) return true
    await page.waitForTimeout(1000).catch(() => {})
  }
  return false
}

async function capture(page: Page, name: string): Promise<void> {
  const painted = await waitForContent(page)
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {})

  const data = (await page.evaluate(INVENTORY_JS).catch((e) => ({ error: String(e) }))) as Record<
    string,
    unknown
  >
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2))

  if (data.error) {
    console.log(`    inventory failed: ${String(data.error).slice(0, 120)}`)
    return
  }
  console.log(
    `    painted=${painted} title="${data.title}" testIds=${data.totalTestIds} bodyChars=${data.bodyChars}`,
  )
  const headings = data.headings as string[]
  if (headings?.length) console.log(`    headings: ${headings.join(' | ')}`)
  for (const b of ((data.buttons as { text: string; testId: string | null }[]) ?? []).slice(0, 14)) {
    console.log(`      [button] "${b.text}"${b.testId ? `  testId=${b.testId}` : ''}`)
  }
  for (const i of (data.inputs as { type: string; placeholder: string | null }[]) ?? []) {
    console.log(`      [input ] type=${i.type} placeholder=${JSON.stringify(i.placeholder)}`)
  }
}

/** Each capture gets its OWN page — the first run died when a shared one closed. */
async function captureUrl(
  context: import('@playwright/test').BrowserContext,
  name: string,
  url: string,
): Promise<void> {
  console.log(`\n--- ${name} → ${url}`)
  const page = await context.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {})
    await capture(page, name)
  } catch (error) {
    console.log(`    capture failed: ${(error as Error).message.slice(0, 120)}`)
  } finally {
    await page.close().catch(() => {})
  }
}

/**
 * Click something by its visible label.
 *
 * Rabby ships no test hooks, so label text is all we have. Try the accessible
 * role first (the inventory confirmed these really are buttons), then fall back
 * to any element carrying the text — wallets love a clickable <div>.
 */
async function clickLabel(page: Page, label: RegExp): Promise<boolean> {
  const byRole = page.getByRole('button', { name: label }).first()
  if (await byRole.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false)) {
    // Report the disabled state BEFORE clicking. The first version swallowed
    // the click error and returned true regardless, so a disabled button looked
    // exactly like a successful click — which is how we spent a run believing
    // the seed grid had advanced when it hadn't.
    const enabled = await byRole.isEnabled().catch(() => false)
    if (!enabled) {
      console.log(`    button /${label.source}/ is present but DISABLED`)
      return false
    }
    const clicked = await byRole
      .click({ timeout: 8000 })
      .then(() => true)
      .catch((e: Error) => {
        console.log(`    click failed: ${e.message.split('\n')[0]}`)
        return false
      })
    return clicked
  }
  const byText = page.locator('button, [role="button"], div, span').filter({ hasText: label }).last()
  if (await byText.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true).catch(() => false)) {
    return byText
      .click({ timeout: 8000 })
      .then(() => true)
      .catch(() => false)
  }
  return false
}

/** What the page thinks about the seed grid right now. */
async function seedGridState(page: Page): Promise<void> {
  const state = await page
    .evaluate(
      `(() => {
        var boxes = Array.prototype.slice.call(document.querySelectorAll('input[type="password"]'))
        var next = Array.prototype.slice.call(document.querySelectorAll('button'))
          .filter(function (b) { return /next/i.test(b.textContent || '') })[0]
        var errs = Array.prototype.slice.call(document.querySelectorAll('*'))
          .filter(function (el) {
            var c = (el.getAttribute('class') || '') + ''
            return /error|invalid|warn/i.test(c) && (el.textContent || '').trim()
          })
          .map(function (el) { return (el.textContent || '').trim().slice(0, 80) })
        return {
          filled: boxes.filter(function (b) { return b.value && b.value.length }).length,
          firstValue: boxes.length ? boxes[0].value : null,
          nextDisabled: next ? (next.disabled || /disabled/i.test(next.getAttribute('class') || '')) : 'no-next',
          errors: errs.slice(0, 4)
        }
      })()`,
    )
    .catch((e) => ({ error: String(e) }))
  console.log(`    grid state: ${JSON.stringify(state)}`)
}

/**
 * Walk the import path far enough to photograph each screen.
 *
 * DELIBERATELY STOPS at the seed-phrase form. This is reconnaissance, not
 * onboarding: it never types SEED_PHRASE. Capturing the shape of the form is
 * all we need to write the real flow, and a probe that handles secrets is a
 * probe that can leak them into a screenshot in matrix-out/.
 */
async function walkOnboarding(page: Page): Promise<void> {
  const steps: [RegExp, string][] = [
    [/i already have an address/i, 'w1-import-chosen'],
    [/seed phrase/i, 'w2-seed-phrase-form'],
  ]
  for (const [label, name] of steps) {
    console.log(`\n--- walk: click /${label.source}/`)
    if (!(await clickLabel(page, label))) {
      console.log(`    NOT FOUND — stopping the walk here`)
      return
    }
    await page.waitForTimeout(2500)
    console.log(`--- ${name} → ${page.url()}`)
    await capture(page, name)
  }

  // Secrets come from the environment, never from this file — it's committed.
  //
  // Use a DEDICATED Rabby burner, not the MetaMask wallet: RABBY_SEED_PHRASE,
  // not SEED_PHRASE. Keeping them separate means a probe can never touch the
  // funded wallet the lending suite uses.
  //
  // Default is the canonical Hardhat mnemonic, which Rabby appears to REJECT —
  // the 2026-07-26 probe filled all 12 words, Next was enabled, the click
  // landed, and the route never changed, with no visible error. Wallets
  // commonly refuse known-compromised seeds and that is the likeliest reading.
  // So the default exists to prove the form works, not to get you a wallet.
  const PUBLIC_TEST_MNEMONIC = 'test test test test test test test test test test test junk'
  const SEED = process.env.RABBY_SEED_PHRASE ?? PUBLIC_TEST_MNEMONIC
  const PROBE_PASSWORD = process.env.RABBY_WALLET_PASSWORD ?? 'ProbePassword123'
  if (!process.env.RABBY_SEED_PHRASE) {
    console.log('\n    NOTE: RABBY_SEED_PHRASE not set — using the public Hardhat mnemonic,')
    console.log('          which Rabby is expected to reject. Set it in .env to go further.')
  }

  const words = SEED.trim().split(/\s+/)
  const boxes = page.locator('input[type="password"]')
  const count = await boxes.count().catch(() => 0)
  console.log(`\n--- walk: seed grid — ${count} inputs for ${words.length} words`)
  if (count < words.length) {
    console.log('    fewer inputs than words — stopping rather than guessing')
    return
  }

  /** Enter the words, either programmatically or as real keystrokes. */
  async function enterWords(mode: 'fill' | 'type'): Promise<void> {
    for (let i = 0; i < words.length; i++) {
      const box = boxes.nth(i)
      await box.click().catch(() => {})
      await box.fill('').catch(() => {})
      if (mode === 'fill') {
        await box.fill(words[i] ?? '').catch(() => {})
      } else {
        await box.pressSequentially(words[i] ?? '', { delay: 30 }).catch(() => {})
      }
    }
    console.log(`    after ${mode}():`)
    await seedGridState(page)
  }

  /** Click Next and report whether we actually LEFT this route. */
  async function tryAdvance(settleMs = 0): Promise<boolean> {
    if (settleMs) {
      console.log(`    settling ${settleMs}ms before clicking Next…`)
      await page.waitForTimeout(settleMs)
    }
    const before = page.url()
    if (!(await clickLabel(page, /^next$/i))) return false
    await page.waitForTimeout(3000)
    return page.url() !== before
  }

  // Gate the keystroke retry on the ROUTE, not on the button's disabled state.
  //
  // The 2026-07-26 run gated it on `!isEnabled()` and so never ran it — because
  // Next is ALWAYS enabled here. That is itself the clue: the button doesn't
  // reflect validity, it validates on click against the component's own state.
  // `fill()` writes the DOM value and fires `input`; a component that tracks
  // its state via keydown/paste never sees it, so the grid looks full and the
  // click quietly does nothing. Real keystrokes are the test that distinguishes
  // "wrong seed" from "wrong input method".
  // THREE-WAY EXPERIMENT — only one variable moves at a time.
  //
  // The 2026-07-26 run confounded two explanations: `type()` changed BOTH the
  // input mechanism AND the elapsed time (12 words at 30ms/char ≈ 3s). So we
  // could not say whether Rabby ignores programmatic values or simply hadn't
  // finished validating. This separates them:
  //
  //   A  fill + click now    → control, expected to fail
  //   B  fill + wait 3s      → isolates TIMING
  //   C  type + click        → isolates INPUT MECHANISM
  //
  // B passes  → it was a race; fill() is fine with a settle.
  // B fails, C passes → the component never sees programmatic values.
  let verdict = ''
  console.log('\n=== EXPERIMENT A: fill(), click immediately ===')
  await enterWords('fill')
  let advanced = await tryAdvance()
  if (advanced) verdict = 'A — fill() + immediate click WORKED (earlier failure was not reproducible)'

  if (!advanced) {
    console.log('\n=== EXPERIMENT B: fill(), settle 3s, then click ===')
    await enterWords('fill')
    advanced = await tryAdvance(3000)
    if (advanced) verdict = 'B — TIMING. fill() is fine; the click was arriving too early.'
  }

  if (!advanced) {
    console.log('\n=== EXPERIMENT C: real keystrokes ===')
    await enterWords('type')
    advanced = await tryAdvance()
    if (advanced) verdict = 'C — INPUT MECHANISM. fill() is not seen even after settling.'
  }

  console.log(`\n>>> EXPERIMENT RESULT: ${verdict || 'ALL THREE FAILED — something else is wrong'}`)

  console.log(`--- w3-after-seed → ${page.url()}`)
  await capture(page, 'w3-after-seed')

  if (!advanced) {
    console.log('\n    ⚠ still on the seed route after BOTH input methods.')
    // Dump every visible line — an inline validation message may not carry any
    // class my error heuristic looks for.
    const visible = await page
      .evaluate(`document.body ? document.body.innerText : ''`)
      .catch(() => '')
    console.log('    visible page text:')
    String(visible)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .forEach((l) => console.log(`      | ${l}`))
    return
  }

  // Expected: the Set Password card (locale: page.newUserImport.PasswordCard.*).
  const pwd = page.locator('input[type="password"]')
  const pwdCount = await pwd.count().catch(() => 0)
  if (pwdCount > 0 && pwdCount <= 4) {
    console.log(`\n--- walk: password screen has ${pwdCount} field(s) — filling and continuing`)
    for (let i = 0; i < pwdCount; i++) {
      await pwd.nth(i).fill(PROBE_PASSWORD).catch(() => {})
    }
    if (await clickLabel(page, /^(next|confirm|submit)$/i)) {
      await page.waitForTimeout(4000)
      console.log(`--- w4-after-password → ${page.url()}`)
      await capture(page, 'w4-after-password')
    }
  }

  console.log('\n    walk finished — profile is throwaway and deleted on the next run')
}

async function main() {
  const ext = rabbyExtensionPath()
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`extension : ${ext}`)
  console.log(`output    : ${OUT}`)

  const profile = path.join(process.cwd(), '.cache-synpress', 'rabby-probe-profile')
  fs.rmSync(profile, { recursive: true, force: true })

  const context = await chromium.launchPersistentContext(profile, {
    headless: false, // headlessness comes from --headless=new in browserArgsFor
    args: browserArgsFor(ext),
  })

  try {
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })
    const id = new URL(worker.url()).host
    console.log(`extension id: ${id}`)

    // Rabby pops its own onboarding tab on install — but WHEN is a race. It
    // appeared within 6s on the first probe and not at all on the second, same
    // machine, same build. So don't depend on it: wait a bounded time for the
    // tab, and if it doesn't come, navigate to the route ourselves. We only
    // know the route BECAUSE the first run caught it, which is the whole
    // argument for probing before writing automation.
    const GUIDE = '/new-user/guide'
    let guidePage: Page | null = null

    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !guidePage) {
      guidePage = context.pages().find((p) => p.url().includes(GUIDE)) ?? null
      if (!guidePage) await new Promise((r) => setTimeout(r, 1000))
    }

    const opened = context.pages().map((p) => p.url())
    console.log(`\npages Rabby opened by itself (${opened.length}):`)
    opened.forEach((u) => console.log(`  ${u}`))
    fs.writeFileSync(path.join(OUT, 'auto-opened-pages.txt'), opened.join('\n') + '\n')

    if (guidePage) {
      console.log(`\n--- 0-auto-guide → ${guidePage.url()}`)
      await capture(guidePage, '0-auto-guide')
    } else {
      console.log(`\n(no ${GUIDE} tab appeared in 15s — opening the route directly)`)
      guidePage = await context.newPage()
      await guidePage
        .goto(`chrome-extension://${id}/index.html#${GUIDE}`, {
          waitUntil: 'domcontentloaded',
          timeout: 20_000,
        })
        .catch(() => {})
      console.log(`--- 0-direct-guide → ${guidePage.url()}`)
      await capture(guidePage, '0-direct-guide')
    }

    await walkOnboarding(guidePage)

    // Then the three pages named in the manifest.
    //   index.html        — full-tab UI (MetaMask's home.html)
    //   notification.html — approval surface (same filename as MetaMask)
    //   popup.html        — toolbar popup
    // notification.html and popup.html both closed themselves on the first run.
    // That is almost certainly Rabby calling window.close() on an approval
    // surface with nothing pending — MetaMask leaves the same page open and
    // empty, which is what `getNotificationPage` currently relies on. Worth
    // knowing before porting that helper: for Rabby the page may only be
    // openable while a request is actually in flight.
    await captureUrl(context, '1-index', `chrome-extension://${id}/index.html`)
    await captureUrl(context, '2-notification', `chrome-extension://${id}/notification.html`)
    await captureUrl(context, '3-popup', `chrome-extension://${id}/popup.html`)

    fs.writeFileSync(
      path.join(OUT, 'extension-id.txt'),
      `${id}\nrabby ${path.basename(ext)}\nprobed ${new Date().toISOString()}\n`,
    )
    console.log(`\n✅ probe complete — screenshots + inventories in ${OUT}`)

    if (process.env.PROBE_HOLD) {
      console.log('PROBE_HOLD set — leaving the browser open for 90s so you can click around.')
      await new Promise((r) => setTimeout(r, 90_000))
    }
  } finally {
    await context.close()
  }
}

main().catch((error: Error) => {
  console.error(`\n❌ ${error.message}`)
  process.exit(1)
})
