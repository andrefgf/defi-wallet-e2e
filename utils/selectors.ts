import type { Page, Locator } from '@playwright/test'

/**
 * Single source of truth for dApp selectors (Aave v3, Base Sepolia market).
 *
 * These are the hooks Aave actually ships — captured off the live app, not
 * guessed. Two things worth knowing:
 *
 *  - Aave's modal is a MUI `role="presentation"`, NOT `role="dialog"`. Every
 *    `getByRole('dialog')` locator silently matches nothing.
 *  - Its `data-cy` attributes (`Modal`, `actionButton`, `faucetListItem_USDC`,
 *    `dashboardSupplyListItem_USDC`, …) are stable and far better than text,
 *    which changes with the asset and the flow's step.
 *
 * If a spec fails on a "not found" locator, fix it HERE — never scatter
 * selectors back into the specs.
 */

// --- Wallet connection ------------------------------------------------------

export const connect = {
  connectWalletButton: (page: Page): Locator =>
    page.getByRole('button', { name: /connect wallet/i }).first(),

  /** MetaMask entry in the wallet picker. */
  metaMaskOption: (page: Page): Locator => page.getByRole('button', { name: /^metamask$/i }),

  /** Aave's first-load analytics consent; it can sit over the connect flow. */
  analyticsOptOut: (page: Page): Locator => page.getByRole('button', { name: /opt-out/i }),

  /**
   * Header control showing the truncated address once connected (e.g.
   * "0xb1…c171"). Its presence is what proves the dApp sees a wallet; it also
   * opens the account menu, where "Disconnect" lives.
   */
  accountChip: (page: Page): Locator =>
    page.getByRole('button', { name: /0x[0-9a-f]{2,4}/i }).first(),

  openAccountMenu: (page: Page): Locator => connect.accountChip(page),

  disconnectButton: (page: Page): Locator => page.getByRole('button', { name: /disconnect/i }),
}

// --- Navigation -------------------------------------------------------------

export const nav = {
  dashboard: (page: Page): Locator => page.getByRole('link', { name: /dashboard/i }).first(),
  markets: (page: Page): Locator => page.getByRole('link', { name: /markets/i }).first(),
  faucet: (page: Page): Locator => page.getByRole('link', { name: /faucet/i }).first(),
}

// --- Faucet (testnet only) --------------------------------------------------

export const faucet = {
  /** Row for an asset, e.g. `faucetListItem_USDC`. */
  row: (page: Page, asset: string): Locator =>
    page.locator(`[data-cy="faucetListItem_${asset.toUpperCase()}"]`),

  /** The "Faucet" button inside that asset's row. */
  mintButton: (page: Page, asset: string): Locator =>
    faucet.row(page, asset).getByRole('button').first(),
}

// --- Modal (shared by faucet / supply / borrow / repay / withdraw) -----------

export const modal = {
  /** Aave's modal. NOT role=dialog — it's a MUI presentation container. */
  root: (page: Page): Locator => page.locator('[data-cy="Modal"]').last(),

  /**
   * BOTH steps of an ERC-20 flow, in DOM order.
   *
   * Aave renders them as two separate buttons with two DIFFERENT hooks, stacked
   * in the same modal, with only one enabled at a time:
   *
   *   [data-cy="approvalButton"]  "Approve USDC to continue"   (step 1)
   *   [data-cy="actionButton"]    "Supply USDC"                (step 2)
   *
   * Matching only `actionButton` silently misses the live Approve button and the
   * flow stalls forever on a modal that looks perfectly fine.
   */
  actionButtons: (page: Page): Locator =>
    modal.root(page).locator('[data-cy="approvalButton"], [data-cy="actionButton"]'),

  /** The ERC-20 allowance step. */
  approvalButton: (page: Page): Locator =>
    modal.root(page).locator('[data-cy="approvalButton"]'),

  /**
   * The FINAL action ("Supply USDC", not the Approve step). Aave relabels it
   * through the flow — and tellingly renders "Wrong Network" here when the
   * chain is wrong — so match the hook, not the text.
   */
  actionButton: (page: Page): Locator => modal.root(page).locator('[data-cy="actionButton"]'),

  /**
   * The amount field.
   *
   * It carries no hook of its own, and `data-cy="inputAsset"` is a red herring —
   * that's the <h3> showing the asset's NAME ("USDC"), not the input. The amount
   * box is simply the only <input> in the modal.
   */
  amountInput: (page: Page): Locator => modal.root(page).locator('input').first(),

  /** "MAX" — fills the full available balance / debt. */
  maxButton: (page: Page): Locator => modal.root(page).getByRole('button', { name: /^max$/i }),

  closeButton: (page: Page): Locator => modal.root(page).locator('[data-cy="close-button"]'),

  /** Terminal success state ("All done!"). */
  success: (page: Page): Locator => modal.root(page).getByText(/all done/i),

  /** Terminal failure state. */
  failure: (page: Page): Locator => modal.root(page).getByText(/transaction failed/i),

  /** Inline validation (insufficient balance, cap reached, …). */
  validationError: (page: Page): Locator =>
    modal
      .root(page)
      .getByText(/not enough|insufficient|exceeds|cannot|too low|reached|no funds|wrong network/i)
      .first(),
}

// --- Dashboard --------------------------------------------------------------

export const dashboard = {
  /** Suppliable asset row, e.g. `dashboardSupplyListItem_USDC`. */
  supplyRow: (page: Page, asset: string): Locator =>
    page.locator(`[data-cy="dashboardSupplyListItem_${asset.toUpperCase()}"]`),

  /** Borrowable asset row, e.g. `dashboardBorrowListItem_USDC`. */
  borrowRow: (page: Page, asset: string): Locator =>
    page.locator(`[data-cy="dashboardBorrowListItem_${asset.toUpperCase()}"]`),

  supplyButton: (page: Page, asset: string): Locator =>
    dashboard.supplyRow(page, asset).getByRole('button', { name: /supply/i }).first(),

  borrowButton: (page: Page, asset: string): Locator =>
    dashboard.borrowRow(page, asset).getByRole('button', { name: /borrow/i }).first(),

  /**
   * Rows in "Your supplies" / "Your borrows", once a position exists.
   *
   * Prefix match on purpose: Aave appends a state suffix to these hooks — a
   * supplied position reads `dashboardSuppliedListItem_USDC_Collateral` when
   * it's being used as collateral. An exact match silently finds nothing.
   */
  suppliedRow: (page: Page, asset: string): Locator =>
    page.locator(`[data-cy^="dashboardSuppliedListItem_${asset.toUpperCase()}"]`),

  borrowedRow: (page: Page, asset: string): Locator =>
    page.locator(`[data-cy^="dashboardBorrowedListItem_${asset.toUpperCase()}"]`),

  withdrawButton: (page: Page, asset: string): Locator =>
    dashboard.suppliedRow(page, asset).getByRole('button', { name: /withdraw/i }).first(),

  repayButton: (page: Page, asset: string): Locator =>
    dashboard.borrowedRow(page, asset).getByRole('button', { name: /repay/i }).first(),

  /** Health factor, shown once collateral is supplied. */
  healthFactor: (page: Page): Locator =>
    page.locator('[data-cy="HealthFactorTopPanel"], [data-cy*="HealthFactor"]').first(),
}

// --- Network state ----------------------------------------------------------

export const network = {
  /** Aave's wrong-network warning; it also disables the modal's action button. */
  wrongNetworkBanner: (page: Page): Locator =>
    page.getByText(/wrong network|couldn't switch the network|please switch/i).first(),
}
