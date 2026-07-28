import { chromium, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import 'dotenv/config'
import { rabbyExtensionPath, browserArgsFor, rabbyProfilePath } from '../utils/wallet-cache'
import { unlockIfLocked } from '../utils/rabby-actions'

/**
 * Third Rabby probe: why does Aave never show an account chip after connect?
 *
 * CI run #9 (2026-07-28) recorded Rabby/reject = PASS but connect, sign and
 * reconnect all blocked on the same line — `connect.accountChip` never became
 * visible. Reject passing is the important clue: the extension loads, the
 * profile unlocks, Aave lists Rabby, the approval page opens and the click
 * lands. Everything works EXCEPT the state after approving.
 *
 * HYPOTHESIS TO TEST
 * The earlier approval probe showed Rabby offering the connection on
 * **Ethereum**. Aave here is Base Sepolia. Rabby hides testnets behind a
 * settings toggle, so the add/switch-network step may be failing silently —
 * `approveFollowUpRequests` is best effort and swallows exactly that.
 *
 * THE DECISIVE MEASUREMENT is not the DOM. It's what the provider itself says:
 *   eth_accounts  — did the connection actually happen?
 *   eth_chainId   — which chain did we land on?
 *
 *   empty accounts        -> the connect never completed
 *   accounts + wrong chain-> connected, but on Ethereum; the switch failed
 *   accounts + 0x14a34    -> connected correctly and the CHIP SELECTOR is wrong
 *
 * Those three point at completely different fixes, which is why guessing here
 * would have cost another 18-minute CI cycle.
 *
 *   pnpm exec tsx scripts/probe-rabby-aave.ts
 */

const OUT = path.join(process.cwd(), 'matrix-out', 'rabby-aave')
const DAPP = process.env.DAPP_URL ?? 'https://app.aave.com/?marketName=proto_base_sepolia_v3'
const BASE_SEPOLIA = '0x14a34' // 84532

const PROVIDER_STATE_JS = `(() => {
  return new Promise(function (resolve) {
    var chosen = null
    function onAnnounce(e) {
      if (e.detail && e.detail.info && e.detail.info.rdns === 'io.rabby') chosen = e.detail.provider
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(function () {
      var p = chosen || window.ethereum
      if (!p) { resolve({ error: 'no provider' }); return }
      Promise.all([
        p.request({ method: 'eth_accounts' }).catch(function (e) { return 'ERR:' + e.message }),
        p.request({ method: 'eth_chainId' }).catch(function (e) { return 'ERR:' + e.message })
      ]).then(function (r) {
        resolve({ via: chosen ? 'eip6963' : 'window.ethereum', accounts: r[0], chainId: r[1] })
      })
    }, 1500)
  })
})()`

async function snap(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {})
  const text = await page
    .evaluate(`document.body ? document.body.innerText : ''`)
    .catch(() => '')
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 14)
  console.log(`    [${name}] ${page.url()}`)
  lines.forEach((l) => console.log(`       | ${l}`))
}

async function providerState(page: Page, label: string): Promise<void> {
  const s = (await page.evaluate(PROVIDER_STATE_JS).catch((e) => ({ error: String(e) }))) as Record<
    string,
    unknown
  >
  const chain = s.chainId as string | undefined
  const verdict =
    s.error ? 'ERROR'
    : !Array.isArray(s.accounts) || s.accounts.length === 0 ? '>>> NOT CONNECTED'
    : chain === BASE_SEPOLIA ? '>>> CONNECTED on Base Sepolia (chip selector is the bug)'
    : `>>> CONNECTED but on ${chain} — network switch FAILED`
  console.log(`    PROVIDER (${label}): ${JSON.stringify(s)}`)
  console.log(`    ${verdict}`)
}

