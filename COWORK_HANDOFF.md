# Apex Automata (AtlasBot v2) — Complete Cowork Handoff

**Created:** March 8, 2026
**Purpose:** Full context transfer for continuing work on a new Cowork session (Windows machine). This document captures everything done across multiple sessions so the new Cowork can pick up exactly where we left off.
**GitHub:** https://github.com/lukebarhoumeh/apex-automata
**Latest Commit:** `94646fa` — "Phase 3.0: Fix backtest infrastructure (6 fixes)"

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Infrastructure & Credentials](#2-infrastructure--credentials)
3. [Phase 0: Emergency Security Fixes — COMPLETED](#3-phase-0-emergency-security-fixes--completed)
4. [Phase 1: Critical Trading Bug Fixes — COMPLETED (17/17)](#4-phase-1-critical-trading-bug-fixes--completed-1717)
5. [Phase 2: Database & Infrastructure — COMPLETED (10/10)](#5-phase-2-database--infrastructure--completed-1010)
6. [Phase 3: Backtest Validation — COMPLETED](#6-phase-3-backtest-validation--completed)
7. [Phase 3 Backtest Verdict (Critical Findings)](#7-phase-3-backtest-verdict-critical-findings)
8. [Revised Implementation Plan (Phase 4+)](#8-revised-implementation-plan-phase-4)
9. [Key Files Reference](#9-key-files-reference)
10. [Known Issues & Technical Debt](#10-known-issues--technical-debt)
11. [Tools & Model Preferences](#11-tools--model-preferences)
12. [How to Continue](#12-how-to-continue)

---

## 1. Project Overview

Apex Automata is a professional algorithmic cryptocurrency trading system. It was built to trade BTC, ETH, and SOL on Coinbase using four strategies: VWAP Mean Reversion, Donchian Breakout, EMA Trend Follow, and RSI/MACD Momentum.

**The bot previously lost $1,090 in 3 live trades** on Coinbase due to a cascade of bugs: the regime filter was bypassed (all strategies in `alwaysAllowStrategies`), position sizing was wrong, risk engine had no NaN guards, and the backtest engine had broken P&L accounting that showed false profits.

A comprehensive 3-round audit identified **80 issues across 10 phases**. Phases 0-3 are now complete. The Phase 3 backtest analysis revealed that **all strategies are negative-EV on Coinbase due to 0.60% taker fees**, but two strategies (Trend Follow and Momentum on ETH) have validated edge on Hyperliquid (0.05% fees).

**Stack:**
- Backend: Node.js/TypeScript (core-node), Express API, WebSocket
- Frontend: React/Vite, TailwindCSS, Supabase hooks
- Database: Supabase (PostgreSQL)
- Exchange: Currently Coinbase only (migrating to Hyperliquid)
- Package Manager: pnpm (standardized in Phase 2)
- Monorepo: `atlas/apps/core-node/` for backend, `src/` for frontend

---

## 2. Infrastructure & Credentials

### Supabase
- **URL:** `https://gdrdaajvutmewgxbjurk.supabase.co`
- **Service Key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MDM2MDM5NywiZXhwIjoyMDc1OTM2Mzk3fQ.aEg70BeVaxmWFpCFxkYPBNxjNAauM4X-JoY39xYOxrY`
- **Historical Data:** 86,888 candles cached in `bars` table:
  - BTC-USD: 35,018 candles (2025-03-05 to 2026-03-05, 15m intervals)
  - ETH-USD: 34,516 candles (2025-03-05 to 2026-03-05, 15m intervals — 500 rows lost to SSL error, coverage sufficient)
  - SOL-USD: 17,354 candles (2025-09-05 to 2026-03-05, 15m intervals)

### GitHub
- **Repo:** https://github.com/lukebarhoumeh/apex-automata (private)
- **Latest commit:** `94646fa` — Phase 3.0 backtest infrastructure fixes
- **Note:** Can't `git pull` from Cowork due to auth (`fatal: could not read Username`). Verify code state from local repo.

### Coinbase
- API keys were in `.env` committed to git (Phase 0 flagged this)
- Keys should have been rotated — verify with Luke

---

## 3. Phase 0: Emergency Security Fixes — COMPLETED

These were addressed in the Phase 1 & 2 combined commit (`c92e753`):

| # | Fix | Status |
|---|-----|--------|
| 0.1 | Revoke exposed secrets, fix .env handling | DONE (`.env` in `.gitignore`) |
| 0.2 | Add authentication to API endpoints | DONE (API key middleware) |
| 0.3 | Restrict CORS | DONE (origin allowlist) |
| 0.4 | Add request size limit | DONE (`express.json({ limit: '10kb' })`) |
| 0.5 | Fix memory leak: event listeners on engine stop | DONE (`removeAllListeners()`) |

---

## 4. Phase 1: Critical Trading Bug Fixes — COMPLETED (17/17)

All 17 fixes were implemented in commit `c92e753`. Verified against the live codebase.

| # | Fix | File | Verification |
|---|-----|------|-------------|
| 1.1 | Regime filter DEFAULT_CONFIG fixed (6 values) | `regime-filter.ts` | `alwaysAllowStrategies: []`, `minCompatibilityScore: 0.3`, `minRegimeConfidence: 0.4` |
| 1.2 | positionMultiplier wired into order sizing | `server.ts ~L1395` | `adjustedSize = computedSize * multiplier` |
| 1.3 | Backtest capital accounting fixed | `backtest-engine.ts L345-347` | PnL = `(exitPrice - entryPrice) * size * sideMultiplier` |
| 1.4 | Daily returns calculation fixed | `backtest-engine.ts L371-380` | Proper daily snapshots |
| 1.5 | Sharpe ratio NaN guard | `backtest-engine.ts L482-487` | `stdDev === 0 ? 0 : ...` |
| 1.6 | Sortino ratio formula fixed | `backtest-engine.ts` | Uses downside deviation only |
| 1.7 | VWAP daily reset fixed (month boundary) | `technical.ts L184` | ISO date string comparison |
| 1.8 | RSI NaN with zero avg loss | `technical.ts` | `if (avgLoss === 0) return 100` |
| 1.9 | Order-manager fill race condition | `order-manager.ts L157-197` | Fill lock mutex |
| 1.10 | Position-tracker P&L on position flips | `position-tracker.ts L299-360` | Fees always subtracted |
| 1.11 | Risk engine bounds checking | `risk-engine.ts` | 28 `Number.isFinite()` calls confirmed |
| 1.12 | TWAP memory leak fixed | `order-manager.ts` | Timer cleanup on cancel |
| 1.13 | Trade outcome threshold | `trade-analytics.ts L390-396` | `BREAKEVEN_THRESHOLD = 1.00` |
| 1.14 | Production-grade signal parameters | `guardrails.yaml` | `risk_per_trade: 0.005`, `max_open: 2`, `equity: 10000`, `max_exposure: 0.30` |
| 1.15 | Position-monitor exit race condition | `position-monitor.ts` | Exit lock pattern at lines 52, 106, 217, 360-410 |
| 1.16 | Advanced backtest slippage tracking | `advanced-backtest-engine.ts L540-559` | Consistent slippage subtraction |
| 1.17 | Signal arbiter strength normalization | `signal-arbiter.ts` | Per-strategy normalization |

---

## 5. Phase 2: Database & Infrastructure — COMPLETED (10/10)

### Batch A: Database Migrations (applied directly to Supabase, NOT in repo migration files)

| # | Fix | Verification |
|---|-----|-------------|
| 2.1 | `bars` table created | Table exists with `UNIQUE(symbol, time, exchange)`, indexes on `symbol_time` and `exchange` |
| 2.2 | `exchange_id` added to trading tables | `positions`, `orders`, `fills`, `trade_log` all have `exchange_id TEXT DEFAULT 'coinbase'`; `signals` has `routed_exchange` |
| 2.3 | Missing FK indexes added | Indexes on `fills(order_leg_id)`, `order_legs(user_id)`, `journal_entries(position_id, order_id, signal_id)`, `trade_outcomes(strategy, regime)` |
| 2.4 | Unique constraints added | `signals` dedup on `(user_id, symbol, strategy, decided_at)`, `fills` dedup on `(order_id, trade_id, filled_at)` |
| 2.5 | Numeric precision fixed | `trade_outcomes.fees` and `realized_pnl` upgraded to `NUMERIC(20,8)` |

**IMPORTANT:** These migrations were applied directly to the live Supabase DB but do NOT exist as SQL files in `supabase/migrations/`. Migration files should be created for version control before Phase 4.

### Batch B: Server Hardening (in commit `c92e753`)

| # | Fix | File Location |
|---|-----|---------------|
| 2.6 | Zod input validation on all config endpoints | `server.ts` Lines 21-110 (11 schemas, 14 `safeParse()` calls) |
| 2.7 | Rate limiting | `server.ts` Lines 130-137 (`100 req/60s` via `express-rate-limit`) |
| 2.8 | parseInt radix fixed | `server.ts` (all 5 parseInt calls have radix 10) |
| 2.9 | WebSocket connection cap | `server.ts` Line 139 (`MAX_WS_CLIENTS = 50`), Lines 507-511 (close with 1013) |
| 2.10 | pnpm standardization | `pnpm-workspace.yaml` created, Dockerfiles updated to use corepack |

---

## 6. Phase 3: Backtest Validation — COMPLETED

### Phase 3.0: Infrastructure Fixes (Cursor, commit `94646fa`)

| # | Fix | File |
|---|-----|------|
| 3.0a | Walk-forward marked `@deprecated`, throws error | `advanced-backtest-engine.ts` Lines 868-877 |
| 3.0b | `loadDataFromAPI()` wired to HistoricalDataLoader | `advanced-backtest-engine.ts` Lines 277-293 |
| 3.0c | Backtest endpoint uses real data (with `?synthetic=true` fallback) | `server.ts` Lines 3010-3035 |
| 3.0d | Paper trading P&L tracking with cost-basis accounting | `paper-trading-simulator.ts` Lines 618-632 |
| 3.0e | Position sizing accounts for allocated capital from open positions | `backtest-engine.ts` Lines 424-442 |
| 3.0f | OHLCV validation function added | `data-loader.ts` Lines 35-67 |

### Phase 3.1-3.6: Statistical Analysis (Cowork)

This is the analysis I (Cowork) ran independently using Python backtesting engine replicating the 4 strategies with production parameters against the cached Supabase data.

**Steps completed:**

1. **3.1 — Historical Data Fetch:** 86,888 candles fetched from Coinbase public API and cached in Supabase `bars` table (BTC 15m, ETH 15m, SOL 15m, plus BTC 1H resampled).

2. **3.2 — Per-Strategy Backtests:** All 8 strategy/asset combinations tested at Coinbase fees. ALL FAILED. Key discovery: original regime detector was broken on 15m data (98.4% classified as "ranging" because thresholds were calibrated for daily bars). Fixed by switching to ADX-based regime detection: ADX > 40 = strong_trend (26.9%), ADX 20-40 = weak_trend (58.4%), ADX < 20 = ranging (14.7%).

3. **3.3 — Parameter Optimization:** Grid search across 1,120+ parameter combinations for the two viable strategies:
   - **Trend Follow ETH best config:** EMA(12/15), Stop 2.5x ATR, TP 5.0x ATR → 130 trades, +$1,864, PF=1.38, Sharpe=2.44
   - **Momentum ETH best config:** RSI(10) Long>55 Short<40, MACD(8/21/5), Stop 2.0x ATR, TP 4.0x ATR → 81 trades, +$1,261, PF=1.41, Sharpe=2.58

4. **3.4 — Walk-Forward Validation:** Quarterly splits:
   - Trend Follow ETH: **All 4 quarters profitable** (Q1: +$475, Q2: +$403, Q3: +$525, Q4: +$353) — strong consistency
   - Momentum ETH: **Only 2 of 4 quarters convincing** (Q1: +$83 marginal, Q2: +$1,016 outlier, Q3: +$452, Q4: -$297 loss)

5. **3.5 — Fee Sensitivity Analysis:** Tested all 8 strategy/asset combos across 4 fee tiers (Coinbase 0.60%, Kraken 0.26%, Hyperliquid 0.05%, Zero). The zero-fee test isolates signal edge from fee impact.

6. **3.6 — Monte Carlo Confidence Intervals (10,000 simulations):**
   - **Trend Follow ETH:** Median +18.5%, P(loss)=4.0%, P(loss>10%)=0.3%, 95th pctl MDD=11.5%, Half Kelly=6.0%
   - **Momentum ETH:** Median +12.5%, P(loss)=7.9%, P(loss>10%)=0.5%, 95th pctl MDD=10.1%, Half Kelly=6.5%

7. **Cross-Asset Robustness:** ETH-optimized params tested on BTC. Trend Follow BTC: -$290 (does NOT transfer). Momentum BTC: +$35 (flat). These are ETH-specific edges.

---

## 7. Phase 3 Backtest Verdict (Critical Findings)

### Fee Sensitivity Matrix

| Strategy | Coinbase (0.60%) | Kraken (0.26%) | Hyperliquid (0.05%) | Zero Fees |
|---|---|---|---|---|
| VWAP MR (BTC) | No trades | No trades | No trades | No trades |
| VWAP MR (ETH) | $3 (1 trade) | $23 (1 trade) | $35 (1 trade) | $38 |
| Breakout (BTC 1H) | -$2,260 | -$1,147 | -$330 | **-$119** |
| Breakout (BTC 15m) | -$1,441 | -$835 | -$427 | **-$326** |
| **Trend Follow (ETH)** | -$836 | +$251 | **+$1,024** | +$1,221 |
| Trend Follow (BTC) | -$513 | -$199 | +$3 | +$52 |
| **Momentum (ETH)** | -$1,732 | -$653 | **+$127** | +$327 |
| Momentum (BTC) | -$760 | -$415 | -$191 | **-$137** |

### Per-Strategy Verdicts

| Strategy | Verdict | Reason |
|---|---|---|
| **VWAP Mean Reversion** | KILL | Zero/1 trade across 12 months. ADX ranging regime too short for signals to fire. |
| **Donchian Breakout** | KILL | Negative-EV even at zero fees. Signal itself has no edge. |
| **EMA Trend Follow (ETH)** | GO (Conditional) | +18.6% on Hyperliquid, all 4 quarters profitable, 4% P(loss). Requires Hyperliquid, ETH-only, quarter-Kelly sizing, 30-day paper minimum. |
| **RSI/MACD Momentum (ETH)** | Paper Only | +12.6% on Hyperliquid but Q4 was losing quarter, 7.9% P(loss). Paper trade 60 days, require 2 consecutive profitable months before live. |

### Optimized Parameters for Viable Strategies

**Trend Follow ETH (PRIMARY):**
- EMA Fast: 12, EMA Slow: 15
- Stop Loss: 2.5x ATR
- Take Profit: 5.0x ATR
- Risk per trade: 0.5%
- Max open positions: 2
- Max exposure: 30%
- Position sizing: Quarter-Kelly (3.0% of bankroll)
- Exchange: Hyperliquid ONLY (fee < 0.10% required)
- Asset: ETH-USD ONLY (does not transfer to BTC)

**Momentum ETH (SECONDARY — paper only):**
- RSI Period: 10, Long threshold: >55, Short threshold: <40
- MACD: Fast 8, Slow 21, Signal 5
- Stop Loss: 2.0x ATR
- Take Profit: 4.0x ATR
- Same risk/sizing parameters as above

### ADX Regime Detection (Critical Fix)

The original regime detector used return-magnitude thresholds (0.15 for strong_trend, 0.05 for weak_trend) calibrated for daily-scale moves. On 15m data, a 15% move in 50 bars (~12.5 hours) is astronomically rare — so 98.4% of bars were classified as "ranging." This broke VWAP MR (it fired constantly) and starved trend strategies of signals.

**Fixed approach:** ADX-based classification:
- ADX > 40 → `strong_trend` (26.9% of bars)
- ADX 20-40 → `weak_trend` (58.4% of bars)
- ADX < 20 → `ranging` (14.7% of bars)

**NOTE:** This fix was only applied in the Python backtesting engine. The production TypeScript regime detector in `regime-filter.ts` may still use the old approach. This needs to be verified and potentially updated as part of Phase 4 work.

---

## 8. Revised Implementation Plan (Phase 4+)

The Phase 3 findings fundamentally change the roadmap. The original plan had Kraken as Phase 5 and Hyperliquid as Phase 6. Now Hyperliquid is the critical path because it's the ONLY venue where strategies are profitable.

### Revised Phase Sequencing

| Phase | Description | Priority | Status |
|---|---|---|---|
| 0 | Emergency security fixes | P0 | COMPLETED |
| 1 | Critical trading bug fixes (17 issues) | P0 | COMPLETED |
| 2 | Database & infrastructure (10 issues) | P0 | COMPLETED |
| 3 | Backtest validation & analysis | P0 | COMPLETED |
| **4** | **Hyperliquid adapter (REST + WebSocket)** | **P0 — Critical path** | **NEXT** |
| **5** | **Paper trading on Hyperliquid (Trend Follow ETH)** | **P0** | Pending |
| 6 | Kraken adapter (backup venue) | P1 | Pending |
| 7 | Live deployment with quarter-Kelly sizing | P1 | Pending |
| 8 | Momentum ETH promotion (if paper validates) | P2 | Pending |
| 9 | Frontend monitoring fixes | P2 | Pending |
| 10 | Multi-asset expansion (SOL, etc.) | P3 | Pending |

### Phase 4 Details: Hyperliquid Adapter

This is the immediate next work. From the original IMPLEMENTATION_PLAN.md:

**4.1 — Create IExchangeAdapter interface** (`atlas/apps/core-node/src/exchanges/exchange-adapter.ts`)
- Standard interface for all exchange adapters
- Capabilities struct (supportsShort, supportsPerps, fees, etc.)

**4.2 — Create ExchangeRegistry** (`atlas/apps/core-node/src/exchanges/exchange-registry.ts`)
- Multi-exchange management

**4.3 — Refactor OrderManager** to remove Coinbase coupling
- Replace `import { CoinbaseExchange }` with `IExchangeAdapter`
- Constructor takes interface, not concrete class

**4.4 — Refactor adapter-factory.ts** for multi-exchange

**4.5 — Refactor server.ts** for multi-exchange
- Create adapters per exchange via ExchangeRegistry
- Tag tickers with exchangeId
- Route signals to correct exchange

**4.6 — Wrap CoinbaseExchange as IExchangeAdapter**

Then the Hyperliquid-specific work (originally Phase 6, now part of Phase 4):

**6.1 — Perpetuals risk module** (`atlas/apps/core-node/src/trading/risk/perps-risk.ts`)
- maxLeverage: 3x cap
- marginType: cross/isolated
- liquidationBuffer: 15% above liquidation
- Margin alert thresholds

**6.2 — Hyperliquid REST client** (`atlas/apps/core-node/src/exchanges/hyperliquid/http/hl-rest.ts`)
- EIP-712 typed data signing (requires ethers.js v6)
- Info endpoint: `POST https://api.hyperliquid.xyz/info`
- Exchange endpoint: `POST https://api.hyperliquid.xyz/exchange`

**6.3 — Hyperliquid WebSocket client** (`atlas/apps/core-node/src/exchanges/hyperliquid/ws/hl-ws.ts`)
- URL: `wss://api.hyperliquid.xyz/ws`
- Channels: allMids, l2Book, trades, userEvents

**6.4 — Hyperliquid adapter**
- Capabilities: supportsShort=true, supportsPerps=true, maxLeverage=50 (config-capped to 3), makerFee=0.0002, takerFee=0.0005

**6.5 — Extend PositionTracker for perps**
- Add: exchangeId, isPerp, leverage, marginUsed, liquidationPrice, cumulativeFunding
- Update calculatePnL: totalPnL = realizedPnL + unrealizedPnL - cumulativeFunding

**6.6 — Extend PositionMonitor for perps exits**
- New exit types: liquidation_buffer, funding_rate, margin_call

**6.7 — Paper mode + ethers.js dependency**

**6.8 — Integration tests**

### What was killed from original plan:
- **Coinbase optimization is dead.** No strategy is profitable on Coinbase. Don't waste engineering time there.
- **VWAP MR and Breakout strategies should be hard-disabled**, not just config-toggled.
- **Original Phase 9 capital rollout needs rewrite** — it assumed Kraken VWAP MR first, but now it's Hyperliquid Trend Follow ETH first.

---

## 9. Key Files Reference

### Core Backend Files

| File | Purpose | Key Lines/Details |
|---|---|---|
| `atlas/apps/core-node/src/api/server.ts` | Main API server | Lines 21-110: Zod schemas; L130-137: rate limiter; L139: WS cap; L507-511: WS close; L1899-1917: Zod safeParse; L3010-3035: backtest endpoint with real data |
| `atlas/apps/core-node/src/strategies/regime-filter.ts` | Regime detection | L118-128: DEFAULT_CONFIG (fixed in Phase 1.1) |
| `atlas/apps/core-node/src/trading/risk-engine.ts` | Risk checks | 28 `Number.isFinite()` calls (Phase 1.11) |
| `atlas/apps/core-node/src/trading/position-monitor.ts` | Position exit logic | Exit lock pattern at L52, 106, 217, 360-410 (Phase 1.15) |
| `atlas/apps/core-node/src/trading/order-manager.ts` | Order execution | Fill lock mutex (Phase 1.9), TWAP timer cleanup (Phase 1.12) |
| `atlas/apps/core-node/src/trading/paper-trading-simulator.ts` | Paper trading | L618-632: Realized P&L with cost-basis (Phase 3.0d) |
| `atlas/apps/core-node/src/backtesting/backtest-engine.ts` | Backtest core | L345-347: Fixed P&L; L424-442: Position sizing with allocated capital |
| `atlas/apps/core-node/src/backtesting/advanced-backtest-engine.ts` | Advanced backtest | L868-877: Walk-forward deprecated; L277-293: API data loading |
| `atlas/apps/core-node/src/backtesting/data-loader.ts` | Data loading | L35-67: validateCandle + filterValidCandles; L102-146: loadCandles cascade (Supabase → Coinbase REST → synthetic) |
| `atlas/config/guardrails.yaml` | Trading parameters | Production values from Phase 1.14 |

### Project-Level Files

| File | Purpose |
|---|---|
| `IMPLEMENTATION_PLAN.md` | Master plan — 80 issues across 10 phases (original, pre-backtest-verdict) |
| `PHASE3_BACKTEST_VERDICT.md` | Phase 3 analysis results and revised roadmap |
| `COWORK_HANDOFF.md` | This file — complete context transfer |
| `pnpm-workspace.yaml` | Monorepo config (`packages: ['atlas/apps/*']`) |
| `.env` | Local secrets (should be in .gitignore) |
| `env.example` | Template for .env |

### Git History (relevant commits)

```
94646fa  Phase 3.0: Fix backtest infrastructure (6 fixes)
c92e753  Phase 1 & 2: trading fixes, server hardening, pnpm standardization
751527d  docs: add comprehensive system overview
```

---

## 10. Known Issues & Technical Debt

### Must Fix Before Phase 4

1. **DB migrations not in repo:** Phase 2 Batch A migrations (2.1-2.5) were applied directly to Supabase but don't exist as SQL files in `supabase/migrations/`. Create migration files for version control.

2. **Regime detector in production code may not match backtested version:** The Python backtesting engine used ADX-based regime detection (ADX > 40 = strong_trend, 20-40 = weak_trend, < 20 = ranging). The TypeScript `regime-filter.ts` may still use the old return-magnitude approach. Verify and align.

3. **Strategy parameters in production code may not match optimized values:** The backtest found optimal params of EMA(12/15) with Stop 2.5x ATR, TP 5.0x ATR. Verify `guardrails.yaml` and strategy implementations match.

### Lower Priority Technical Debt

| Issue | Severity | File |
|---|---|---|
| RLS policies `USING(true)` overly permissive | MEDIUM | Supabase migrations |
| `auth.users` FK constraints were dropped | MEDIUM | migration 20251212 |
| K8s deployment placeholders (YOUR_ORG) | HIGH | `deploy/k8s/*.yaml` |
| No CI/CD pipeline | MEDIUM | Missing |
| No docker-compose for local dev | LOW | Missing |
| HTML meta description says "Lovable" | LOW | `index.html` |
| ESLint disables unused-vars | LOW | `eslint.config.js` |
| TypeScript strictness mismatch (FE lax) | MEDIUM | tsconfig files |

### Complete Issue Registry

The full 80-issue registry is in `IMPLEMENTATION_PLAN.md` with severity, file, and line numbers for every issue. Phases 0-3 (issues 1-48) are resolved. Issues 49-80 remain for Phases 4-9.

---

## 11. Tools & Model Preferences

- **Cursor primary model:** Opus 4.6 Max (Sonnet 4.6 as fallback when hitting usage cap)
- **Claude Code extension in Cursor:** NOT recommended (redundant with Cursor's built-in AI)
- **Cowork role:** Backtest analysis, fee sensitivity, Monte Carlo, strategy validation, architecture review, prompt generation for Cursor
- **Cursor role:** All code changes, tests, adapters, configs, migrations
- **Production parameters:** $10K equity, 0.5% risk/trade, max 2 open positions, 30% max exposure, $1.00 breakeven threshold

---

## 12. How to Continue

### Immediate Next Steps

1. **Verify production code alignment:** Check that `regime-filter.ts` uses ADX-based classification and that strategy parameters in `guardrails.yaml` match the optimized values from Phase 3.

2. **Create migration files:** Write SQL migration files for Phase 2 Batch A changes (2.1-2.5) and commit them to `supabase/migrations/`.

3. **Begin Phase 4:** Start with the exchange abstraction layer (4.1-4.6), then build the Hyperliquid adapter (6.1-6.8). The Cursor prompt for this work should reference `IMPLEMENTATION_PLAN.md` sections 4.1-4.6 and 6.1-6.8.

4. **Strategy concentration:** When building the Hyperliquid adapter, only wire up Trend Follow and Momentum strategies. VWAP MR and Breakout are dead — add hard kill switches.

### Cursor Prompt Template for Phase 4

When ready to start Phase 4 in Cursor, use this as the base prompt:

```
Reference IMPLEMENTATION_PLAN.md sections 4.1-4.6 and 6.1-6.8. We're combining the exchange abstraction layer and Hyperliquid adapter into a single phase because Phase 3 backtest analysis proved Hyperliquid is the only viable exchange (see PHASE3_BACKTEST_VERDICT.md).

Priority order:
1. Create IExchangeAdapter interface and ExchangeRegistry (4.1-4.2)
2. Refactor OrderManager to remove Coinbase coupling (4.3)
3. Wrap existing CoinbaseExchange as adapter (4.6)
4. Build Hyperliquid REST client with EIP-712 signing (6.2)
5. Build Hyperliquid WebSocket client (6.3)
6. Build Hyperliquid adapter implementing IExchangeAdapter (6.4)
7. Add perpetuals risk module (6.1)
8. Extend PositionTracker and PositionMonitor for perps (6.5-6.6)
9. Integration tests (6.8)

Key constraints:
- Hyperliquid uses EIP-712 typed data signing (ethers.js v6)
- Cap leverage at 3x regardless of exchange max
- Maker fee: 0.02%, Taker fee: 0.05%
- Only wire Trend Follow and Momentum strategies (VWAP MR and Breakout are KILLED)
- ETH-USD only for now
```

### Data Available in Supabase

All 86,888 candles remain in the `bars` table and can be queried for any future analysis. The Python backtesting scripts that generated the Phase 3 analysis are NOT in the repo (they ran in the Cowork session), but the methodology is documented in this file and `PHASE3_BACKTEST_VERDICT.md`.

---

*This handoff was generated on March 8, 2026 from a Cowork session that ran across multiple conversations covering Phases 0-3 of the Apex Automata implementation plan.*
