# Apex Automata (AtlasBot v2) — Complete Cowork Handoff

**Created:** March 10, 2026
**Purpose:** Full context transfer from Windows Cowork to MacBook Cowork. Covers all work from project inception through Phase 4D, including the current startup blocker and pending fix.
**GitHub:** https://github.com/lukebarhoumeh/apex-automata (private)

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Two-AI Architecture (How We Work)](#2-two-ai-architecture)
3. [Infrastructure & Credentials](#3-infrastructure--credentials)
4. [Completed Phases (0-3)](#4-completed-phases-0-3)
5. [Phase 4 Work (Current) — Exchange Abstraction + Coinbase Perps](#5-phase-4-work-current)
6. [CURRENT BLOCKER — Bot Won't Start](#6-current-blocker--bot-wont-start)
7. [TASK_004 Is Ready — Immediate Next Step](#7-task_004-is-ready--immediate-next-step)
8. [Key Files Reference (Phase 4 State)](#8-key-files-reference-phase-4-state)
9. [Architecture Decisions Made in Phase 4](#9-architecture-decisions-made-in-phase-4)
10. [Known Issues & Technical Debt](#10-known-issues--technical-debt)
11. [What Comes After TASK_004](#11-what-comes-after-task_004)
12. [Strategy & Backtest Verdicts (Phase 3 Summary)](#12-strategy--backtest-verdicts-phase-3-summary)
13. [How to Continue](#13-how-to-continue)

---

## 1. Project Overview

Apex Automata is a professional algorithmic cryptocurrency trading system. It trades BTC, ETH, and SOL using four strategies: VWAP Mean Reversion, Donchian Breakout, EMA Trend Follow, and RSI/MACD Momentum. Only Trend Follow and Momentum on ETH have validated edge (see Section 12).

**Stack:**
- Backend: Node.js/TypeScript (core-node), Express API, WebSocket broadcasts
- Frontend: React/Vite/TailwindCSS via Lovable, Supabase hooks for real-time data
- Database: Supabase (PostgreSQL)
- Exchange: Coinbase Advanced Trade (spot + perpetual futures via INTX)
- Package Manager: pnpm
- Monorepo: `atlas/apps/core-node/` for backend, `src/` for frontend

**The bot previously lost $1,090 in 3 live trades** due to bugs fixed in Phases 0-2. Phase 3 backtest analysis confirmed strategies need low-fee venues (Hyperliquid or perps) to be profitable. Phase 4 builds Coinbase Perpetual Futures support as the bridge to low-fee trading.

---

## 2. Two-AI Architecture

This project uses a strict division of labor between two AIs:

**Cowork Claude (you) = CEO / Architect:**
- Writes task specification files in `CURSOR_TASKS/TASK_XXX_name.md`
- Each task has precise FIND/REPLACE code blocks, constraints, and a verification checklist
- Writes companion verify scripts in `CURSOR_TASKS/verify/verify_XXX.js`
- After Cursor implements, Cowork reads the codebase to cross-verify all changes
- Makes all strategic/architectural decisions
- Does NOT write code directly into the codebase

**Cursor (IDE AI) = Engineer:**
- Reads and executes task files written by Cowork
- Makes all code changes following the spec exactly
- Runs verify scripts to confirm implementation
- Luke tells Cursor: `Read and execute CURSOR_TASKS/TASK_XXX_name.md`
- After completion, Luke runs: `node CURSOR_TASKS/verify/verify_XXX.js`

**Workflow:** Cowork writes task → Luke gives to Cursor → Cursor implements → Luke runs verify → If green, comes back to Cowork for next task. If red, Cowork diagnoses.

---

## 3. Infrastructure & Credentials

### Supabase
- URL: `https://gdrdaajvutmewgxbjurk.supabase.co`
- Service Key: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MDM2MDM5NywiZXhwIjoyMDc1OTM2Mzk3fQ.aEg70BeVaxmWFpCFxkYPBNxjNAauM4X-JoY39xYOxrY`
- Historical Data: 86,888 candles in `bars` table (BTC/ETH/SOL, 15m intervals, ~12 months)

### GitHub
- Repo: https://github.com/lukebarhoumeh/apex-automata (private)
- Note: Git auth from Cowork may not work — verify code state from local repo

### Coinbase
- API keys in `.env` (should be in .gitignore)
- Keys may NOT have INTX (perpetual futures) entitlements — this is the current blocker

### Running the Bot
- `cd atlas/apps/core-node && pnpm api` — starts Express API server on port 8080
- POST `http://localhost:8080/api/engine/start` with `{ "mode": "paper" }` to start paper trading
- Frontend (Lovable): runs separately, connects to the API via WebSocket for live data

---

## 4. Completed Phases (0-3)

### Phase 0: Emergency Security Fixes — DONE
Fixed exposed secrets, added API auth middleware, CORS restrictions, request size limits, memory leak in event listeners.

### Phase 1: Critical Trading Bug Fixes (17/17) — DONE
Fixed regime filter bypass, position sizing, backtest P&L accounting, Sharpe/Sortino NaN guards, VWAP daily reset, RSI NaN guard, fill race condition, position flip P&L, risk engine bounds checking, TWAP memory leak, trade outcome threshold, production parameters, exit race condition, slippage tracking, signal normalization.

### Phase 2: Database & Infrastructure (10/10) — DONE
Created `bars` table, added `exchange_id` to trading tables, FK indexes, unique constraints, numeric precision, Zod validation, rate limiting, parseInt radix, WebSocket cap, pnpm standardization.

### Phase 3: Backtest Validation — DONE
Ran comprehensive backtests across all 8 strategy/asset combinations at 4 fee tiers. Key finding: only Trend Follow ETH and Momentum ETH are profitable, and only at low fees (Hyperliquid 0.05% or Coinbase perps 0.03%). See Section 12 for full verdict.

---

## 5. Phase 4 Work (Current) — Exchange Abstraction + Coinbase Perps

Phase 4 was split into sub-phases, each implemented via numbered CURSOR_TASKS:

### Phase 4A — Exchange Abstraction Layer (TASK_001) ✅ VERIFIED
Created `IExchangeAdapter` interface, `ExchangeRegistry`, refactored `OrderManager` to use adapter interface instead of direct Coinbase coupling. Wrapped existing `CoinbaseExchange` as `CoinbaseAdapter`.

### Phase 4B — Coinbase Perpetual Futures Integration (TASK_002 A→D) ✅ ALL VERIFIED

**TASK_002A:** Extended `CoinbaseAdapter` into `CoinbasePerpsAdapter` subclass with position tracking, funding rate queries, leverage management, portfolio margin summary, and perps product detection.

**TASK_002B:** Updated `guardrails.yaml` with full perps configuration section (risk_per_trade: 1.5%, default_leverage: 3, max_leverage: 10, liquidation_buffer: 20%, funding rate limits) and `perps_symbols` section with per-symbol configs for ETH-PERP-INTX and BTC-PERP-INTX including strategy_overrides. Updated `loadGuardrails.ts` Zod schema to parse all perps fields.

**TASK_002C:** Built `PerpsRiskMonitor` module — real-time liquidation distance tracking, funding rate monitoring, leverage warnings, margin utilization alerts. Emits events: `perps:liquidation_warning`, `perps:leverage_warning`, `perps:funding_alert`, `perps:margin_warning`.

**TASK_002D:** Wired perps into server.ts startup flow — `CoinbasePerpsAdapter` instantiation, `PerpsRiskMonitor` setup, `effectiveRiskPerTrade` computation (uses `perps.risk_per_trade` for perps symbols, `account.risk_per_trade` for spot), `reduce_only` flag support, `computeOrderSize` override for leveraged position sizing.

### Phase 4C — Perps Override Wiring (TASK_003A) ✅ VERIFIED (17/17)

Fixed a critical gap: `perps_symbols` strategy overrides were loaded by Zod schema but NEVER applied at runtime. Three fixes:
1. Wired `guardrails.perps_symbols` into `signalProcessor.loadPerSymbolOverridesFromGuardrails()` (server.ts lines 1259-1273)
2. Wired `perps_symbols` notional limits into `evaluateRiskThresholds()` (evaluate-risk.ts lines 442-471)
3. Wired per-symbol leverage into adapter initialization (server.ts lines 953-967)

### Phase 4D — Perps Market Data & Paper Trading (TASK_003B) ✅ VERIFIED (19/19)

Enables perps symbols to participate in the paper trading loop:
1. **Hoisted `perpsAdapter` to module scope** (server.ts line 259) so signal handler closure can access it
2. **Dynamic products list** from guardrails (server.ts lines 875-894) — replaced hardcoded `['BTC-USD', 'ETH-USD', 'SOL-USD']` with `Object.keys(guardrails.per_symbol)` for spot and `Object.keys(guardrails.perps_symbols)` for perps
3. **Spot→perps candle proxy** (server.ts lines 407-411) — Coinbase WS ticker channel does NOT support INTX product IDs, so BTC-USD candles are mirrored to BTC-PERP-INTX (standard approach — perps track spot index via funding rate)
4. **Warmup mirroring** (server.ts lines 1696-1704) — copies spot candle history to perps symbols after warmup completes
5. **`getCandleBuffer()` getter** added to SignalProcessor (signal-processor.ts line 430) for warmup data access
6. **Module-scoped state variables** (server.ts lines 258-260): `perpsRiskMonitor`, `perpsAdapter`, `activeSpotToPerpsMap`

---

## 6. CURRENT BLOCKER — Bot Won't Start

When Luke tried to start the paper trading bot after TASK_003B, it crashed with a **404 error** from the Coinbase API.

### Error Chain
```
POST /api/engine/start
  → tradingEngine = new TradingEngine(...) ← succeeds
  → perpsAdapter = new CoinbasePerpsAdapter(logger)
  → await perpsAdapter.initialize(credentials)
    → await super.initialize(credentials) ← succeeds
    → await this.refreshPerpsProducts()
      → restClient.getPerpsProducts()
        → GET /api/v3/brokerage/products?product_type=FUTURE → 404
        → fallback GET /products → returns empty (no PERP products in spot list)
        → OR: error propagates up → CRASH
  → Engine startup aborted, 500 returned
```

### Root Cause: Two Bugs

**Bug 1: `refreshPerpsProducts()` 404 crashes startup.**
The Coinbase INTX API endpoint returns 404 — likely because the API key doesn't have INTX/perpetual futures entitlements. But in paper mode, we don't need real perps products from the API at all. The spot→perps candle proxy handles signal generation, PaperSimulator handles any product_id string, and `isPerpsSymbol()` already has a string-matching fallback (`symbol.includes('-PERP-')`). The product cache is only used for `getMarketInfo()` which can fall back to the parent adapter.

**Bug 2: Engine state not cleaned up on startup crash.**
At server.ts line 951, `tradingEngine = new TradingEngine(...)` succeeds and sets the module variable. Then line 960 `await perpsAdapter.initialize(credentials)` throws the 404. The catch block at line 1718 logs and returns 500, but `tradingEngine` stays non-null. Next startup attempt hits `if (tradingEngine)` at line 854 → returns "Trading engine already running." User has to manually call the stop endpoint to clear ghost state.

### Secondary Issues (Not Blocking)

**Supabase 429 rate limiting:** Frontend hooks (`useSessionStats`, `useEquityCurve`) poll Supabase too aggressively, getting 429 Too Many Requests every 5 seconds. Needs increased polling interval or exponential backoff. This is a Lovable frontend fix, not a backend issue.

---

## 7. TASK_004 Is Ready — Immediate Next Step

**File:** `CURSOR_TASKS/TASK_004_startup_resilience.md`
**Verify:** `node CURSOR_TASKS/verify/verify_004.js`
**Status:** PENDING — Ready for Cursor to execute

TASK_004 fixes both bugs with three surgical changes across three files:

**1. `coinbase-perps-adapter.ts`** — Wrap `refreshPerpsProducts()` call in `initialize()` with try-catch (non-fatal). Also add inner try-catch in `refreshPerpsProducts()` itself. The adapter initializes with 0 products and relies on string-matching fallback.

**2. `rest-client.ts`** — Double-wrap `getPerpsProducts()` fallback so it returns `[]` instead of throwing when both the v3 endpoint AND the spot products fallback fail.

**3. `server.ts`** — Add state cleanup in the engine start catch block: null out `tradingEngine`, `perpsAdapter`, `perpsRiskMonitor`, reset `activeSpotToPerpsMap`, set `engineRunningGauge` to 0. This prevents ghost state on startup failure.

**NOTE:** As of this handoff, Cursor has already implemented the `coinbase-perps-adapter.ts` and `rest-client.ts` changes (the file modifications are visible). The `server.ts` state cleanup may or may not be done yet — verify by reading the catch block around line 1718. If it only has the original error logging without cleanup, Cursor still needs to do that part.

**To execute:** Tell Cursor: `Read and execute CURSOR_TASKS/TASK_004_startup_resilience.md` then run `node CURSOR_TASKS/verify/verify_004.js`

---

## 8. Key Files Reference (Phase 4 State)

### Core Backend (Modified in Phase 4)

| File | Key Changes | Critical Lines |
|------|-------------|----------------|
| `atlas/apps/core-node/src/api/server.ts` | Module-scoped perps state, dynamic products, candle proxy, warmup mirroring, strategy override loading, leverage init, perps risk monitor setup | L258-260: module vars; L407-411: candle proxy; L875-894: dynamic products; L951-974: perps adapter + risk monitor init; L1259-1273: override loading; L1696-1704: warmup mirroring; L1718-1728: catch block (NEEDS STATE CLEANUP) |
| `atlas/apps/core-node/src/exchanges/coinbase-perps-adapter.ts` | CoinbasePerpsAdapter subclass with graceful init | L51-61: initialize with try-catch; L69-87: refreshPerpsProducts with inner try-catch; L90-92: isPerpsSymbol with string fallback |
| `atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts` | Perps REST endpoints, double-wrapped fallback | L299-338: getPerpsProducts with nested try-catch; L336-344: getIntxPositions; L362-370: getIntxPortfolio; L376-384: getFundingRate; L390-402: setLeverage |
| `atlas/apps/core-node/src/exchanges/coinbase-adapter.ts` | Base adapter wrapping CoinbaseExchange | Implements IExchangeAdapter interface |
| `atlas/apps/core-node/src/exchanges/types.ts` | IExchangeAdapter, IPerpsAdapter, AdapterPosition, etc. | All exchange abstraction types |
| `atlas/apps/core-node/src/exchanges/exchange-registry.ts` | Multi-exchange registry | Register/get adapters by ID |
| `atlas/apps/core-node/src/trading/risk/perps-risk-monitor.ts` | Real-time perps risk monitoring | Liquidation, leverage, funding, margin events |
| `atlas/apps/core-node/src/trading/risk/evaluate-risk.ts` | Extended for perps_symbols | L442-471: perps_symbols type + merge loop for notional/daily loss limits |
| `atlas/apps/core-node/src/strategies/signal-processor.ts` | getCandleBuffer getter added | L430-433: public getCandleBuffer(symbol) |
| `atlas/apps/core-node/src/trading/trading-engine.ts` | effectiveRiskPerTrade, reduce_only, computeOrderSize override | Modified in TASK_002D |

### Configuration

| File | Purpose |
|------|---------|
| `atlas/config/guardrails.yaml` | Master trading config — includes `perps:` section (L109-126) and `perps_symbols:` section (L129-165) with ETH-PERP-INTX and BTC-PERP-INTX configs |
| `atlas/config/paper.local.yaml` | Paper mode startup config — may still have old hardcoded `symbols:` array that conflicts with new dynamic products from guardrails |
| `atlas/apps/core-node/.cursorrules` | Cursor AI instructions — updated in TASK_002D with perps context |

### Task Files

| File | Status | Checks |
|------|--------|--------|
| `CURSOR_TASKS/TASK_000_regime_detector_confidence_fix.md` | ✅ VERIFIED | — |
| `CURSOR_TASKS/TASK_001_phase4a_exchange_abstraction.md` | ✅ VERIFIED | — |
| `CURSOR_TASKS/TASK_002A_coinbase_perps_adapter.md` | ✅ VERIFIED | — |
| `CURSOR_TASKS/TASK_002B_guardrails_perps_update.md` | ✅ VERIFIED | — |
| `CURSOR_TASKS/TASK_002C_perps_risk_module.md` | ✅ VERIFIED | — |
| `CURSOR_TASKS/TASK_002D_strategy_perps_wiring.md` | ✅ VERIFIED | — |
| `CURSOR_TASKS/TASK_003A_perps_override_wiring.md` | ✅ VERIFIED | 17/17 |
| `CURSOR_TASKS/TASK_003B_perps_market_data_and_routing.md` | ✅ VERIFIED | 19/19 |
| `CURSOR_TASKS/TASK_004_startup_resilience.md` | PENDING | 16 checks |

---

## 9. Architecture Decisions Made in Phase 4

### Spot→Perps Candle Proxy
Coinbase Advanced Trade WebSocket ticker channel does NOT support INTX perpetual product IDs. Standard industry approach: mirror spot candles (BTC-USD) to perps symbols (BTC-PERP-INTX) since perps track the spot index price via funding rate mechanism. The mapping is built dynamically from guardrails config using base currency matching (BTC-PERP-INTX → BTC → BTC-USD).

### Dynamic Products List
Replaced hardcoded `['BTC-USD', 'ETH-USD', 'SOL-USD']` with `Object.keys(guardrails.per_symbol)` for spot and `Object.keys(guardrails.perps_symbols)` for perps. Products are now config-driven.

### Module-Scoped Perps State
`perpsAdapter`, `perpsRiskMonitor`, and `activeSpotToPerpsMap` are module-scoped variables in server.ts (not function-scoped inside the route handler) so the signal handler closure and candle proxy callback can access them.

### effectiveRiskPerTrade
When evaluating risk for an order, the system uses `perps.risk_per_trade` (1.5%) for perps symbols and `account.risk_per_trade` (0.5%) for spot symbols. This allows leveraged positions to use more aggressive sizing while keeping spot conservative.

### Paper Mode Order Flow for Perps
`tradingEngine.createOrder()` → RiskEngine check → PaperSimulator. The PaperSimulator handles any product_id string, so perps symbols (BTC-PERP-INTX) work without explicit routing changes in paper mode. The order just needs a valid price and size.

### Strategy Override Sharing
Both `guardrails.per_symbol` and `guardrails.perps_symbols` have compatible structure (`Record<string, { strategy_overrides?: ... }>`), so `signalProcessor.loadPerSymbolOverridesFromGuardrails()` is called twice — once for spot, once for perps — with the same function.

---

## 10. Known Issues & Technical Debt

### Critical (Blocking)

1. **Coinbase INTX 404 — TASK_004 fixes this.** The API key likely lacks INTX entitlements. The fix makes the product fetch non-fatal so paper trading works without live INTX API access.

2. **Engine state ghost on crash — TASK_004 fixes this.** Startup failure leaves `tradingEngine` non-null, blocking subsequent start attempts.

### High Priority

3. **`paper.local.yaml` may conflict with dynamic products.** The old config file has `symbols: [BTC-USD, ETH-USD]` which might override or conflict with the new dynamic products built from guardrails. After TASK_004, verify that startup uses guardrails-based products and isn't limited by paper.local.yaml.

4. **Supabase 429 rate limiting from frontend.** `useSessionStats` and `useEquityCurve` hooks poll aggressively. Needs increased polling interval or exponential backoff. This is a Lovable frontend fix.

5. **DB migrations not in repo.** Phase 2 Batch A migrations (2.1-2.5) were applied directly to Supabase but don't exist as SQL files in `supabase/migrations/`.

6. **Regime detector in production may not match backtested version.** Python backtests used ADX-based classification (ADX > 40 = strong_trend). TypeScript `regime-filter.ts` may still use old return-magnitude thresholds. Needs verification and alignment.

### Medium Priority

7. **Perps-specific frontend monitoring not built yet.** The existing Lovable UI can see perps trades in the order table and trade log (same WebSocket broadcasts), but perps-specific data (leverage indicator, liquidation distance, funding rate, perps P&L breakdown) needs new WS broadcasts from backend + new Lovable components. This is TASK_003C territory (not yet created).

8. **Leverage initialization calls `perpsAdapter.setLeverage()` which hits the INTX API.** In paper mode, these calls will fail silently (already has `.catch()`), but leverage won't actually be set on the exchange. The `leverageCache` in the adapter won't be populated. This is fine for paper trading but needs fixing for live.

9. **RLS policies `USING(true)` overly permissive** in Supabase migrations.

10. **K8s deployment placeholders** (`YOUR_ORG`) in `deploy/k8s/*.yaml`.

---

## 11. What Comes After TASK_004

Once TASK_004 passes and the bot starts successfully in paper mode:

### Immediate (Same Session)

1. **Start paper trading** — `pnpm api` then POST to start endpoint. Watch logs for candle proxy working, signals generating for both spot and perps symbols.

2. **Verify perps signals appearing** — Check that BTC-PERP-INTX and ETH-PERP-INTX are receiving mirrored candles and generating signals via the trend_follow and momentum strategies.

3. **Monitor for a few minutes** — Confirm no crashes, check the localhost:8080 dashboard for trade activity.

### Next Tasks to Create

4. **TASK_003C — Perps risk data WebSocket broadcasts.** Add new broadcast events for funding rate, leverage status, liquidation warnings so the Lovable frontend can display perps-specific monitoring data.

5. **Lovable UI work** — Build perps monitoring panel (leverage indicator, funding rate, liquidation distance, perps-specific P&L). Can reference the WS broadcast types from TASK_003C.

6. **Supabase polling fix** — Increase frontend polling intervals to avoid 429s.

### Longer Term

7. **Hyperliquid adapter** — The Phase 3 backtest proved Hyperliquid (0.05% fees) is the most profitable venue. Coinbase perps (0.03% fees) is the stepping stone. The exchange abstraction layer (TASK_001) was designed to support multiple exchanges. Hyperliquid adapter would register alongside coinbase-perps.

8. **Live trading preparation** — After paper validation period (minimum 30 days for Trend Follow, 60 days for Momentum), begin live deployment with quarter-Kelly sizing.

---

## 12. Strategy & Backtest Verdicts (Phase 3 Summary)

### Fee Sensitivity Matrix (Annual Returns on $10K)

| Strategy | Coinbase 0.60% | Kraken 0.26% | Hyperliquid 0.05% | CB Perps 0.03% |
|---|---|---|---|---|
| VWAP MR (ETH) | $3 (1 trade) | $23 | $35 | ~$37 |
| Breakout (BTC) | -$2,260 | -$1,147 | -$330 | ~-$280 |
| **Trend Follow (ETH)** | -$836 | +$251 | **+$1,024** | **~+$1,100** |
| **Momentum (ETH)** | -$1,732 | -$653 | **+$127** | **~+$180** |

### Strategy Verdicts

| Strategy | Verdict | Reason |
|---|---|---|
| VWAP Mean Reversion | KILL | Zero/1 trade across 12 months |
| Donchian Breakout | KILL | Negative-EV even at zero fees |
| **EMA Trend Follow (ETH)** | GO | +18.6% on low fees, all 4 quarters profitable, 4% P(loss) |
| **RSI/MACD Momentum (ETH)** | Paper Only | +12.6% but inconsistent (Q4 losing quarter), 7.9% P(loss) |

### Optimized Parameters (in guardrails.yaml perps_symbols section)

**Trend Follow ETH:** EMA(12/15), Stop 2.5x ATR, TP 5.0x ATR
**Momentum ETH:** RSI(10) Long>55 Short<40, MACD(8/21/5), Stop 2.0x ATR, TP 4.0x ATR

---

## 13. How to Continue

### Step 1: Execute TASK_004
Tell Cursor: `Read and execute CURSOR_TASKS/TASK_004_startup_resilience.md`
Run: `node CURSOR_TASKS/verify/verify_004.js`
Expected: 16/16 checks pass.

**Check first:** The `coinbase-perps-adapter.ts` and `rest-client.ts` changes may already be done (they were visible as file modifications before this handoff). The `server.ts` state cleanup in the catch block is the part that may still be pending. Read the catch block around line 1718 of server.ts to check.

### Step 2: Start Paper Trading
```bash
cd atlas/apps/core-node
pnpm api
```
Then POST to `http://localhost:8080/api/engine/start` with body `{ "mode": "paper" }`.

### Step 3: Verify Perps Working
Watch logs for:
- "CoinbasePerpsAdapter initialized with 0 perps products" (expected — INTX not enabled)
- "Mirrored X warmup candles from BTC-USD to BTC-PERP-INTX"
- "Mirrored X warmup candles from ETH-USD to ETH-PERP-INTX"
- Signals generating for PERP symbols

### Step 4: Create Next Tasks
If paper trading is running, create TASK_003C for perps WS broadcasts, then move to Lovable UI work for perps monitoring.

### Tools & Preferences
- Cursor primary model: Opus 4.6 Max (Sonnet 4.6 as fallback)
- Cowork role: Architecture, task specs, verification, strategic decisions
- Cursor role: All code changes
- Production parameters: $10K equity, 0.5% risk/trade (1.5% for perps), max 2 open positions, 30% max exposure
- Luke's style: Direct communication, no fluff, structured outputs, high-level architecture before execution

---

*This handoff was generated on March 10, 2026 from a Windows Cowork session covering Phases 0-4D of Apex Automata. The previous handoff (March 8) covered only Phases 0-3. This version supersedes it entirely.*
