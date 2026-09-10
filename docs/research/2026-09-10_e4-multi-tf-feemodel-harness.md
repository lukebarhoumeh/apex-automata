# E4 multi-TF FeeModel expectancy harness — Eng note for Algo

**Date:** 2026-09-10 · **Task:** TASK_018 E4 (TM-corrected order) · **PR:** #48 (harness) · data: #47 (merged), #49 (Dev Backtest fixtures, draft)
**Authority:** Apex Engineer Fable greenlight; PR only, no merge. Never `CONFIRM_LIVE`; no live trading; no Intro-1 capital.
**SoT:** `atlas/config/guardrails.yaml`. Paper GO = trend_follow spot+PERP, momentum spot. NO-GO = breakout, vwap_mr, momentum on PERP-INTX. **FeeModel 15m spot trend_follow = NO-GO; no 15m param tweaks. No E5. Spot long-only.**

**Burn hold (desk 2026-09-10):** this PR builds the harness only. No first 4H FeeModel burn has been run or scripted as evidence; the holdout burn waits for the Algo Alpha run card + Beta design clear. The harness enforces the hold (§2, "UNGRADED").

Cited pre-registration docs `quant-prereg-atr-fee-floors.md` and `e4-timeframe-brief.md` are **not in the repo** (searched working tree and `origin/main`); the locked floors are therefore encoded in code (`E4_ZERO_FEE_PF_FLOOR`, frozen + unit-tested) and here. The desk spec `apex-research/2026-09-10_algo-alpha-e4-research-specs.md` is also absent; the harness follows the E4 kickoff, TASK_018 and the live-readiness audit §4.1.

---

## 1. What was built (PR #48)

