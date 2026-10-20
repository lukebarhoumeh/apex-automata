# CFM Backtest Verdict — BTC-USD Nano Futures (BIP) + Multi-Asset Extension

Generated: 2026-10-20 16:25 UTC
Codebase: `main` @ `490fe8b`

## Data

- Source: Coinbase Advanced public API, spot prices as proxy for CFM futures
- Granularity: 1H candles resampled to 4H (trend_follow) and 1D (donchian_daily_s3)
- Instruments: 6 → BTC-USD, ETH-USD, SOL-USD, LTC-USD, DOGE-USD, XRP-USD

| Instrument | CFM Product | Contract Size | Status | Daily Bars | Period |
|-----------|------------|---------------|--------|-----------|--------|
| BTC-USD | BIP-20DEC30-CDE | 0.01 | listed | 2850 | 2019-01-01 → 2026-10-20 |
| ETH-USD | ETP-20DEC30-CDE | 0.1 | listed | 2850 | 2019-01-01 → 2026-10-20 |
| SOL-USD | — | 1.0 | hypothetical | 1952 | 2021-06-17 → 2026-10-20 |
| LTC-USD | — | 1.0 | hypothetical | 2850 | 2019-01-01 → 2026-10-20 |
| DOGE-USD | — | 1000.0 | hypothetical | 1966 | 2021-06-03 → 2026-10-20 |
| XRP-USD | — | 100.0 | hypothetical | 1890 | 2019-02-26 → 2026-10-20 |

### Why these instruments

- **BTC-USD (BIP)**: listed CDE nano BTC, 0.01 BTC/ct — the primary target
- **ETH-USD (ETP)**: listed CDE nano ETH, 0.1 ETH/ct — disabled in guardrails pending Risk Master sign-off, but spec verified
- **SOL-USD**: hypothetical 1 SOL/ct — reliable Coinbase spot history since 2021-06, second-largest alt after ETH
- **LTC-USD**: hypothetical 1 LTC/ct — Coinbase spot since 2016, proxy for established non-BTC trends
- **DOGE-USD**: hypothetical 1000 DOGE/ct — Coinbase spot since 2021-06, high-vol alt
- **XRP-USD**: hypothetical 100 XRP/ct — Coinbase spot since 2019-02, different correlation regime

Hypothetical contract sizes chosen so 1 contract ≈ $50–$150 notional, matching BIP/ETP nano sizing philosophy.

## Cost Model

Same as Phase 1 (matches `cfm-fee-calculator.ts`):
- Entry: 9.5 bps maker commission + $0.10/ct exchange fee
- Exit: 10.0 bps taker commission + $0.10/ct exchange fee
- Slippage base case: 2 bps/side
- Sizing: production `cfm-position-sizer.ts` logic, max_daily_loss_usd=$100 (NOT raised)

## Trend Follow (4H EMA Crossover)

### Verdict: **HOLD**

| Metric | Full Sample | WF OOS (stitched) | Holdout OOS (12mo) |
|--------|------------|-------------------|--------------------|
| Net P&L after costs | $580.06 | $504.64 | $-310.99 |
| Sharpe | 0.16 | 0.26 | -1.22 |
| Trades | 180 | 84 | 25 |
| Win Rate | 33.3% | 33.3% | 32.0% |
| Profit Factor | 1.26 | 1.33 | 0.69 |
| Max Drawdown | 7.07% | — | 4.38% |
| Expectancy/trade | $3.22 | $6.01 | $-12.44 |
| Avg R | 0.10 | 0.09 | -0.16 |
| Total Fees | $987.92 | — | $104.98 |
| Fees % of Gross | 63.0% | — | 51.0% |
| CAGR | 0.73% | — | -3.29% |
| Exposure | 29.4% | — | 32.6% |
| Size-zero skips | 0 (0.0%) | — | 0 (0.0%) |

### Overfitting Checks

