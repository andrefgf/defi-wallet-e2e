# Manual reproduction runbook

Every step, in order, with the **expected result** for each. Run it top to bottom
when something looks wrong, or when a claim in `tests/matrix/STATUS.md` needs
re-checking.

## Why this file exists

This project has recorded a false finding, retracted a published cell, and twice
nearly published a claim about a vendor's product that a controlled run then
disproved. In every case the failure was the same shape: **a conclusion drawn
from a partial observation, with no stated expectation to compare against.**

So the rule is now:

> Before calling anything a bug, run the step that would produce it and compare
> against the expected result written below. If the observed result is not in
> this file, the honest report is *"unexpected output, cause unknown"* — not a
> diagnosis.

A step that produces the expected result rules something out. That is worth as
much as one that fails, and it is cheaper.

## What counts as evidence

Ranked by how often each has actually settled a question here:

1. **A screenshot.** Twice decisive when logs were silent — a disabled Rabby
   button that never errored, and Aave rendering the mainnet market while the URL
   said Base Sepolia. A silent state cannot appear in a log.
2. **Raw values printed verbatim** (`inputs=[...]`, dialog fields, error codes).
   Summaries hide the answer; the Chain ID was read wrongly twice in opposite
   directions before the raw union of text and input values was printed.
3. **A control run** — the same measurement with one variable moved.
4. **Logs.** Useful, and the weakest of the four. Six log-driven iterations on the
   Rabby connect blocker each found a real but non-decisive bug.

---

# A. Environment

### A1. Typecheck

```powershell
cd C:\Users\Andre\defi-wallet-e2e
pnpm run typecheck
```

**Expected:** no output, exit 0.

**If it fails:** read *which file*. Errors confined to one file are that file's
problem, not the harness's. `noUncheckedIndexedAccess: true` is on, so
`record[key]` is `string | undefined` — TS2322/TS2532/TS2538 in a batch almost
always means indexed access, not a logic error. **Do not fix these with
`as string`**; the flag exists to catch exactly the "I assumed the key was there"
assumption this harness keeps being bitten by.

### A2. Env vars

```powershell
Get-Content .env
```

**Expected:** `SEED_PHRASE`, `WALLET_PASSWORD`, `RABBY_SEED_PHRASE`,
`RABBY_WALLET_PASSWORD` all populated. `PHANTOM_*` may be blank — only phase 4 of
the Phantom probe needs them.

**Never** a seed that has held value. Testnets only.

---

# B. Wallet builds

### B1. MetaMask

```powershell
pnpm run fetch:metamask
```

**Expected:** resolves **13.39.1** (pinned via `METAMASK_VERSION`).

**If the version differs:** stop. MetaMask renamed the Connect button's test id
between 13.13.1 and 13.39.1 and silently broke the whole connect flow. A version
change is a plausible cause for *any* MetaMask symptom and must be ruled out
before anything else is investigated.

### B2. Rabby

```powershell
pnpm run fetch:rabby
```

**Expected:** `Rabby ready: …\.cache-synpress\rabby-chrome-0.93.100`,
`version=0.93.100`, `manifest_version=3`.

### B3. Phantom

```powershell
pnpm run fetch:phantom
```

**Expected:** a boxed `RECORD THIS: wallet_version = …` banner.
**Last observed: 26.24.0**, `manifest_version=3`.

**Phantom CANNOT be pinned** — Web Store only, no published build. If the version
has moved since 26.24.0, every Phantom observation in STATUS.md was made on a
different build and must be re-run before being cited. This is the single most
fragile thing in the repo.

---

# C. Wallet caches

### C1. MetaMask cache

```powershell
pnpm run build:cache:headless
```

**Expected:** completes; a `.cache-synpress\metamask-profile-*` directory exists.

### C2. Rabby cache

```powershell
pnpm run build:cache:rabby
```

**Expected:** built and verified, and it reports the profile **reopens LOCKED**
with the vault present. Burner address `0xe59c45…706010`.

**"Reopens LOCKED" is correct, not a failure.** Unlock is on the critical path of
every Rabby run, which is why `fixtures/rabby.ts` calls `unlockIfLocked`.