| Piece | Path | Purpose |
|---|---|---|
| **E4 harness** | `src/backtesting/e4-harness.ts`, `src/cli/backtest-e4.ts`, `pnpm backtest:e4` | One TF per invocation on one **per-TF fixture directory**. Zero-fee PF fail-fast against the **locked floors** → FeeModel fee pass (default FeeModel 40) → Monte Carlo (month-block on 4H) → gates → derived label (SMOKE ONLY / FULL UNGRADED / FULL GRADED / VOID). JSON + Markdown artefacts. |
| `pnpm backtest --bar-minutes 15\|60\|240\|1440` | `src/backtesting/bar-aggregation.ts`, `cli/backtest.ts` | TASK_017 step 5 / **B6** (confirmed not in #44): UTC-aligned OHLCV rollup of stored bars, fail-closed geometry, partial buckets dropped below `--min-bucket-fill` and counted. **Not used by the E4 harness** — E4 runs on Dev Backtest's per-TF fixtures. |
| Shared config builder | `src/backtesting/backtest-cli-config.ts` | `pnpm backtest` and the harness build `BacktestConfig` through one function (fee tier → FeeModel, EV gate, per-symbol overrides, realism). |
| Engine fix | `src/backtesting/backtest-engine.ts` | `--strategy trend_follow` silently also ran momentum (`BaseStrategy.enabled` defaults `true`; only trend_follow's toggle was applied). **Every single-strategy backtest before this was contaminated**; `--strategy all` and the CI gate are unchanged. |
| Runner fix | `src/backtesting/backtest-runner.ts` | Per-pass `fileTag` + same-second collision guard (the fee pass was overwriting the zero-fee pass's `backtest_*.json`). |
| Tests | `src/__tests__/e4-harness.test.ts` (30), `src/__tests__/bar-aggregation.test.ts` (14) | Locked floors, label/verdict order, data-path refusals, end-to-end on the committed REAL 4h/1d fixtures. |

No new dependencies. No guardrails change. No 15m parameter change. No E5 / A6 / maker-fill model.

## 2. Pipeline per run (STOP rules, in this order)

0. **Data path** — `--fixture-dir` is **required** and must be a per-TF directory: every symbol's fixture must declare the TF's bar width (`granularitySeconds`) and step at that spacing. The 15m gate fixtures (`fixtures/bars/{BTC,ETH}-USD.json`, ~7 d) are **refused** (`E4_FIXTURE_TF_MISMATCH`, exit 2); nothing is rolled up on the fly. Perps symbols are refused (`E4_SPOT_ONLY`). Missing/short data is `DATA_UNAVAILABLE` (exit 2). There is **no `--allow-synthetic`**; `DATA: SYNTHETIC` ⇒ VOID.
1. **Zero-fee pass** — `commission 0`, EV gate `off` ⇒ raw-signal PF against the **LOCKED floor**: **4H 1.61 · 1D 1.44 · 1H 2.25** (zero-fee PF needed for PF 1.2 at 40 bps, audit §4.1). **zf PF < floor ⇒ STOP** (fee pass and MC never run). Fewer than **10** zero-fee trades ⇒ INCONCLUSIVE, also STOP. No CLI override exists for either number.
2. **Fee pass** — FeeModel at the tier. **Default = guardrails.yaml spot bucket = "FeeModel 40" (25/40 bps taker-charged)**, the first-burn spec. `--fee-tier intro1|t1k|custom:…` is for tier-consistent re-runs (TASK_018 E4, second step) and is printed on every line of output. EV gate `enforce` (live parity) by default. Stats: n, WR, PF, payoff, mean/sd/t of $ and R, fees ($/trade, % of gross wins), max DD, by symbol / strategy, exit reasons, **E[n] = n × 365.25 / windowDays**, 4 equal window-quarters by exit time.
3. **Monte Carlo** — seeded (mulberry32, `--seed 20260910`) bootstrap of the fee-pass trades: `--mc-block month` (default 4H/1H; resamples calendar-month blocks by exit month) or `trade` (default 1D). Net $ / meanR / PF percentiles, max DD percentiles, P(net ≤ 0). Realized P&L path from initial capital; sizing not re-compounded (stated in the report).

### Label lock + burn hold — derived, never operator-asserted

Line 1 of stdout and of the `.md`:

| Data | Window | `--run-card` | Line 1 | Grade |
|---|---|---|---|---|
| any SYNTHETIC | any | — | `VOID — DATA: SYNTHETIC …` | none |
| REAL | < 365 d | — | `SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight (…; no grade issued)` | **none** |
| REAL | ≥ 365 d | absent | `FULL WINDOW — DATA: REAL, … — UNGRADED (burn hold 2026-09-10: pass --run-card … after Beta design clear; stats only, no grade)` | **none** |
| REAL | ≥ 365 d | present | `FULL WINDOW — DATA: REAL, … — GRADED under run card <id>` | GO-ELIGIBLE / NO-GO / EXPLORATORY / INCONCLUSIVE |

`fixtures/bars/4h/smoke-aug2026` (Aug 2026 month-block) is always **SMOKE ONLY**. The 4H holdout (`fixtures/bars/4h/holdout-2025-03_2026-03`, 2025-03-01 → 2026-03-01, exactly 365 d) is a FULL window: **UNGRADED until Algo passes the run card**. The STOP rules of §2 apply regardless of grading.

### Gates and verdict (GRADED FULL windows only)

Hard: data 100% REAL · zero-fee n ≥ 10 · zero-fee PF ≥ locked floor · fee-pass **PF ≥ 1.20** · **E[n] ≥ 60/12m (4H, 1H) / ≥ 100 (1D)** · **max DD ≤ 15%** · **≥ 3/4 window-quarters PF ≥ 1.0** · long-only spot (0 short entries). Info: t-stat of mean R (t ≈ 2 ≈ proof; PF 1.2 on 60 trades is a screen), MC P(net ≤ 0).

Verdict order: `VOID` → `SMOKE ONLY` → `UNGRADED` (no run card) → `INCONCLUSIVE` (zero-fee n < 10) → **1D with E[n] < 100 ⇒ `EXPLORATORY`** (TM rule, unconditional; uses the zero-fee E[n] as an upper bound if the fee pass was stopped) → zero-fee floor `NO-GO` → any hard gate fail `NO-GO` → **1H ⇒ `EXPLORATORY`** (demoted; never GO-eligible until the multi-ATR/maker path is proven, E5/E6) → non-evaluable gate ⇒ `EXPLORATORY` → `GO-ELIGIBLE`. **Desk GO stays a human decision.**

Last stdout line, machine-readable: `E4_RESULT tf=… label=… graded=… runCard=… verdict="…" data=… zeroFeeN=… zeroFeePF=… zeroFeeFloor=… feeN=… feePF=… feeMeanR=… E_n_12m=… maxDD=… mcProbLoss=… feeTier="…" fixtureDir=…`.

## 3. Fixtures (Dev Backtest) and how Algo runs it

One timeframe per `--fixture-dir`. Directories per #47 (merged) and #49 (draft; after it merges the bare `fixtures/bars/4h` is `DATA_UNAVAILABLE` by design):

| `--fixture-dir` | Role | `--start-date` / `--end-date` | Bars/symbol | Harness label |
|---|---|---|---|---|
| `fixtures/bars/4h/holdout-2025-03_2026-03` | **4H HOLDOUT — hard-preflight SoT, counted E[n]** | `2025-03-01` / `2026-03-01` | 2188 (2 documented Coinbase outage buckets) | FULL → UNGRADED until `--run-card` |
| `fixtures/bars/4h/tune-2023-03_2025-03` | 4H TUNE — in-sample fitting only | `2023-03-01` / `2025-03-01` | 4384 | FULL → UNGRADED/graded — **never a GO source** (in-sample) |
| `fixtures/bars/4h/smoke-aug2026` (= `fixtures/bars/4h` before #49) | SMOKE ONLY | `2026-08-01` / `2026-09-01` | 186 | SMOKE ONLY |
| `fixtures/bars/1d` | 1D, native ONE_DAY, 24 months | `2024-09-01` / `2026-08-31` | 730 | FULL → UNGRADED until `--run-card` |
| `fixtures/bars/{BTC,ETH}-USD.json` (15m) | backtest-gate CI only | — | 673 | **refused** by the harness |

All from `atlas/apps/core-node`. Use `pnpm exec tsx src/cli/backtest-e4.ts …` (or `pnpm backtest:e4 …` — never with `--` after `pnpm`). Set `ENCRYPTION_KEY` (any 64-hex dummy; several modules read it at import time).

**First burn — 4H holdout. DO NOT RUN until the desk clears it (Algo Alpha run card + Beta design clear).** Spec: TF=4H, long-only, no synthetic, **FeeModel 40**, zero-fee fail-fast **@ 1.61**:

```bash
pnpm exec tsx src/cli/backtest-e4.ts --tf 4h \
  --fixture-dir fixtures/bars/4h/holdout-2025-03_2026-03 \
  --products BTC-USD ETH-USD SOL-USD --strategy trend_follow \
  --start-date 2025-03-01 --end-date 2026-03-01 \
  --run-card <ALGO-ALPHA-RUN-CARD-ID>
# defaults already are the burn spec: fee pass = guardrails FeeModel (25/40 bps), --ev-gate enforce,
# --mc-block month --mc-runs 2000 --seed 20260910 --initial-capital 1000. Without --run-card: UNGRADED.
```

**Second — 1D** (EXPLORATORY unless E[n] ≥ 100):

```bash
pnpm exec tsx src/cli/backtest-e4.ts --tf 1d --fixture-dir fixtures/bars/1d \
  --products BTC-USD ETH-USD SOL-USD --strategy trend_follow \
  --start-date 2024-09-01 --end-date 2026-08-31 [--run-card <id>]
```

**Third — 1H (demoted).** Requires a per-TF 1h fixture directory (none committed); verdict capped at EXPLORATORY; floor 2.25.

Tier-consistent re-runs (TASK_018 E4 second step): add `--fee-tier intro1` (4H/1D, $1K account) or `--fee-tier t1k`. `--ev-gate shadow` counts would-be EV rejects without removing them. `--mc-block none` skips MC. `--smoke-run-all-stages` only acts on SMOKE ONLY windows (runs the fee pass + MC past a STOP for pipeline validation; never evidence). Artefacts: per-pass `backtest_<ts>_e4-<tf>-zero-fee.json` / `…-fee.json` + `report_*.txt`, and `e4_<tf>_<ts>.json` / `.md` in `--results-path` (default `atlas/var/backtest_results/e4`).

Per-strategy runs: `--strategy trend_follow` and `--strategy momentum` are genuinely isolated now (§1 engine fix). `--strategy all` pools both paper-GO strategies; the kill list still applies.

## 4. Pipeline validation runs on committed fixtures (not research results, not a burn)

| Run | Line 1 | Zero-fee pass | Fee pass @ FeeModel 40 | Verdict |
|---|---|---|---|---|
| `--tf 4h --fixture-dir <Aug-2026 4h>` 2026-08-01 → 2026-09-01, trend_follow, BTC/ETH/SOL | **SMOKE ONLY** (31 d) | n=3 (BTC 1 / ETH 1 / SOL 1), 5 SELLs blocked (spot) → INCONCLUSIVE, STOP | not run (with `--smoke-run-all-stages`: EV gate evaluates the 3 entries at 40 bps) | `SMOKE ONLY` (no grade) |
| `--tf 1d --fixture-dir fixtures/bars/1d` 2024-09-01 → 2026-08-31, trend_follow, BTC/ETH/SOL, no run card | **FULL WINDOW — UNGRADED** (729 d) | n=17, zf PF 1.54 ≥ 1.44 floor → continue | n at 25/40 bps, E[n] = n × 365.25 / 729 reported; MC trade-block | `UNGRADED` (burn hold; stats only) |
| `--tf 4h --fixture-dir fixtures/bars` (15m gate set) | — | — | — | refused, `E4_FIXTURE_TF_MISMATCH`, exit 2 |
| `--tf 15m` | — | — | — | refused ("15m is NOT an E4 timeframe"), exit 1 |

These validate the pipeline and the label/hold machinery. They use default (15m-tuned) parameters and are not E4 results; parameters are to be chosen on the tune window (2023-03 → 2025-03) and evaluated once on the holdout (2025-03 → 2026-03), TASK_018 anti-overfitting rules.

## 5. Engine caveats on wide bars (documented, not changed here)

- **MTF collapse ≥ 1H.** `SignalProcessor` buckets incoming bars by clock into 5m/15m/1h groups. With ≥ 60m base bars every group holds one bar, so the "1h" series (trend_follow `requireMtfAlignment`, `checkTimeframeFilter`) equals the base series — MTF alignment degenerates to a same-TF check.
- **Indicator periods stay in bars.** EMA(12/15), ATR(14), ADX on 4H bars are 12/15/14 × 4H. That is the intended frequency-lever semantics; no rescaling.
- **Warm-up.** Indicator/regime warm-up consumes the first tens of bars (7 days of 4H = 42 bars produce zero signals; 31 days = 186 bars produced 8 candidates). E[n] is annualized over the whole window, so short windows understate it; the 12-month holdout is the right denominator.
- **Meta-filter time-of-day rule** (lo-liq 04–07 UTC penalty, 13–17 UTC bonus) was designed for 15m. On 4H bars every signal is at 00/04/08/12/16/20 UTC (04 penalised, 16 rewarded); on 1D every signal is at 00 UTC (neither). Disabling it needs ex-ante justification (TASK_018 rule 3); there is no CLI flag for it here.
- **Stop-on-entry-bar.** A 15m-sized ATR stop can be hit inside the 4H entry bar (hold time 0; the engine checks stop before TP — pessimistic). Exit redesign is E5, not E4.
- **Upstream gaps.** The holdout has one 4-hour Coinbase outage (2025-10-25T16:00–20:59Z); the engine steps the union timeline, so the missing buckets simply do not exist (no fabricated bars).
- **Quarter gate** uses 4 equal window segments by exit time (not calendar quarters), so the holdout yields four comparable 91.25-day segments.

## 6. Not in scope / explicitly not done

- No first 4H burn, no evidence claim, no desk GO. `GO-ELIGIBLE` is a gate statement on a GRADED FULL REAL window; the desk decides.
- No E5 exit redesign (G1/G3/G5), no A6, no maker-fill model (E6), no 15m runs, no re-enabling of disabled strategies, no perps/INTX path.
- No synthetic data path on the harness; `pnpm backtest --allow-synthetic` still exists for SMOKE runs and stamps `DATA: SYNTHETIC`.
- No hand-edited candles; nothing written under `fixtures/bars/**` by this PR.