- **Deflated Sharpe probability**: 0.0000 (FAIL <0.95)
- **PBO (CSCV 16 splits)**: 0.5100 (FAIL ≥0.3)
- **Shifted entry (+1 bar)**: ratio 5.21 (original $580.06 → shifted $3024.20)
- **Random baseline (1000 runs)**: random better 16.2% of the time (mean $-1150.72)

### Fee Sensitivity

| Scenario | Net P&L | Sharpe | Trades | Win Rate |
|----------|---------|--------|--------|----------|
| 1.0x_fees_10.0bps_slip | $110.05 | 0.03 | 180 | 33.3% |
| 1.0x_fees_2.0bps_slip | $580.06 | 0.16 | 180 | 33.3% |
| 1.0x_fees_5.0bps_slip | $403.81 | 0.11 | 180 | 33.3% |
| 2.0x_fees_10.0bps_slip | $-760.37 | -0.21 | 180 | 31.7% |
| 2.0x_fees_2.0bps_slip | $-290.36 | -0.08 | 180 | 32.8% |
| 2.0x_fees_5.0bps_slip | $-466.61 | -0.13 | 180 | 32.2% |
| 3.0x_fees_10.0bps_slip | $-1630.79 | -0.45 | 180 | 31.1% |
| 3.0x_fees_2.0bps_slip | $-1160.78 | -0.32 | 180 | 31.7% |
| 3.0x_fees_5.0bps_slip | $-1337.04 | -0.37 | 180 | 31.1% |

Breakeven fee multiplier: 1.7x (43.9 bps effective)

### Regime / Year Breakdown

| Period | Trades | Net P&L | Win Rate | Avg R |
|--------|--------|---------|----------|-------|
| 2019 (recovery) | 19 | $-162.49 | 32% | 0.07 |
| 2020 (covid + rally) | 23 | $661.75 | 39% | 0.37 |
| 2021 (bull) | 24 | $44.98 | 33% | 0.07 |
| 2022 (bear) | 23 | $97.94 | 30% | 0.14 |
| 2023 (recovery) | 20 | $-32.03 | 30% | -0.01 |
| 2024 (bull) | 22 | $189.06 | 36% | 0.19 |
| 2025 (current) | 27 | $32.63 | 33% | 0.07 |
| 2026 (current) | 22 | $-251.78 | 32% | -0.12 |




## Donchian Daily S3 — Multi-Asset Extension

### Verdict: **HOLD**

### stopAtr Sweep (1.5 → 2.5)

| stopAtr | Trades | Net P&L | Sharpe | Skip % | Win Rate | PF |
|---------|--------|---------|--------|--------|----------|----|
| 1.50 | 288 | $29628.84 | 0.91 | 0.0% | 44.1% | 3.14 |
| 1.75 | 288 | $25965.21 | 0.93 | 0.0% | 44.1% | 3.22 |
| 2.00 | 288 | $22464.95 | 0.93 | 0.0% | 44.1% | 3.22 |
| 2.25 | 288 | $20402.02 | 0.93 | 0.0% | 44.1% | 3.27 |
| 2.50 | 288 | $17638.18 | 0.92 | 0.0% | 44.1% | 3.17 |

**Selected stopAtr: 2.0** (best Sharpe with <15% skip rate)

### Per-Asset Results (stopAtr=2.0)

| Asset | Trades | Net P&L | Skips | Skip % |
|-------|--------|---------|-------|--------|
| BTC-USD | 58 | $4116.44 | 0/116 | 0% |
| ETH-USD | 61 | $4038.53 | 0/122 | 0% |
| SOL-USD | 37 | $6203.05 | 0/74 | 0% |
| LTC-USD | 64 | $477.35 | 0/128 | 0% |
| DOGE-USD | 32 | $2373.58 | 0/64 | 0% |
| XRP-USD | 36 | $5255.99 | 0/72 | 0% |

