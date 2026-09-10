# E4 multi-TF FeeModel expectancy harness — Eng note for Algo

**Date:** 2026-09-10 · **Task:** TASK_018 E4 (TM-corrected order) · **PR:** #48
**Authority:** Apex Engineer Fable greenlight; PR only, no merge. Never `CONFIRM_LIVE`; no live trading; no Intro-1 capital.
**SoT:** `atlas/config/guardrails.yaml`. Paper GO = trend_follow spot+PERP, momentum spot. NO-GO = breakout, vwap_mr, momentum on PERP-INTX. **FeeModel 15m spot trend_follow = NO-GO; no 15m param tweaks.**

The desk spec `apex-research/2026-09-10_algo-alpha-e4-research-specs.md` is not on `main`; this harness was built from the E4 kickoff, TASK_018, and the live-readiness audit §4.1 thresholds.

---

## 1. What was built

| Piece | Path | Purpose |
|---|---|---|
| `pnpm backtest --bar-minutes 15\|60\|240\|1440` | `src/backtesting/bar-aggregation.ts`, `cli/backtest.ts` | TASK_017 step 5 (never implemented before): UTC-aligned OHLCV rollup of stored bars. Fail-closed geometry (target must be an integer multiple of the stored spacing). Partial buckets dropped below `--min-bucket-fill` (default 0.5) and counted in provenance + report. Identity when the fixture already is the target width (#47's 4h/1d sets). |
| Shared config builder | `src/backtesting/backtest-cli-config.ts` | `pnpm backtest` and the harness build `BacktestConfig` through one function (fee tier → FeeModel, EV gate, per-symbol overrides, realism). No drift between a plain run and a harness run. |
| Engine fix | `src/backtesting/backtest-engine.ts` | `--strategy trend_follow` silently also ran momentum (`BaseStrategy.enabled` defaults `true`; only trend_follow's toggle was ever applied). Selector toggles are now applied at the registry. **Every single-strategy backtest before this was contaminated**; `--strategy all` and the CI gate are unchanged. |
| **E4 harness** | `src/backtesting/e4-harness.ts`, `cli/backtest-e4.ts`, `pnpm backtest:e4` | One TF per invocation. Zero-fee PF fail-fast → FeeModel expectancy at the tier-consistent fee → Monte Carlo (month-block on 4H) → gates → derived label + verdict. JSON + Markdown artefacts. |
| Tests | `src/__tests__/bar-aggregation.test.ts`, `src/__tests__/e4-harness.test.ts` | 14 + 23 tests; both end-to-end on the committed REAL fixtures. |

No new dependencies. No guardrails change. No 15m parameter change. No E5 (exit redesign) or A6.

## 2. Pipeline per run (fail-fast, in this order)

0. **Data** — fail-closed loader (TASK_017). There is **no `--allow-synthetic`** on the harness. `DATA: SYNTHETIC` anywhere ⇒ `VOID`, nothing else runs.
1. **Zero-fee pass** — `commission 0`, EV gate `off` ⇒ raw-signal PF. `n < --min-zero-fee-trades` (10) ⇒ `INCONCLUSIVE`; `PF < threshold` ⇒ `NO-GO`. Fee pass and MC are **skipped** on either. Thresholds (zero-fee PF needed for PF 1.2 @ 40 bps, audit §4.1): **1H 2.25 · 4H 1.61 · 1D 1.44**.
2. **Fee pass** — FeeModel at the tier (defaults: **intro1 60/120 bps** for 4H/1D, **t1k 35/75** for 1H = the tier a $1K account sits in at that frequency, TASK_018 E4), EV gate `enforce` (live parity) unless overridden. Expectancy stats: n, WR, PF, payoff, mean/sd/t of $ and R, fees ($/trade, % of gross wins), max DD, by symbol, by strategy, exit reasons, **E[n] = n × 365.25 / windowDays**, 4 equal window-quarters by exit time.
3. **Monte Carlo** — seeded (mulberry32, `--seed 20260910`) bootstrap of the fee-pass trades. `--mc-block month` (default 4H/1H: resample calendar-month blocks by exit month, keeps intra-month clustering) or `trade` (default 1D: ≈1–3 trades/month makes month blocks degenerate). Reports net $ / meanR / PF percentiles, max DD percentiles, P(net ≤ 0). Realized P&L path from initial capital; sizing is not re-compounded (stated in the report).

### Label lock (desk, 2026-09-10) — derived, never operator-asserted

Line 1 of stdout and of the `.md` is the label:

| Data | Window | Line 1 | Grade |
|---|---|---|---|
| any SYNTHETIC | any | `VOID — DATA: SYNTHETIC …` | none |
| REAL | `< --min-full-window-days` (365) | `SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight (…; no grade issued)` | **none** — stats print for pipeline validation only |
| REAL | ≥ 365 d | `FULL WINDOW — DATA: REAL, … (grade issued below)` | GO-ELIGIBLE / NO-GO / EXPLORATORY / INCONCLUSIVE |

`fixtures/bars/4h` (Aug 2026 month-block) is therefore always **SMOKE ONLY**. Holdout counted E[n] waits on the Backtest expand-fixture PR (REAL 4H 2025-03 → 2026-03).

### Gates and verdict (FULL windows only)

Hard gates (TASK_018 + TM): data 100% REAL · zero-fee n ≥ 10 · zero-fee PF ≥ TF threshold · fee-pass **PF ≥ 1.20** · **E[n] ≥ 60/12m (4H, 1H) / ≥ 100 (1D)** · **max DD ≤ 15%** · **≥ 3/4 window-quarters PF ≥ 1.0** · long-only spot (0 short entries). Info (not gated): t-stat of mean R (t ≈ 2 ≈ proof; PF 1.2 on 60 trades is a screen), MC P(net ≤ 0).

Verdict order: `VOID` → `SMOKE ONLY` → `INCONCLUSIVE` (zero-fee n < 10) → **1D with E[n] < 100 ⇒ `EXPLORATORY`** (TM rule, unconditional; other gate results kept as context; uses the zero-fee E[n] as an upper bound if the fee pass was skipped) → zero-fee fail-fast `NO-GO` → any hard gate fail `NO-GO` → **1H ⇒ `EXPLORATORY`** (demoted, never GO-eligible until the multi-ATR/maker path is proven, E5/E6) → non-evaluable gate ⇒ `EXPLORATORY` → `GO-ELIGIBLE`. **Desk GO stays a human decision; the harness only says GO-ELIGIBLE.**

The last stdout line is machine-readable: `E4_RESULT tf=… label=… verdict="…" data=… zeroFeeN=… zeroFeePF=… feeN=… feePF=… feeMeanR=… E_n_12m=… maxDD=… mcProbLoss=… feeTier=…`.

## 3. How Algo runs it (from `atlas/apps/core-node`)

Never put `--` after `pnpm backtest:e4` (yargs treats every later flag as positional); `pnpm exec tsx src/cli/backtest-e4.ts …` is equivalent and always safe. Set `ENCRYPTION_KEY` (any 64-hex dummy works for backtests; several modules read it at import time).

**Run 1 — 4H (primary, month-block MC).** Against the REAL 4H holdout once the expand-fixture PR lands (`fixtures/bars/4h-holdout` or whatever it is called; one timeframe per directory):

```bash
pnpm backtest:e4 --tf 4h --fixture-dir <4h-holdout-dir> \
  --products BTC-USD ETH-USD SOL-USD --strategy trend_follow \
  --start-date 2025-03-05 --end-date 2026-03-05
# defaults: --fee-tier intro1 --ev-gate enforce --mc-block month --mc-runs 2000 --seed 20260910 --initial-capital 1000
```

**Run 2 — 1D (EXPLORATORY unless E[n] ≥ 100).** The 24-month set is already on `main`:

```bash
pnpm backtest:e4 --tf 1d --fixture-dir fixtures/bars/1d \
  --products BTC-USD ETH-USD SOL-USD --strategy trend_follow \
  --start-date 2024-09-01 --end-date 2026-08-31
# defaults: --fee-tier intro1 --mc-block trade
```

**Run 3 — 1H (demoted; only if the multi-ATR/maker path is proven).** Stored 15m bars are rolled up to 60m; the verdict is capped at EXPLORATORY; the zero-fee threshold is 2.25:

```bash
pnpm backtest:e4 --tf 1h --products BTC-USD ETH-USD --strategy trend_follow \
  --start-date 2025-03-05 --end-date 2026-03-05          # Supabase bars, or --fixture-dir <15m or 1h dir>
```

**Supabase instead of fixtures:** omit `--fixture-dir`; the loader reads `public.bars` (15m) and rolls up to the TF. Backfill first: `pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD --since 2025-03-05 --until 2026-03-05 --granularity FIFTEEN_MINUTE --upsert`.

Useful flags: `--fee-tier custom:0,0` (sensitivity), `--ev-gate shadow` (count would-be rejects without removing them), `--mc-block none`, `--zero-fee-pf-min` / `--min-expected-trades` (overrides; the effective value is always printed), `--smoke-run-all-stages` (SMOKE ONLY windows: run the fee pass + MC past a fail-fast to exercise the pipeline). Per-pass `backtest_*.json` / `report_*.txt` plus `e4_<tf>_<ts>.json` / `.md` land in `--results-path` (default `atlas/var/backtest_results/e4`).

Per-strategy runs: `--strategy trend_follow` and `--strategy momentum` are now genuinely isolated (see §1 engine fix). `--strategy all` pools both paper-GO strategies; the kill list still applies.

## 4. What the committed fixtures produce today (pipeline validation, not research results)

| Run | Label | Zero-fee pass | Fee pass @ intro1, EV enforce | Verdict |
|---|---|---|---|---|
| `--tf 4h --fixture-dir fixtures/bars/4h` 2026-08-01 → 2026-09-01, trend_follow, BTC/ETH/SOL | **SMOKE ONLY** (31 d) | n=3 (1/1/1), PF 3.11, 5 SELLs blocked (spot) | skipped — INCONCLUSIVE (n < 10). With `--smoke-run-all-stages`: n=0, all 3 entries EV-rejected (EV −$5.78 / −$3.61 / −$2.23 at 120 bps, p=0.40 prior) | `SMOKE ONLY` (no grade) |
| `--tf 1d --fixture-dir fixtures/bars/1d` 2024-09-01 → 2026-08-31, trend_follow, BTC/ETH/SOL | FULL (729 d) | n=17, PF 1.54 ≥ 1.44 → pass; zero-fee E[n] 8.5 | n=13, PF 0.71, meanR −0.21, fees 34% of gross wins, max DD 3.3%, **E[n] 6.5**, quarters 2/4; MC (trade, 2000) P(net ≤ 0) 70.9% | `EXPLORATORY` (E[n] < 100, TM rule; PF/E[n]/quarters gates would fail) |

The 1D numbers are on the 24-month `main` fixtures with default (15m-tuned) parameters — a harness run, not an E4 result: parameters must be chosen on 2023-03 → 2025-03 and evaluated once on 2025-03 → 2026-03 (TASK_018 anti-overfitting rules).

## 5. Engine caveats on wide bars (documented, not changed here)

- **MTF collapse ≥ 1H.** `SignalProcessor` buckets incoming bars by clock into 5m/15m/1h groups. With ≥ 60m base bars every group holds one bar, so the "1h" series (trend_follow `requireMtfAlignment`, `checkTimeframeFilter`) equals the base series — MTF alignment degenerates to a same-TF check.
- **Indicator periods stay in bars.** EMA(12/15), ATR(14), ADX on 4H bars are 12/15/14 × 4H. That is the intended frequency-lever semantics; no rescaling.
- **Warm-up.** Indicator/regime warm-up consumes the first tens of bars: 7 days of 4H (42 bars) produce zero signals; 31 days (186 bars) produced 8 candidates. E[n] is annualized over the whole window, so short windows understate it.
- **Meta-filter time-of-day rule** (lo-liq 04–07 UTC penalty, 13–17 UTC bonus) was designed for 15m. On 4H bars every signal is at 00/04/08/12/16/20 UTC (04 penalised, 16 rewarded); on 1D every signal is at 00 UTC (neither). Disabling it needs ex-ante justification in the E4 doc (TASK_018 rule 3); there is no CLI flag for it here.
- **Stop-on-entry-bar.** A 15m-sized ATR stop can be hit inside the 4H entry bar (hold time 0; the engine checks stop before TP — pessimistic). Exit redesign is E5, not E4.
- **Quarter gate** uses 4 equal window segments by exit time (not calendar quarters) so a 2025-03-05 → 2026-03-05 holdout yields four comparable segments.

## 6. Not in scope / explicitly not done

- No E5 exit redesign (G1/G3/G5), no A6, no maker-fill model (E6), no 15m runs, no re-enabling of disabled strategies, no perps/INTX path (parked; spot primary).
- No synthetic data path on the harness; `pnpm backtest --allow-synthetic` still exists for SMOKE runs and stamps `DATA: SYNTHETIC`.
- No desk GO. `GO-ELIGIBLE` is a harness statement about gates on a FULL REAL window; the desk decides.
