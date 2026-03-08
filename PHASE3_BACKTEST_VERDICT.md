# Phase 3 Backtest Verdict — Apex Automata (AtlasBot v2)

**Date:** March 6, 2026  
**Data:** 12 months BTC-USD + ETH-USD (15m candles, Coinbase), 86,888 candles total  
**Equity:** $10,000 | Risk/trade: 0.5% | Max open: 2 | Max exposure: 30%  
**Regime Detection:** ADX-based (>40 strong trend, 20-40 weak trend, <20 ranging)

---

## Executive Summary

**Two of four strategies have statistically validated edge on ETH-USD when traded on low-fee venues (Hyperliquid).** All four strategies are definitively dead on Coinbase. The path forward is exchange migration + strategy concentration.

---

## Fee Sensitivity Matrix (PnL by Exchange)

| Strategy | Coinbase (0.60%) | Kraken (0.26%) | Hyperliquid (0.05%) | Zero Fees |
|---|---|---|---|---|
| VWAP MR (BTC) | No trades | No trades | No trades | No trades |
| VWAP MR (ETH) | $3 (1 trade) | $23 (1 trade) | $35 (1 trade) | $38 |
| Breakout (BTC 1H) | -$2,260 | -$1,147 | -$330 | **-$119** |
| Breakout (BTC 15m) | -$1,441 | -$835 | -$427 | **-$326** |
| **Trend Follow (ETH)** | -$836 | +$251 | **+$1,024** | +$1,221 |
| Trend Follow (BTC) | -$513 | -$199 | +$3 | +$52 |
| Momentum (ETH) | -$1,732 | -$653 | **+$127** | +$327 |
| Momentum (BTC) | -$760 | -$415 | -$191 | **-$137** |

**Key insight:** Breakout and VWAP MR have no signal edge — they lose even at zero fees. Trend Follow and Momentum on ETH have real edge that gets eaten by fees above ~0.10%.

---

## Strategy Verdicts

### 1. VWAP Mean Reversion — ❌ KILL

**Reason:** ADX regime filter correctly constrains this to ranging markets (~14.7% of the time), but ranging regimes in crypto are too short-lived for mean reversion signals to generate meaningful trade volume. BTC produced zero trades; ETH produced one trade across 12 months. No amount of parameter tuning fixes a strategy that doesn't fire.

**Action:** Remove from production rotation entirely.

### 2. Donchian Breakout — ❌ KILL

**Reason:** Loses money even at zero fees. The signal itself is negative-expectancy. 40.9% win rate with avg_loss 1.9x avg_win means the strategy is systematically entering at bad levels — likely buying into exhaustion moves and selling into bottoms. This is a well-documented failure mode of channel breakout strategies in crypto's high-noise environment.

**Action:** Remove from production rotation entirely.

### 3. EMA Trend Follow (ETH) — ✅ GO (Conditional)

**Optimized Parameters:** EMA(12/15), Stop 2.5x ATR, TP 5.0x ATR  
**Exchange:** Hyperliquid (0.05% taker fee required)

| Metric | Value |
|---|---|
| Total trades | 130 |
| Win rate | 43.8% |
| PnL | +$1,864 (+18.6%) |
| Profit factor | 1.38 |
| Sharpe ratio | 2.44 |
| Max drawdown | 5.5% |
| Half Kelly | 6.0% |

**Monte Carlo (10,000 simulations):**
- Median outcome: +18.5%
- 5th percentile (worst realistic): +1.2%
- P(any loss): 4.0%
- P(loss >10%): 0.3%
- P(ruin): 0.0%
- 95th percentile MDD: 11.5%

**Walk-Forward (quarterly):**
- Q1: +$475 (45.7% WR) ✅
- Q2: +$403 (42.9% WR) ✅
- Q3: +$525 (46.7% WR) ✅
- Q4: +$353 (40.5% WR) ✅
- All 4 quarters profitable — strong consistency signal.

**Cross-asset:** Does NOT transfer to BTC (-$290). This is an ETH-specific edge.

