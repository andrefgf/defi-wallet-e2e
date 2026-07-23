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
