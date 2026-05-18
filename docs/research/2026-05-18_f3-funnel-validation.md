# F3 — Funnel-Latch Validation (Re-run of May 11 4-Run Backtest Matrix)

**Date:** 2026-05-18
**Commit:** `2041ba46093ca5e91bef1d40daff616870f01f43` (main)
**Wall clock:** ~4 minutes total (2026-05-18T18:19:53Z → 18:23:51Z)

## TL;DR

**VERDICT: PASS** — all 4 runs cleared the ≥ 50-trades success gate. Wave 1's funnel-latch fix (F1 PR #24 commit `bb65598`, F2 PR #35 commit `3dbd49c`) is empirically validated. The strategy funnel now produces trades on historical bars instead of latching after 36-48 simulated hours.

## Per-run results

| Run | Window | Fee | Total Trades | Win Rate | Profit Factor | Net PnL | Total Fees | Final Capital | Max DD | Total Return |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | CB 90d (2025-12-05 → 2026-03-05) | 40 bps | **249** | 32.5% | 0.25 | -$5,905 | $5,762 | $4,095 | 59.5% | -59.05% |
| 2 | HL 90d (2025-12-05 → 2026-03-05) | 4.5 bps | **249** | 39.4% | 0.83 | -$791 | $648 | $9,209 | 11.6% | -7.91% |
| 3 | CB 12m (2025-03-05 → 2026-03-05) | 40 bps | **470** | 28.5% | 0.33 | -$11,253 | $10,513 | -$1,253 | 112.5% | -112.53% |
| 4 | CB 30d late (2026-02-04 → 2026-03-05) | 40 bps | **95** | 30.5% | 0.38 | -$2,465 | $1,943 | $7,535 | 24.7% | -24.65% |

All runs ≥ 50 trades. Funnel is no longer latched.

## Comparison vs May 11 baseline

| Run | May 11 trades | 2026-05-18 trades | Δ |
|---|---:|---:|---|
| run1 (CB 90d) | 9 | 249 | +27.7× |
| run2 (HL 90d) | 9 | 249 | +27.7× |
| run3 (CB 12m) | 10 | 470 | +47.0× |
| run4 (CB 30d late) | 10 | 95 | +9.5× |

Pre-fix funnel produced < 12 trades regardless of window length (the "funnel latched in the first 36-48 sim hours" signature). Post-fix, trade count scales roughly linearly with window — exactly what a healthy funnel does.

## Secondary finding — fee leverage matches H2's prediction

run1 vs run2 — identical window, identical strategy state, identical bars — only the commission flag differs:

| Metric | run1 (Coinbase 40 bps) | run2 (HL 4.5 bps) | Δ |
|---|---:|---:|---:|
| Total Fees | $5,762 | $648 | 8.89× reduction |
| Net PnL | -$5,905 | -$791 | -$5,114 |
| Final Capital | $4,095 | $9,209 | +$5,114 |
| Max DD | 59.5% | 11.6% | -47.9 pp |

The 8.89× fee leverage matches H2's "8.9× improvement" thesis (`docs/research/2026-05-14_min-trade-size-hl-fees.md`) almost exactly. **Same trades, different venue: account survives at HL and gets blown at Coinbase.** This validates the entire Wave 2 A-track premise — venue change is non-negotiable.

## What this run does NOT prove

- **Strategies are still negative-EV on raw price action.** HL profit factor 0.83 — better than Coinbase's 0.25 but still < 1.0. A1 retune is required, not optional.
- **Backtest covers 2025-12-05 → 2026-03-05.** Two months of more recent bars (2026-03-05 → 2026-05-18) are un-backtested. Plan §649 already flags this; not a Wave 2 blocker.
- **run3 (CB 12m) blew the account** mid-window (-112.5% return, final capital −$1,253). Trade counts in run3 are inflated by trades on negative equity. F4 should re-run the 12m window at HL fees for a clean comparison.

## Artifacts

- Stdout per run: `atlas/var/backtest_results/_session_2026-05-18/run{1..4}_*.txt`
- CLI auto-generated JSON + text reports: `atlas/var/backtest_results/backtest_2026-05-18T*.json` + `report_2026-05-18T*.txt`

## Next steps (per sprint plan)

- **A1** — HL-fee-aware param retune from H2 (agent in flight at time of writing). Highest leverage Wave 2 task.
- **Backtest engine per-symbol fee routing** — new blocker discovered by B4 audit. `BacktestConfig.commission: number` is one flat decimal; F4 cannot mix spot + perp `--products` without first replacing it with a `FeeModel` lookup. See `docs/research/2026-05-18_b4-fee-model-audit.md` §"Structural latent defect".
- **F4** — re-run matrix at HL fees, with A1's retuned params, after backtest-engine routing is fixed.