### Key Numbers (stopAtr=2.0, pooled)

| Metric | Full Sample | WF OOS (stitched) | Holdout OOS (12mo) |
|--------|------------|-------------------|--------------------|
| Net P&L after costs | $22464.95 | $7754.55 | $91.34 |
| Sharpe | 0.93 | 1.05 | 0.09 |
| Trades | 288 | 82 | 43 |
| Win Rate | 44.1% | 51.2% | 30.2% |
| Profit Factor | 3.22 | 4.23 | 1.22 |
| Max Drawdown | 8.47% | — | 10.61% |
| Expectancy/trade | $78.00 | $94.57 | $2.12 |
| Avg R | 0.87 | 1.06 | 0.05 |
| Total Fees | $1430.41 | — | $206.11 |
| Exposure | 183.2% | — | 207.1% |

### Holdout OOS Per-Asset

| Asset | Trades | Net P&L | Win Rate | Sharpe |
|-------|--------|---------|----------|--------|
| BTC-USD | 7 | $-133.85 | 14% | -1.45 |
| ETH-USD | 8 | $-103.17 | 50% | -0.75 |
| SOL-USD | 8 | $320.34 | 38% | 0.67 |
| LTC-USD | 9 | $-86.19 | 22% | -0.32 |
| DOGE-USD | 5 | $-41.93 | 40% | -0.21 |
| XRP-USD | 6 | $136.14 | 17% | 0.41 |

### Overfitting Checks

- **Deflated Sharpe probability**: 0.0000 (FAIL <0.95) [n_trades=288, n_trials=55]
- **PBO (CSCV 16 splits)**: 0.9900 (FAIL ≥0.3)
- **Shifted entry (+1 bar)**: ratio 0.99 (original $22464.95 → shifted $22340.25)
- **Random baseline (1000 runs)**: random better 22.1% (mean $16820.94)

### Fee Sensitivity (pooled)

- **1.0x fees**: $22464.95 (288 trades)
- **2.0x fees**: $21144.71 (288 trades)
- **3.0x fees**: $19824.46 (288 trades)

### GO Criteria

| Criterion | Result | Value |
|-----------|--------|-------|
| WF-OOS expectancy > 0 | ✓ PASS | $7754.55 |
| Full-sample positive at 2x costs | ✓ PASS | $21144.71 |
| Deflated Sharpe > 0.95 | ✗ FAIL | 0.0000 |
| PBO < 0.3 | ✗ FAIL | 0.9900 |
| ≥100 WF-OOS trades | ✗ FAIL | 82 |

### `donchian_daily_s3 (1D, multi-asset)` → **HOLD**

The pooled multi-asset donchian strategy is structurally profitable and fee-resistant,
but fails statistical rigour checks (DSR, PBO). The trade count is higher with
multiple instruments but may still be insufficient for CSCV to converge. The strategy
should remain in soak / research mode until more data accumulates or the parameter
grid is narrowed to reduce the trial count.

### $100 Risk Cap

At stopAtr=2.0, the skip rate is 0.0%.
The $100 cap is viable with a tighter stopAtr; the tradeoff is that the software stop
will cut more trades the pure S3 rule would have held. Do NOT raise the $100 cap.

## Charts

- `research/charts/equity_curves.png` — BTC-only equity (Phase 1)
- `research/charts/donch_multi_equity.png` — multi-asset donchian equity
- `research/charts/donch_multi_drawdown.png` — multi-asset donchian drawdown
- `research/charts/donch_stopatr_sweep.png` — stopAtr sweep (P&L, Sharpe, skip %)
- `research/charts/donch_multi_wf_oos.png` — multi-asset WF-OOS equity
- `research/charts/drawdown.png` — BTC-only drawdown (Phase 1)
- `research/charts/wf_heatmap_tf.png` / `wf_heatmap_donch.png` — Phase 1 WF heatmaps