async function main() {
  const profile = rabbyProfilePath()
  if (!fs.existsSync(profile)) throw new Error(`no Rabby cache — run: pnpm run build:cache:rabby`)
  fs.mkdirSync(OUT, { recursive: true })

  const context = await chromium.launchPersistentContext(profile, {
    headless: false,
    args: browserArgsFor(rabbyExtensionPath()),
    viewport: { width: 1280, height: 720 },
  })
  await context.addInitScript(() => {
    try {
      if (window.location.hostname.endsWith('aave.com')) {
        window.localStorage.setItem('testnetsEnabled', 'true')
      }
    } catch {}
  })

  try {
    let [worker] = context.serviceWorkers()
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 60_000 })
    const id = new URL(worker.url()).host
    console.log(`extension id: ${id}`)

    // Unlock first — CI proved the cached profile reopens locked.
    const wallet = await context.newPage()
    await wallet
      .goto(`chrome-extension://${id}/index.html`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      .catch(() => {})
    await wallet.waitForTimeout(3000)
    console.log(`\n=== 1. UNLOCK ===`)
    console.log(`    unlocked: ${await unlockIfLocked(wallet)}`)

    // Which networks does Rabby think exist? Testnets are hidden by default,
    // which is the leading hypothesis for the switch failing.
    console.log(`\n=== 2. RABBY NETWORK LIST (is Base Sepolia even available?) ===`)
    await wallet
      .goto(`chrome-extension://${id}/index.html#/settings/chain-list`, {
        waitUntil: 'domcontentloaded',
        timeout: 20_000,
      })
      .catch(() => {})
    await wallet.waitForTimeout(3000)
    await snap(wallet, '1-rabby-chain-list')

    console.log(`\n=== 3. AAVE — CONNECT ===`)
    const page = await context.newPage()
    await page.goto(DAPP, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(4000)

    await page.getByRole('button', { name: /opt-out|reject/i }).first().click().catch(() => {})
    await page.getByRole('button', { name: /connect wallet/i }).first().click()
    await page.waitForTimeout(2000)
    await snap(page, '2-aave-wallet-list')

    await page.getByRole('button', { name: /rabby/i }).first().click()
    console.log('    clicked Rabby, waiting for the approval page…')

    let approval: Page | null = null
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline && !approval) {
      approval = context.pages().find((p) => p.url().includes('notification.html')) ?? null
      if (!approval) await new Promise((r) => setTimeout(r, 500))
    }
    if (!approval) {
      console.log('    ⚠ no approval page appeared')
      await snap(page, '3-no-approval')
      return
    }

    await approval.waitForTimeout(2500)
    await snap(approval, '3-approval-before')

    // WHICH CHAIN does the approval offer? This is the crux.
    const chainText = await approval.evaluate(`document.body.innerText`).catch(() => '')
    console.log(
      `    approval mentions Base Sepolia: ${/base sepolia/i.test(String(chainText))}` +
        ` | mentions Ethereum: ${/ethereum/i.test(String(chainText))}`,
    )

    console.log(`\n=== 4. APPROVE ===`)
    const connectBtn = approval.getByRole('button', { name: /^connect$/i }).first()
    console.log(`    Connect enabled: ${await connectBtn.isEnabled().catch(() => 'n/a')}`)
    await connectBtn.click({ timeout: 10_000 }).catch((e) => console.log(`    click failed: ${e.message.split('\n')[0]}`))
    await page.waitForTimeout(4000)

    await providerState(page, 'right after connect')

    console.log(`\n=== 5. ANY FOLLOW-UP APPROVAL (network switch)? ===`)
    let follow: Page | null = null
    const d2 = Date.now() + 15_000
    while (Date.now() < d2 && !follow) {
      follow = context.pages().find((p) => p.url().includes('notification.html') && !p.isClosed()) ?? null
      if (!follow) await new Promise((r) => setTimeout(r, 500))
    }
    if (follow) {
      await follow.waitForTimeout(2000)
      await snap(follow, '4-followup-approval')
      const btn = follow.getByRole('button', { name: /^(confirm|connect|switch|approve|allow)$/i }).first()
      if (await btn.isVisible({ timeout: 5000 }).catch(() => false)) {
        console.log(`    clicking "${await btn.innerText().catch(() => '?')}"`)
        await btn.click().catch(() => {})
        await page.waitForTimeout(5000)
      }
    } else {
      console.log('    none appeared — Aave did not raise a switch, or Rabby swallowed it')
    }

    console.log(`\n=== 6. FINAL STATE ===`)
    await providerState(page, 'final')
    await snap(page, '5-aave-final')

    const chipVisible = await page
      .getByRole('button', { name: /0x[0-9a-f]{2,4}/i })
      .first()
      .isVisible({ timeout: 5000 })
      .catch(() => false)
    console.log(`    account chip visible on Aave: ${chipVisible}`)

    console.log(`\n✅ ${OUT}`)
  } finally {
    await context.close()
  }
}

main().catch((e: Error) => {
  console.error(`\n❌ ${e.message}`)
  process.exit(1)
})
