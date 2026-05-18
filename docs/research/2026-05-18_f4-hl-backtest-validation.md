# F4 — HL Backtest Validation of A1 Retune

**Date:** 2026-05-18 (session "b")
**Commit (engine):** `c2329c5` (post-#11 per-symbol fee routing; pre-tune base = `bffba3b`)
**Wall clock:** ~10 min baseline matrix + ~10 min tune matrix
**Falsification predicate (per A1 doc §6.5 / prompt):**
- Combined PF across all 4 windows ≥ 1.20
- Avg net PnL per TP-exit trade > 0
- Total trades across all 4 windows ∈ [100, 350]

**Verdict: PREDICATE FAILS on baseline AND on +20 % landing-zone tune.** Per the prompt's stop condition ("1 round of param tuning doesn't recover: STOP after pushing the failing F4 doc, do NOT proceed to A2"), the YAML is reverted to the A1-as-committed state (`bc95fb8`) and A2 is skipped. A3 (fee-adjusted EV gate) proceeds because it is structurally additive regardless of A1's PF outcome.

---

## 1. Baseline F4 — current main (post-A1 + post-#11)

YAML state: `bc95fb8` A1 retune as committed. Engine state: `c2329c5` post-#11 per-symbol fee routing (pre-F4 blocker resolved this session — see `2026-05-18_b4-fee-model-audit.md` §"Recommended fix shape" Option B).

| Run | Window | Products | Trades | WR | PF | Net PnL | Fees | Final Capital | Max DD |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | HL 90d (2025-12-05 → 2026-03-05) | BTC/ETH/SOL spot | 246 | 39.84% | 0.88 | -$521.13 | $640.54 | $9,478.87 | 10.86% |
| 2 | HL 12m (2025-03-05 → 2026-03-05) | BTC/ETH/SOL spot | 544 | 33.64% | 0.77 | -$2,815.94 | $1,377.73 | $7,184.06 | 29.28% |
| 3 | HL 30d late (2026-02-04 → 2026-03-05) | BTC/ETH/SOL spot | 95 | 32.63% | 0.74 | -$719.29 | $220.05 | $9,280.71 | 7.34% |
| 4 | HL 90d perps | ETH/BTC PERP-INTX | **902** | 33.04% | **0.37** | **-$5,870.71** | $2,387.70 | $4,129.29 | 58.77% |

Combined (sum across runs): **1,787 trades**, total net **-$9,927.07**, total fees **$4,626.02**.

Combined PF (gross-profit-weighted): `0.654` (back-derived from per-run PF and netProfit; see §5).

**Per-strategy split (baseline):**

| Run | Strategy | Trades | WR | Net PnL | Avg R-multiple |
|---|---|---:|---:|---:|---:|
| 1 | trend_follow | 145 | 39.31% | -$654.54 | -0.127 |
| 1 | momentum | 101 | 40.59% | +$133.40 | -0.139 |
| 2 | trend_follow | 421 | 34.68% | -$1,667.22 | -0.147 |
| 2 | momentum | 123 | 30.08% | -$1,148.72 | -0.392 |
| 3 | trend_follow | 42 | 28.57% | -$521.34 | -0.349 |
| 3 | momentum | 53 | 35.85% | -$197.95 | -0.214 |
| 4 | trend_follow | 310 | 35.16% | -$1,472.14 | -0.287 |
| 4 | momentum | 592 | 31.93% | -$4,398.57 | -0.546 |

momentum is the dominant bleed source on perps (run 4: $4.4k of the $5.9k loss). trend_follow is more contained but still net negative across all 4 windows.

### 1.1 Predicate evaluation — baseline

| Criterion | Target | Actual | Verdict |
|---|---|---:|---|
| Combined PF | ≥ 1.20 | 0.654 | **FAIL** |
| Per-run PF | ≥ 1.20 each | 0.88 / 0.77 / 0.74 / 0.37 | **FAIL** (all 4) |
| Combined trade count | ∈ [100, 350] | 1,787 | **FAIL** (5.1× over) |
| Per-window trade count | ∈ [25, 100] | 246 / 544 / 95 / 902 | **FAIL** (3 of 4 over) |
| Avg net PnL per TP-exit | > 0 | not directly reported by engine, but PF < 1 across all 4 runs implies it is ≤ 0 (gross profit < gross loss + fees combined) | **FAIL** (inferred) |

**All three predicate axes fail.**

### 1.2 vs F3 baseline (pre-A1, same windows where they overlap)

Direct comparison on the 90 d HL window (F3 run 2 vs F4 run 1) tests A1 in isolation since #11 routing only matters for the perps run 4 (F3 didn't include perps):

| Metric | F3 run 2 (HL 90d, pre-A1) | F4 run 1 (HL 90d, post-A1) | Δ |
|---|---:|---:|---|
| Trades | 249 | 246 | -1.2 % |
| Win Rate | 39.4 % | 39.84 % | +0.4 pp |
| Profit Factor | 0.83 | 0.88 | +0.05 |
| Net PnL | -$791 | -$521 | **+$270** |
| Fees | $648 | $641 | -$7 |

A1 is **directionally working** — on the same 90 d window, PF improved by +0.05 and net loss shrank by $270 (-34 %). But the absolute level (PF 0.88) remains structurally below break-even, so the predicate's PF ≥ 1.20 target is unreachable from this starting point with one tune round.

---

## 2. +20 % landing-zone tune — second F4 pass

Per A1 doc §3.3 ("the conservative landing zone if F4 shows the 5.0× TP isn't enough"):
- `filters.atr_volatility_min`: 0.005 → **0.006** (+20 %, = 0.6 % min 30-day ATR)
- `momentum.takeProfitAtr`: 5.0 → **6.0** globally + on every per-symbol momentum override (4 lines total)
- trend_follow `takeProfitAtr` already at 6.0 post-A1 → unchanged

YAML diff applied locally, all 4 F4 runs re-ran, YAML reverted.

| Run | Trades | WR | PF | Net PnL | Fees | Δ Net vs baseline | Δ Trades vs baseline |
|---|---:|---:|---:|---:|---:|---|---|
| 1 | 245 | 40.00 % | 0.87 | -$577.89 | $638.16 | **-$57** | -1 |
| 2 | 540 | 33.52 % | 0.77 | -$2,821.76 | $1,368.04 | **-$6** | -4 |
| 3 | 93 | 31.18 % | 0.70 | -$838.26 | $215.24 | **-$119** | -2 |
| 4 | **178** | 29.21 % | 0.29 | **-$1,370.78** | $471.17 | **+$4,500** | **-724** |

Combined tune: **1,056 trades** (-41 % vs baseline), total net **-$5,608.69** (+$4,318 vs baseline), total fees **$2,692.61**.

Combined PF (tune): **0.738** (vs 0.654 baseline; +0.084).

### 2.1 Predicate evaluation — tune

| Criterion | Target | Actual | Verdict |
|---|---|---:|---|
| Combined PF | ≥ 1.20 | 0.738 | **FAIL** |
| Per-run PF | ≥ 1.20 each | 0.87 / 0.77 / 0.70 / 0.29 | **FAIL** (all 4) |
| Combined trade count | ∈ [100, 350] | 1,056 | **FAIL** (3× over) |
| Per-window trade count | ∈ [25, 100] | 245 / 540 / 93 / 178 | **FAIL** (3 of 4 over) |
| Avg net PnL per TP-exit | > 0 | inferred ≤ 0 (PF < 1 universally) | **FAIL** |

**Predicate still fails on all three axes after one tune round.**

### 2.2 What the tune did and didn't do

**Did help:**
- Run 4 perps lost 80 % of its trades (902 → 178). Most of this is cascading: stricter `atr_volatility_min` + wider momentum TP → fewer winners → cold-streak meta-filter trips more often → fewer admitted signals. Funnel diagnostics confirm: `meta.cold_streak` filtered 6,524 signals (tune) vs 4,918 (baseline), and `momentum admitted` collapsed from 1,176 → 220.
- Capital preservation on run 4: **+$4,500 saved**. The tune's dollar effect on the perps run is the single biggest improvement of the session.
- Combined PF improved 0.654 → 0.738.

**Didn't help:**
- All 4 per-run PFs stayed sub-1.0. Wider TPs reduce TP-hit-rate, so the surviving winning trades realize their full 6× ATR move less often. Net dollar PF as ratio barely changes (or even slightly degrades on runs 1 / 2 / 3).
- Spot windows are slightly worse: run 1 -$57, run 2 -$6, run 3 -$119 (cumulative -$182). The tune is a perps-driven net win, not a spot win.
- Trade count, while down 41 %, is still 3× over the [100, 350] target.

**Why the predicate is structurally hard to reach in one tune:**
1. Run 4 perps uses 1-minute bars (129,600 bars in 90 d) vs spot's 15-minute bars (8,640 bars). The trade-count target [100, 350] was likely calibrated for spot-only matrices like F3 (where pre-A1 totals were 249 + 249 + 470 + 95 = 1,063 trades, already above target).
2. The dominant loss source is **momentum on 1-minute perp bars** (run 4 momentum: -$4.4k of run 4's -$5.9k). MACD-confirm + wider TP only partially mitigates this; the real cure is either (a) higher-timeframe entry filter, (b) a per-signal EV gate (A3), or (c) outright disable of momentum on 1m perps until A6's regime-conditional work lands.
3. PF stays sub-1.0 because trend_follow's "let multi-day winners run" thesis requires multi-day winners that the 90 d windows didn't supply enough of. trend_follow Avg R-multiple stays in -0.13 to -0.35 range across all runs — the trades simply don't pay back their stops on this tape.

---

## 3. Conclusions

1. **Predicate falsified.** Combined PF 0.65 → 0.74 (with tune) vs target 1.20. Three of three axes failing in both passes.
2. **A1 is directionally correct** (+$270 net on the F3-comparable 90 d window) but not powerful enough on its own to flip the strategy to net-positive EV at HL fees. The retune's headroom analysis (A1 doc §2.2) assumed `p ≈ 0.50` baseline winrate — empirical WR sits at 30-40 % across all 4 runs, well below the planning baseline. The geometric R cushion A1 builds in (TP/stop = 2.5 - 2.4 ratio) is insufficient to overcome WR < 40 %.
3. **The "+20 % landing zone" tune saves $4,300** on the perps run but degrades spot slightly, costs PF on every per-run basis, and is not the right surface to chase the predicate. Reverted.
4. **Per-symbol fee drag is material on both spot and perps** ($2.60 / trade spot, $2.65 / trade perps; both > 5 % of average loss). This means A2's wider-stop optimization remains live as a *future* lever, but A1's stop changes already captured the BTC-PERP-INTX / HL BTC-USD low-hanging fruit. The remaining `stopAtr=2.0` values would need direct empirical validation to justify lifting — which A2 was supposed to do, but per stop condition A2 is skipped this session.
5. **#11 (per-symbol fee routing) is validated end-to-end.** Run 4 perps fired correctly at the perps_intx fee tier (5 bps) — without #11 it would have charged spot 40 bps and reported ~8× higher fees. The lower fees are exactly why the perps loss is "only" -$5,871 instead of the ~$15-20k it would have been pre-#11. (Cross-check: $2,388 fees on $2.65/trade × 902 trades = self-consistent; that's the 5 bps tier, not 40.)

---

## 4. Recommended next steps

### 4.1 In scope for this session (per prompt)

- ✅ #11 — committed in `c2329c5`.
- ✅ F4 — this doc.
- **SKIP A2** per stop condition. The +20 % tune attempt empirically demonstrates that wider TP / tighter ATR floor alone cannot reach the predicate.
- **DO A3** (fee-adjusted pre-trade EV gate) — A3 is structurally additive and partially closes the gap A1 left open. EV gate filters individual signals where `p * TP_R - (1-p) * SL_R - 2 * fee * notional < threshold` regardless of geometric R. With current empirical `p` in [0.30, 0.40] range, A3 will reject the long left tail of low-edge trades — that's the real lever for PF improvement.

### 4.2 Out of scope (next session)

- **Revisit the predicate.** Per-window trade count [25, 100] is not achievable on 1-minute perp data without disabling momentum on perps entirely. A revised predicate should either (a) measure spot and perps separately, (b) normalize trade count by candle count, or (c) target a lower PF threshold like 1.0 break-even.
- **Empirical p per (strategy, symbol).** A1 doc §7 Q2 already flags this; F4 makes it urgent. Most likely conclusion: `p_momentum_on_1m_perps < 0.30 → A6 regime-conditional disable`.
- **Re-apply the +20 % landing zone for perps-only.** The $4,500 savings on run 4 is real and worth capturing. Either via separate perps-specific overrides in `perps_symbols.*.strategy_overrides.momentum.takeProfitAtr` (set to 6.0 only for perps; leave spot at 5.0), or as part of A6.
- **Consider an A1-precedent-style commit of just the perps-side tweaks** as a follow-up — the spot side is essentially unchanged; only perp momentum benefits from the 5.0→6.0 TP. That keeps the spot config at the A1 optimum and lifts only the perps side.
- **B1 (HL adapter completion, testnet)** remains the next-biggest unblocker for collecting real HL fill data so F5 can validate on actual HL price action instead of CB-candles-with-HL-fees-simulated.

### 4.3 J1 readiness

J1 is gated on A1+A2+A3+A4 settling (handoff §3.1). With A2 skipped this session and A4 still pending (depends on H6), J1 stays parked. The F4 numbers are useful J1 input though: `max_drawdown_limit = 0.15` was hit on run 2 (29.28 % drawdown over 12 m) and exceeded on run 4 (58.77 %). If A3 reduces trade count + improves per-trade EV enough to keep DD < 20 % across all 4 windows, J1's existing limits hold; otherwise J1 needs to tighten DD limits.

---

## 5. Combined-PF derivation (for traceability)

Combined PF = (Σ grossProfit) / (Σ grossLoss). The engine logs profitFactor and netProfit per run; gross profit and gross loss are back-computed from `netProfit = grossProfit - grossLoss` and `PF = grossProfit / grossLoss`:
- `grossLoss = netProfit / (PF - 1)` (for PF < 1, both terms negative → positive result)
- `grossProfit = grossLoss * PF`

Baseline:

| Run | netProfit | PF | grossLoss | grossProfit |
|---|---:|---:|---:|---:|
| 1 | -$521.13 | 0.88 | $4,342.78 | $3,821.65 |
| 2 | -$2,815.94 | 0.77 | $12,243.22 | $9,427.28 |
| 3 | -$719.29 | 0.74 | $2,766.50 | $2,047.21 |
| 4 | -$5,870.71 | 0.37 | $9,318.59 | $3,447.88 |
| **Total** | **-$9,927.07** | — | **$28,671.09** | **$18,744.02** |

Combined PF = $18,744.02 / $28,671.09 = **0.654**.

Tune:

| Run | netProfit | PF | grossLoss | grossProfit |
|---|---:|---:|---:|---:|
| 1 | -$577.89 | 0.87 | $4,445.30 | $3,867.41 |
| 2 | -$2,821.76 | 0.77 | $12,268.52 | $9,446.76 |
| 3 | -$838.26 | 0.70 | $2,794.20 | $1,955.94 |
| 4 | -$1,370.78 | 0.29 | $1,930.68 | $559.90 |
| **Total** | **-$5,608.69** | — | **$21,438.70** | **$15,830.01** |

Combined PF = $15,830.01 / $21,438.70 = **0.738**.

---

## 6. Artifacts

- Raw stdouts: `atlas/var/backtest_results/_session_2026-05-18b/run{1..4}_hl_{90d,12m,30d,perps_90d}.txt`
- Tune stdouts: `atlas/var/backtest_results/_session_2026-05-18b/run{1..4}_*_TUNE.txt`
- Engine-generated JSON + text reports: `atlas/var/backtest_results/backtest_2026-05-18T{18..19}-*.json` and `report_2026-05-18T{18..19}-*.txt` (the timestamped CLI auto-saves; not curated to the session dir but exist for full inspection).
- Session README: `atlas/var/backtest_results/_session_2026-05-18b/README.md`.

---

**End of F4.**
