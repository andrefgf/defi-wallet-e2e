# Web3 dApp E2E Wallet Testing Suite

> Automated end-to-end tests for a real DeFi dApp — covering wallet connection, on-chain transactions, and failure modes — using **Playwright + Synpress + MetaMask**, written in **TypeScript**.
>
> **Target:** Aave v3 on the **Base Sepolia** testnet — Aave's only remaining testnet market (Ethereum Sepolia has been retired from the app).

<!-- Wire these up once CI is green -->
<!-- ![E2E](https://img.shields.io/badge/e2e-passing-brightgreen) ![Playwright](https://img.shields.io/badge/Playwright-✓-blue) ![TypeScript](https://img.shields.io/badge/TypeScript-✓-blue) -->

---

## Why this exists

This is a public QA portfolio artifact. In web3, wallet-driven flows are the hardest and least-automated part of dApp testing — MetaMask popups, network switching, transaction signing, and on-chain state are exactly where most suites give up. This repo demonstrates that those flows can be automated, run in CI, and cover not just the happy path but the **failure modes that matter** when bugs are irreversible and expensive.

> Maintained by **André Guerra** — [LinkedIn](https://www.linkedin.com/in/andrefgfrancisco)

---

## What it tests

### Wallet setup & connection
- Cold connect: import the test wallet, connect MetaMask to the dApp, assert connected account + network.
- Network switching: the dApp asks the wallet to add + switch to Base Sepolia; we approve it, and also **reject** it and assert graceful handling.
- Disconnect / reconnect.

### Happy path (Aave v3, Base Sepolia)
- Acquire test tokens via the Aave faucet.
- **Supply** an asset as collateral; assert balances, aToken receipt, and tx confirmation.
- **Borrow** against collateral; assert borrowed balance + health-factor update.
- **Repay** the loan; assert debt reduction.
- **Withdraw** collateral; assert balance returns.

### Edge cases & failure modes (the part that signals real QA)
- User **rejects** the transaction in MetaMask — dApp shows the right error, no state change.
- **Insufficient collateral / LTV too low** — borrow is blocked with correct messaging.
- Attempt to **withdraw more than supplied** — blocked.
- **Wrong network** connected — dApp prompts to switch, actions disabled.
- **Borrow cap reached / asset not borrowable** — handled.
- **Pending / slow transaction** — UI reflects the pending state correctly.

### Cross-cutting
- Deterministic, isolated tests (cached wallet setup, clean state per test).
- Runs headless in CI.

---

## Tech stack
- **Language:** TypeScript
- **Runner:** Playwright
- **Web3 wallet automation:** Synpress **4.1.2** (`@synthetixio/synpress`) for the cached-wallet architecture — though most of its runtime turned out to be broken against the MetaMask it ships, and had to be replaced (see *Working around Synpress*)
- **Wallet:** MetaMask **13.13.1**, driven directly
- **Network:** **Base Sepolia** testnet (Aave's only live testnet market)
- **Target dApp:** Aave v3 testnet market (`app.aave.com`, testnet mode)
- **CI:** GitHub Actions

> ⚠️ Synpress evolves quickly. This suite was scaffolded against **Synpress 4.1.2**. Before changing the wallet layer, re-check the current version (`npm view @synthetixio/synpress version`) and the API at **docs.synpress.io**.

---

## Prerequisites
- **Linux or macOS — or Windows via WSL2** (see below). The Synpress CLI refuses to run on native Windows.
- Node.js 18+ and pnpm (or npm)
- A **dedicated, throwaway** MetaMask wallet — see *Security notes*. **Never** use a wallet that holds real funds.
- **Base Sepolia** ETH for gas (bridge from Sepolia, or a Base Sepolia faucet) — NOT Ethereum Sepolia ETH
- Aave test tokens (from the Aave testnet faucet inside the app)
- (Optional) A Base Sepolia RPC URL, for on-chain assertions

> ### ⚠️ Windows users: use WSL2
> Synpress's cache builder exits with *"Sorry, Windows is currently not supported. Please use WSL instead!"*, so the suite must be driven from a Linux environment.
>
> ```bash
> wsl -d Ubuntu                     # from PowerShell
>
> # Node must be a LINUX build — a Windows Node on $PATH via /mnt/c will fail.
> curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
> source ~/.nvm/nvm.sh && nvm install 20 && corepack enable && corepack prepare pnpm@10 --activate
>
> # Chromium's system libraries (needs root):
> sudo apt-get update && sudo apt-get install -y libnss3 libnspr4 libasound2t64
>
> cd /mnt/c/path/to/crispy-guide
> pnpm install                      # installs Linux-native binaries
> pnpm exec playwright install chromium
> ```
>
> WSL2 on Windows 11 ships **WSLg**, so `pnpm run test:headed` opens a real browser window — which is how you verify the dApp selectors. Run `pnpm install` from *inside* WSL: a `node_modules` installed on Windows carries win32 binaries (esbuild, Chromium) that Linux can't execute.

## Setup
1. `pnpm install` (installs Playwright + Synpress; Synpress downloads the MetaMask build on first cache run)
2. Copy `.env.example` → `.env` and fill in:
   ```dotenv
   SEED_PHRASE=...        # throwaway TEST wallet only
   WALLET_PASSWORD=...    # any value; used for the in-test MetaMask
   DAPP_URL=https://app.aave.com/?marketName=proto_base_sepolia_v3
   ```
   Then fund the wallet with **Base Sepolia** ETH:
   ```bash
   pnpm run wallet:address   # prints the address to fund
   pnpm run wallet:balance   # checks Base Sepolia + Sepolia balances
   ```
3. Build the wallet cache: `pnpm run build:cache` (headed) or `pnpm run build:cache:headless`
4. Run the tests (below)

> The wallet cache is keyed by a hash of the wallet-setup function. Change `wallet-setup/basic.setup.ts` and you must rebuild the cache.
>
> `build:cache` downloads MetaMask (`scripts/fetch-metamask.sh`) and then builds the browser profile with **our own builder** rather than the `synpress` CLI — see *Working around Synpress*. It verifies its own output, so if it prints ✅ the wallet really is in there.

## Running the tests
```bash
pnpm test              # headless
pnpm run test:headed   # watch it drive MetaMask
pnpm run test:ui       # Playwright UI mode
pnpm run report        # open the last HTML report
```

## Project structure
```
.
├─ wallet-setup/
│  └─ basic.setup.ts        # import wallet, finish MetaMask onboarding
├─ tests/
│  ├─ connection.spec.ts
│  ├─ supply-borrow.spec.ts
│  ├─ repay-withdraw.spec.ts
│  └─ edge-cases.spec.ts
├─ fixtures/
│  └─ metamask.ts           # testWithMetaMask fixture (replaces Synpress's)
├─ utils/
│  ├─ selectors.ts          # dApp selectors in one place
│  ├─ metamask-actions.ts   # wallet-popup actions (working MetaMask selectors)
│  ├─ wallet-cache.ts       # profile paths, launch args, unlock
│  └─ helpers.ts
├─ scripts/
│  ├─ fetch-metamask.sh     # download + extract MetaMask
│  ├─ build-cache.ts        # builds & verifies the wallet cache (replaces the CLI)
│  ├─ wallet-address.ts     # prints the test wallet address (for funding)
│  └─ check-balance.ts      # Base Sepolia / Sepolia balances
├─ .github/workflows/e2e.yml
├─ playwright.config.ts
├─ .env.example
└─ README.md
```

## The pattern

We do **not** use Synpress's `testWithSynpress` / `metaMaskFixtures` — they're broken against the MetaMask they ship (see below). The fixture is our own, and specs read like this:

```ts
import { test, expect } from '../fixtures/metamask'
import { connectWallet, expectConnected } from '../utils/helpers'

// `context` + `extensionId` come from the fixture; the wallet is already
// imported (from the cached profile) and unlocked.
test('connects wallet to the dApp', async ({ page, context, extensionId }) => {
  await connectWallet(page, context, extensionId)
  await expectConnected(page)
})
```

Wallet popups are driven through `utils/metamask-actions.ts`:

```ts
import * as mm from '../utils/metamask-actions'

await mm.confirmTransaction(context, extensionId)
await mm.rejectTransaction(context, extensionId)
await mm.approveSwitchNetwork(context, extensionId)
```

Synpress is still used for two things that *do* work: `defineWalletSetup` (which hashes the setup function to key the cache) and its `MetaMask` class for the onboarding/import flow.

## CI
GitHub Actions runs the suite headless on push / PR, under `xvfb` (Chromium extensions need a display server even with `--headless=new`), caching the downloaded MetaMask build and the Playwright browsers.

**Required repository secrets** (Settings → Secrets and variables → Actions) — a throwaway wallet only:

| Secret | Purpose |
|---|---|
| `SEED_PHRASE` | The throwaway test wallet to import |
| `WALLET_PASSWORD` | Password for the in-test MetaMask |

That's all: the wallet is imported from the seed, and the dApp drives any network switching itself, so no RPC URL is needed.

CI runs **`pnpm run test:ci`**, which currently executes the *verified* specs only (`connection.spec.ts`). The supply/borrow/repay/withdraw and edge-case specs need a funded wallet and still have unverified selectors — running them would make the badge red for reasons unrelated to the code under test. Each spec moves into `test:ci` as it is confirmed green. **The badge should only ever claim what actually passes.**

The connection tests spend **no gas**, so CI is free to run on every push.

## Security notes (read this)
- Use a **brand-new wallet created only for testing.** It must never hold mainnet assets.
- Keep `SEED_PHRASE` / private keys in `.env` (gitignored) locally, and in **GitHub secrets** for CI. Never commit them.
- Only ever point tests at **testnets.**
- Treat the seed phrase as compromised the moment it touches CI — it's a throwaway, so that's fine by design.

---

## Roadmap
- [x] **Phase 0** — Scaffold project, config, env, CI skeleton
- [x] **Phase 1** — Wallet setup + connection tests **— green against live Aave**
- [x] **Phase 2** — Happy-path supply / borrow / repay / withdraw *(written; needs a funded wallet to verify)*
- [x] **Phase 3** — Edge cases & failure modes *(written; needs a funded wallet to verify)*
- [ ] **Phase 4** — Green CI + status badge
- [ ] **Phase 5** — Demo gif / video

### Current status (honest)

| Suite | State |
|---|---|
| `connection.spec.ts` (3 tests) | ✅ **Passing** against live `app.aave.com` with a real MetaMask — **headed and headless** |
| `supply-borrow` / `repay-withdraw` / `edge-cases` | ⚠️ Written and type-checked, **not yet verified** — they need a wallet funded with **Base Sepolia** ETH + Aave faucet tokens, and their Aave selectors (`utils/selectors.ts`) still need confirming against the live UI |

The connection flow is the part that proves the hard bit works: a cached MetaMask, unlocked, driving a real dApp, approving and **rejecting** in the wallet popup. The remaining specs reuse exactly that machinery.

---

## Working around Synpress (the interesting part)

**Synpress 4.1.2 is broken against the MetaMask build it ships.** It pins MetaMask `13.13.1`, but its page objects predate MetaMask's multichain redesign. Getting to green meant diagnosing and routing around several real bugs — documented here because "the tool was broken and I fixed it" is the whole point of a QA portfolio.

| Problem | Reality | Fix |
|---|---|---|
| `synpress wallet-setup` CLI | Refuses to run on Windows; under WSL it hot-loops at ~96% CPU and never launches a browser | Replaced with [`scripts/build-cache.ts`](scripts/build-cache.ts), which builds the same profile directly |
| `importWallet()` | Stops at MetaMask's "Your wallet is ready!" screen and never clicks **Open wallet**, so onboarding never completes and the wallet home never renders | [`wallet-setup/basic.setup.ts`](wallet-setup/basic.setup.ts) finishes onboarding itself |
| `metaMaskFixtures()` | Its `unlockForFixture` never types the password in headless — every test dies with `Test timeout exceeded while setting up "page"`. **Passes headed, fails in CI.** | Replaced with our own fixture, [`fixtures/metamask.ts`](fixtures/metamask.ts) |
| `connectToDapp()` | Clicks `[data-testid="page-container-footer-next"]` — gone. The button is now `confirm-btn` | [`utils/metamask-actions.ts`](utils/metamask-actions.ts) |
| `switchNetwork()` / `addNetwork()` / `getAccountAddress()` | Depend on `network-display` / `address-copy-button-text`, which the redesign **removed entirely** — there is no longer a single "current network" element | Not used. The dApp requests the network switch itself and we approve it in the popup — which is the realistic user flow anyway |
| Cache built but tests saw "Create a new wallet" | The vault needs time to flush to disk; closing the browser too early yields a profile that *looks* built but has no wallet | The builder now **self-verifies** by reopening the profile and asserting the unlock screen appears |

### MetaMask in headless is a different animal

The suite passed headed and failed in CI. Three separate reasons, none of them obvious:

1. **No popup window exists.** Under `--headless=new` MetaMask never creates its confirmation window, so waiting for one hangs forever. The pending request *is* still served at `notification.html`, so we open that page ourselves.
2. **`load` never fires** on MetaMask's pages. A default `page.goto()` therefore blocks until it times out — and `page.reload()` has *no* timeout by default, so it hung indefinitely and silently ate the entire test budget. Everything now waits on `domcontentloaded` and is explicitly bounded.
3. **MetaMask takes ~30 seconds to boot** its notification UI in headless, sitting as an empty shell first. The instinctive fix — retry/reload until it renders — is exactly wrong: each reload *restarts* that boot, so it never finishes. You have to wait it out.

Also: never close-and-reopen the notification page to retry. Closing that window is how a user **rejects** a request, so retrying that way silently kills the very request you're waiting for.

That last set is why a connect flow takes ~4 minutes in CI, and why `timeout` in [`playwright.config.ts`](playwright.config.ts) is generous. The bounded action/navigation timeouts are what catch a genuine hang.

All wallet-popup interaction lives in **one file** — [`utils/metamask-actions.ts`](utils/metamask-actions.ts). If MetaMask's UI shifts again, that's the only thing to fix.

---

## Quality bar
- Tests are deterministic and independent: they rely on the cached wallet state and assert their own preconditions.
- Selectors prefer role/text; every dApp-specific selector lives in `utils/selectors.ts`, not scattered through specs.
- Each edge-case test asserts the **correct** failure (right message / blocked action / unchanged state), not merely that "something happened".
- Secrets are read from env only and never logged.

---

## Decision points for André

- [x] **Target dApp — SELECTED: Aave v3 (Sepolia).** Reliable Sepolia testnet, in-app faucet, rich multi-step flows (supply → borrow → repay → withdraw), and documented revert cases (insufficient collateral, LTV limits, borrow caps) that turn straight into edge-case tests. To repurpose: a DEX (e.g. a Uniswap testnet deployment) or an L2 market (Aave on Base / Arbitrum Sepolia) — verify the testnet is live first.
- [x] **Network — Base Sepolia.** Not a preference: Aave has retired its Ethereum Sepolia market, and Base Sepolia is the only testnet market left. The test wallet therefore needs **Base Sepolia** ETH for gas.
- [x] **Runner — Playwright.** Synpress also supports Cypress.
- [ ] **Repo name + identity.** Repo is `crispy-guide`; rename if you like. Name + LinkedIn are in *Why this exists*.

## Stretch goals (next portfolio pieces)
- Add a **Foundry** suite that forks Sepolia/mainnet and tests a protocol's contracts directly (fuzz + invariant tests).
- Open a **test-coverage PR** to an open-source protocol's repo.
- Write a short post breaking down one bug or edge case you found, and how the suite catches it.

## References
- Synpress docs — https://docs.synpress.io
- Synpress (npm) — https://www.npmjs.com/package/@synthetixio/synpress
- Aave testing & debugging docs — https://aave.com/docs
- Playwright docs — https://playwright.dev
