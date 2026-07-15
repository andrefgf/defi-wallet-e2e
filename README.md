<h1 align="center">defi-wallet-e2e</h1>

<p align="center">
  <b>End-to-end tests that drive a real MetaMask against live Aave v3</b><br/>
  Wallet connection · the full lending lifecycle · the failure modes that matter<br/>
  <sub>TypeScript + Playwright · every transaction really signed, really settled on-chain · green in CI</sub>
</p>

<p align="center">
  <a href="https://github.com/andrefgf/defi-wallet-e2e/actions/workflows/e2e.yml"><img alt="E2E" src="https://github.com/andrefgf/defi-wallet-e2e/actions/workflows/e2e.yml/badge.svg"></a>
  <img alt="Tests" src="https://img.shields.io/badge/tests-10%20passing-2EAD33">
  <img alt="Playwright" src="https://img.shields.io/badge/Playwright-2EAD33?logo=playwright&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white">
  <img alt="MetaMask" src="https://img.shields.io/badge/MetaMask-F6851B?logo=metamask&logoColor=white">
  <img alt="Aave v3" src="https://img.shields.io/badge/Aave-v3-B6509E?logo=aave&logoColor=white">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue">
</p>

> **Target:** Aave v3 on **Base Sepolia** (Aave's only remaining testnet market).

---

## Why this exists

In web3, wallet-driven flows are the hardest and least-automated part of dApp testing. MetaMask popups, network switching, transaction signing, security prompts, and irreversible on-chain state are exactly where most suites give up and start mocking.

This one doesn't mock. Every transaction here is **really signed in a real MetaMask extension** and **really settles on-chain** — and the assertions read the chain back to prove it.

> Maintained by **André Guerra** — [LinkedIn](https://www.linkedin.com/in/andrefgfrancisco)

---

## What passes

| Suite | Tests | What it proves |
|---|---|---|
| **`connection.spec.ts`** | 3 | Cold connect, **reject** the connection, disconnect — plus the add-network / switch-network handshake, asserting the wallet lands on the right chain |
| **`lending-lifecycle.spec.ts`** | 4 | **supply → borrow → repay → withdraw** against live Aave. Real transactions, verified against on-chain balances |
| **`edge-cases.spec.ts`** | 3 | User **rejects** a transaction, an over-sized supply is **blocked before it reaches the wallet**, and a wrong-network state **disables actions** instead of letting them fail |

The lending suite takes ~20 minutes: MetaMask's popup needs ~30s to boot for *each* interaction in headless, and a single supply is two on-chain transactions (ERC-20 approve, then the action). That's the honest cost of not mocking.

### Assertions worth reading

The point isn't that things pass — it's *what* is asserted:

- **Health factor.** Borrowing must produce a health factor **above 1** (the liquidation threshold), and taking on more debt must **lower** it. That number decides whether a user gets liquidated.
- **On-chain, not the DOM.** A row appearing in the UI only proves the frontend rendered. `utils/onchain.ts` reads balances straight from the node — supplying must *reduce* the wallet balance, withdrawing must *increase* it.
- **The negative case.** An over-sized supply must be blocked by the dApp *and never reach the wallet at all*. A UI that submits it and lets the chain revert has already failed the user — it costs them gas.

### Two things the protocol taught me

Written into the tests, because they're easy to get wrong:

- **You cannot fully repay a loan with only what you borrowed.** Interest accrues from the moment you borrow, so the debt is always a hair larger than the tokens received. A test asserting "debt hits exactly zero" is asserting something the protocol *cannot do*. So repay asserts the health factor **rises**.
- **The chain is persistent.** A wallet that borrowed in an earlier run still carries that position. Assertions must hold on *any* wallet state, not just a pristine one.

---

## Working around a broken toolchain

**Synpress 4.1.2 — the standard tool for this job — is broken against the MetaMask it ships.** It pins MetaMask `13.13.1` (the current release is `13.39.x`) and most of its runtime had to be replaced. This was the bulk of the work, and it's the part worth reading.

| Problem | Reality | Fix |
|---|---|---|
| **MetaMask 13.13.1 cannot broadcast transactions on Base Sepolia** | It mangles the RPC payload (`failed to decode param in array[0] invalid JSON input`) on an endpoint viem talks to happily. The dApp just says "Transaction failed". Every transaction test was dead on arrival. | Proved it with a control experiment (below), then upgraded to **13.39.1** |
| `synpress wallet-setup` CLI | Refuses to run on Windows; under WSL it hot-loops at ~96% CPU and never launches a browser | Replaced with [`scripts/build-cache.ts`](scripts/build-cache.ts), which **self-verifies** the wallet really persisted |
| `metaMaskFixtures()` | Never types the password in headless — every test dies with `Test timeout exceeded while setting up "page"`. **Passes headed, fails in CI.** | Our own fixture, [`fixtures/metamask.ts`](fixtures/metamask.ts) |
| `MetaMask.importWallet()` | Targets an onboarding flow that no longer exists | [`utils/onboarding.ts`](utils/onboarding.ts) |
| `connectToDapp()` / `switchNetwork()` / `getAccountAddress()` | Target elements MetaMask's redesign **deleted** | [`utils/metamask-actions.ts`](utils/metamask-actions.ts) |

Synpress is now used for exactly one thing that still works: `defineWalletSetup`, which hashes the setup function to key the wallet cache.

### The control experiment

The faucet kept reporting "Transaction failed" and it looked like a contract revert. Instead of guessing, I intercepted the exact `eth_sendTransaction` payload the dApp handed to the wallet, confirmed it was well-formed, and **replayed that identical transaction through viem on the same RPC** — where it succeeded immediately.

Same transaction, same chain, same endpoint, same wallet. Works via viem, fails via MetaMask. That isolates the bug to the wallet, not the dApp, not the chain, not the RPC — and it's what justified the version upgrade. ([`scripts/mint-test-tokens.ts`](scripts/mint-test-tokens.ts) is the surviving harness.)

### MetaMask in headless is a different animal

The suite passed headed and failed in CI. Three reasons, none obvious:

1. **No popup window exists** under `--headless=new`. Waiting for one hangs forever. The pending request *is* still served at `notification.html`, so we open that page ourselves.
2. **`load` never fires** on MetaMask's pages, so a default `goto()` burns its timeout — and `page.reload()` has *no* timeout by default, so it hung indefinitely and silently ate the whole test budget.
3. **MetaMask takes ~30s to boot** its notification UI, sitting blank first. The instinctive fix — reload until it renders — is exactly wrong: each reload **restarts** that boot, so it never finishes.

Plus: never close-and-reopen that page to retry. Closing MetaMask's notification window is how a user **rejects** — retrying that way silently kills the request you're waiting for.

### MetaMask's security scanner blocks automation

MetaMask's Blockaid scanner has no reputation data for **testnet** contracts, so it flags Aave's legitimate pool as a **"Malicious address"** — *"you will probably lose your assets to a scammer"* — and stacks **two** gates in front of every transaction:

1. `"Malicious address"` → an informational modal ("Got it")
2. `"Your assets may be at risk"` → an acknowledgement checkbox, then a Confirm **inside** that modal (the footer Confirm merely reopens it)

Unhandled, transactions never sign and the dApp waits forever. Handled in `metamask-actions.ts` — with a warning **not** to copy that pattern anywhere near mainnet, where the alert may well be telling the truth.

### Aave's selectors, for the record

Its modal is a MUI `role="presentation"` — **never** `role="dialog"`, so every `getByRole('dialog')` locator silently matches nothing. The rest is `data-cy`, with traps:

| Element | Hook | Trap |
|---|---|---|
| Modal | `Modal` | Not a `dialog` role |
| Approve step | `approvalButton` | **Separate** from the action button — an ERC-20 flow is two transactions, two stacked buttons, one enabled at a time |
| Action step | `actionButton` | Disabled until the approval lands |
| Amount field | *(the only `<input>`)* | `data-cy="inputAsset"` is a red herring — it's the `<h3>` showing "USDC" |
| Supplied row | `dashboardSuppliedListItem_USDC_Collateral` | Aave appends a **state suffix**; an exact match finds nothing |

All of it lives in [`utils/selectors.ts`](utils/selectors.ts). One file to fix when Aave ships a redesign.

---

## Running it

### Prerequisites
- **Linux, macOS, or Windows via WSL2** — the Synpress CLI refuses to run on native Windows
- Node.js 18+ and pnpm
- A **dedicated, throwaway** wallet. Never one that holds real funds.
- **Base Sepolia** ETH for gas (not Ethereum Sepolia — different chain)

### Setup
```bash
pnpm install
cp .env.example .env          # add SEED_PHRASE + WALLET_PASSWORD

pnpm run wallet:address       # the address to fund
pnpm run wallet:balance       # check Base Sepolia gas + USDC
pnpm run mint:tokens          # mint test USDC (faucet has a mint timelock)

pnpm run build:cache          # import the wallet once; cached and reused
```

### Tests
```bash
pnpm test                     # everything, headless (what CI runs)
pnpm run test:smoke           # connection only — the quick check
pnpm run test:headed          # watch it drive MetaMask for real
pnpm run test:demo            # everything + video recording (slow; see below)
pnpm run report               # ← open the report
```

### Watching the user journey

Traces and screenshots are captured on **every** run, not just failures — these specs *are* the deliverable. `pnpm run report` opens an HTML report where each test gives you:

- **A trace** — Playwright's time-travel debugger. Scrub the whole journey with a full DOM snapshot before and after every action, plus the network calls behind each one. This is the best way to watch the flow.
- **Named milestone screenshots**, so it reads as a story rather than a log:
  ```
  1. Wallet connected on Base Sepolia
  2. Supply 100 USDC — before signing
  3. Supply USDC — confirmed on-chain
  4. Borrow 10 USDT — before signing
  …
  ```
- **Named steps** (`test.step`) — "Connect MetaMask to Aave", "Switch the wallet to Base Sepolia", "Supply 100 USDC as collateral" — so the report is legible to someone who has never seen the code.

CI uploads the same report as the **`playwright-report`** artifact on every run.

**Video is opt-in** (`pnpm run test:demo`). Playwright films *every* page in the context — which here means every MetaMask popup, 30+ clips per run — and it pushed a 3.8-minute test to 9 minutes. The trace already gives you a scrubable filmstrip, so paying that on every CI run buys almost nothing. Turn it on when you want footage to hand someone.

> Test tokens are a **precondition**, not the thing under test — Aave's faucet enforces a mint timelock, so driving it every run would guarantee flakes. `mint:tokens` handles it out-of-band.

<details>
<summary><b>Windows: WSL2 setup</b></summary>

```bash
wsl -d Ubuntu

# Node must be a LINUX build — a Windows Node on $PATH via /mnt/c will fail.
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.nvm/nvm.sh && nvm install 20 && corepack enable && corepack prepare pnpm@10 --activate

sudo apt-get update && sudo apt-get install -y libnss3 libnspr4 libasound2t64

cd /mnt/c/path/to/defi-wallet-e2e
pnpm install                  # from INSIDE WSL: a Windows node_modules carries
pnpm exec playwright install chromium   # win32 binaries Linux can't execute
```
WSL2 ships **WSLg**, so `test:headed` opens a real browser window.
</details>

---

## Project structure
```
├─ tests/
│  ├─ connection.spec.ts        # connect / reject / disconnect + network handshake
│  ├─ lending-lifecycle.spec.ts # supply → borrow → repay → withdraw (serial)
│  └─ edge-cases.spec.ts        # rejection, blocked actions, wrong network
├─ fixtures/metamask.ts         # cached, unlocked wallet per test
├─ utils/
│  ├─ selectors.ts              # every dApp selector, one file
│  ├─ metamask-actions.ts       # every wallet popup, one file
│  ├─ onboarding.ts             # imports the wallet (replaces Synpress)
│  ├─ onchain.ts                # balances read from the node (viem)
│  ├─ networks.ts               # Base Sepolia
│  └─ helpers.ts                # behaviour-level flows
├─ scripts/
│  ├─ build-cache.ts            # builds + verifies the wallet cache
│  ├─ fetch-metamask.sh         # downloads MetaMask
│  ├─ mint-test-tokens.ts       # mints test USDC on-chain
│  ├─ wallet-address.ts         # the address to fund
│  └─ check-balance.ts          # gas + token balances
└─ .github/workflows/e2e.yml
```

**The design rule:** every dApp selector lives in `selectors.ts`, every wallet interaction in `metamask-actions.ts`. MetaMask and Aave both ship UI changes constantly — when they do, there is exactly one file to fix.

---

## CI

GitHub Actions runs the **entire suite** headless under `xvfb` on push / PR — all 10 tests, including every on-chain transaction. It caches the MetaMask build and the Playwright browsers, and takes ~40 minutes: MetaMask's popup needs ~30s to boot for *each* interaction, and a single supply is two transactions.

**Required secrets** (a throwaway wallet only): `SEED_PHRASE`, `WALLET_PASSWORD`.

A **preflight** step (`pnpm run preflight`) checks the wallet still has gas and test tokens *before* the browsers start — so a depleted wallet fails in ten seconds with an actionable message instead of twenty minutes later from inside a wallet popup. The suite nets about **-75 USDC per run**; `pnpm run mint:tokens` tops it up.

Every run uploads a **`playwright-report` artifact** containing the videos, traces and screenshots (below).

## Security notes
- Use a **brand-new wallet created only for testing.** It must never hold mainnet assets.
- `SEED_PHRASE` lives in `.env` (gitignored) and GitHub secrets. Never in the repo.
- Only ever point this at **testnets**.
- Treat the seed as compromised the moment it touches CI — it's a throwaway, so that's fine by design.

## Next
- [ ] A **Foundry** suite that forks the chain and tests the contracts directly (fuzz + invariant tests)
- [ ] Liquidation: push a position below health factor 1 and assert it's liquidatable
- [ ] Report the MetaMask 13.13.1 Base Sepolia broadcast bug upstream

## References
- Aave — https://aave.com/docs · Synpress — https://docs.synpress.io · Playwright — https://playwright.dev
