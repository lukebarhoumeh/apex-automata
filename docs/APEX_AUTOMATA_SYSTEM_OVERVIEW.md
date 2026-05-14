# Apex Automata (AtlasBot v2) — Full System Overview

**Document Version:** 1.0  
**Date:** March 3, 2026  
**Classification:** Internal — Developer & Executive Reference

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [System Architecture](#2-system-architecture)
3. [Technology Stack](#3-technology-stack)
4. [Frontend — Dashboard & UI](#4-frontend--dashboard--ui)
5. [Backend — Trading Runtime](#5-backend--trading-runtime)
6. [Database Layer — Supabase](#6-database-layer--supabase)
7. [Data Flow: End to End](#7-data-flow-end-to-end)
8. [Exchange Integration — Coinbase](#8-exchange-integration--coinbase)
9. [Trading Strategies](#9-trading-strategies)
10. [Signal Processing Pipeline](#10-signal-processing-pipeline)
11. [Regime Detection & Filtering](#11-regime-detection--filtering)
12. [Risk Management System](#12-risk-management-system)
13. [Kill Switch Mechanism](#13-kill-switch-mechanism)
14. [Position Management](#14-position-management)
15. [Order Execution](#15-order-execution)
16. [Paper vs Live Trading](#16-paper-vs-live-trading)
17. [Session Statistics & Analytics](#17-session-statistics--analytics)
18. [24/7 Resilience & Recovery](#18-247-resilience--recovery)
19. [Startup & Deployment](#19-startup--deployment)
20. [Security Model](#20-security-model)
21. [Known Issues & Current State](#21-known-issues--current-state)
22. [File & Directory Map](#22-file--directory-map)

---

## 1. Executive Summary

**Apex Automata** (internally "AtlasBot v2") is a professional algorithmic cryptocurrency trading system. It connects to the Coinbase Advanced Trade API, ingests real-time market data via WebSocket, runs multiple configurable trading strategies, manages risk through a multi-layered guardrail system, and presents everything through a real-time dashboard.

### What It Does
- Trades BTC-USD, ETH-USD, and SOL-USD on Coinbase (spot market)
- Runs four distinct trading strategies simultaneously (Donchian Breakout, VWAP Mean Reversion, RSI/MACD Momentum, EMA Trend Follow)
- Detects market regimes (trending, ranging, choppy) and filters signals accordingly
- Manages risk with position sizing, daily loss limits, drawdown caps, and an automatic kill switch
- Persists all trades, orders, fills, positions, and risk events to Supabase (cloud Postgres)
- Delivers real-time updates to a React dashboard via WebSocket

### How It Makes Money (Profit Generation Model)
The system generates profit by exploiting short-term market inefficiencies across three strategies:
1. **Mean Reversion** — When price deviates significantly from VWAP (volume-weighted average price), the system bets on a return to the mean. This works in ranging markets, which represent ~70% of crypto market time.
2. **Momentum/Oscillator** — RSI oversold/overbought zones combined with MACD confirmation capture reversals at extremes.
3. **Trend Following** — EMA crossovers and Donchian breakouts ride directional moves when the market is trending.
4. **Risk-adjusted sizing** — Each trade risks a fixed percentage of equity (currently 1%), with ATR-based stops that adapt to volatility.

### Current State (as of March 3, 2026)
- Paper trading mode active, using real Coinbase production market data
- Starting equity: $50,000
- Session result: 3 trades, 0 wins, 3 losses, equity down to ~$48,910
- Kill switch triggered at -$1,090.07 daily loss (-2.18R)
- Root cause identified: regime filtering is completely bypassed (all strategies whitelisted), and signal thresholds are set to ultra-aggressive test values

---

## 2. System Architecture

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                              COINBASE EXCHANGE                                   │
│                                                                                  │
│   WebSocket Feed (wss://ws-feed.exchange.coinbase.com)                          │
│     ├── ticker channel (BTC-USD, ETH-USD, SOL-USD)                              │
│     └── level2 channel (orderbook snapshots + updates)                          │
│                                                                                  │
│   REST API (api.exchange.coinbase.com)                                          │
│     ├── Historical candles                                                       │
│     ├── Order placement/cancellation                                             │
│     └── Account/portfolio info                                                   │
└──────────────────────┬───────────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│                       BACKEND (Node.js Runtime)                                  │
│                       Port 3001 — atlas/apps/core-node                          │
│                                                                                  │
│   ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│   │  Coinbase    │  │   Signal    │  │   Trading    │  │   Express API        │ │
│   │  Exchange    │→│  Processor   │→│   Engine      │  │   + WebSocket Server │ │
│   │  (WS+REST)  │  │  + Strategies│  │  + Risk      │  │   (broadcasts)       │ │
│   └─────────────┘  └─────────────┘  └──────────────┘  └──────────────────────┘ │
│                                                                                  │
│   ┌─────────────┐  ┌─────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│   │  Order      │  │  Position   │  │  Trade       │  │  Engine              │ │
│   │  Manager    │  │  Tracker    │  │  Analytics   │  │  Supervisor          │ │
│   └─────────────┘  └─────────────┘  └──────────────┘  └──────────────────────┘ │
└──────────────────────┬──────────────────────┬────────────────────────────────────┘
                       │                      │
          WebSocket    │                      │  Direct Supabase Client
          broadcasts   │                      │  (service key)
                       ▼                      ▼
┌────────────────────────────┐    ┌───────────────────────────────────────────────┐
│     FRONTEND (React)       │    │              SUPABASE                          │
│     Port 8080 — src/       │    │                                               │
│                            │←──│  Postgres Database                             │
│  React + Vite + shadcn/ui  │    │    ├── positions, orders, fills               │
│  TanStack React Query      │    │    ├── signals, risk_events, alerts           │
│  Recharts, Radix UI        │    │    ├── trade_log, trading_sessions            │
│  WebSocket client          │    │    ├── exchange_credentials (encrypted)        │
│  Supabase Realtime         │    │    └── account_metrics, daily_equity          │
│                            │    │                                               │
│  Consumes:                 │    │  Realtime Subscriptions                       │
│    - Backend WS events     │    │    └── positions, orders, fills, signals,     │
│    - Backend REST API      │    │        risk_events, alerts, risk_metrics       │
│    - Supabase direct reads │    │                                               │
│    - Supabase Realtime     │    │  Edge Functions                               │
└────────────────────────────┘    │    ├── runtime-health                          │
                                  │    ├── risk-settings-update                   │
                                  │    ├── journal-entry                           │
                                  │    └── strategy-signal-upsert                  │
                                  └───────────────────────────────────────────────┘
```

The system follows a three-tier architecture:
- **Frontend** — React SPA at `localhost:8080`, purely for visualization and control
- **Backend** — Node.js process at `localhost:3001`, handles all trading logic
- **Database** — Supabase cloud Postgres, handles persistence and real-time subscriptions

---

## 3. Technology Stack

### Frontend
| Category | Technology | Version |
|----------|-----------|---------|
| Framework | React | 18.3 |
| Build Tool | Vite (SWC plugin) | 5.4 |
| UI Components | shadcn/ui (Radix UI primitives) | Latest |
| Styling | Tailwind CSS | 3.4 |
| State/Cache | TanStack React Query | 5.83 |
| Charts | Recharts | 2.15 |
| Forms | react-hook-form + zod | 7.61 / 3.25 |
| Routing | react-router-dom | 6.30 |
| Icons | lucide-react | 0.462 |
| Theme | next-themes (dark/light) | 0.3 |
| Notifications | sonner | 1.7 |
| Supabase Client | @supabase/supabase-js | 2.75 |

### Backend
| Category | Technology | Version |
|----------|-----------|---------|
| Runtime | Node.js | 20+ |
| Language | TypeScript (executed via tsx, no compile step) | 5.x |
| HTTP Server | Express | 4.x |
| WebSocket | ws | 8.x |
| Supabase Client | @supabase/supabase-js | 2.x |
| HTTP Client | axios | Latest |
| Config | yaml + zod + dotenv | Latest |
| Metrics | prom-client (Prometheus) | Latest |
| ML (stub) | onnxruntime-node | Latest |
| Native (optional) | C++ via node-addon-api / node-gyp | - |

### Infrastructure
| Component | Technology |
|-----------|-----------|
| Database | Supabase (cloud-hosted Postgres) |
| Realtime | Supabase Realtime (Postgres CDC) |
| Auth | Supabase Auth (single-user fixed ID for MVP) |
| Exchange | Coinbase Advanced Trade API |
| Deployment | Docker + Kubernetes manifests |
| Monitoring | Prometheus metrics endpoint |

---

## 4. Frontend — Dashboard & UI

### Pages & Navigation

The frontend is a single-page application with 10 routes:

| Route | Page | Purpose |
|-------|------|---------|
| `/` | Dashboard | Main trading dashboard with 4 tabs (Overview, Trading, Risk, Config) |
| `/orders` | Orders | Order blotter, open positions, fills table, equity curve |
| `/signals` | Signals | Signal history, strategy configuration (breakout, VWAP, meta) |
| `/risk` | Risk | Position sizing controls, kill switch panel, risk events table |
| `/model` | Model | ML model status, calibration chart, probability thresholds |
| `/backtest` | Backtest | Backtesting configuration, results, equity curve visualization |
| `/journal` | Journal | Trading journal with CRUD operations (Supabase-backed) |
| `/alerts` | Alerts | Risk alerts with acknowledgment (Supabase Realtime) |
| `/settings` | Settings | Theme, safe operations, data retention, API endpoint config |

### Dashboard Tabs

**Overview Tab** — The primary view:
- **MetricsGrid**: Total equity, daily P&L (in R-units and USD), unrealized P&L, risk heat %, spread percentile, daily stop status
- **EquityCurveChart**: Real-time equity curve with high-water mark and max drawdown annotations
- **SessionStatsPanel**: Trade count, wins/losses, win rate, profit factor, expectancy, Sharpe/Sortino estimates, avg win/loss, avg duration, slippage, gross profit/loss, net P&L
- **RegimePanel**: Per-symbol regime detection (trending/ranging/choppy) with ADX, choppiness, ATR%, BB width, MTF alignment, direction consistency, regime duration
- **SystemHealthPanel**: Runtime/database connection status, WS/REST latency
- **LiveTickersPanel**: Real-time BTC, ETH, SOL prices with spread percentages

**Trading Tab** — Active trading view:
- Candle chart with indicator overlays (1m, 5m, 15m timeframes)
- Live signals table with strategy attribution
- Market conditions panel
- Open positions with real-time P&L
- Order blotter and trade log

**Risk Tab** — Risk management:
- Risk controls panel with kill switch, daily limits
- Meta filter configuration and performance
- System metrics and resource usage
- Risk event alerts

**Config Tab** — Strategy configuration:
- Strategy plugin management (enable/disable/configure each strategy)
- Per-symbol parameter overrides
- Signal filter configuration

### Real-Time Data Flow to UI

The frontend receives data through four channels simultaneously:

1. **Backend WebSocket** (`ws://localhost:3001`) — Low-latency events: tickers, candles, signals, orders, fills, position updates, risk events, status updates
2. **Backend REST API** (`http://localhost:3001/api/*`) — On-demand queries: session stats, risk analytics, equity curve, strategy config
3. **Supabase Direct Reads** — Query tables directly: positions, orders, fills, signals, risk events
4. **Supabase Realtime** — Postgres change notifications: positions, orders, fills, signals, alerts, risk metrics

All events are normalized through an **Event Bus** with LRU deduplication. The `UnifiedEventProvider` merges WebSocket and Supabase Realtime into a single stream, which `applyEventToCache` routes into TanStack React Query cache updates. This means the UI reflects state changes within milliseconds.

### Provider Hierarchy

```
BrowserRouter
  └─ AuthProvider (fixed user ID)
      └─ RuntimeWsProvider (WebSocket connection + subscribe API)
          └─ UnifiedEventProvider (event bus + cache sync)
              └─ SidebarProvider (UI layout state)
                  └─ Routes
```

---

## 5. Backend — Trading Runtime

### Entry Point & Server

The backend runs as a single Node.js process started via `tsx src/api/server.ts`. It creates:
- An Express HTTP server on port 3001
- A WebSocket server on the same port (paths: `/`, `/events`, `/ws`)
- A Supabase client using the service role key (bypasses RLS)

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| **TradingEngine** | `trading/trading-engine.ts` | Central orchestrator — manages lifecycle, wires all components |
| **SignalProcessor** | `strategies/signal-processor.ts` | Candle aggregation, indicator computation, signal generation pipeline |
| **StrategyRegistry** | `strategies/plugins/strategy-registry.ts` | Registers and runs trading strategy plugins |
| **RegimeDetector** | `strategies/regime-detector.ts` | Market regime classification (trending/ranging/choppy) |
| **RegimeFilter** | `strategies/regime-filter.ts` | Gates signals based on regime-strategy compatibility |
| **MetaFilter** | `strategies/meta-filter.ts` | Rule-based trade quality filter |
| **SignalArbiter** | `strategies/signal-arbiter.ts` | Resolves conflicts when multiple strategies fire |
| **RiskEngine** | `trading/risk-engine.ts` | Pre-trade risk checks, position sizing, kill switch logic |
| **OrderManager** | `trading/order-manager.ts` | Order lifecycle management, retry logic, fill matching |
| **PositionTracker** | `trading/position-tracker.ts` | Position state from fills, P&L computation, risk alerts |
| **PositionMonitor** | `trading/position-monitor.ts` | Exit monitoring: stop loss, take profit, trailing stop, time stop |
| **TradeAnalytics** | `trading/trade-analytics.ts` | Session statistics computation (win rate, Sharpe, expectancy) |
| **PaperTradingSimulator** | `trading/paper-trading-simulator.ts` | Simulated fills with latency, slippage, fees, depth |
| **CoinbaseExchange** | `exchanges/coinbase/index.ts` | Coinbase WebSocket + REST integration |
| **EngineSupervisor** | `api/server.ts` (inline) | 24/7 watchdog — heartbeat, stale data, auto-restart |
| **SecretManager** | `config/secrets.ts` | AES-256-GCM encrypted credential storage |

### Engine Lifecycle

```
STOPPED ──start()──► STARTING ──(init complete)──► RUNNING
                                                      │
                                              kill switch / error
                                                      │
                                                      ▼
STOPPED ◄──stop()── STOPPING ◄──────────────── HALTED
                                              (trading paused,
                                               runtime alive)
```

**Start Sequence:**
1. Validate configuration and environment
2. Initialize paper simulator (if paper mode) or exchange credentials (if live)
3. Initialize OrderManager, PositionTracker, RiskEngine, PositionMonitor, TradeAnalytics
4. Wire all event handlers
5. Connect to Coinbase WebSocket, wait for connection
6. Validate products exist on exchange
7. Subscribe to ticker + orderbook channels for configured products
8. Load historical candles for strategy warmup (50+ candles needed)
9. Start data gap monitor and heartbeat (2s interval)
10. Set state to `running`

**Stop Sequence:**
1. Set state to `stopping`
2. Stop heartbeat
3. Cancel all open orders
4. Flatten positions if `flatten_on_shutdown` is configured
5. Disconnect exchange
6. Stop all component intervals (position tracker, risk engine, position monitor, trade analytics)
7. Clear data gap monitor
8. Remove all event listeners
9. Set state to `stopped`

### API Endpoints (Complete)

The backend exposes 60+ REST endpoints organized by domain:

**Health & Status** — `/health`, `/api/health`, `/api/status`, `/api/pnl`, `/metrics`

**Engine Control** — `/api/engine/start`, `/api/engine/stop`, `/api/engine/kill`, `/api/control/pause`, `/api/control/resume`, `/api/control/close-all`

**Risk Management** — `/api/risk/status`, `/api/risk/analytics`, `/api/risk/blocked/symbols`, `/api/risk/unblock/symbol/:symbol`, `/api/risk/reset/daily`, `/api/risk/killswitch`, `/api/killswitch/deactivate`

**Analytics** — `/api/analytics/session`, `/api/analytics/equity-curve`, `/api/analytics/trades`, `/api/analytics/trade-history`, `/api/analytics/daily-summary`, `/api/analytics/sessions`, `/api/analytics/system-metrics`

**Strategies** — `/api/strategies`, `/api/strategies/stats`, `/api/strategies/:id`, `/api/strategies/:id/enable`, `/api/strategies/:id/disable`, `/api/strategies/:id/config`, `/api/strategies/config/export`, `/api/strategies/config/import`, `/api/strategies/plugin-mode`, `/api/strategies/symbol-overrides`

**Regime** — `/api/regime/status`, `/api/regime/state`, `/api/regime/state/:symbol`, `/api/regime/filter/stats`, `/api/regime/filter/toggle`, `/api/regime/filter/config`

**MetaFilter** — `/api/metafilter/stats`, `/api/metafilter/performance`, `/api/metafilter/decisions`, `/api/metafilter/toggle`, `/api/metafilter/config`

**Exchange** — `/api/exchange/health`, `/api/exchange/reset-circuit`, `/api/exchange/reconcile`

**Config** — `/api/config/risk`, `/api/config/signals`

**Backtest** — `/api/backtest/run`

### WebSocket Broadcast Events

The backend broadcasts these event types to all connected WebSocket clients:

| Event Type | Frequency | Payload |
|-----------|-----------|---------|
| `StatusUpdate` | Every 1.5s | Engine state, mode, metrics, P&L, warmup status, kill switch, 24/7 health |
| `PnLSnapshot` | Every 1.5s | Total equity, realized/unrealized P&L, daily P&L, risk heat |
| `TickerUpdate` | Per tick | Symbol, price, bid/ask, volume, spread |
| `CandleUpdate` | Every 1m | OHLCV candle for each symbol |
| `Signal` | On generation | Strategy, direction, strength, stop/target, regime metadata |
| `SignalFiltered` | On filter | Signal + filter reason |
| `OrderUpdate` | On order event | Order details, status, fill info |
| `Fill` | On fill | Fill price, size, fee, slippage |
| `PositionUpdate` | On position change | Position state, P&L, stop/target levels |
| `RiskEvent` | On risk alert | Event type, severity, message |
| `RiskMetrics` | Periodic | Daily P&L, drawdown, exposure, risk heat |
| `RegimeUpdate` | On regime change | Symbol, regime, confidence, indicators |
| `WarmupUpdate` | During warmup | Symbol, candle count, ready status |
| `EngineStateChanged` | On state change | Previous state, new state, reason |
| `KillSwitchDeactivated` | On deactivation | Reason, timestamp |

---

## 6. Database Layer — Supabase

### Tables

| Table | Purpose | Key Columns |
|-------|---------|-------------|
| `positions` | Open and closed positions | symbol, side, entry_price, exit_price, realized_pnl, stop_loss, take_profit |
| `orders` | All orders | symbol, side, type, status, price, filled_size, strategy |
| `fills` | Order fills | order_id, price, quantity, fee, slippage_bps |
| `order_legs` | TWAP/child orders | parent_order_id, leg details |
| `signals` | Strategy signals | symbol, direction, strength, strategy, allowed, regime |
| `risk_events` | Risk alerts | event_type, severity, message, acknowledged |
| `risk_metrics` | Risk snapshots | daily_pnl, drawdown, exposure, kill_switch_active |
| `risk_settings` | Per-user risk config | risk_per_trade, daily_loss_limit, max_positions |
| `alerts` | System alerts | severity, title, message, acknowledged |
| `trade_log` | Closed trades | entry/exit details, P&L, duration, outcome, strategy |
| `trading_sessions` | Session rollups | start/end time, trade count, P&L, Sharpe |
| `account_metrics` | Daily account metrics | equity, P&L, risk heat, wins/losses |
| `daily_equity` | Daily equity snapshots | start_equity, end_equity |
| `exchange_credentials` | Encrypted API keys | api_key_encrypted, iv, tag (AES-256-GCM) |
| `bot_states` | Engine state per user | mode (paper/live/paused) |
| `profiles` | User profiles | metadata |
| `user_roles` | Auth roles | role (admin/mod/user) |
| `strategies` | Strategy registry | parameters, enabled status |
| `strategy_signals` | Strategy performance | win rate, trade count |
| `symbols` | Tradable symbols | exchange info |
| `trade_outcomes` | ML training data | features, labels |
| `models` | ML models | path, schema, metrics |
| `journal_entries` | Trading journal | notes on positions/orders |
| `metrics_intraday` | Intraday metrics | bucketed metrics |

### Views

| View | Purpose |
|------|---------|
| `daily_trade_summary` | Aggregated daily trade stats |
| `ml_training_data` | ML feature/label view |
| `strategy_regime_performance` | Strategy performance by regime |
| `v_daily_r` | Daily R-unit calculations |
| `v_open_positions` | Currently open positions |
| `v_recent_activity` | Recent order/fill activity |
| `v_signal_funnel` | Signal generation → filter → execution funnel |

### Data Flow Patterns

**Backend → Supabase (Writes):**
- Orders, fills, positions synced on every event via direct Supabase client
- Risk metrics, daily equity written by RiskEngine
- Trade log and session summaries written by TradeAnalytics
- Signals synced on generation
- Alerts created on risk events

**Frontend → Supabase (Reads):**
- Direct queries via `supabase.from(table).select(...)` for positions, orders, fills, signals
- Edge functions for writes: risk settings updates, journal entries, alert acknowledgment

**Supabase Realtime (Push):**
- The `SupabaseRealtimeManager` subscribes to Postgres changes on: positions, orders, order_legs, fills, signals, risk_events, risk_metrics, alerts, account_metrics, trading_sessions
- Changes are normalized and published to the Event Bus
- React Query cache is updated automatically

### RLS (Row-Level Security)

- All tables scoped to `user_id` via `auth.uid() = user_id` policies
- Backend uses service role key (bypasses RLS)
- Frontend uses anon key with fixed user ID
- `exchange_credentials` has user-scoped policies with optimized subquery pattern

---

## 7. Data Flow: End to End

### Market Data → Signal → Trade → P&L

```
Coinbase WS (ticker)
    │
    ▼
CoinbaseExchange.handleTicker()
    │
    ▼
server.ts: processTickerForCandles()
  ├── Aggregate ticks into 1m OHLCV candles
  ├── Broadcast TickerUpdate to WS clients
  └── On candle close:
        │
        ▼
      SignalProcessor.addCandle(symbol, candle)
        │
        ├── Store candle (last 500 per symbol)
        ├── Aggregate to 5m, 15m, 1h candles
        ├── updateIndicators()
        │     ├── SMA(20, 50), EMA(9, 12, 21, 26)
        │     ├── RSI(14), MACD(12, 26, 9)
        │     ├── Bollinger Bands(20, 2σ)
        │     ├── VWAP, ATR(14)
        │     ├── Donchian Channels
        │     └── Volume SMA(20)
        │
        ├── RegimeDetector.update()
        │     ├── ADX, Choppiness Index
        │     ├── Direction consistency
        │     ├── BB width, ATR%
        │     └── MTF alignment (1m/5m/15m/1h)
        │     → Classify: strong_trend | weak_trend | ranging | choppy
        │
        └── checkSignals() [if warmup complete, ≥50 candles]
              │
              ▼
            StrategyRegistry.generateSignals(context)
              ├── BreakoutStrategy.generateSignals()
              ├── VwapMrStrategy.generateSignals()
              ├── MomentumStrategy.generateSignals()
              └── TrendFollowStrategy.generateSignals()
              │
              ▼
            SignalArbiter.arbitrate() [if multiple signals]
              ├── Filter by minSignalStrength (0.3)
              ├── Flip cooldown (5 min)
              ├── Rank by strength × priority × regime preference
              └── Pick winning direction
              │
              ▼
            processSignal(signal) [per signal]
              │
              ├── Dedupe: same strategy+direction within 5 min
              │
              ├── RegimeFilter.filter(signal)
              │     ├── Check alwaysAllowStrategies [CURRENT BUG: all allowed]
              │     ├── Lookup compatibility score in REGIME_STRATEGY_COMPAT matrix
              │     ├── Compute positionMultiplier
              │     └── Block if score < minCompatibilityScore
              │
              ├── MetaFilter.filter(signal, context)
              │     ├── Cold streak check (10 consecutive losses → block)
              │     ├── Time-of-day quality adjustment
              │     ├── Strategy win rate penalty (< 30% → penalize)
              │     ├── Hourly performance check (< 25% → block)
              │     └── Quality score ≥ 0.5 required
              │
              └── emit('signal:generated', adjustedSignal)
                    │
                    ▼
                  server.ts: signal handler
                    │
                    ├── Broadcast Signal to WS clients
                    ├── Sync signal to Supabase
                    │
                    ├── Guardrail checks:
                    │     ├── Skip if paused / daily stop / kill switch
                    │     ├── Sell = exit long only (no shorts on Coinbase spot)
                    │     ├── Time filter (allowed hours)
                    │     └── ATR volatility filter (min/max range)
                    │
                    ├── computeOrderSize(symbol, entryPrice, stopPrice)
                    │     └── size = (equity × risk_per_trade) / stopDistance
                    │         capped by max_position_exposure
                    │
                    └── TradingEngine.createOrder(orderRequest)
                          │
                          ├── RiskEngine.checkOrder()
                          │     ├── Kill switch check
                          │     ├── Per-symbol block check
                          │     ├── Short selling check
                          │     ├── Min/max order size
                          │     ├── Max open positions
                          │     ├── Total exposure limit
                          │     └── Daily loss limit check
                          │
                          ├── Paper: PaperSimulator.placeOrder()
                          │     ├── Simulate latency (50-150ms)
                          │     ├── Apply slippage + depth impact
                          │     ├── Generate Fill event
                          │     └── Update simulated balances
                          │
                          └── Live: OrderManager.createOrder()
                                └── Exchange.createOrder() with retry
                          │
                          ▼
                        Fill event
                          │
                          ▼
                        PositionTracker.processFill()
                          ├── Update or create position
                          ├── Compute realized/unrealized P&L
                          ├── Sync position to Supabase
                          └── emit('position:update')
                                │
                                ▼
                              PositionMonitor.registerPosition()
                                ├── Set stop loss from signal (ATR-based)
                                ├── Set take profit from signal
                                └── Start monitoring:
                                      ├── Stop loss hit → exit
                                      ├── Take profit hit → exit
                                      ├── Trailing stop (ATR-based) → exit
                                      └── Time stop (96 bars) → exit
                                            │
                                            ▼
                                          Exit Order
                                            │
                                            ▼
                                          TradeAnalytics.recordExit()
                                            ├── Classify: win (>$0.01) / loss (<-$0.01) / breakeven
                                            ├── Update running stats (Welford's algorithm)
                                            ├── Update equity curve
                                            ├── Update HWM and max drawdown
                                            └── Persist to trade_log in Supabase
```

---

## 8. Exchange Integration — Coinbase

### WebSocket Connection
- **URL**: `wss://ws-feed.exchange.coinbase.com` (production)
- **Channels**: `ticker` (real-time price/volume), `level2` (orderbook)
- **Products**: BTC-USD, ETH-USD, SOL-USD
- **Reconnection**: Infinite reconnect with exponential backoff (1s → 60s cap) and jitter
- **Heartbeat**: Ping every 30s, stall detection at 45s → force reconnect
- **Subscription Management**: `SubscriptionManager` auto-restores all subscriptions on reconnect

### REST API
- **Timeout**: 10s with AbortController
- **Retry**: 3 retries with exponential backoff (1s → 2s → 4s)
- **Rate Limiting**: Token bucket (15 req/s global, 5 req/s for orders)
- **Circuit Breaker**: Opens after 5 failures, 30s cooldown
- **Error Classification**: timeout/network/rate_limit → retryable; auth/insufficient_funds → not retryable

### Reconciliation
Even when WebSocket is healthy, a reconciler runs every 5s:
1. **Order Reconciliation**: Compares local orders vs Coinbase open orders
2. **Fill Reconciliation**: Fetches recent fills, deduplicates by trade_id
3. **Triggered Reconciliation**: Runs immediately on WS reconnect or order actions

### Market Data Gap Filling
When WebSocket data goes stale (>30s without candles):
1. Gap filler detects the gap
2. Fetches missing candles via REST
3. Deduplicates and backfills the candle buffer
4. Indicators resume without gaps

---

## 9. Trading Strategies

### Strategy Architecture

Strategies are implemented as plugins conforming to the `StrategyPlugin` interface. Each strategy:
- Has a unique ID and category (trend/mean-reversion/momentum)
- Can be independently enabled/disabled at runtime
- Has per-symbol parameter overrides
- Generates `StrategySignal` objects with direction, strength, stop/target prices

### Active Strategies

#### 1. Donchian Breakout (`breakout`)
**Category:** Trend-following  
**Entry Logic:**
- Bullish: Close price breaks above the previous-period Donchian upper band
- Bearish: Close price breaks below the previous-period Donchian lower band
- Volume confirmation (configurable threshold)
- Uses previous-period values to prevent lookahead bias

**Exit Logic:**
- Stop loss: Entry ± (ATR × atrMultiplier), default 2.0
- Take profit: Stop distance × targetMultiplier, default 2.0 (1:2 risk/reward)

**Strength:** `min(volumeRatio / 2, 1)` — higher volume = stronger signal

**Best Regime:** Strong trend (1.0 compatibility). Poor in ranging (0.3) and choppy (0.0).

#### 2. VWAP Mean Reversion (`vwap_mr`)
**Category:** Mean reversion  
**Entry Logic:**
- Long: Price deviation from VWAP < -deviationEntry standard deviations
- Short: Price deviation from VWAP > +deviationEntry standard deviations
- Deviation computed as rolling 20-bar std dev of (close - VWAP)
- Optional Bollinger Bands mode

**Exit Logic:**
- Take profit: Return to VWAP (the mean)
- Stop loss: Price ± stdDev × stopMultiplier

**Strength:** `min(|deviation| / 3, 1)` — deeper deviation = stronger signal

**Best Regime:** Ranging (1.0 compatibility). Blocked in strong trend (0.0).

#### 3. RSI/MACD Momentum (`momentum`)
**Category:** Oscillator/momentum  
**Entry Logic:**
- Bullish: RSI crosses into oversold zone (≤ rsiOversold threshold) with optional MACD histogram confirmation
- Bearish: RSI crosses into overbought zone (≥ rsiOverbought threshold) with optional MACD confirmation
- RSI component (70% weight): How far into the extreme zone
- MACD component (30% weight): Histogram magnitude

**Exit Logic:**
- Stop loss: Entry ± (ATR × atrMultiplier), default 2.0
- Take profit: Stop distance × targetMultiplier, default 2.0

**Strength:** `rsiStrength (0.7) + macdStrength (0.3)`

**Best Regime:** Weak trend (1.0) and ranging (0.9). Reduced in choppy (0.4).

#### 4. EMA Trend Follow (`trend_follow`)
**Category:** Trend-following  
**Entry Logic:**
- Bullish: Fast EMA(9) crosses above Slow EMA(21) within lookback window (15 bars)
- Bearish: Fast EMA(9) crosses below Slow EMA(21)
- Price must be on correct side of both EMAs
- Optional ADX filter and MTF alignment

**Exit Logic:**
- Stop loss: Entry ± (ATR × 2.5)
- Take profit: Stop distance × 3.0

**Strength:** Base 0.5, plus bonuses for fresh crossover, ADX strength, price confirmation, MTF alignment, and trending regime.

**Best Regime:** Strong trend (1.0 compatibility). Poor in choppy (0.0).

### Current Configuration Issues

The guardrails.yaml has **ultra-aggressive test settings** that fire signals on noise:

| Parameter | Current (Test) | Proper Production |
|-----------|---------------|-------------------|
| RSI Oversold | 45 | 30 |
| RSI Overbought | 55 | 70 |
| VWAP deviationEntry | 0.1 σ | 1.5-2.0 σ |
| Breakout period | 8 bars | 20 bars |
| Volume threshold | 0.3 (very low) | 1.2+ (above average) |
| risk_per_trade | 1% | 0.5% |

---

## 10. Signal Processing Pipeline

### Indicator Computation

On every 1-minute candle close, the SignalProcessor computes:

| Indicator | Period/Params | Used By |
|-----------|-------------|---------|
| SMA | 20, 50 | General trend reference |
| EMA | 9, 12, 21, 26 | Trend Follow, MACD |
| RSI | 14-period | Momentum strategy |
| MACD | 12/26/9 | Momentum strategy |
| Bollinger Bands | 20-period, 2σ | Regime detector, VWAP-MR |
| VWAP | Session cumulative | VWAP-MR strategy |
| ATR | 14-period | All strategies (stop/target sizing) |
| Donchian Channels | Configurable (default 10) | Breakout strategy |
| Volume SMA | 20-period | Breakout volume confirmation |
| ADX | 14-period | Regime detector |
| Choppiness Index | Calculated | Regime detector |

### Multi-Timeframe Aggregation

1-minute candles are aggregated into higher timeframes:
- **5-minute**: Every 5 candles
- **15-minute**: Every 15 candles
- **1-hour**: Every 60 candles

Higher timeframes feed the RegimeDetector for MTF alignment scoring.

### Signal Arbitration

When multiple strategies generate conflicting signals simultaneously:

1. Drop signals below minimum strength (0.3)
2. Check flip cooldown (5 minutes between direction changes)
3. Rank signals by: `baseStrength × strategyPriority × regimePreference`
4. If buy and sell signals conflict, pick the direction with the highest aggregate score
5. If consensus mode is enabled (off by default), require minimum agreement count

**Strategy Priorities:** trend_follow 1.1, breakout 1.0, vwap_mr 1.0, momentum 0.9

---

## 11. Regime Detection & Filtering

### Regime Classification

The `RegimeDetector` classifies each symbol's market condition using multiple inputs:

| Input | Weight | What It Measures |
|-------|--------|-----------------|
| ADX (14) | High | Trend strength (>25 = trending, <20 = ranging) |
| Choppiness Index | High | Market noise (>61.8 = choppy) |
| Direction Consistency | Medium | How consistently price moves in one direction |
| Bollinger Band Width | Medium | Volatility compression/expansion |
| MTF Alignment | Medium | Agreement across 1m/5m/15m/1h timeframes |

**Output Regimes:**
- `strong_trend` — Clear directional move, high ADX, consistent direction
- `weak_trend` — Mild directional bias, moderate ADX
- `ranging` — Price oscillating in a band, low ADX, high choppiness
- `choppy` — Erratic, whipsawing, no clear pattern

### Regime-Strategy Compatibility Matrix

|  | Trend Following | Mean Reversion | Oscillator | Neutral |
|--|----------------|---------------|------------|---------|
| **Strong Trend** | 1.0 | 0.0 | 0.5 | 0.7 |
| **Weak Trend** | 0.8 | 0.3 | 1.0 | 0.6 |
| **Ranging** | 0.3 | 1.0 | 0.9 | 0.7 |
| **Choppy** | 0.0 | 0.7 | 0.4 | 0.5 |

Strategy-to-type mapping: breakout → trend_following, vwap_mr → mean_reversion, momentum → oscillator, trend_follow → trend_following

### Current Bug: Filter Is Bypassed

The `DEFAULT_CONFIG` in `regime-filter.ts` includes:
```
alwaysAllowStrategies: ['vwap_mr', 'breakout', 'momentum', 'trend_follow']
```

This means **every single strategy** bypasses the compatibility matrix. The regime filter computes scores but never actually blocks anything. This is the root cause of the current losses — breakout and trend-following strategies fired in a ranging/choppy market where they have 0.0-0.3 compatibility.

---

## 12. Risk Management System

### Pre-Trade Checks (RiskEngine.checkOrder)

Every order passes through these checks in sequence:

1. **Kill Switch Active** → Reject (unless reduce-only/exit)
2. **Per-Symbol Block** → Reject (unless reduce-only)
3. **Short Selling Disabled** → Reject if would open short (Coinbase spot limitation)
4. **Min Order Size** → Reject if below exchange minimum
5. **Max Open Positions** → Reject if already at limit (5 default)
6. **Max Order Size** → Reject if exceeds per-symbol limit
7. **Position Size Limit** → Reject if would exceed per-symbol exposure
8. **Total Exposure** → Reject if total portfolio exposure exceeds limit
9. **Daily Loss Limit** → Reject if daily P&L exceeds -2% of equity
10. **Max Open Orders** → Reject if too many pending orders

### Position Sizing

```
riskUsd = sizingEquity × risk_per_trade (1% default)
size = riskUsd / stopDistance
size = min(size, maxExposure / entryPrice)
if (size × entryPrice < minNotional) → reject
```

### R-Unit System

The system measures risk in "R" units:
- **1R** = per_trade_risk × day_start_equity (e.g., 1% × $50,000 = $500)
- **Daily Stop** = -2R (e.g., -$1,000)
- Daily halts auto-clear on day rollover
- Non-daily halts require manual reset via API

### Risk State Machine

```
RUNNING ──(daily loss / kill switch)──► HALTED
    │                                      │
    │                                      │
    └──(pause)──► PAUSED ◄────────────────┘
                     │                     (deactivate kill switch)
                     └──(resume)──► RUNNING
```

**RUNNING**: All trading allowed  
**PAUSED**: New entries blocked, exits allowed  
**HALTED**: Kill switch active, only reduce-only exits allowed, runtime stays alive

---

## 13. Kill Switch Mechanism

### Trigger Conditions

The kill switch can be activated by four conditions:

| Trigger | Threshold | Source |
|---------|-----------|--------|
| **Daily Loss** | -2R (-2% of equity) | RiskEngine.checkKillSwitches() |
| **Consecutive Losses** | 5 losses in a row | RiskEngine.checkKillSwitches() |
| **Error Rate** | >20% of operations failing | RiskEngine.checkKillSwitches() |
| **Data Gap** | All symbols stale >30s (paper) / >10s (production) | TradingEngine data gap monitor |

The `RiskStateMachine` manages the halt state with reason tracking.

### What Happens When Kill Switch Fires

1. **Engine state** → `halted` (NOT `stopped`)
2. **New entries** → Blocked at RiskEngine pre-trade check
3. **Existing positions** → PositionMonitor continues running stop/TP/trailing exits
4. **WebSocket** → Stays connected, market data keeps flowing
5. **API** → Stays up, status reports "HALTED (KILL SWITCH)"
6. **Frontend** → Shows kill switch banner, modal dialog, and halt status
7. **Alerts** → Risk event persisted to Supabase, alert broadcast to all clients

### Kill Switch In Current Session

The kill switch triggered because:
- 3 trades executed (breakout and momentum strategies in a ranging market)
- All 3 were losses (avg -$363.36 each)
- Total daily loss hit -$1,090.07 = -2.18R
- Daily loss guardrail (-2R = -$1,000) was exceeded

### Deactivation

The kill switch can only be deactivated via:
```
POST /api/killswitch/deactivate
Body: { "confirm": "RESUME TRADING" }
```
This requires explicit text confirmation as a safety gate. Daily-triggered halts auto-clear on day rollover.

---

## 14. Position Management

### Position Tracker

The `PositionTracker` maintains the definitive position state:

- **processFill()**: Applies fills to positions, handles long/short/flip transitions, allocates fees, computes realized/unrealized P&L
- **Update Loop**: Every 5 seconds, recomputes unrealized P&L for all open positions using latest market prices
- **Risk Alerts**: Triggers alerts on excessive drawdown, oversized positions, or large unrealized losses
- **Portfolio Summary**: `totalUnrealizedPnL`, `totalRealizedPnL`, `positionCount`, `totalValue`

### Position Monitor

The `PositionMonitor` checks exit conditions every 1 second:

| Exit Type | Condition | Default |
|-----------|-----------|---------|
| **Stop Loss** | Price hits stop level (from signal) | ATR-based, ~1.5-2.0× ATR |
| **Take Profit** | Price hits target level (from signal) | 2-3× stop distance |
| **Trailing Stop** | Price retraces from high-water mark by `stop_trail_atr` × ATR | 1.0× ATR |
| **Time Stop** | Position open longer than `time_stop_bars` bars | 96 bars (96 minutes) |
| **Signal Exit** | Opposite signal on same symbol (sell signal closes long) | When allow_short = false |

### Position Lifecycle

```
Signal → Order → Fill → Position OPEN
                              │
              PositionMonitor checks every 1s
                              │
                    ┌─────────┼─────────┐
                    ▼         ▼         ▼
              Stop Loss   Take Profit  Trailing/Time Stop
                    │         │         │
                    └─────────┴─────────┘
                              │
                        Exit Order
                              │
                        Fill → Position CLOSED
                              │
                        TradeAnalytics.recordExit()
```

---

## 15. Order Execution

### Order Types

| Type | Description | Usage |
|------|------------|-------|
| `market` | Execute at best available price | Emergency exits |
| `limit` | Execute at specified price or better | Normal entries |
| `marketable_limit` | Limit order priced to fill immediately (with offset) | Default for entries (configurable) |

### Execution Flow

**Paper Mode:**
1. `PaperTradingSimulator.placeOrder()` receives order
2. Simulates latency (50-150ms random delay)
3. Calculates price impact based on order size and simulated depth
4. Applies execution price = market ± slippage ± depth impact
5. Applies fees (maker 0.4%, taker 0.6%)
6. Generates Fill event with realistic details
7. Updates simulated balances

**Live Mode:**
1. `OrderManager.createOrder()` receives order
2. `placeOrderWithRetry()` → `exchange.createOrder()` via Coinbase REST
3. Retry with exponential backoff on transient errors
4. Exchange returns order acknowledgment
5. WebSocket receives fill events
6. `handleExchangeFill()` matches fills to managed orders
7. Updates order state (partial fills supported)

### TWAP (Time-Weighted Average Price)

For large orders, the system supports TWAP execution:
- Slices the order into smaller pieces
- Executes each slice at random intervals
- Random size variation per slice
- Reduces market impact on larger positions

---

## 16. Paper vs Live Trading

### Unified Model

Paper and live modes share 100% identical code paths. Only the execution adapter differs:

| Aspect | Paper | Live |
|--------|-------|------|
| Market Data | Real Coinbase production WS | Real Coinbase production WS |
| Signal Generation | Same strategies, same indicators | Same strategies, same indicators |
| Risk Checks | Same RiskEngine | Same RiskEngine |
| Order Execution | PaperTradingSimulator | OrderManager → Coinbase REST |
| Fill Generation | Simulated (latency + slippage + fees) | Real exchange fills |
| Balances | In-memory simulation | Real Coinbase account |

### Paper Simulator Features

- Simulated latency: 50-150ms per order
- Slippage: 0.05% base + depth-aware price impact
- Fees: Maker 0.4%, Taker 0.6% (matches Coinbase fee tier)
- Post-only validation: Rejects limit orders that would cross spread
- Tick/lot size enforcement: Respects exchange product specifications
- Balance tracking: Simulated USD and crypto balances

### Live Safety Gates

Going live requires:
- `CONFIRM_LIVE=YES` in environment
- Explicit confirmation phrase `ENABLE LIVE` in the start request
- Preflight checklist (valid credentials, sufficient balance)
- API credentials stored encrypted in Supabase
- `go_live_criteria` in guardrails: paper parity check, min profitable days, max errors, manual approval

---

## 17. Session Statistics & Analytics

### What's Tracked

The `TradeAnalytics` module computes running statistics using Welford's online algorithm:

| Metric | Formula/Source |
|--------|---------------|
| Total Trades | Count of closed trades |
| Wins / Losses / Breakeven | Outcome classification (±$0.01 threshold) |
| Win Rate | wins / totalTrades |
| Profit Factor | grossProfit / grossLoss |
| Expectancy | (winRate × avgWin) - (lossRate × avgLoss) |
| Avg Win / Avg Loss | grossProfit/wins, grossLoss/losses |
| Sharpe Estimate | (avgTrade / stdDev) × √(min(n, 252)) |
| Sortino Estimate | (avgTrade / downsideDeviation) × √(min(n, 252)) |
| Calmar Estimate | totalPnl / maxDrawdown |
| Max Drawdown | Largest peak-to-trough equity drop |
| High Water Mark | Highest equity reached |
| Avg Duration | Mean trade holding time |
| Avg Slippage | Mean entry+exit slippage in basis points |
| Equity Curve | Array of equity points (per-trade + every 60s samples) |

### Known Issues

1. **Daily P&L vs Session Net P&L**: Different baselines. Daily P&L uses midnight equity; session P&L uses session start equity. They diverge if the engine runs across midnight.
2. **Outcome threshold mismatch**: TradeAnalytics uses ±$0.01 band; trading-engine uses strict >0/<0. A $0.005 trade is "breakeven" in stats but "win" in the engine.
3. **Risk analytics fallback**: When session stats are null, `/api/risk/analytics` falls back to `positionCount` (open positions) as trade count — incorrect.
4. **positionMultiplier not applied**: Regime filter computes position size multipliers but `computeOrderSize()` ignores them.
5. **Equity curve points ≠ trades**: Points include 60-second interval samples, so the count exceeds trade count.

---

## 18. 24/7 Resilience & Recovery

### Engine Supervisor (Watchdog)

The `EngineSupervisor` runs a periodic tick checking:
- **Engine Heartbeat**: If no heartbeat for >15s, trigger engine restart
- **Market Data Freshness**: If no market data for >10s, trigger WS reconnect
- **Restart Tracking**: Max 5 consecutive restarts before giving up, with 30s cooldown between attempts

### Process-Level Recovery

`start.cjs` provides process-level supervision:
- Auto-restarts backend on crash with exponential backoff (1s → 30s)
- Max 10 restarts in a 5-minute window
- Tracks restart history for circuit breaking

### WebSocket Resilience

| Feature | Implementation |
|---------|---------------|
| Reconnection | Infinite retry with exponential backoff (1s → 60s) + jitter |
| Heartbeat | Ping every 30s, stall at 45s → force reconnect |
| Subscription Restore | `SubscriptionManager` auto-resubscribes on reconnect |
| Gap Filling | REST candle fetch for missing data after disconnect |

### Degraded Mode

| Condition | Entries | Exits | Monitoring |
|-----------|---------|-------|------------|
| WS disconnected only | Allowed | Allowed | Active |
| REST circuit open | Blocked | Warning | Active |
| WS + reconciler degraded | Blocked | Warning | Active |
| Rate limited | Warning | Warning | Active |

---

## 19. Startup & Deployment

### Quick Start

```bash
pnpm start        # Runs start.cjs — installs deps, starts backend + frontend
```

`start.cjs` performs:
1. Install root dependencies (`pnpm install`)
2. Install backend dependencies (`cd atlas/apps/core-node && pnpm install`)
3. Start backend API (`tsx src/api/server.ts` on port 3001)
4. Wait for backend health (`/health` endpoint)
5. Start frontend dev server (`vite` on port 8080)
6. Open browser
7. Auto-start trading engine in paper mode via REST call

### Manual Start

```bash
# Terminal 1: Frontend
pnpm dev                                          # Vite on :8080

# Terminal 2: Backend
cd atlas/apps/core-node && pnpm api               # Express on :3001

# Terminal 3: Start engine
curl -X POST localhost:3001/api/engine/start \
  -H 'Content-Type: application/json' \
  -d '{"mode":"paper"}'
```

### Docker Deployment

```bash
docker build -f deploy/docker/Dockerfile.api -t atlas-api:latest .
docker run -p 3001:3001 --env-file .env atlas-api:latest
```

### Kubernetes

Manifests in `deploy/k8s/`:
- `api-deployment.yaml` — Backend deployment
- Readiness/liveness probes on `/api/status`
- ConfigMap for guardrails
- Secrets for environment variables

### Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Service role key (bypasses RLS) |
| `SUPABASE_ANON_KEY` | No | Anon key for frontend |
| `ENCRYPTION_KEY` | Yes | 64 hex chars for AES-256-GCM credential encryption |
| `COINBASE_API_KEY` | Live only | Coinbase API key |
| `COINBASE_API_SECRET` | Live only | Coinbase API secret |
| `COINBASE_API_PASSPHRASE` | Live only | Coinbase passphrase |
| `CONFIRM_LIVE` | No | `YES` to enable live trading (default `NO`) |
| `USER_ID` | No | Fixed user ID for single-user MVP |
| `VITE_RUNTIME_API_URL` | No | Frontend → backend URL (default `http://localhost:3001`) |

---

## 20. Security Model

### Authentication
- **Single-user MVP**: Fixed `USER_ID = b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f`
- No real authentication flow; both frontend and backend use this ID
- Supabase RLS policies scoped to `user_id`

### Credential Storage
- Exchange API keys stored in `exchange_credentials` table
- Encrypted with AES-256-GCM using `ENCRYPTION_KEY`
- Per-credential IV and auth tag stored alongside ciphertext
- `SecretManager` handles encrypt/decrypt

### Live Trading Safety
- `CONFIRM_LIVE=NO` by default — live mode cannot be started without explicit override
- Start request requires confirmation phrase `"ENABLE LIVE"`
- Preflight checklist validates credentials and balances before live trading
- `go_live_criteria` in guardrails requires: paper parity check, 3+ profitable days, 0 errors/day, manual approval

### API Security
- No authentication on REST endpoints (single-user MVP)
- Backend runs on localhost only in development
- Kubernetes deployment intended for private cluster

---

## 21. Known Issues & Current State

### Critical

| Issue | Impact | Root Cause |
|-------|--------|-----------|
| **Regime filter 100% bypassed** | All strategies trade in all market conditions, causing losses in ranging/choppy markets | `alwaysAllowStrategies` contains all 4 strategies |
| **Ultra-aggressive signal thresholds** | Signals fire on market noise (RSI 45/55, VWAP deviation 0.1σ, Donchian period 8) | Guardrails.yaml set for testing, never tuned for production |
| **positionMultiplier ignored** | Regime-adjusted sizing never applied to actual orders | `computeOrderSize()` doesn't read `signal.metadata.positionMultiplier` |

### Medium

| Issue | Impact |
|-------|--------|
| Risk analytics fallback uses `positionCount` (open positions) as trade count | Incorrect stats when session analytics unavailable |
| Outcome threshold mismatch (±$0.01 vs strict 0) | Minor win/loss/breakeven classification inconsistency |
| Equity curve `currentEquity` uses static guardrails vs dynamic equity | Minor equity display inconsistency |

### UI/UX Issues

| Issue | Description |
|-------|------------|
| WS/REST latency shows dashes | Not populated despite active connection |
| Equity curve "Points" misleading | Shows equity samples (every 60s), not trade count |
| Kill switch triple notification | Banner + modal + toast all fire simultaneously |
| Building candles loading state | Trading tab chart shows perpetual loading |
| Open Positions stuck loading | Loading state persists after positions close |
| No trade history on main dashboard | Must navigate to separate pages |

---

## 22. File & Directory Map

```
apex-automata/
├── src/                              # Frontend (React + Vite)
│   ├── components/
│   │   ├── dashboard/                # Dashboard panels (30+ components)
│   │   ├── debug/                    # WS debug panel
│   │   ├── model/                    # ML model components
│   │   ├── status/                   # Connection status
│   │   └── ui/                       # shadcn/ui primitives (40+ components)
│   ├── contexts/                     # AuthContext
│   ├── hooks/                        # React hooks (25+ hooks)
│   ├── integrations/supabase/        # Supabase client + types
│   ├── lib/                          # Utilities
│   ├── pages/                        # Route pages (10 pages)
│   ├── runtime/                      # Real-time infrastructure
│   │   ├── alerts/                   # Alert state management
│   │   ├── connectivity/             # WS/REST health tracking
│   │   ├── event-bus/                # Unified event bus
│   │   ├── pnl/                      # PnL computation
│   │   ├── realtime/                 # Supabase Realtime manager
│   │   ├── state/                    # Trading state machine
│   │   └── ws/                       # WebSocket client + normalization
│   └── services/                     # API clients
│
├── atlas/                            # Backend monorepo
│   ├── apps/core-node/               # Trading runtime
│   │   ├── src/
│   │   │   ├── api/server.ts         # Express + WS server (main entry)
│   │   │   ├── trading/              # Core trading logic
│   │   │   │   ├── trading-engine.ts # Central orchestrator
│   │   │   │   ├── risk-engine.ts    # Pre-trade risk checks
│   │   │   │   ├── order-manager.ts  # Order lifecycle
│   │   │   │   ├── position-tracker.ts
│   │   │   │   ├── position-monitor.ts
│   │   │   │   ├── trade-analytics.ts
│   │   │   │   ├── paper-trading-simulator.ts
│   │   │   │   ├── risk/             # Risk state machine, R-math
│   │   │   │   ├── execution/        # Execution adapters
│   │   │   │   ├── account/          # Account management
│   │   │   │   └── pnl/             # PnL computation
│   │   │   ├── strategies/           # Signal generation
│   │   │   │   ├── signal-processor.ts
│   │   │   │   ├── signal-arbiter.ts
│   │   │   │   ├── regime-detector.ts
│   │   │   │   ├── regime-filter.ts
│   │   │   │   ├── meta-filter.ts
│   │   │   │   └── plugins/builtin/  # Strategy implementations
│   │   │   │       ├── breakout-strategy.ts
│   │   │   │       ├── vwap-mr-strategy.ts
│   │   │   │       ├── momentum-strategy.ts
│   │   │   │       └── trend-follow-strategy.ts
│   │   │   ├── exchanges/coinbase/   # Exchange integration
│   │   │   │   ├── index.ts
│   │   │   │   ├── ws/               # WebSocket client
│   │   │   │   ├── http/             # REST client
│   │   │   │   └── reconciliation/   # Order/fill reconciler
│   │   │   ├── indicators/           # Technical indicators
│   │   │   ├── backtesting/          # Backtesting engine
│   │   │   ├── ml/                   # ML trade outcomes
│   │   │   ├── config/               # Secrets, configuration
│   │   │   ├── core/                 # Environment, logging
│   │   │   ├── persistence/          # Schema capabilities
│   │   │   ├── alerts/               # Alert system
│   │   │   └── cli/                  # CLI tools
│   │   └── package.json
│   ├── config/                       # YAML configs
│   │   ├── guardrails.yaml           # Risk parameters
│   │   ├── paper.local.yaml
│   │   └── live.local.yaml
│   ├── docs/                         # Backend documentation
│   └── var/                          # Runtime data (bars, logs, models, state)
│
├── supabase/
│   ├── migrations/                   # 26 SQL migration files
│   └── functions/                    # Edge functions
│
├── deploy/
│   ├── docker/Dockerfile.api
│   ├── k8s/                          # Kubernetes manifests
│   └── monitoring/                   # Prometheus dashboards
│
├── docs/                             # Project documentation
├── start.cjs                         # Cross-platform startup script
├── stop.cjs                          # Graceful shutdown script
├── package.json                      # Frontend dependencies + scripts
├── vite.config.ts                    # Vite build configuration
├── tailwind.config.ts                # Tailwind CSS configuration
├── .env                              # Environment variables (not committed)
└── README.md                         # Project README
```

---

*End of document. For questions or updates, refer to the codebase directly or the plan document in `.cursor/plans/`.*
