import type { Page, Locator } from '@playwright/test'

/**
 * Single source of truth for dApp selectors.
 *
 * Strategy (in priority order):
 *   1. Role + accessible name  — `getByRole('button', { name: /supply/i })`
 *   2. Visible text            — `getByText(...)`
 *   3. Aave `data-cy` hooks    — the Aave interface (github.com/aave/interface)
 *      ships stable `data-cy` attributes for many controls. We prefer these
 *      over CSS where a role/text selector would be ambiguous.
 *
 * ⚠️ These target a live, third-party UI (app.aave.com testnet mode). Aave ships
 * UI changes regularly. If a spec fails on a "not found" locator, fix it HERE —
 * never scatter selectors back into the specs. Run `pnpm run test:headed` and
 * inspect with the Playwright Inspector / `page.pause()` to confirm hooks.
 */

// --- Wallet connection ------------------------------------------------------

export const connect = {
  /** Top-right "Connect wallet" entry point. */
  connectWalletButton: (page: Page): Locator =>
    page.getByRole('button', { name: /connect wallet/i }).first(),

  /** MetaMask option in the wallet-picker modal (verified against app.aave.com). */
  metaMaskOption: (page: Page): Locator =>
    page.getByRole('button', { name: /^metamask$/i }),

  /**
   * Aave shows an analytics consent prompt on first load. It can sit above the
   * connect flow, so dismiss it before interacting with the page.
   */
  analyticsOptOut: (page: Page): Locator =>
    page.getByRole('button', { name: /opt-out/i }),

  /**
   * The header control that, once connected, shows the truncated address
   * (e.g. "0x1234…abcd"). Its presence is what proves the dApp sees a wallet.
   * Doubles as the opener for the account menu, where "Disconnect" lives.
   */
  accountChip: (page: Page): Locator =>
    page.getByRole('button', { name: /0x[0-9a-f]{2,4}/i }).first(),

  /** Opens the account menu (disconnect lives inside). */
  openAccountMenu: (page: Page): Locator => connect.accountChip(page),

  disconnectButton: (page: Page): Locator =>
    page.getByRole('button', { name: /disconnect/i }),
}

// --- Network banner / switching --------------------------------------------

export const network = {
  /** Banner the dApp shows when the wallet is on an unsupported network. */
  wrongNetworkBanner: (page: Page): Locator =>
    page.getByText(/wrong network|unsupported|switch.*network|please switch/i).first(),

  /** In-app "switch network" CTA (triggers a MetaMask switch prompt). */
  switchNetworkButton: (page: Page): Locator =>
    page.getByRole('button', { name: /switch.*network|change network/i }),
}

// --- Markets / dashboard ----------------------------------------------------

export const markets = {
  /** "Supply <ASSET>" button on the dashboard / asset row. */
  supplyButton: (page: Page, asset: string): Locator =>
    page.getByRole('button', { name: new RegExp(`supply\\s+${asset}`, 'i') }).first(),

  /** Generic "Supply" button (e.g. inside the asset's action panel). */
  supplyButtonGeneric: (page: Page): Locator =>
    page.getByRole('button', { name: /^supply$/i }),

  borrowButton: (page: Page, asset: string): Locator =>
    page.getByRole('button', { name: new RegExp(`borrow\\s+${asset}`, 'i') }).first(),

  borrowButtonGeneric: (page: Page): Locator =>
    page.getByRole('button', { name: /^borrow$/i }),

  repayButton: (page: Page): Locator =>
    page.getByRole('button', { name: /^repay$/i }),

  withdrawButton: (page: Page): Locator =>
    page.getByRole('button', { name: /^withdraw$/i }),

  /** Faucet entry (testnet mode only). */
  faucetNavLink: (page: Page): Locator =>
    page.getByRole('link', { name: /faucet/i }),

  faucetMintButton: (page: Page, asset: string): Locator =>
    page.getByRole('button', { name: new RegExp(`faucet\\s+${asset}|mint`, 'i') }).first(),
}

// --- Action modal (shared by supply/borrow/repay/withdraw) ------------------

export const modal = {
  root: (page: Page): Locator => page.getByRole('dialog'),

  amountInput: (page: Page): Locator =>
    page.getByRole('dialog').locator('input[type="number"], input[inputmode="decimal"]').first(),

  /** "Max" shortcut next to the amount input. */
  maxButton: (page: Page): Locator =>
    page.getByRole('dialog').getByRole('button', { name: /^max$/i }),

  /**
   * Primary action button inside the modal. Aave relabels this through the
   * flow ("Approve", "Supply DAI", "Borrow", etc.), so match broadly and let
   * the caller pass the expected verb.
   */
  primaryAction: (page: Page, verb: RegExp): Locator =>
    page.getByRole('dialog').getByRole('button', { name: verb }).last(),

  /** Approve step that precedes some supply/repay actions (ERC-20 allowance). */
  approveButton: (page: Page): Locator =>
    page.getByRole('dialog').getByRole('button', { name: /^approve/i }),

  /** Success state shown after the tx mines. */
  successMessage: (page: Page): Locator =>
    page.getByRole('dialog').getByText(/all done|success|confirmed/i).first(),

  /** Inline validation error (insufficient balance, cap reached, …). */
  validationError: (page: Page): Locator =>
    page.getByRole('dialog').getByText(
      /not enough|insufficient|exceeds|cannot|too low|reached|disabled|no funds/i,
    ).first(),

  closeButton: (page: Page): Locator =>
    page.getByRole('dialog').getByRole('button', { name: /close|done|ok/i }).last(),
}

// --- Dashboard read-outs (assertions) --------------------------------------

export const dashboard = {
  /** Health-factor value shown on the dashboard once a position exists. */
  healthFactor: (page: Page): Locator =>
    page.locator('[data-cy="HealthFactorTopPanel"], [data-cy*="HealthFactor"]').first(),

  /** "Your supplies" section. */
  yourSupplies: (page: Page): Locator =>
    page.getByText(/your supplies/i).first(),

  /** "Your borrows" section. */
  yourBorrows: (page: Page): Locator =>
    page.getByText(/your borrows/i).first(),

  /** A supplied-asset row by symbol (proves an aToken position exists). */
  suppliedRow: (page: Page, asset: string): Locator =>
    page.locator('[data-cy*="dashboardSuppliedListItem"]').filter({ hasText: new RegExp(asset, 'i') }).first(),

  borrowedRow: (page: Page, asset: string): Locator =>
    page.locator('[data-cy*="dashboardBorrowedListItem"]').filter({ hasText: new RegExp(asset, 'i') }).first(),
}
