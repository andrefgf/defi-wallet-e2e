# Matrix runner — session state

Branch `matrix-runner`.

## First cell recorded ✅ (2026-07-22)

**Aave / MetaMask / reject = pass** — recorded in prumada-business-os/matrix, chain=base-sepolia. First verified data point. Commit both repos.

## The patient-boot fix worked

Headed run after the fix: no more blank popup. `reject` passed cleanly in 1.4m; `connect` got a real rendered request (previously blank). The 2026-07-22 harness fixes in `utils/metamask-actions.ts` are good — keep them.

## Two flows still not green — and both smell like headed resource pressure, not logic

- **connect = blocked (6.3m):** "MetaMask did not act on 'confirm' — request still pending after 6 steps." The Base Sepolia connect is a 3-popup chain (connect → add network → switch). Clicks are landing on not-yet-wired buttons on a slow/loaded machine, burning the 6-step budget. Their own `connection.spec.ts` does this exact flow and is GREEN in CI (headless).
- **reconnect = crashed:** "MetaMask extension crashed" during the network switch. That's memory/stability, not test logic.

## 2026-07-22 (later still) — connect blocks HEADLESS too → it's logic, not the machine

Headless run: `reject` = pass again (consistent), `connect` = same "still pending after 6 steps". Since headless is the CI-green mode, the machine is exonerated — the connect confirm loop genuinely isn't completing the Base Sepolia connect chain on MetaMask 13.39.1.

Instrumented `resolveRequest` in `utils/metamask-actions.ts` (gated on `MATRIX_DEBUG`, syntax-checked, does not change control flow): logs every visible button + enabled state + testids per step, whether the confirm button is `enabled`, and saves screenshots to `test-results/matrix-debug/`. Prime suspect: a disabled confirm button (new checkbox/scroll gate in 13.39.1) — the `enabled=` line will confirm or kill that instantly.

### 2026-07-24 (final on borrow) — reload fix shipped, STILL failed → quarantined

Run 30101446018 ran commit 58a48a3 (which INCLUDES the reload fix) and borrow still hung. Conclusion: MV3 doesn't just lock the wallet — killing the idle service worker DROPS the in-flight tx request with the worker's memory. Unlock + re-route recovers a locked wallet but cannot resurrect a lost request; the dApp waits on a promise that never resolves. Not fixable from the test side without SW keep-alive.