---

# D. Probes

Probes look; they never record a cell.

### D1. Phantom reconnaissance

```powershell
pnpm run probe:phantom
```

A headed Chromium opens and closes. ~2 minutes.

| Phase | Expected result |
|---|---|
| 0 | version + `MV3? YES`, extension id `bfnaelmomeimhlpmgjnjophhpkkoljpa` |
| 1 `onboarding.html` | paints; buttons **"Create a New Wallet"**, **"I Already Have a Wallet"**; `testIds=2` |
| 1 `popup.html` | **"Target page… has been closed"** — *expected*, see below |
| 1 `index.html` | **"Your file couldn't be accessed"** — *expected*; the route does not exist |
| 1 `notification.html` | `painted=false`, `bodyChars=0` — *expected*, see below |
| 2 | one announcement, `rdns: "app.phantom"`, flags `["isPhantom","isMetaMask"]` |
| 3 target `0x14a34` | `rejected`, **code 4901** |
| 3 control `0x2105` | `resolved`, `returned: "null"` |
| 3 sepolia `0xaa36a7` | `rejected`, **code 4901** |
| 4 | `SKIPPED` unless `PHANTOM_SEED_PHRASE` is set |

**Three non-defects, and they cost three probe runs to learn once already.**
`popup.html` closing and `notification.html` painting nothing are **normal empty
states** — an approval surface with nothing pending closes itself. `index.html`
simply is not a Phantom route. None of the three is a bug. Do not report them.

**Reading phase 3:** the three requests share one provider **in sequence**, so
state carries — run 3 showed `before=0x1` for the target and `before=0x2105` for
Sepolia, because the control actually switched the wallet. That is enough to make
a planning decision and **not** enough to publish. To publish, re-run each request
in its own fresh context with the order randomised.

### D2. Provider identity — does load order decide `window.ethereum`?

```powershell
pnpm run probe:identity
# or: $env:PROBE_REPEATS=5; pnpm run probe:identity
```

Needs at least **two** wallets fetched. Opens and closes one browser per run
(configs x repeats), so 5 configs x 3 repeats = 15 windows. Several minutes.

**Expected shape:** per config, N signature lines then either
`-> STABLE across repeats` or `-> UNSTABLE: n different answers`, then a VERDICT
block.

**How to read the verdict — the whole point of the probe:**

| Observed | Conclusion |
|---|---|
| `A,B` and `B,A` both STABLE and **different** | load order decides. P2 supported. |
| `A,B` and `B,A` both STABLE and **same** | order does **not** decide. **The "install order" claim is false as written** and must not be published. |
| Any config **UNSTABLE** | a **race**, not an order. Stronger than either, and invisible to a single run. Report as non-deterministic. |

**Do not** read a single run as evidence for any of the three.

**Independently settled, and not what this probe tests:** a wallet setting
`isMetaMask` on its *own* announced provider. Phantom does, observed in a
single-extension profile — no neighbours, no ambiguity. That is impersonation.
Load order is precedence. Different claims; keep them apart.

---

# E. The matrix

### E1. Local run — iterate only, never record

```powershell
pnpm test tests/matrix/aave.rabby.spec.ts
```

**Expected on this laptop: RED, and that is not informative.** Settled
2026-07-26 by a natural experiment — same spec, same commit, hours apart, laptop
all-red and CI all-green. The machine cannot sustain Chromium + a real wallet +
Aave; connect alone took 8.8 minutes locally and the box OOM'd.

**A cell is only ever recorded from a CI run.** This has cost two evenings across
two sessions. Do not pay it again.

Local runs are for: does the code execute, do selectors resolve, does the flow
reach the step you changed.

### E2. CI run — the only thing that produces verdicts

```powershell
git push origin matrix-runner
# or: GitHub → Actions → Matrix → Run workflow
```

**Expected:** job **succeeds** in roughly 11–13 minutes, 8 tests passed.

**A failing CELL does not fail the job** — `matrix.yml` captures every `MATRIX:`
line and never lets a cell redden the build. A red *job* means the harness broke,
which is a different problem from a cell failing.

