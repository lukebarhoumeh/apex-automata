# F4 — HL backtest validation of A1 (2026-05-18b session)

**Engine commit:** `c2329c5` (post-#11 per-symbol fee routing)
**YAML commit (tested):** `bc95fb8` (A1 retune) and a transient `+20 %` tune that was reverted before commit.
**Falsification predicate (per A1 doc §6.5 / prompt):**
- Combined PF across all 4 windows ≥ 1.20
- Avg net PnL per TP-exit > 0
- Total trades across all 4 windows ∈ [100, 350]

**Verdict: PREDICATE FAILS on baseline AND tune.** Per stop condition: pushed this dir + the failing F4 doc, did NOT proceed to A2. A3 still implemented because it is structurally additive.

Full analysis: `docs/research/2026-05-18_f4-hl-backtest-validation.md`.

---

## Runs in this session

| File | Window | Products | Trades | WR | PF | Net PnL | Fees | Note |
|---|---|---|---:|---:|---:|---:|---:|---|
| `run1_hl_90d.txt` | 2025-12-05 → 2026-03-05 | BTC/ETH/SOL spot | 246 | 39.84 % | 0.88 | -$521.13 | $640.54 | A1 baseline (post-#11) |
| `run2_hl_12m.txt` | 2025-03-05 → 2026-03-05 | BTC/ETH/SOL spot | 544 | 33.64 % | 0.77 | -$2,815.94 | $1,377.73 | A1 baseline |
| `run3_hl_30d.txt` | 2026-02-04 → 2026-03-05 | BTC/ETH/SOL spot | 95 | 32.63 % | 0.74 | -$719.29 | $220.05 | A1 baseline |
| `run4_hl_perps_90d.txt` | 2025-12-05 → 2026-03-05 | ETH/BTC PERP-INTX | 902 | 33.04 % | 0.37 | -$5,870.71 | $2,387.70 | A1 baseline; first run with #11 per-symbol fee routing live for perps |
| `run1_hl_90d_TUNE.txt` | (same as run1) | (same) | 245 | 40.00 % | 0.87 | -$577.89 | $638.16 | +20 % landing zone (atr_min 0.006, momentum TP 6.0) |
| `run2_hl_12m_TUNE.txt` | (same as run2) | (same) | 540 | 33.52 % | 0.77 | -$2,821.76 | $1,368.04 | +20 % tune |
| `run3_hl_30d_TUNE.txt` | (same as run3) | (same) | 93 | 31.18 % | 0.70 | -$838.26 | $215.24 | +20 % tune |
| `run4_hl_perps_90d_TUNE.txt` | (same as run4) | (same) | **178** | 29.21 % | 0.29 | **-$1,370.78** | $471.17 | +20 % tune — single largest dollar improvement (+$4,500 vs baseline run 4) |

Combined baseline: 1,787 trades, -$9,927 net, $4,626 fees, combined PF 0.654.
Combined tune: 1,056 trades (-41 %), -$5,609 net (+$4,318), $2,693 fees, combined PF 0.738.

---

## Why predicate fails

1. **Combined trade count too high.** Target ∈ [100, 350]; actual 1,787 baseline / 1,056 tune. Driven heavily by run 4 perps on 1-minute bars vs spot runs on 15-minute bars (15× bar count for the same window). The predicate appears calibrated for spot-only matrices.
2. **PF universally sub-1.0.** Both passes; both spot and perps. Underlying WR ~30-40 % vs A1's planning baseline of `p ≈ 0.50` means the geometric R cushion A1 built in (TP / stop = 2.5) isn't enough.
3. **Wider TP / tighter ATR floor (the +20 % tune) doesn't solve PF.** It cuts trade count and saves dollars on perps, but per-run PF stays roughly flat (or slightly worse) because wider TPs reduce TP-hit-rate.

Per F4 doc §3, the real lever for PF improvement is **A3's pre-trade EV gate**, which filters per-signal where `EV < min_ev` regardless of geometric R. That's why A3 proceeds even though A2 is skipped.

---

## Compared to F3 (Coinbase 40 bps, pre-A1)

90 d window direct comparison (same dates, same products):

| Metric | F3 run 2 (HL 90d, pre-A1) | F4 run 1 (HL 90d, post-A1) | Δ |
|---|---:|---:|---|
| Trades | 249 | 246 | -1 % |
| Win Rate | 39.4 % | 39.84 % | +0.4 pp |
| Profit Factor | 0.83 | 0.88 | +0.05 |
| Net PnL | -$791 | -$521 | **+$270** |
| Fees | $648 | $641 | -$7 |

A1 saves $270 per 90-day window (-34 % loss reduction). Directionally correct; absolute level still negative.
