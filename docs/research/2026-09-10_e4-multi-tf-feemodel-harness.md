# E4 multi-TF FeeModel expectancy harness — Eng handoff (Algo Creator Beta card)

**Date:** 2026-09-10 · **Task:** TASK_018 E4 (TM-corrected order) · **Card:** Algo Creator Beta CLEAR 2026-09-10 (box brief) · **PRs:** #48 (merged, foundation), #51 (this: card alignment) · data: #47, #49 (Dev Backtest, merged)
**Authority:** Algo Creator authorized Eng preflight + 4H screen path. **Still NOT a GO to TM.** Never `CONFIRM_LIVE`; no live trading; no Intro-1 capital.
**SoT:** `atlas/config/guardrails.yaml`. Paper GO = trend_follow spot+PERP, momentum spot. NO-GO = breakout, vwap_mr, momentum on PERP-INTX. **15m out. No E5. Spot long-only. INTX/perps out.**

Cited pre-registration docs `quant-prereg-atr-fee-floors.md` and `e4-timeframe-brief.md` are **not in the repo** (searched working tree + `origin/main`); every threshold is encoded as a frozen constant in `src/backtesting/e4-harness.ts` and repeated here.

---

## 0. Counted E[n] preflight — REAL 4H holdout (eval window)

`pnpm exec tsx src/cli/backtest-e4.ts --tf 4h --window eval --run-card AlgoCreator-Beta-CLEAR-2026-09-10` · fixtures `fixtures/bars/4h/holdout-2025-03_2026-03` (#49) · `DATA: REAL`, `source=fixture`, declared 240 m, 2188/2191 bars per symbol (one documented Coinbase outage) · zero knobs verified (A1 2.5/6.0 per symbol, atr_volatility_min 0.005, EV gate enforce/min_ev_threshold 0, cooldown 1 × 4H bar, GO fee book 40 bps/side).

| | pooled n | BTC-USD | ETH-USD | SOL-USD | window | counted E[n] (12 m) | gate |
|---|---|---|---|---|---|---|---|
| **fee book 40 bps/side, EV gate on** | **42** | **9** | **14** | **19** | 2025-03-01 → 2026-03-01 (365.0 d) | **42.0** | ≥ 100 ⇒ **RESEARCH SCREEN ONLY** |
| raw (zero-fee, EV off) upper bound | 52 | 20 | 14 | 18 | same | 52.0 | — |

Zero-fee PF on the holdout **0.94 < 1.61 ⇒ STOP** (no fee-sensitivity, no GO MC). Fee-book pass (informational): PF 0.53, net −$68.07 on $1,000, meanR −0.33 (t −1.79), max DD 6.87 %, EV gate rejected 34 of 76 entries, 59 SELLs blocked (spot), 2 same-bar exits ignored by the 1-bar cooldown, exits 21 signal / 15 stop / 6 TP; window quarters n = 14/15/12/1, PF 0.76/0.70/0.20/0.00. **Verdict: RESEARCH SCREEN ONLY** (no GO packaging). Eval ledger entry 1 of 1 for 4H (walk-forward rule: eval once).

Tune diagnostic (`--window tune`, 2023-03-01 → 2025-03-01, never GO bars): fee-book n = 95 (BTC 22 / ETH 27 / SOL 46), E[n] 47.5; zero-fee n = 131, PF 1.17 < 1.61 ⇒ STOP; fee-book PF 0.82. Verdict TUNE DIAGNOSTIC.
1D eval (`--tf 1d --window eval`): fee-book n = 6 (BTC 0 / ETH 4 / SOL 2), E[n] 6.0 < 100 ⇒ **EXPLORATORY**; zero-fee n = 6 < 10 ⇒ INCONCLUSIVE/STOP.

These are the numbers the card asked for. They are Eng screen output, not a desk GO.

## 1. What #51 changes (on top of merged #48)

| Piece | Path | Card requirement |
|---|---|---|
| Hard preflight print path | `e4-harness.ts` Stage P, `E4_PREFLIGHT` line | Counted pooled long-only E[n] + per-symbol n on the fee book (EV on), printed **first**; E[n] < 100 ⇒ RESEARCH SCREEN ONLY (4H) / EXPLORATORY (1D); raw zero-fee count printed as an upper bound |
| Locked floors + bars | `E4_ZERO_FEE_PF_FLOOR` (4H 1.61 · 1D 1.44 · 1H 2.25), `E4_MIN_EXPECTED_TRADES` (100), `E4_BETA_BARS`, `E4_MC_SCREEN`; CLI is yargs-strict | zf PF < floor ⇒ STOP; no override flags exist |
| Zero knobs asserted | `assertZeroKnobs` ⇒ `E4_ZERO_KNOBS_DRIFT` | trend_follow A1 stopAtr 2.5 / takeProfitAtr 6.0 per symbol (guardrails per_symbol pins), `filters.atr_volatility_min` 0.005, `risk.min_ev_threshold` 0, cooldown ≥ 1 bar; drift refuses the run |
| Cooldown = 1 × 4H bar | engine `execution.minHoldBars` (new), `--cooldown-bars` (default 1) | Live `trade_cooldown_min` (15 min = 1 × 15m bar) was wall-clock and absent from the backtest; now a bar-clock min hold before an opposite-signal exit (`exit_position_too_young`); stops/TPs bypass it as live |
| atr_volatility_min applied | engine `filters` (new), wired by the shared config builder for `pnpm backtest` too | Live pre-entry `atr_vol` filter was absent from the backtest; now parity. Note: the 15m backtest-gate run goes 15 → 11 trades (15m ATR% < 0.5 % rejections), still ≥ 5 / 0 shorts |
| GO fee book | default fee pass = guardrails spot bucket (25/40 ⇒ **40 bps/side, 80 RT**); `--fee-tier` anything else ⇒ sensitivity run, capped at RESEARCH SCREEN ONLY | "FeeModel 40 bps/side only; never cherry-pick" |
| Fee stress | `--fee-stress` (default on): separate 25 / 75 / 120 bps-per-side passes, printed in their own table, never graded | "Stress 25/75/Intro-1 separate" |
| Walk-forward windows | `E4_WALK_FORWARD`, `--window eval\|tune`, `classifyWindow`, `window_eval` bar, eval ledger `E4_EVAL_LEDGER.jsonl` (WARNING on re-run) | tune 2023-03 → 2025-03 diagnostics; eval 2025-03 → 2026-03 once, GO bars only |
| True 4H | `assertFixtureTimeframe` (declared width = TF, spacing = TF, no rollup) | "no silent ONE_MINUTE map"; 15m gate fixtures refused |
| MC screen | `probPfGteScreen` in `runMonteCarlo`; INFO bar | 4H month-block default; P(PF ≥ 1.20) ≥ 0.60 is a screen, not GO |
| Verdict vocabulary | `VOID · SMOKE ONLY · UNGRADED · TUNE DIAGNOSTIC · RESEARCH SCREEN ONLY · EXPLORATORY · INCONCLUSIVE · STOP · BETA BARS FAIL · BETA BARS PASS` | PASS is an Eng screen statement — printed with "NOT a desk GO (TM decides)" |

Unchanged from #48: `--bar-minutes` rollup on `pnpm backtest` (B6; not used by the harness), shared config builder, strategy-selector isolation fix, per-pass artefact tags + collision guard, fail-closed loader, no `--allow-synthetic` on the harness.

## 2. Pipeline per run (order matches the card)

0. **Data path** — `--fixture-dir` (or `--window` preset) must be a per-TF directory; fixture declared width = TF; spot products only; missing data ⇒ `DATA_UNAVAILABLE` (exit 2); any SYNTHETIC ⇒ **VOID whole run**. Zero knobs asserted before any engine work.
P. **HARD PREFLIGHT** — fee-book pass (40 bps/side, EV gate enforce, cooldown 1 bar) ⇒ counted pooled n, per-symbol n, E[n] = n × 365.25 / windowDays. `E4_PREFLIGHT …` machine-readable line. **E[n] < 100 ⇒ RESEARCH SCREEN ONLY (4H) / EXPLORATORY (1D): no GO packaging, MC informational.**
1. **Zero-fee fail-fast** — commission 0, EV off. **PF < locked floor ⇒ STOP** (no fee-sensitivity, no GO MC). n < 10 ⇒ INCONCLUSIVE, also STOP.
2. **FeeModel 40 expectancy** — stats from the preflight pass (PF, WR, payoff, mean/sd/t of $ and R, fees, max DD, exits, by symbol, 4 window-quarters by exit).
3. **Monte Carlo** — month-block default on 4H (trade-block on 1D), seeded; net/meanR/PF/max-DD percentiles, P(net ≤ 0), **P(PF ≥ 1.20) screen (≥ 0.60 = screen met, not GO)**. Informational when preflight failed; not run after STOP.
4. **Fee stress** — 25 / 75 / 120 bps per side, separate passes, own table. Not run after STOP.

### Labels (derived) and Beta bars

| Data | Window | `--run-card` | Line 1 | Grade |
|---|---|---|---|---|
| any SYNTHETIC | any | — | `VOID — DATA: SYNTHETIC …` | none |
| REAL | < 365 d | — | `SMOKE ONLY — NOT screen, NOT holdout, NOT Beta hard-preflight …` | none |
| REAL | ≥ 365 d | absent | `FULL WINDOW — … — UNGRADED (burn hold …)` | none |
| REAL | ≥ 365 d | present | `FULL WINDOW — … — GRADED under run card <id> (Eng screen; NOT a desk GO)` | see below |

Verdict order on a GRADED window: tune ⇒ `TUNE DIAGNOSTIC` → preflight E[n] < 100 ⇒ `RESEARCH SCREEN ONLY` / `EXPLORATORY` → zero-fee n < 10 ⇒ `INCONCLUSIVE` → zf PF < floor ⇒ `STOP` → not the eval window / fee book ≠ 40 / 1H ⇒ `RESEARCH SCREEN ONLY` → hard bars: fee PF ≥ 1.20, max DD ≤ 15 %, ≥ 3/4 window-quarters PF ≥ 1.0, long-only, REAL ⇒ `BETA BARS FAIL` / `BETA BARS PASS`. INFO (never gating): t-stat of mean R, MC P(net ≤ 0), MC P(PF ≥ 1.20) screen.

## 3. How to run — separate 4H then 1D (from `atlas/apps/core-node`)

Set `ENCRYPTION_KEY` (any 64-hex dummy). Use `pnpm exec tsx src/cli/backtest-e4.ts …` (or `pnpm backtest:e4 …`; never `--` after `pnpm`). Defaults **are** the card; the only inputs are TF, window and the run card.

```bash
# 1) FeeModel 4H first — eval window, GO bars here only, run ONCE (ledger warns on repeats)
pnpm exec tsx src/cli/backtest-e4.ts --tf 4h --window eval --run-card <card id>
#    = --fixture-dir fixtures/bars/4h/holdout-2025-03_2026-03 --start-date 2025-03-01 --end-date 2026-03-01
#      --products BTC-USD ETH-USD SOL-USD --strategy trend_follow --ev-gate enforce --cooldown-bars 1
#      fee book 40 bps/side (guardrails) --fee-stress --mc-block month --mc-runs 2000 --seed 20260910

# 1b) 4H tune window — diagnostics only, never GO bars
pnpm exec tsx src/cli/backtest-e4.ts --tf 4h --window tune --run-card <card id>

# 2) 1D — only if counted E[n] ≥ 100 else EXPLORATORY (same eval window sliced from fixtures/bars/1d)
pnpm exec tsx src/cli/backtest-e4.ts --tf 1d --window eval --run-card <card id>

# 3) 1H — demoted, do not lead (needs a per-TF native 1h fixture directory; capped at RESEARCH SCREEN ONLY)
```

Without `--run-card` the same commands print everything and grade nothing (UNGRADED). `--fee-tier intro1|t1k|custom:…` turns the fee-book pass into a sensitivity run (capped at RESEARCH SCREEN ONLY; the 25/75/120 stress table is the sanctioned way to look at other fee books). `--smoke-run-all-stages` only acts on SMOKE windows. Artefacts: per-pass `backtest_<ts>_e4-<tf>-<window>-{feebook,zero-fee,stress-<bps>bps}.json` + `report_*.txt`, `e4_<tf>_<window>_<ts>.json/.md`, `E4_EVAL_LEDGER.jsonl` in `--results-path` (default `atlas/var/backtest_results/e4`).

Refusals (exit 2 unless noted): 15m gate fixtures for `--tf 4h` (`E4_FIXTURE_TF_MISMATCH`); bare `fixtures/bars/4h` (`DATA_UNAVAILABLE`); perps symbols (`E4_SPOT_ONLY`); guardrails drift from A1 / atr min / EV 0 (`E4_ZERO_KNOBS_DRIFT`); `--tf 15m`, `--zero-fee-pf-min`, `--min-expected-trades`, `--allow-synthetic` (exit 1, unknown/refused).

## 4. Engine caveats on wide bars (documented, not changed here)

- **MTF collapse ≥ 1H.** `SignalProcessor` buckets incoming bars by clock into 5m/15m/1h groups; with ≥ 60 m bars each group holds one bar, so trend_follow's "1h" alignment degenerates to a same-TF check.
- **Indicator periods stay in bars** (EMA 12/15, ATR 14, ADX on 4H bars = 12/15/14 × 4H). Intended frequency-lever semantics.
- **Meta-filter time-of-day rule** (04–07 UTC penalty, 13–17 UTC bonus) was designed for 15m; on 4H every signal is at 00/04/08/12/16/20 UTC. No CLI flag here (TASK_018 rule 3: ex-ante justification needed).
- **Stop-on-entry-bar.** A 15m-sized ATR stop can be hit inside the 4H entry bar (engine checks stop before TP — pessimistic). Exit redesign is E5, not E4.
- **Upstream gaps.** The holdout has one 4-hour Coinbase outage (2025-10-25T16:00–20:59Z); the engine steps the union timeline (no fabricated bars).
- **Q4 of the eval window has 1 trade** (n per quarter 14/15/12/1). Regime/EMA-crossover silence, not a data gap (bars are present to 2026-02-28T20:00Z). Reported, not interpreted.

## 5. Not done / not in scope

- No desk GO. `BETA BARS PASS` is an Eng screen statement; TM decides.
- No E5 exit redesign, no A6, no maker-fill model, no 15m runs, no re-enabling of disabled strategies, no INTX/perps path, no synthetic data path, nothing written under `fixtures/bars/**`, no guardrails change.