**Expected output**, one line per cell, in the run Summary and in
`matrix-out/results.txt` inside the `matrix-results` artifact:

```
MATRIX: Aave/MetaMask/connect   = pass (chip="0xb1...c171", account=0xb1c375ec…c171, chain=base-sepolia)
MATRIX: Aave/MetaMask/sign      = pass (recovered=0xB1c375ec…c171, account=0xb1c375ec…c171, via=eip6963, …)
MATRIX: Aave/MetaMask/reconnect = pass (outcome=restored, before == after)
MATRIX: Aave/MetaMask/reject    = pass
MATRIX: Aave/Rabby/sign         = pass (via=eip6963)
MATRIX: Aave/Rabby/reconnect    = pass (outcome=restored)
MATRIX: Aave/Rabby/reject       = pass
MATRIX: Aave/Rabby/connect      = ← THE ONE UNDER TEST
```

**`via=eip6963` matters.** It means the provider was resolved by rdns, not the
legacy `window.ethereum` slot. If a line ever reports a legacy fallback, that cell
measured *a* wallet, not necessarily *the* wallet — three vendors now claim
`isMetaMask` on that slot.

**Case:** `recovered` comes back EIP-55 checksummed against a lowercase
`account`. The comparison is case-insensitive on purpose. A naive `===` reports a
**false fail**.

### E3. Reading the chain-order trace — new, and it is the point

Since 2026-08-07 the Rabby fixture installs `CHAIN_REQUEST_HOOK`, so every
`wallet_addEthereumChain` / `wallet_switchEthereumChain` — **Aave's and ours** —
is logged on one clock. In the run log, after the connect step:

```
[chain-order] Rabby connect — N chain request(s)
  +  1234ms  wallet_addEthereumChain  chainId=0xa869 (Avalanche Fuji)  rdns=io.rabby  caller~dapp?
  +  5678ms  wallet_addEthereumChain  chainId=0x14a34                  rdns=io.rabby  caller~harness?
```

| Observed | Means |
|---|---|
| **`0` requests** | the hook did not install. Check it is added via `addInitScript` **before** the page loads. Nothing about ordering can be concluded. |
| dApp's Fuji request **first**, ours second | the harness answered after the dApp asked. Compare against the MetaMask column once it is on the shared path. |
| ours **first**, dApp's second | the reverse ordering — and if the two columns differ here, **that is the harness, not the wallet**. |
| both columns identical | ordering is ruled out and any remaining divergence is real. |

`caller~` is a **stack heuristic** (`harness?` / `dapp?`), good enough to read a
timeline and **not** good enough to publish an attribution. Say "the call
recorded at +1234ms", not "Aave called".

---

# F. What may be concluded from what

| You have | You may say | You may **not** say |
|---|---|---|
| one local run | "it did X on this machine" | anything about a wallet or a dApp |
| one CI run | "the cell measured X on run N" | that it is stable |
| two CI runs agreeing | "stable across two runs" | a cause |
| a control (one variable moved) | "the response depends on that variable" | the mechanism |
| a screenshot of the state | what is on screen | why it is there |
| a verbatim error code | the code and message | that it is a spec violation, unless the spec mandates a code |

**Two explanations fitting the evidence means isolate, not choose.** That rule was
learned twice: the `fill()` retraction (input mechanism vs timing — timing, and
the confound was that `type()` changed both), and the chain-policy asymmetry (two
harness policies recorded as a difference between two wallets).

## Before reporting anything as a bug

1. Which step above produced it, and what was the expected result?
2. Is there a screenshot? If a state is silent rather than erroring, only a
   screenshot will show it.
3. Was one variable moved, or several?
4. Local or CI? Local reds are usually the machine.
5. Does a stale cache, a moved wallet version, or a missing `testnetsEnabled`
   flag explain it? All three have caused a false alarm before.

If any answer is "don't know", the report is **"unexpected output, cause
unknown"** with the raw evidence attached. That is a complete and useful report.
A wrong diagnosis is not.