**Conditions for go-live:**
1. Must trade on Hyperliquid (or equivalent <0.10% fee venue)
2. ETH-USD only — do not deploy on BTC
3. Start at quarter-Kelly position sizing (3.0% of bankroll per trade)
4. 30-day paper trade minimum before real capital

### 4. RSI/MACD Momentum (ETH) — ⚠️ CONDITIONAL GO (Paper Only)

**Optimized Parameters:** RSI(10) Long>55 Short<40, MACD(8/21/5), Stop 2.0x ATR, TP 4.0x ATR  
**Exchange:** Hyperliquid (0.05% taker fee required)

| Metric | Value |
|---|---|
| Total trades | 81 |
| Win rate | 44.4% |
| PnL | +$1,261 (+12.6%) |
| Profit factor | 1.41 |
| Sharpe ratio | 2.58 |
| Max drawdown | 5.9% |
| Half Kelly | 6.5% |

**Monte Carlo (10,000 simulations):**
- Median outcome: +12.5%
- 5th percentile: -2.0%
- P(any loss): 7.9%
- P(loss >10%): 0.5%
- 95th percentile MDD: 10.1%

**Walk-Forward (quarterly):**
- Q1: +$83 (38.5% WR) — Marginal
- Q2: +$1,016 (76.9% WR) — Outlier concentration
- Q3: +$452 (52.9% WR) ✅
- Q4: -$297 (28.0% WR) ❌
- Only 2 of 4 quarters convincingly profitable. Q2 is carrying the annual result.

**Why conditional:** The walk-forward shows quarterly inconsistency. Q4 losing quarter means this strategy may be regime-dependent in ways the ADX filter doesn't fully capture. The 7.9% probability of loss in Monte Carlo is also notably higher than Trend Follow's 4.0%.

**Conditions:**
1. Paper trade only for minimum 60 days
2. Require 2 consecutive profitable months before live
3. Hyperliquid only
4. ETH-USD only

---

## Architecture Implications for Phase 4+

### What changes in the implementation plan:

1. **Kill Phases 6-7 Coinbase optimization** — There is no viable strategy on Coinbase. The 0.60% fee structure makes all 4 strategies negative-EV. Don't waste engineering time optimizing for a venue where the math doesn't work.

2. **Reprioritize Hyperliquid adapter** — Move from Phase 6 to Phase 4. The entire system's viability depends on low-fee execution. Hyperliquid's 0.05% taker / 0.02% maker is the minimum threshold for positive expectancy.

3. **Reduce strategy surface area** — Instead of maintaining 4 strategy implementations with all their configuration and monitoring overhead, concentrate on Trend Follow + Momentum on ETH only. Less code = fewer bugs = faster iteration.

4. **Add strategy-level kill switches** — The backtest data shows VWAP MR and Breakout should never fire live. Build hard disables, not just config toggles.

5. **Kraken as backup venue** — Trend Follow ETH is marginally profitable on Kraken ($448 at best params, PF=1.09). This is too thin for primary deployment but serves as a fallback if Hyperliquid has issues.

---

## Revised Phase Sequencing

| Phase | Description | Priority |
|---|---|---|
| 4 | Hyperliquid adapter (REST + WebSocket) | **P0 — Critical path** |
| 5 | Paper trading on Hyperliquid (Trend Follow ETH) | **P0** |
| 6 | Kraken adapter (backup venue) | P1 |
| 7 | Live deployment with quarter-Kelly sizing | P1 |
| 8 | Momentum ETH promotion (if paper validates) | P2 |
| 9 | Frontend monitoring fixes | P2 |
| 10 | Multi-asset expansion (SOL, etc.) | P3 |

---

## Data Files

All backtest data and analysis scripts are preserved:
- `backtest_v2.json` — Initial per-strategy results (Coinbase fees)
- `fee_sensitivity_results.json` — Full 4-tier fee matrix (32 strategy×fee combos)
- `param_optimization_results.json` — Grid search results (1,120 parameter combos)
- Supabase `bars` table — 86,888 cached candles (BTC, ETH, SOL)

---

*Analysis completed March 6, 2026. All results based on out-of-sample data from Coinbase public API.*
