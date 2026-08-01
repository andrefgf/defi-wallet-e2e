import type { Page } from '@playwright/test'
import { BASE_SEPOLIA } from './networks'

/**
 * ONE chain-approval policy, shared by every wallet.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 *
 * It did not, and that cost a published verdict.
 *
 * `rabby-actions.approveChainDialog` declined any dialog that wasn't offering
 * the chain under test. `metamask-actions.resolveRequest` approved whatever
 * appeared, with no chain check at all. Both behaviours were defensible on
 * their own; together they were a measurement bias.
 *
 * Aave requests a switch to Avalanche Fuji (43113) during connect on its Base
 * Sepolia market. So the Rabby column rejected that request and lost its
 * connection, the MetaMask column accepted it and kept one — and the resulting
 * difference was recorded as a difference between the WALLETS. It survived a CI
 * run, a green suite, and a written cell note, and was found only when a
 * narrowing probe printed the dApp's own dialog contents.
 *
 * The cell was retracted. The rule that replaced it:
 *
 *   ANY harness policy that can change a verdict must be identical across
 *   every column, or the columns are not comparable.
 *
 * ---------------------------------------------------------------------------
 * THE SEAM
 * ---------------------------------------------------------------------------
 *
 * Clicking is wallet-specific — different labels, different testids, different
 * multi-step flows. DECIDING is not. The bias lived entirely in the decision,
 * so the decision is what lives here. Each wallet reads its own notification
 * page, asks this module what to do, and then clicks in its own dialect.
 *
 * ---------------------------------------------------------------------------
 * THE POLICY
 * ---------------------------------------------------------------------------
 *
 * Approve a chain dialog only when it offers the chain under test.
 * Decline on a mismatch. Decline when unreadable.
 *
 * Declining on unreadable is deliberate and is the expensive lesson twice over:
 * an earlier version treated "couldn't read it" as "not a chain dialog" and
 * approved blind, which is how a run landed on Fuji despite a guard already
 * existing. A wallet dialog you cannot read is not a dialog you may accept.
 *
 * The permissive alternative — approve whatever the dApp asks — was considered
 * and rejected. It would land the wallet on Fuji, and every downstream cell
 * (`sign`, `reconnect`) would then be measuring on the wrong chain while the
 * results file claims `base-sepolia`. A blocked cell is honest. A passing cell
 * measured on the wrong network looks like data and is worse than nothing.
 */

/** The chain every cell is measured against. Single-chain suite, for now. */
export const TARGET_CHAIN_ID = BASE_SEPOLIA.chainId

export interface ChainDialogReading {
  /** Did the dialog render anything at all? */
  painted: boolean
  /** Does this screen offer to add or switch a network? */
  isChainDialog: boolean
  /** Rendered text plus every input value, joined. */
  haystack: string
  /** Input values, kept separately for logging. */
  inputs: string[]
  /** First plausible chain id found, for the log line. */
  sawChainId: string | null
}

export type ChainDecision = 'approve' | 'decline' | 'not-a-chain-dialog'

export interface ChainVerdict {
  decision: ChainDecision
  reason: string
}

/**
 * Read a wallet notification page without judging it.
 *
 * Waits for paint first. Wallets render an empty shell and fill it in; reading
 * too early returns '' and every downstream check is then operating on nothing.
 */
export async function readChainDialog(
  page: Page,
  paintTimeoutMs = 12_000,
): Promise<ChainDialogReading> {
  let text = ''
  const deadline = Date.now() + paintTimeoutMs
  while (Date.now() < deadline) {
    text = String(
      await page.evaluate(`document.body ? document.body.innerText : ''`).catch(() => ''),
    ).trim()
    if (text.length > 0) break
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!text) {
    return { painted: false, isChainDialog: false, haystack: '', inputs: [], sawChainId: null }
  }

  // Read the rendered text AND every input value.
  //
  // Got this wrong twice, in opposite directions. Reading the first input gave
  // the Network *name*. Reading `innerText` alone excludes input values, and the
  // Chain ID lives in an `<input>` — so that run logged `saw ?`, having found no
  // digits anywhere. Neither source alone can see the field. Match the union.
  const inputs = await page
    .locator('input')
    .evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).filter(Boolean))
    .catch(() => [] as string[])

  const haystack = [text, ...inputs].join(' | ')

  return {
    painted: true,
    // Detect on the ACTION, not on the phrase "chain id".
    //
    // This guard now runs on every confirm screen, including transactions. A
    // transaction confirmation can legitimately display a chain id in its
    // details — and if that alone marked it a "chain dialog", a supply or borrow
    // whose chain happened not to match would be silently DECLINED and the
    // lending tests would fail somewhere far from the cause.
    //
    // So require add/switch-network intent. "Chain id" still supplies the number
    // once we know it is a network prompt; it no longer decides that it is one.
    isChainDialog:
      /(add|switch)\s+(a\s+)?(custom\s+)?network|custom network|add ethereum chain|allow this site to (add|switch)/i.test(
        text,
      ),
    haystack,
    inputs,
    sawChainId: haystack.match(/\b\d{3,7}\b/)?.[0] ?? null,
  }
}

/**
 * The decision. Pure — no page, no clicking, no wallet.
 *
 * This function is the thing that must be identical across columns. Everything
 * else about how a wallet is driven may differ; this may not.
 */
export function decideChainDialog(
  reading: ChainDialogReading,
  expectedChainIdDec: number = TARGET_CHAIN_ID,
): ChainVerdict {
  if (!reading.painted) {
    return {
      decision: 'decline',
      reason: 'dialog never painted — declining rather than approving something unreadable',
    }
  }

  if (!reading.isChainDialog) {
    return { decision: 'not-a-chain-dialog', reason: 'no network add/switch on this screen' }
  }

  const wanted = String(expectedChainIdDec)
  // Bounded match: `4351` must not satisfy a request for `43`, and `84532` must
  // not be found inside `845321`.
  const matches = new RegExp(`(^|[^0-9])${wanted}([^0-9]|$)`).test(reading.haystack)

  return matches
    ? { decision: 'approve', reason: `chain ${wanted} offered` }
    : {
        decision: 'decline',
        reason: `wrong chain (saw ${reading.sawChainId ?? '?'}, want ${wanted})`,
      }
}

/** One log line, same shape for every wallet, so runs stay comparable by eye. */
export function logChainVerdict(wallet: string, verdict: ChainVerdict, reading: ChainDialogReading): void {
  if (verdict.decision === 'not-a-chain-dialog') return
  console.log(`  [${wallet}] chain dialog ${verdict.decision}: ${verdict.reason}`)
  if (verdict.decision === 'decline' && reading.inputs.length) {
    console.log(`  [${wallet}] inputs=${JSON.stringify(reading.inputs)}`)
  }
}
