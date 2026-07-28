import { chromium, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import { rabbyExtensionPath, browserArgsFor, rabbyProfilePath } from '../utils/wallet-cache'

/**
 * Second Rabby probe: the LOCK screen and the APPROVAL surface.
 *
 * `probe-rabby.ts` covered onboarding. Two surfaces are still unmeasured, and
 * both are required before `rabby-actions.ts` can be written honestly:
 *
 *   1. The lock screen. The cache builder reported "profile reopened LOCKED",
 *      so every test run will meet it. Its selectors are unknown.
 *   2. `notification.html` with a request actually pending. It self-closes when
 *      there is nothing to approve, which is why three earlier probes recorded
 *      it as "target closed" — that was Rabby behaving correctly, not a bug.
 *
 * HOW A PENDING REQUEST IS CREATED
 * Not by driving Aave — that drags in a slow dApp and a live network for no
 * benefit. Any ordinary page can raise the same request: fire
 * `eth_requestAccounts` at the injected provider and do NOT await it. Rabby
 * opens its approval window and the promise stays unresolved until we answer.
 *
 * Requires a built cache:  pnpm run build:cache:rabby
 * Then:                    pnpm run probe:rabby:approval
 */

const OUT = path.join(process.cwd(), 'matrix-out', 'rabby-approval')

const INVENTORY_JS = `(() => {
  var vis = function (el) { var r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 }
  var txt = function (el) { return (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 70) }
  var buttons = Array.prototype.slice.call(
    document.querySelectorAll('button, [role="button"], a[href]')
  ).filter(vis).map(function (el) {
    return { text: txt(el), cls: (el.getAttribute('class') || '').slice(0, 60) }
  }).filter(function (b) { return b.text })
  var inputs = Array.prototype.slice.call(
    document.querySelectorAll('input, textarea')
  ).filter(vis).map(function (el) {
    return { type: el.getAttribute('type') || el.tagName.toLowerCase(),
             placeholder: el.getAttribute('placeholder') }
  })
  return {
    url: location.href,
    bodyChars: (document.body ? document.body.innerText || '' : '').trim().length,
    headings: Array.prototype.slice.call(document.querySelectorAll('h1,h2,h3')).filter(vis).map(txt).slice(0, 8),
    text: (document.body ? document.body.innerText || '' : '').trim().split('\\n').map(function (s) { return s.trim() }).filter(Boolean).slice(0, 25),
    buttons: buttons.slice(0, 25),
    inputs: inputs,
    totalTestIds: document.querySelectorAll('[data-testid],[data-test-id]').length
  }
})()`

async function capture(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(2500)
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {})
  const data = (await page.evaluate(INVENTORY_JS).catch((e) => ({ error: String(e) }))) as Record<
    string,
    unknown
  >
  fs.writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(data, null, 2))

  if (data.error) {
    console.log(`    inventory failed: ${String(data.error).slice(0, 110)}`)
    return
  }
  console.log(`    url=${data.url}`)
  console.log(`    testIds=${data.totalTestIds} bodyChars=${data.bodyChars}`)
  for (const line of ((data.text as string[]) ?? []).slice(0, 12)) console.log(`      | ${line}`)
  for (const b of (data.buttons as { text: string }[]) ?? []) console.log(`      [button] "${b.text}"`)
  for (const i of (data.inputs as { type: string; placeholder: string | null }[]) ?? []) {
    console.log(`      [input ] type=${i.type} placeholder=${JSON.stringify(i.placeholder)}`)
  }
}

async function main() {
  const profile = rabbyProfilePath()
  if (!fs.existsSync(profile)) {
    throw new Error(`no Rabby cache at ${profile} — run: pnpm run build:cache:rabby`)
  }
  fs.mkdirSync(OUT, { recursive: true })
  console.log(`profile : ${profile}`)
  console.log(`output  : ${OUT}`)

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: browserArgsFor(rabbyExtensionPath()),
  })

  try {
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })
    const id = new URL(worker.url()).host
    console.log(`extension id: ${id}`)

    // --- 1. the lock screen -------------------------------------------------
    console.log('\n=== 1. LOCK SCREEN ===')
    const wallet = await context.newPage()
    await wallet
      .goto(`chrome-extension://${id}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch(() => {})
    await capture(wallet, '1-locked')

    // --- 2. unlock ----------------------------------------------------------
    console.log('\n=== 2. UNLOCK ATTEMPT ===')
    const password = process.env.RABBY_WALLET_PASSWORD ?? ''
    const pwField = wallet.locator('input[type="password"]').first()
    if (await pwField.isVisible({ timeout: 5000 }).catch(() => false)) {
      await pwField.fill(password)
      // Enter is more forgiving than guessing the button label.
      await pwField.press('Enter').catch(() => {})
      await wallet.waitForTimeout(4000)
      console.log(`    after unlock → ${wallet.url()}`)
      await capture(wallet, '2-unlocked')
    } else {
      console.log('    no password field — wallet may already be unlocked')
      await capture(wallet, '2-unlocked')
    }

    // --- 3. raise a real connection request ---------------------------------
    console.log('\n=== 3. APPROVAL SURFACE (eth_requestAccounts) ===')
    const dapp = await context.newPage()
    await dapp.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await dapp.waitForTimeout(2000)

    // Deliberately NOT awaited: it settles only once the request is answered.
    dapp
      .evaluate(`(() => {
        var eth = window.ethereum
        if (!eth) return 'no provider'
        window.__probeResult = 'pending'
        eth.request({ method: 'eth_requestAccounts' })
          .then(function (a) { window.__probeResult = 'approved:' + JSON.stringify(a) })
          .catch(function (e) { window.__probeResult = 'rejected:' + (e && e.message) })
        return 'fired'
      })()`)
      .catch(() => {})

    // Rabby opens its approval as a separate page/window.
    console.log('    waiting for the approval page…')
    let approval: Page | null = null
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && !approval) {
      approval =
        context.pages().find((p) => p.url().includes('notification.html')) ??
        context.pages().find((p) => p.url().includes(id) && p !== wallet) ??
        null
      if (!approval) await new Promise((r) => setTimeout(r, 500))
    }

    console.log(`\n    pages open now (${context.pages().length}):`)
    context.pages().forEach((p) => console.log(`      ${p.url()}`))

    if (approval) {
      console.log(`\n--- approval page → ${approval.url()}`)
      await capture(approval, '3-connect-approval')
    } else {
      console.log('\n    ⚠ no approval page appeared — capturing notification.html directly')
      const direct = await context.newPage()
      await direct
        .goto(`chrome-extension://${id}/notification.html`, {
          waitUntil: 'domcontentloaded',
          timeout: 15_000,
        })
        .catch(() => {})
      await capture(direct, '3-connect-approval')
    }

    console.log(`\n✅ probe complete — ${OUT}`)
    console.log('   NOTE: the request was left UNANSWERED on purpose. Nothing was approved.')
  } finally {
    await context.close()
  }
}

main().catch((error: Error) => {
  console.error(`\n❌ ${error.message}`)
  process.exit(1)
})
