# CFM Backtest Verdict — BTC-USD Nano Futures (BIP)

Generated: 2026-10-20 16:01 UTC
Codebase: `main` @ `490fe8b`

## Data

- Source: Coinbase Advanced public API, BTC-USD spot as proxy for BIP futures price
- Granularity: 1H candles resampled to 4H (trend_follow) and 1D (donchian_daily_s3)
- No basis/funding data from `market_context_bars` (VM cannot reach Supabase); sensitivity sweep included

## Cost Model

Matches `cfm-fee-calculator.ts`:
- Entry: 9.5 bps maker commission + $0.10/ct exchange fee
- Exit: 10.0 bps taker commission + $0.10/ct exchange fee
- Slippage base case: 2 bps/side (stress: 5 and 10 bps)
- Contract size: 0.01 BTC (BIP nano)
- Sizing: production `cfm-position-sizer.ts` logic, max_daily_loss_usd=$100

## Assumptions & Gaps

1. Spot used as futures price proxy — no basis adjustment in base case (sensitivity sweep ±5/10/20 bps per 8h)
2. CDE weekly break (Fri 17:00-18:00 ET) not modeled in base case (would remove ~0.6% of 4H bars)
3. No market impact model beyond slippage estimate (reasonable for nano contract sizes)
4. ADX-based regime detection (simplified from production `adx_primary` mode)
5. Walk-forward parameter grid capped at <50 combos per strategy per spec

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

## Donchian Daily S3 (in20/out10, long-only)

### Verdict: **HOLD**

| Metric | Full Sample | WF OOS (stitched) | Holdout OOS (12mo) |
|--------|------------|-------------------|--------------------|
| Net P&L after costs | $2788.85 | $738.72 | $-67.33 |
| Sharpe | 0.89 | 0.42 | -0.75 |
| Trades | 53 | 25 | 6 |
| Win Rate | 49.1% | 40.0% | 16.7% |
| Profit Factor | 3.66 | 1.96 | 0.57 |
| Max Drawdown | 3.86% | — | 1.11% |
| Expectancy/trade | $52.62 | $29.55 | $-11.22 |
| Avg R | 0.63 | 0.40 | -0.14 |
| Total Fees | $138.15 | — | $12.33 |
| Fees % of Gross | 4.7% | — | 22.4% |
| CAGR | 3.26% | — | -0.89% |
| Exposure | 38.9% | — | 37.2% |
| Size-zero skips | 5 (4.3%) | — | 1 (7.1%) |

### Overfitting Checks

- **Deflated Sharpe probability**: 0.0000 (FAIL <0.95)
- **PBO (CSCV 16 splits)**: 0.7300 (FAIL ≥0.3)
- **Shifted entry (+1 bar)**: ratio 0.85 (original $2788.85 → shifted $2362.02)
- **Random baseline (1000 runs)**: random better 11.0% of the time (mean $-324.84)

### Fee Sensitivity

| Scenario | Net P&L | Sharpe | Trades | Win Rate |
|----------|---------|--------|--------|----------|
| 1.0x_fees_10.0bps_slip | $2726.24 | 0.87 | 53 | 49.1% |
| 1.0x_fees_2.0bps_slip | $2788.85 | 0.89 | 53 | 49.1% |
| 1.0x_fees_5.0bps_slip | $2765.37 | 0.88 | 53 | 49.1% |
| 2.0x_fees_10.0bps_slip | $2603.74 | 0.84 | 53 | 47.2% |
| 2.0x_fees_2.0bps_slip | $2666.35 | 0.86 | 53 | 49.1% |
| 2.0x_fees_5.0bps_slip | $2642.87 | 0.85 | 53 | 49.1% |
| 3.0x_fees_10.0bps_slip | $2481.24 | 0.80 | 53 | 41.5% |
| 3.0x_fees_2.0bps_slip | $2543.85 | 0.82 | 53 | 43.4% |
| 3.0x_fees_5.0bps_slip | $2520.37 | 0.81 | 53 | 41.5% |

Breakeven fee multiplier: infx (inf bps effective)

### Regime / Year Breakdown

| Period | Trades | Net P&L | Win Rate | Avg R |
|--------|--------|---------|----------|-------|
| 2019 (recovery) | 6 | $799.00 | 83% | 1.38 |
| 2020 (covid + rally) | 9 | $925.85 | 67% | 1.14 |
| 2021 (bull) | 6 | $145.45 | 50% | 0.44 |
| 2022 (bear) | 8 | $-329.72 | 12% | -0.47 |
| 2023 (recovery) | 7 | $568.72 | 57% | 0.93 |
| 2024 (bull) | 9 | $502.61 | 44% | 0.85 |
| 2025 (current) | 2 | $244.27 | 100% | 1.36 |
| 2026 (current) | 6 | $-67.33 | 17% | -0.14 |

### $100 Risk Cap Analysis

- Total entry signals: 58
- Sized to zero contracts at $100 cap: 5
- Minimum stopAtr for <10% skips: 0.5

The $100 risk cap combined with 1D ATR creates sizing constraints:
daily ATR on BTC routinely exceeds 3%, so `stopAtr × ATR` pushes stop
distance beyond what $100 loss cap allows for even 1 contract (0.01 BTC).
Widening `stopAtr` helps but does not eliminate the issue; a narrower
`stopAtr` of ~1.5 would allow most entries but sacrifices the wide stop
the S3 rule design relies on. Do NOT raise the $100 cap — instead,
consider a `stopAtr` of 1.5–2.0 with the understanding that the
software stop will cut some trades the pure S3 rule would have held.

## Combined Portfolio

| Metric | Value |
|--------|-------|
| Trades | 233 |
| Net P&L | $3368.91 |
| Sharpe | 0.70 |
| Max Drawdown | 6.34% |
| Win Rate | 36.9% |
| Profit Factor | 1.64 |

## Verdict Summary

### `trend_follow (4H)` → **HOLD**

- WF-OOS expectancy>0 at 2x: ✗ ($-290.36)
- DSR>0.95: ✗ (0.0000)
- PBO<0.3: ✗ (0.5100)
- ≥100 OOS trades: ✗ (84)

### `donchian_daily_s3 (1D)` → **HOLD**

- WF-OOS expectancy>0 at 2x: ✓ ($2666.35)
- DSR>0.95: ✗ (0.0000)
- PBO<0.3: ✗ (0.7300)
- ≥100 OOS trades: ✗ (25)

## Charts

- `research/charts/equity_curves.png` — equity curves after costs
- `research/charts/drawdown.png` — drawdown percentage
- `research/charts/wf_heatmap_tf.png` — trend_follow walk-forward parameter selection
- `research/charts/wf_heatmap_donch.png` — donchian walk-forward parameter selection
- `research/charts/wf_oos_equity.png` — walk-forward OOS equity (stitched)