Applied the pre-agreed guardrail:
- `tests/lending-lifecycle.spec.ts`: borrow/repay/withdraw → `test.fixme` (skipped, don't fail CI) with a full explanatory note. `supply` stays active — it runs early (worker alive) and proves the tx-confirm + on-chain-assertion machinery.
- `e2e.yml`: now runs `playwright test --grep-invert "Matrix"` — the matrix has its own workflow and must not gate the stable e2e suite.

e2e now = connection ×3, edge-cases ×3, supply — all green last run → should pass. Matrix runs in matrix.yml. The MV3-SW-death behaviour is a documented, sellable finding.

### 2026-07-24 (later) — borrow layer 3: post-unlock routing

Re-ran with the 90s budget fix: unlock now HAPPENS (screenshot showed MetaMask unlocked on account Home), but the tx still didn't confirm — because after unlock MetaMask lands on Home, not the queued approval, so the confirm button never appears and Aave hangs on "Borrowing USDT". Fix: `unlockIfLocked` now returns bool; `getNotificationPage` (both headless + headed branches) reloads notification.html immediately after a successful unlock, routing MetaMask to the pending request. This completes the MV3-relock recovery (lock → unlock → re-route → confirm).

If borrow STILL hangs after this, do NOT keep iterating — quarantine borrow/repay/withdraw (test.fixme with a comment) so the matrix PR can merge; the lending lifecycle is tangential to the matrix deliverable, and MV3 relock is a documented finding either way.

### 2026-07-24 — borrow failure diagnosed from report screenshots: LOCKED WALLET

The e2e `borrow` fail (which cascades → repay + withdraw skip) is NOT a lending/testnet issue. The failure screenshot shows MetaMask on its **unlock screen** at the moment the borrow tx fired. Root cause: under headless MV3, Chrome kills MetaMask's idle service worker during the long (~40-min) suite; it restarts LOCKED. `supply` (test #7, early) confirms while the wallet is still warm; `borrow` (test #8, ~5+ min in) hits a re-locked wallet. The confirmation path has `unlockIfLocked`, but `submitModalAction` gave it only a 20s budget — too short for headless popup boot (~30s) + unlock + re-render.

Fix (utils/): `approveFollowUpRequests` now takes `firstTimeoutMs`; `submitModalAction` passes 90s for the known transaction (unlock-aware) while later probes stay short. Should clear borrow → repay/withdraw run → e2e green. Real finding worth noting: MV3 SW re-lock breaks long real-wallet suites that don't re-unlock.

### 2026-07-24 — reconnect bug #2: isVisible() no-op (fixed with waitFor)

After the race fix, reconnect came back `blocked` (neither chip nor CTA in 45s), both attempts. Cause: `locator.isVisible({ timeout })` IGNORES the timeout and returns immediately — so the "wait 30s for the chip" was a no-op that checked the instant after reload, before anything rendered. Fixed to `waitFor({ state: 'visible', timeout: 30_000 })`, which actually blocks. Fixed the same latent no-op in `reject` (was passing only because the button is already present).

Two reconnect bugs total (race, then isVisible no-op) — but neither recorded a false cell: bug #1 showed as flakiness, bug #2 as `blocked`. The discipline held.

connect + reject: green on every run, done. Next Matrix run should give reconnect a STABLE restored/dropped.

### 2026-07-23 (two CI runs) — reconnect FLIPPED → my test had a race bug (fixed)

Same commit, two runs, opposite reconnect verdicts:
- e2e run: reconnect = pass (outcome=restored)
- matrix run: reconnect = fail (outcome=dropped)

That flakiness = a bug in MY test, not an Aave finding. Aave (wagmi) shows the Connect CTA transiently during rehydration, then swaps in the chip. The old 45s race broke on whichever appeared first → caught the transient CTA as "dropped" inconsistently. **Did NOT record reconnect** — a recorded fail would have been false.

Fixed: reconnect now waits up to 30s for the chip (the definitive reconnected signal); `dropped` only if the chip never returns while the CTA is present. Re-run the Matrix workflow:
- consistently `restored` → the old dropped was my bug; record reconnect = pass.
- consistently `dropped` → real Aave session-drop; record fail (a finding).
- still flipping → intermittent session drop IS the finding; record fail w/ note.

Recorded so far (stable across runs): connect = pass, reject = pass.

### borrow (e2e only) — separate, not the matrix
lending-lifecycle borrow (USDT) times out at the modal success/fail wait, both attempts. supply (identical confirm machinery) passes, so it's not my shared-code change — it's a lending/testnet-domain issue. It's the only thing reddening e2e now (matrix cells are green-as-tests there). Investigate via its trace later; not a matrix blocker.

### 2026-07-23 (CI, funded wallet) — 9/13 green; only borrow + reconnect red

Full e2e run with the CI wallet now FUNDED (gas 0.0129 ETH, USDC 19375). typecheck green. Passed: all connection (3), all edge-cases (3), supply, matrix connect + reject. So the shared metamask-actions changes are proven across the whole suite.

Two failures, unrelated:
- **borrow** (lending-lifecycle) — modal never reached "all done" in 180s, borrowing USDT. NOT the matrix; supply (identical confirm machinery) passes, so it's a lending/testnet-domain issue (USDT borrow liquidity / health factor), not my code. Investigate later via its trace.
- **reconnect** — still `reconnected=false` on the OLD spec (this run predated the rewrite).

My rewrite (now bulletproof-typed: plain `runCell` wrapper, no HOF-fixture typing) is READY, unpushed. It: (1) single verdict line per cell, (2) pass/fail = green test so a matrix fail no longer reds e2e, (3) reconnect races chip-vs-connect-CTA over 45s + screenshots the post-reload state.

**Open question on reconnect:** wagmi reconnect *should* be fast (it just re-permits an already-authorised account), which leans toward a REAL drop — but Aave is heavy and a cold headless reload could exceed the old 20s. The 45s race + the chip-vs-CTA distinction + the screenshot settle it next run. Don't record reconnect until then.

Matrix workflow ran green in CI. `pnpm run typecheck` passes locally → my edits are type-clean, so **e2e's failure is NOT the matrix changes** — it's the full lending suite needing a funded wallet (preflight/funds). Separate, pre-existing; don't block the matrix branch on it.

CI verdicts:
- connect = pass (on CI wallet 0xb1c3…c171 — a DIFFERENT wallet than the local 0xf39f…2266, so connect + chipMatches are proven on two wallets)
- reject = pass
- reconnect = fail (reconnected=false, after=null) — AMBIGUOUS: could be a real Aave session-drop-on-reload (Safe #8307 class) OR the old 20s timeout being too short for a heavy reload. Also the old test double-printed (fail + blocked) by asserting cell-success.

**Instrumented (this commit), needs a CI run to resolve:**
- Rewrote the spec to a clean verdict model: exactly ONE MATRIX line per cell; pass/fail = measured (test green), blocked = couldn't measure (test red). No more double lines.
- reconnect now races chip-returns (restored) vs connect-CTA-returns (dropped) over 45s, and captures a post-reload screenshot. `dropped` = real fail; `restored` = pass; neither-in-45s = blocked.
- matrix.yml now uploads `test-results/` + `playwright-report/` so the failure screenshots come back in the artifact.

**Next:** re-run `pnpm run typecheck` (fast), push, read reconnect's single verdict + the screenshot. Only then record reconnect. connect + reject already recorded.

---

### 2026-07-23 — TWO CELLS PASS. Laptop is the wall. Moving to CI.

Recorded (real, verified): **Aave/MetaMask/connect = pass**, **Aave/MetaMask/reject = pass**.
- connect works: dApp bound to authorised account 0xf39f…b92266 (chip 0xf3…2266). Needed the label-click fallback (13.39.1 re-tagged Connect) + a `chipMatches` fix (Aave truncates to 2 head hex, not 4).
- reconnect = blocked: hit the 10-min test timeout / browser closed. Connect alone took **8.8 min** here and the machine OOM'd ("Not enough memory to open this page"). This is RAM, not logic.

**Do not keep grinding the laptop.** It can't sustain headed Chromium + MetaMask + Aave. `connect` at 8.8 min + OOM proves it.

### → Run the matrix in CI (added `.github/workflows/matrix.yml`)

CI is where the suite is already green (7 GB RAM, no Defender). The workflow runs `tests/matrix` headless, extracts every `MATRIX:` line to an artifact + the run summary, and never fails the job on a failing cell (a fail is data).

To use it:
1. Ensure repo secrets `SEED_PHRASE` + `WALLET_PASSWORD` exist (Settings → Secrets and variables → Actions). Throwaway wallet only.
2. Push branch `matrix-runner` (the workflow triggers on it), or Actions → Matrix → Run workflow.
3. Read results in the run Summary, or download the `matrix-results` artifact.
4. Transcribe verdicts with `prumada-business-os/matrix/record.mjs` → `node build.mjs` → commit.

This unblocks everything the laptop can't: reconnect, the transaction cell, more dApps, other wallets — all run in CI now.

---

### ROOT CAUSE FOUND (2026-07-22, from test-failed-5.png)

Connect stuck on MetaMask's connect-permission screen: an enabled **"Connect"** button that never advances after 6 clicks. Version drift — actions written for 13.13.1, running 13.39.1, which re-tagged the footer button. `showsRequest` still matches a confirm testid (so it loops, not errors), but the testid click misses the visible Connect button. Reject works because "Cancel" kept its tag.

**Fix applied** in `utils/metamask-actions.ts`: after the testid click, if a request is still showing, click the visible button by label (`Connect|Confirm|Approve|Sign|Next`). Confirm side only; cancel/reject untouched; additive (skipped entirely when the testid click already worked, so the green suite is unaffected). Syntax-checked, not yet run.

### Run again — headed + connect-only + debug, all in one line so the env var sticks

    $env:MATRIX_DEBUG='1'; pnpm exec playwright test --headed tests/matrix/aave.metamask.spec.ts -g connect

Watch the popup: with the fix, clicking Connect should advance to add-network → switch-network → done, ending in `MATRIX: Aave/MetaMask/connect = pass`. If it still stalls, the `[MM ...]` lines + `test-results/matrix-debug/` PNGs now capture every button/testid — hand those to Claude.

(Earlier debug run created no matrix-debug/ folder — MATRIX_DEBUG wasn't set in the test process. The one-line form above fixes that.)

Then hand Claude: the `[MM ...]` console lines, and/or the PNGs in `test-results/matrix-debug/`. Those name the exact blocker, and the fix is then one targeted change (tick the gate / pick the right button / raise the cap), not a guess.

reject stays recorded. connect + reconnect remain unrecorded (no verdict earned).

---

## (superseded) Next action — run the PROVEN way: headless

CI runs headless and is green; headless is also lighter (no rendering) so the extension is far less likely to crash. Use the repo's own `test` script (sets HEADLESS=true):

    pnpm test tests/matrix/aave.metamask.spec.ts

- connect + reconnect green → record both, done.
- connect STILL blocks headless → it's logic, not the machine. Then harden the confirm loop in `resolveRequest` (raise 6-step cap; after each click, detect whether the request actually advanced before counting the step; re-click dead buttons). Ping Claude with the trace.
- Control if unsure: `pnpm test tests/connection.spec.ts` — if that blocks too, it's the machine (close VS Code/other apps; Defender exclusion for repo + %TEMP%\metamask-profile-*).

Do NOT record connect/reconnect until a run earns a verdict. `reject` stands on its own.

---

## 2026-07-26 (Sun) — `sign` cell written, not yet run

Fourth flow added to `aave.metamask.spec.ts`. Written ahead of Tuesday so the
evening is spent running it, not designing it.

**What gets signed, and why that choice.** Aave exposes no plain `personal_sign`
in its UI, so the cell fires `personal_sign` directly at the injected provider
from Aave's origin. The alternative — driving Aave's permit-signature path —
couples the cell to Aave's supply flow, which the lending suite already covers
and which would make the *wallet* cell fail whenever the *dApp* changed. The
cell must measure the wallet.

**Ground truth.** `recoverMessageAddress` (viem) recovers the signer from the
signature and compares it to the connected account. Per `matrix/flows.md`: not
"the modal closed", not "a toast appeared".

**The nonce matters.** The message carries an ISO timestamp, so it is new on
every run. A mocked provider handing back a canned signature recovers to the
wrong address and the cell reads `fail`. The assertion and the signature share
no assumption — which is the one thing a mocked suite structurally cannot claim.

**Provider resolved by EIP-6963 `rdns`, not `window.ethereum`.** Today the test
profile loads only MetaMask, so both agree and this looks like ceremony. It is
not: on a real browser `window.ethereum` has been observed reporting
`isMetaMask: true` AND `isOneKey: true` simultaneously. The moment Rabby joins
the matrix, a cell trusting the legacy slot would silently measure the wrong
wallet. The verdict line reports which path resolved (`via=`), so a fallback to
the legacy slot is visible rather than silent.

**Approval budget** is 90s on the first request — MV3 can kill and restart the
service worker, and it comes back locked.

**Not yet verified:** the sandbox can't typecheck (pnpm symlink store doesn't
materialise) and can't drive a real wallet. Run `pnpm run typecheck` before the
first run.

### Also fixed
`reconnect`'s blocked message claimed "within 45s" while the wait is 30s. Cosmetic,
but the message is the thing that gets pasted into a diagnosis, so it should be true.

---

## 2026-07-26 (Sun) — local run: 4 red, but the cause is the machine

`pnpm test tests/matrix/aave.metamask.spec.ts` — typecheck clean, all four cells red.

| Cell | Duration | Outcome |
|---|---|---|
| connect | 20.0m | test timeout (600s) ×3 |
| sign | 20.0m | test timeout (600s) ×3 |
| reject | 59.6s | **printed `pass`**, then timed out in teardown |
| reconnect | 5.5m | `blocked` — "did not act on confirm after 6 steps" inside `connectToDapp` |

### What the screenshots actually show

- **connect** (`test-failed-4.png`): Aave sitting on **"Requesting Connection — Open the MetaMask browser extension"**. The dApp fired the request and nothing answered.
- **reconnect** (`test-failed-3.png`): **MetaMask is on the LOCK SCREEN.** Password field empty, Unlock greyed out.

That's the MV3 service-worker death signature — the same one that quarantined
borrow/repay/withdraw. What's new is that it's now hitting **connect**, at the
very start of a run, not just a late transaction. The confirm loop then spends
its six steps hunting for a confirm button on a lock screen.

### Not a code regression

`reject` **printed its verdict and passed.** If the confirm loop or the unlock
path were fundamentally broken, reject would have died too. The logic is intact;
the environment starved.

### Aggravator: `trace: 'on'` is back

`playwright.config.ts:49` has `trace: 'on'`, and there's a `trace.zip` in every
result folder. Tracing snapshots the DOM on **every action** — against a real
MetaMask plus Aave, over a 20-minute run, that's exactly the memory pressure
that gets the service worker reaped. Trace was turned **off** once before for
this precise reason and has drifted back on.

### ⚠️ The sign cell is UNTESTED

`sign` calls `connectWallet` first, and connect never completed. Nothing was
learned about the new code — not that it works, not that it doesn't. Do not
record anything for it.

### Decision: verdicts get earned in CI, not on the laptop

`matrix.yml`'s own header already says it — *"CI, where there's enough memory to
actually drive a real wallet — a laptop OOMs on headed Chromium + MetaMask +
Aave."* Local runs are for iterating on logic; **a cell is only recorded from a
CI run.** This has now cost two evenings across two separate sessions. Stop
paying it.

Consequence for the Rabby work: bring the wallet up locally one cell at a time
with `--trace off` and `MM_DEBUG=1`, but earn every verdict in CI.

---

## 2026-07-26 (Sun) — CI: 4/4 GREEN. MetaMask column complete.

Matrix run #8, commit `4894869`, manually triggered. **Success, 12m 30s, 4 passed.**
https://github.com/andrefgf/defi-wallet-e2e/actions/runs/30212701804

```
connect   = pass  chip="0xb1...c171" == account 0xb1c375ec204f581a4ae3ca04fdbd4292dca1c171
sign      = pass  recovered=0xB1c375ec...c171, account=0xb1c375ec...c171, via=eip6963
reconnect = pass  outcome=restored, before == after
reject    = pass
```

All four transcribed into `matrix/data/results.csv` with the run URL as evidence.
**Aave × MetaMask is 4/4 — the first complete column.**

### The sign cell worked on its first real execution

- `via=eip6963` — the provider was resolved by **rdns**, not the legacy
  `window.ethereum` fallback. That path is now proven, which materially de-risks
  Rabby: the mechanism for targeting a specific wallet among several works.
- `recovered` came back EIP-55 checksummed (`0xB1c3…`) against a lowercase
  `account` (`0xb1c3…`). The case-insensitive comparison handled it. A naive
  `===` would have reported a **false `fail`** — worth remembering for every
  future wallet.

### reconnect: flip-flop resolved

`outcome=restored`, same account either side of the reload. The `waitFor` fix
holds. The two contradictory CI runs from 07-23 were the harness racing, exactly
as diagnosed — `isVisible()` ignoring its timeout.

### The laptop-vs-CI experiment is now settled

Same spec, same commit, hours apart: **laptop all-red, CI all-green.** That is as
clean a natural experiment as this project will ever get, and it retires the
question. Iterate locally; **record only from CI.**

### Note for future runs
The CI wallet (`0xb1c375…c171`, from the `SEED_PHRASE` secret) is a *different*
account from the local `.env` wallet (`0xf39f…2266`). Expected, and correct — but
it means cell notes should always name which account was used, since a reader
comparing two runs would otherwise see a mismatch and assume a bug.

---

## 2026-07-26 (Sun) — Rabby prep done ahead of Wednesday

Three unknowns closed without touching the harness.

**1. Rabby announces cleanly over EIP-6963 — go.**
Probe run with five extensions installed together:

| wallet | rdns |
|---|---|
| Rabby | **`io.rabby`** |
| OneKey | `so.onekey.app.wallet` |
| MetaMask | `io.metamask` |
| Phantom | `app.phantom` |
| Brave Wallet | `com.brave.wallet` |

All five announced **synchronously**. `RDNS = 'io.rabby'` is what the Rabby spec targets.

**2. The legacy slot changed owner — a real finding.**
`window.ethereum` on 2026-07-26 reports `isMetaMask: true` **AND** `isRabby: true`,
with no `providers` array. On 2026-07-21, before Rabby was installed, the same
machine reported `isMetaMask: true` and `isOneKey: true`.

Same laptop, same user, five days apart, different answer — because one more
extension was installed. **Two separate vendors have now been observed claiming
`isMetaMask` on the legacy slot**, so it isn't a OneKey quirk. Anything detecting
wallets via `window.ethereum.isMetaMask` is reading install order, not intent.

This retroactively justifies the sign cell resolving by rdns. Had the Rabby cells
trusted `window.ethereum` they'd have *accidentally* passed — Rabby owns it today —
while the MetaMask cells would have silently measured Rabby.

**3. Distribution: prebuilt zip, no build-from-source.**
`Rabby_v0.93.100.zip`, 16.1 MB, released 24 Jul:
`https://github.com/RabbyHub/Rabby/releases/download/v{VERSION}/Rabby_v{VERSION}.zip`

`scripts/fetch-rabby.mjs` written and wired to `pnpm run fetch:rabby`. Pinned to
0.93.100 by default (`RABBY_VERSION` overrides) — a floating version makes a cell
verdict irreproducible, and MetaMask's 13.13.1→13.39.1 testid rename already cost
us a day. It prints the resolved `manifest.version` so `wallet_version` in
results.csv can finally be filled.

**Untested:** the download itself. Sandbox DNS blocks github.com. The zip's
internal layout is therefore unknown, so `findManifestDir()` accepts manifest.json
at the root *or* one level down and prints which it found. First real run is
`pnpm run fetch:rabby` on the laptop — that is a download, not a wallet flow, so
local is fine.

### Still open for Wednesday
Rabby's **UI actions** — unlock, approve, reject — are the actual work. Nothing
here shortcuts that. Deliberately did NOT write `aave.rabby.spec.ts` or generalise
`metamask-actions.ts`: both need Rabby's real selectors, and guessing them is how
you get a day of debugging a fiction.

---

## 2026-07-26 (Sun) — Rabby import WORKS end to end

`scripts/probe-rabby.ts` drove Rabby 0.93.100 from a fresh profile to an unlocked
dashboard. Every route and selector below is verified, not inferred.

```
#/new-user/guide                           "I already have an address"
#/new-user/import-wallet-type              "Seed Phrase"
#/new-user/import/seed-or-key              12 masked inputs -> "Next"
#/new-user/import/seed-phrase/set-password "Password (8 characters min)"
                                           "Confirm Password" -> "Confirm"
#/new-user/success?hd=HD%20Key%20Tree      "Open Wallet"
index.html                                 dashboard: Swap/Send/Bridge/Receive
```

Written up as `utils/rabby-onboarding.ts`.

### popup.html was never broken
It failed on three earlier probes with "target closed" — because there was **no
wallet yet**. Once the vault existed it painted the full dashboard. Same for
`notification.html`: an approval surface with nothing pending closes itself.
Three runs were spent treating a normal empty state as a defect.

### The one thing NOT established: why fill() fails

`fill()` populated all twelve boxes — correct DOM values, `Next` enabled — and
clicking Next did nothing. No navigation, no error text. `pressSequentially`
immediately afterwards worked.

**Two explanations survive and this run cannot separate them:**

1. The component tracks state via key events and never sees a programmatic value.
2. It validates asynchronously and the click arrived before validation settled.

André raised (2) unprompted and it fits the evidence exactly as well as (1) —
typing 12 words at 30ms/char also spends ~3s, so `type()` changed the input
mechanism **and** the elapsed time. Only one variable should have moved.

**The experiment:** `fill()`, wait 3s, then click.
- advances -> timing, explanation (2)
- does not -> input mechanism, explanation (1)

**Do not write "Rabby cannot be driven by fill()" into the matrix until this is
run.** It would be a published claim about a vendor's product resting on a
confounded experiment, which is exactly the Safe #8307 mistake.

`rabby-onboarding.ts` uses keystrokes because that satisfies both explanations.

### Rabby vs MetaMask, for the record
| | MetaMask | Rabby |
|---|---|---|
| test hooks | `confirm-btn`, `unlock-password`, … | **none** |
| approval page | `notification.html` | `notification.html` (same) |
| full UI | `home.html` | `index.html` |
| manifest | MV3 | **MV3** |
| seed entry | grid | 12 masked inputs, keystrokes required |

MV3 on both means the service-worker death that quarantined borrow/repay/withdraw
is a platform property, not a MetaMask quirk. Expect it here too.

---

## 2026-07-26 (Sun) — RESOLVED: it was timing, not the input mechanism

Controlled three-way run, one variable moved at a time:

```
A  fill() + click immediately      → did NOT advance
B  fill() + settle 3s + click      → ADVANCED  ✅
C  real keystrokes                 → not reached
```

A and B were identical except the 3s wait — both re-entered the words with
`fill()` from cleared boxes. Clean isolation.

**`fill()` works. Rabby validates the seed asynchronously (debounced across all
twelve fields) and `Next` stays enabled the entire time regardless of validity.
A click landing before validation completes does nothing: no navigation, no
error, no clue.**

André called this from the UX before any of it was instrumented. The competing
theory — that Rabby ignores programmatic values and needs real keystrokes — was
mine, was mechanically plausible, and is **false**.

### Why running the experiment mattered
"Rabby cannot be driven by `fill()`" was one step from being written into the
matrix as a published finding about a vendor's product. It would have been
wrong, and wrong in a way a Rabby engineer could disprove in five minutes. The
confound was that `type()` changed the input mechanism AND spent ~3s doing it;
two variables moved, so the earlier run could not distinguish them.

Second time this pattern has appeared (see Safe #8307). The rule holds: when two
explanations fit, isolate before publishing.

### Consequence for the code
`utils/rabby-onboarding.ts` uses `fill()` plus a 3s settle — simpler and faster
than typing 12 words at 30ms/char — with one retry at double the settle, since
the value is empirical and a loaded machine may need longer. The settle is
load-bearing and commented as such; there is no signal to poll for, because the
button never reflects validity.

---

## 2026-07-27 (Mon) — Rabby cache built; lock + approval surfaces probed

`pnpm run build:cache:rabby` → **built and verified**, profile reopened LOCKED
(vault present). Burner address `0xe59c45...706010`.

### Three failures getting there, all the same mistake
Each came from extending a verified path instead of porting it exactly:

1. `fill()` without the preceding `click()` — the probe focused each box first.
2. One pass over the seed grid — the probe only advanced on its **second**.
3. Waiting for the dashboard after "Open Wallet" — **the probe never pressed
   that button.** Everything past it was inference wearing the probe's
   credibility.

Rule, now written down: a probe is evidence for exactly what it did. Port the
sequence, get it green, simplify only afterwards.

### Verified by scripts/probe-rabby-approval.ts

**Lock screen** — `index.html#/unlock`
- `input[placeholder="Enter the Password to Unlock"]`
- buttons: "Unlock with biometrics", "Unlock", "Forgot Password?"
- **Enter submits**, which sidesteps choosing between Unlock and biometrics
- unlocks to `index.html#/dashboard`

**Approval** — `notification.html#/approval`
- heading "Connect to Dapp", origin, chain, "Listed by", "Site popularity"
- buttons: **"Connect"** / **"Cancel"**
- Rabby opens this page **itself**; it appeared unrequested as a 4th page

**Rabby defaults the connect approval to Ethereum**, not Base Sepolia — so the
add/switch-network follow-up is required for Aave, exactly as with MetaMask.

### notification.html was never broken
It self-closes with nothing pending. Three earlier probes recorded "target
closed" and I read it as a defect. The consequence is a real API difference:
MetaMask lets you pre-open `notification.html` and wait; **Rabby does not** —
you must wait for Rabby to open it. `getNotificationPage` differs accordingly.

### Still UNVERIFIED in utils/rabby-actions.ts
Transaction and signature approvals. No probe has driven a signature through
Rabby yet. `CONFIRM_LABELS` therefore carries "Sign" and "Confirm" as
candidates from the shipped locale file, flagged in-comment. Prune the list once
a real signature has been observed — do not assume it.

---

## 2026-07-28 (Tue) — CI #9: Rabby/reject PASS, three cells blocked. Cause found.

Run #9 (`e59627d`) **succeeded** — MetaMask still 4/4, no regression from adding
Rabby, and **Rabby's cache built headless in CI in 1m24s**. Rabby/reject = pass,
recorded. Matrix is 5/16.

connect, sign and reconnect all blocked on the SAME line: `connect.accountChip`
never visible.

### Reject passing was the clue
It proves the whole Rabby harness works: extension loads, profile unlocks, Aave
lists Rabby, `notification.html#/approval` opens, the click lands, Aave returns
to its disconnected state. Only the state AFTER approving fails.

### The measurement that settled it
`scripts/probe-rabby-aave.ts` read the provider rather than the DOM:

```
accounts: ["0xe59c45...706010"]   chainId: "0x1"
>>> CONNECTED but on 0x1 — network switch FAILED
```

Connect works. The wallet is authorised **on Ethereum**.

### And then the screenshot
Aave's follow-up raised Rabby's **"Add Custom Network to Rabby"** dialog,
pre-filled with:

```
Chain ID       43113
Network name   Avalanche Fuji
RPC URL        https://api.avax-test.network/ext/bc/C/rpc
Currency       AVAX
```

**Aave asked for Avalanche Fuji, not Base Sepolia (84532).** `utils/helpers.ts`
already documented this — *"Aave lands the wallet on whatever chain it fancies
(we've watched it add Avalanche Fuji)"* — which is exactly why the MetaMask path
never trusts Aave's switch and calls `wallet_addEthereumChain` itself.

**My Rabby connect flow didn't.** It relied on Aave's switch, which the repo
already knew was unreliable. That's the bug, and it was mine.

### Two fixes
1. **`CONFIRM_LABELS` was missing `/^add$/i`.** Rabby's add-network dialog's
   primary button is **"Add"**, not Confirm. Even a correct request would not
   have been approved. `/^switch/i` added alongside it.
2. **`ensureNetwork()` added to the Rabby spec**, mirroring `helpers.ts`: check
   the chain, fire `wallet_addEthereumChain` with Base Sepolia params ourselves,
   approve Rabby's dialog, then poll until the chain actually changes and throw
   with the observed chainId if it doesn't.

### Side observation, genuinely matrix-relevant
MetaMask and Rabby receive the *same* `wallet_addEthereumChain` and present it
very differently. MetaMask shows a standard approval. Rabby shows a form headed
*"Rabby cannot verify the security of custom networks. Please add trusted
networks only."* Same request, materially higher friction and a security warning
on one wallet. Not one of the four flows, but worth writing up when the matrix
is published.

### Also worth noting
Rabby ships **82 chains, all mainnets**. No Base Sepolia. Every testnet is a
"custom network" with that warning attached.
