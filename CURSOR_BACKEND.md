# AtlasBot v2 - Backend Implementation Guide for Cursor

**Document Purpose:** Complete backend development reference for the Node.js trading runtime.  
**Current Status:** UI/UX complete (Lovable), Database ready (Supabase), Backend implementation needed (Cursor).  
**Target:** Build production-ready trading engine in `atlas/apps/core-node/`.

---

## Table of Contents
1. [Project Overview](#project-overview)
2. [What's Already Complete](#whats-already-complete)
3. [Critical Pre-Implementation Items](#critical-pre-implementation-items)
4. [Backend Architecture](#backend-architecture)
5. [API Endpoints to Implement](#api-endpoints-to-implement)
6. [Trading Engine Implementation](#trading-engine-implementation)
7. [Supabase Integration](#supabase-integration)
8. [Data Contracts](#data-contracts)
9. [Testing Strategy](#testing-strategy)
10. [Success Criteria](#success-criteria)

---

## Project Overview

### Mission
Build a fast, safe, explainable interface for a single pro trader. Must reduce errors, expose risk in real-time, and improve realized expectancy by enforcing discipline and surfacing high-value information.

### Tech Stack
- **Frontend:** React + TypeScript + Vite + TanStack Query (Lovable) ✅ COMPLETE
- **Database:** Supabase (Postgres + Realtime + Storage) ✅ COMPLETE
- **Backend:** Node.js + TypeScript + Express + WebSockets (Cursor) ⚠️ NEEDS IMPLEMENTATION
- **Exchange:** Coinbase Advanced Trade API (REST + WebSocket)

### Key Design Principles
1. **Risk-first**: Show R next to $; heat gauge fixed in header; daily stop and kill-switch always visible
2. **Progressive disclosure**: Compact KPIs first; expand for detail (drawers)
3. **One-click auditability**: "Why did we enter?" opens drawer with signal name, meta_prob, features at entry, stop/TP
4. **Statefulness**: live/paper, paused/running, kill/daily stop are badged and sticky
5. **Consistency**: Number formatting (Intl.NumberFormat), UTC timestamps, monospace for numeric tables

---

## What's Already Complete

### ✅ Phase 1-8: UI/UX (Lovable)
All screens built and fully functional:

**1. Dashboard** (`src/pages/Index.tsx`)
- Header KPIs: Equity, Daily P&L (R & $), Open Risk Heat %, Spread Percentile, Regime, Bot State
- Controls: Pause/Resume, Close All (ConfirmGate), Override Kill-Switch, Live/Paper toggle
- Chart: 1/5/15m selectable with VWAP, ATR bands, Donchian overlays
- Panels: Recent Fills, Active Positions, Alerts, System Health
- Badges: KILL-SWITCH (red), DAILY STOP (amber), PAUSED (gray)

**2. Orders/Positions** (`src/pages/Orders.tsx`)
- Open Positions table: symbol, side, qty, entry, stop, R at risk, UPL (R/$), meta_prob, age
- Orders blotter: status, fill %, type, venue latency, slippage bps
- Details drawer: feature snapshot at entry/exit, reason codes, partials timeline

**3. Signals** (`src/pages/Signals.tsx`)
- Strategy cards: Breakout+Vol, VWAP MR, OBI
- Enable toggle and sliders per strategy
- Meta threshold slider with acceptance-rate preview

**4. Risk** (`src/pages/Risk.tsx`)
- Inputs: per-trade risk (bp), heat cap, daily stop (R), correlation clamp %, time stops
- Live preview: size calculator at current price/ATR
- Kill-Switch tile showing trigger reasons and auto-reset countdown

**5. Model** (`src/pages/Model.tsx`)
- ONNX model info (name, version, hash)
- Input schema, calibration thumbnail, ROC, precision@θ
- Threshold slider with predicted trade volume change

**6. Backtest** (`src/pages/Backtest.tsx`)
- Date range + symbol set; Run button; progress; KPIs; equity curve
- Export MD report + CSV

**7. Journal** (`src/pages/Journal.tsx`)
- Trade list with tags; note editor; attachments (Supabase Storage)
- Filters by strategy, outcome, date

**8. Alerts** (`src/pages/Alerts.tsx`)
- Stream with severity color + icon + text
- Click-through opens related entity

### ✅ Supabase Database (Complete)

**Tables Created:**
- `symbols` - Trading instruments (BTC-USD, ETH-USD)
- `strategies` - Strategy definitions (breakout, vwap_mr, obi)
- `strategy_signals` - Strategy configuration per user
- `signals` - Generated trade signals with features
- `orders` - Parent orders
- `order_legs` - Child orders (for TWAP, multi-leg)
- `fills` - Executed trades
- `positions` - Open/closed positions with PnL
- `risk_events` - Kill-switch triggers, daily stop hits
- `alerts` - User notifications
- `models` - ONNX model metadata
- `journal_entries` - Trade notes and attachments
- `account_metrics` - Daily summary stats
- `bot_states` - Bot mode (paper/live)
- `risk_settings` - Risk parameters
- `profiles` - User profiles
- `user_roles` - Role-based access control

**Views Created:**
- `v_daily_r` - Daily R-multiple performance
- `v_open_positions` - Current open positions
- `v_recent_activity` - Latest orders/fills
- `v_signal_funnel` - Signal acceptance rates

**Features Enabled:**
- ✅ Row Level Security (RLS) on all tables
- ✅ Realtime subscriptions on: `orders`, `order_legs`, `fills`, `positions`, `risk_events`, `alerts`, `signals`, `account_metrics`
- ✅ Storage bucket: `journal-attachments` (10MB limit, user-scoped)
- ✅ Indexes on all foreign keys and query-heavy columns
- ✅ `updated_at` triggers on mutable tables
- ✅ Foreign key constraints for data integrity
- ✅ `upsert_account_metrics()` function for backend

**Secrets Stored:**
- `COINBASE_API_KEY`
- `COINBASE_API_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `ENCRYPTION_KEY`

### ✅ Frontend Integration Layer

**Hooks:**
- `useTradingEngine.ts` - WebSocket connection to backend, event handling, debouncing
- `useRuntimeStatus.ts` - Polls `/api/status` every 2s
- `useRuntimeHealth.ts` - Polls `/api/health` every 5s
- `useRiskSettings.ts` - CRUD for risk_settings table
- `usePositions.ts` - Realtime positions from Supabase
- `useAccountMetrics.ts` - Realtime account metrics
- `useModelData.ts` - Model info from Supabase
- `useBacktest.ts` - Backtest execution (stub for backend)
- `useJournal.ts` - Journal CRUD with Storage

**Services:**
- `runtimeClient.ts` - HTTP client for runtime control (pause, resume, close-all, config updates)
- `tradingApi.ts` - WebSocket client for trading engine events

**Components:**
- Full design system in `src/components/ui/`
- Dashboard panels in `src/components/dashboard/`
- ConfirmGate pattern for dangerous actions
- Connection status banners
- Stale data warnings

---

## Critical Pre-Implementation Items

### 🚨 MUST FIX BEFORE FIRST RUN

#### 1. Environment Variable Missing
Add to `.env` in project root:
```env
VITE_RUNTIME_API_URL=http://localhost:3001
```

#### 2. Authentication Decision Required
**Current State:** No authentication. RLS policies use `true` (allow all).

**Option A: Single-User Mode (Recommended for MVP)**
- Hardcode `user_id` in backend: `const USER_ID = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';`
- Generate UUID once: `node -e "console.log(require('crypto').randomUUID())"`
- Keep current RLS policies
- Skip login entirely
- **Timeline:** Ship in 4-6 hours

**Option B: Multi-User Mode (Production)**
- Implement Supabase Auth (email/password)
- Add login/signup pages in Lovable
- Update RLS policies to use `auth.uid()`
- **Timeline:** Add 2-3 hours for auth setup

**Recommendation:** Start with Option A, add auth later if needed.

#### 3. Supabase Security Linter Warnings
Run `supabase db lint` to see 5 warnings:
- 4 ERROR: Views with `SECURITY DEFINER` (v_daily_r, v_open_positions, v_recent_activity, v_signal_funnel)
- 1 WARN: `touch_updated_at()` function missing `search_path`

**Impact:** Functional for single-user, but violates security best practices.

**Fix (optional):**
```sql
-- Fix views (make them SECURITY INVOKER)
DROP VIEW v_daily_r;
CREATE VIEW v_daily_r 
WITH (security_invoker=true)
AS SELECT ...;

-- Fix function
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
begin
  new.updated_at = now();
  return new;
end $function$;
```

#### 4. Runtime Status Shape Mismatch
**Backend currently returns:**
```typescript
{
  engineRunning: boolean;
  mode: 'paper' | 'live';
  positions: Position[];
  riskMetrics: any;
  activeOrders: Order[];
}
```

**Frontend expects:**
```typescript
{
  mode: 'paper' | 'live';
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
    since: string;
  };
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: 'trend' | 'chop';
}
```

**Action:** Update `atlas/apps/core-node/src/api/server.ts` `/api/status` endpoint.

---

## Backend Architecture

### File Structure
```
atlas/apps/core-node/
├── src/
│   ├── api/
│   │   └── server.ts                 # Express server + WebSocket + Prometheus ⚠️ INCOMPLETE
│   ├── backtesting/
│   │   ├── backtest-engine.ts        # Backtest simulation ✅ EXISTS
│   │   └── backtest-runner.ts        # Backtest orchestration ✅ EXISTS
│   ├── cli/
│   │   ├── index.ts                  # Main CLI entry ✅ EXISTS
│   │   ├── backtest.ts               # Backtest CLI ✅ EXISTS
│   │   ├── diagnose.ts               # Health check CLI ✅ EXISTS
│   │   └── paper-test.ts             # Paper trading test ✅ EXISTS
│   ├── config/
│   │   ├── loadConfig.ts             # YAML config loader ✅ EXISTS
│   │   └── secrets.ts                # Secret manager ✅ EXISTS
│   ├── core/
│   │   ├── clock.ts                  # Time sync ✅ EXISTS
│   │   ├── logger.ts                 # Winston logger ✅ EXISTS
│   │   ├── types.ts                  # Core types ✅ EXISTS
│   │   └── env.ts                    # Environment loader ✅ EXISTS
│   ├── exchanges/
│   │   └── coinbase/
│   │       ├── index.ts              # Coinbase client ✅ EXISTS
│   │       ├── rest-client.ts        # REST API ✅ EXISTS
│   │       ├── websocket.ts          # WebSocket client ✅ EXISTS
│   │       └── types.ts              # Coinbase types ✅ EXISTS
│   ├── indicators/
│   │   └── technical.ts              # ATR, VWAP, Donchian, ADX ✅ EXISTS
│   ├── io/
│   │   ├── csvWriter.ts              # CSV export ✅ EXISTS
│   │   ├── jsonlWriter.ts            # JSONL logs ✅ EXISTS
│   │   ├── logRotate.ts              # Log rotation ✅ EXISTS
│   │   └── snapshot.ts               # State snapshots ✅ EXISTS
│   ├── strategies/
│   │   └── signal-processor.ts       # Signal generation ⚠️ NEEDS IMPLEMENTATION
│   └── trading/
│       ├── trading-engine.ts         # Main engine ⚠️ NEEDS IMPLEMENTATION
│       ├── order-manager.ts          # Order lifecycle ⚠️ NEEDS IMPLEMENTATION
│       ├── position-tracker.ts       # Position tracking ⚠️ NEEDS IMPLEMENTATION
│       ├── risk-engine.ts            # Risk checks ⚠️ NEEDS IMPLEMENTATION
│       └── paper-trading-simulator.ts # Paper fills ⚠️ NEEDS IMPLEMENTATION
├── config/
│   ├── paper.local.yaml              # Paper trading config ✅ EXISTS
│   └── live.local.yaml               # Live trading config ✅ EXISTS
└── package.json                      # Dependencies ✅ EXISTS
```

### Component Responsibilities

**Trading Engine** (`trading-engine.ts`)
- Orchestrates all components
- Emits events: `engine:started`, `engine:stopped`, `ticker`, `orderbook`, `fill`, `position:opened`, `position:closed`, `risk:alert`
- Public API: `start()`, `stop()`, `createOrder()`, `cancelOrder()`, `emergencyStop()`

**Signal Processor** (`signal-processor.ts`)
- Subscribes to market data (ticker, orderbook)
- Calculates indicators (ATR, VWAP, Donchian, ADX)
- Generates signals from strategies (breakout, vwap_mr, obi)
- Runs ONNX model for meta-label filtering
- Emits: `signal:generated`

**Order Manager** (`order-manager.ts`)
- Manages order lifecycle: new → submitted → partial/filled → canceled/rejected
- Handles TWAP execution
- Tracks fills and slippage
- Emits: `order:submitted`, `order:filled`, `order:canceled`, `order:rejected`

**Position Tracker** (`position-tracker.ts`)
- Maintains open positions map
- Calculates unrealized/realized PnL (R and $)
- Tracks trades per position
- Emits: `position:opened`, `position:updated`, `position:closed`, `pnl:update`

**Risk Engine** (`risk-engine.ts`)
- Pre-trade checks: per-trade risk, heat cap, daily stop, correlation clamp
- Post-trade monitoring: spread percentile, ATR burst detection
- Kill-switch activation/deactivation
- Emits: `risk:alert`, `killswitch:activated`, `killswitch:cleared`

**Paper Trading Simulator** (`paper-trading-simulator.ts`)
- Simulates fills when mode='paper'
- Adds realistic slippage (1-5 bps)
- Emits: `fill` (same as live)

---

## API Endpoints to Implement

### Server Location
`atlas/apps/core-node/src/api/server.ts`

### Required Endpoints

#### Status Endpoints
```typescript
GET /health
Response: { ok: true, timestamp: ISO8601 }

GET /metrics
Response: Prometheus metrics (text format)

GET /api/status
Response: RuntimeStatus {
  mode: 'paper' | 'live';
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
    since: string | null;
  };
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: 'trend' | 'chop';
}
```

#### Engine Control
```typescript
POST /api/engine/start
Body: { mode: 'paper' | 'live' }
Response: { ok: true, message: string }

POST /api/engine/stop
Response: { ok: true, message: string }

POST /api/engine/kill
Response: { ok: true, message: string }
```

#### Runtime Control
```typescript
POST /api/control/pause
Response: { ok: true }

POST /api/control/resume
Response: { ok: true }

POST /api/control/close-all
Body: { reason: string, confirm: 'CLOSE ALL' }
Response: { ok: true, submitted: number }
```

#### Configuration
```typescript
POST /api/config/risk
Body: RiskConfig {
  perTradeBp: number;
  heatBp: number;
  dailyStopR: number;
  clampPct: number;
  timeStops: { [strategy]: number };
  spreadPctileMax: number;
  atrBurstMult: number;
}
Response: { ok: true }

POST /api/config/signals
Body: SignalsConfig {
  breakout: {
    enabled: boolean;
    adxMin: number;
    donchianN: number;
    atrPctileMin: number;
  };
  vwap_mr: {
    enabled: boolean;
    zAbsMin: number;
    adxMax: number;
  };
  meta: {
    enabled: boolean;
    threshold: number;
  };
}
Response: { ok: true }
```

### WebSocket Endpoint
```typescript
WS /events

Messages (Server → Client):
{
  type: 'StatusUpdate' | 'OrderUpdate' | 'Fill' | 'PositionUpdate' | 'RiskEvent' | 'Alert';
  payload: any;
}

Example:
{
  type: 'StatusUpdate',
  payload: { paused: true, dailyStopHit: false, ... }
}
```

---

## Trading Engine Implementation

### Core Loop

**File:** `atlas/apps/core-node/src/trading/trading-engine.ts`

```typescript
async start() {
  // 1. Initialize components
  this.exchange = await this.initializeExchange();
  this.orderManager = this.initializeOrderManager();
  this.positionTracker = this.initializePositionTracker();
  this.riskEngine = this.initializeRiskEngine();
  this.signalProcessor = this.initializeSignalProcessor();
  
  if (this.config.mode === 'paper') {
    this.paperSimulator = this.initializePaperSimulator();
  }
  
  // 2. Setup event handlers
  this.setupEventHandlers();
  
  // 3. Connect to exchange
  await this.exchange.connect();
  
  // 4. Subscribe to market data
  await this.exchange.subscribe({
    channels: ['ticker', 'level2'],
    symbols: this.config.symbols
  });
  
  // 5. Start update loops
  this.startStatusUpdateLoop(); // 1s interval
  this.startRiskMonitoringLoop(); // 5s interval
  
  this.emit('engine:started', { mode: this.config.mode });
}

private setupEventHandlers() {
  // Exchange → Signal Processor
  this.exchange.on('ticker', (ticker) => {
    this.signalProcessor.processTicker(ticker);
    this.emit('ticker', ticker);
  });
  
  this.exchange.on('orderbook', (book) => {
    this.signalProcessor.processOrderBook(book);
  });
  
  // Signal Processor → Order Manager
  this.signalProcessor.on('signal:generated', async (signal) => {
    await this.handleSignal(signal);
  });
  
  // Order Manager → Position Tracker
  this.orderManager.on('fill', async (fill) => {
    await this.positionTracker.processFill(fill);
    this.emit('fill', fill);
  });
  
  // Position Tracker → Risk Engine
  this.positionTracker.on('position:opened', (position) => {
    this.riskEngine.checkPositionRisk(position);
    this.emit('position:opened', position);
  });
  
  // Risk Engine → Trading Engine
  this.riskEngine.on('risk:alert', (alert) => {
    this.handleRiskAlert(alert);
  });
}

private async handleSignal(signal: Signal) {
  // 1. Check if paused
  if (this.paused) return;
  
  // 2. Check daily stop
  if (this.dailyStopHit) return;
  
  // 3. Check kill-switch
  if (this.killSwitch.active) return;
  
  // 4. Pre-trade risk check
  const riskCheck = await this.riskEngine.preTradeCheck(signal);
  if (!riskCheck.allowed) {
    await this.syncSignalToSupabase(signal, false, riskCheck.reason);
    return;
  }
  
  // 5. Calculate position size
  const size = this.riskEngine.calculatePositionSize(signal);
  
  // 6. Create order
  const order = await this.orderManager.createOrder({
    symbol: signal.symbol,
    side: signal.side,
    quantity: size,
    type: 'limit',
    price: signal.entryPrice,
    stopPrice: signal.stopPrice,
    takeProfitPrice: signal.takeProfitPrice,
    strategy: signal.strategy,
    signalId: signal.id
  });
  
  // 7. Sync to Supabase
  await this.syncOrderToSupabase(order);
  await this.syncSignalToSupabase(signal, true);
  
  this.emit('order:created', order);
}
```

### Signal Generation

**File:** `atlas/apps/core-node/src/strategies/signal-processor.ts`

```typescript
class SignalProcessor extends EventEmitter {
  private indicators: Map<string, IndicatorSet> = new Map();
  private onnxSession: InferenceSession | null = null;
  
  async initialize() {
    // Load ONNX model
    const modelPath = this.config.modelPath;
    this.onnxSession = await InferenceSession.create(modelPath);
  }
  
  processTicker(ticker: Ticker) {
    const { symbol, price, volume } = ticker;
    
    // Update indicator state
    const indicators = this.getOrCreateIndicators(symbol);
    indicators.addBar({ price, volume, timestamp: ticker.timestamp });
    
    // Check each strategy
    if (this.config.strategies.breakout.enabled) {
      this.checkBreakoutSignal(symbol, indicators);
    }
    
    if (this.config.strategies.vwap_mr.enabled) {
      this.checkVwapMeanReversionSignal(symbol, indicators);
    }
  }
  
  private checkBreakoutSignal(symbol: string, indicators: IndicatorSet) {
    const { adx, donchian, atr, atrPercentile } = indicators.current;
    const { adxMin, donchianN, atrPctileMin } = this.config.strategies.breakout;
    
    // Breakout conditions
    const isTrending = adx > adxMin;
    const isHighVolatility = atrPercentile > atrPctileMin;
    const isAboveUpperBand = indicators.price > donchian.upper;
    const isBelowLowerBand = indicators.price < donchian.lower;
    
    if (isTrending && isHighVolatility) {
      let side: 'long' | 'short' | null = null;
      
      if (isAboveUpperBand) side = 'long';
      if (isBelowLowerBand) side = 'short';
      
      if (side) {
        const signal = this.createSignal({
          symbol,
          side,
          strategy: 'breakout',
          score: adx * atrPercentile / 100,
          features: { adx, atrPercentile, donchian, atr }
        });
        
        this.applyMetaLabel(signal);
      }
    }
  }
  
  private async applyMetaLabel(signal: Signal) {
    if (!this.config.strategies.meta.enabled) {
      signal.metaProb = 1.0;
      signal.allowed = true;
      this.emit('signal:generated', signal);
      return;
    }
    
    // Prepare features for ONNX
    const features = this.prepareFeatures(signal);
    const inputTensor = new Tensor('float32', features, [1, features.length]);
    
    // Run inference
    const outputs = await this.onnxSession.run({ input: inputTensor });
    const prob = outputs.output.data[1]; // probability of class 1 (winner)
    
    signal.metaProb = prob;
    signal.allowed = prob >= this.config.strategies.meta.threshold;
    
    this.emit('signal:generated', signal);
  }
}
```

### Order Management

**File:** `atlas/apps/core-node/src/trading/order-manager.ts`

```typescript
class OrderManager extends EventEmitter {
  private orders: Map<string, Order> = new Map();
  
  async createOrder(params: CreateOrderParams): Promise<Order> {
    const order: Order = {
      id: randomUUID(),
      ...params,
      status: 'new',
      createdAt: new Date(),
      filledQty: 0,
      fills: []
    };
    
    this.orders.set(order.id, order);
    
    if (this.config.mode === 'live') {
      // Submit to exchange
      const exchangeOrder = await this.exchange.createOrder({
        symbol: order.symbol,
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        price: order.price,
        postOnly: true
      });
      
      order.externalOrderId = exchangeOrder.id;
      order.status = 'submitted';
    } else {
      // Paper mode: mark as submitted
      order.status = 'submitted';
    }
    
    this.emit('order:submitted', order);
    return order;
  }
  
  handleFill(fill: Fill) {
    const order = this.orders.get(fill.orderId);
    if (!order) return;
    
    order.fills.push(fill);
    order.filledQty += fill.quantity;
    
    if (order.filledQty >= order.quantity) {
      order.status = 'filled';
    } else {
      order.status = 'partial';
    }
    
    this.emit('fill', fill);
    this.emit('order:updated', order);
  }
}
```

### Position Tracking

**File:** `atlas/apps/core-node/src/trading/position-tracker.ts`

```typescript
class PositionTracker extends EventEmitter {
  private positions: Map<string, Position> = new Map();
  
  async processFill(fill: Fill) {
    const order = await this.getOrder(fill.orderId);
    const positionKey = `${order.symbol}-${order.strategy}`;
    
    let position = this.positions.get(positionKey);
    
    if (!position) {
      // Open new position
      position = {
        id: randomUUID(),
        symbol: order.symbol,
        side: order.side,
        strategy: order.strategy,
        qtyOpen: fill.quantity,
        entryPrice: fill.price,
        stopPriceAtEntry: order.stopPrice,
        takeProfitPrice: order.takeProfitPrice,
        openedAt: new Date(),
        trades: [fill]
      };
      
      this.positions.set(positionKey, position);
      this.emit('position:opened', position);
      
      await this.syncPositionToSupabase(position);
    } else {
      // Update existing position
      if (fill.side === position.side) {
        // Add to position
        position.qtyOpen += fill.quantity;
        position.entryPrice = this.calculateWeightedAverage(position, fill);
      } else {
        // Reduce/close position
        position.qtyOpen -= fill.quantity;
        position.realizedPnL = this.calculateRealizedPnL(position, fill);
        
        if (position.qtyOpen <= 0) {
          position.closedAt = new Date();
          position.exitPrice = fill.price;
          this.positions.delete(positionKey);
          this.emit('position:closed', position);
        }
      }
      
      position.trades.push(fill);
      this.emit('position:updated', position);
      
      await this.syncPositionToSupabase(position);
    }
  }
  
  updateMarketPrice(symbol: string, price: number) {
    for (const [key, position] of this.positions) {
      if (position.symbol === symbol) {
        position.unrealizedPnL = this.calculateUnrealizedPnL(position, price);
        position.unrealizedR = position.unrealizedPnL / this.calculateRisk(position);
        this.emit('pnl:update', position);
      }
    }
  }
}
```

### Risk Engine

**File:** `atlas/apps/core-node/src/trading/risk-engine.ts`

```typescript
class RiskEngine extends EventEmitter {
  private config: RiskConfig;
  private killSwitch: KillSwitch = { active: false, reasons: [] };
  
  async preTradeCheck(signal: Signal): Promise<RiskCheckResult> {
    // 1. Check per-trade risk
    const riskAmount = this.calculateRiskAmount(signal);
    if (riskAmount > this.config.perTradeBp * this.accountEquity / 10000) {
      return { allowed: false, reason: 'Exceeds per-trade risk limit' };
    }
    
    // 2. Check heat cap
    const currentHeat = this.calculateCurrentHeat();
    const newHeat = currentHeat + riskAmount;
    if (newHeat > this.config.heatBp * this.accountEquity / 10000) {
      return { allowed: false, reason: 'Exceeds heat cap' };
    }
    
    // 3. Check daily stop
    const dailyR = await this.getDailyR();
    if (dailyR <= -this.config.dailyStopR) {
      this.dailyStopHit = true;
      this.emit('risk:alert', {
        type: 'daily_stop_hit',
        severity: 'error',
        message: `Daily stop hit: ${dailyR.toFixed(2)}R`,
        value: dailyR,
        threshold: -this.config.dailyStopR
      });
      return { allowed: false, reason: 'Daily stop hit' };
    }
    
    // 4. Check correlation clamp (if multiple positions)
    const correlationRisk = this.calculateCorrelationRisk(signal);
    if (correlationRisk > this.config.clampPct / 100) {
      return { allowed: false, reason: 'Correlation limit exceeded' };
    }
    
    return { allowed: true };
  }
  
  checkKillSwitchConditions(ticker: Ticker, indicators: IndicatorSet) {
    const reasons: string[] = [];
    
    // Check spread percentile
    const spread = ticker.ask - ticker.bid;
    const spreadPctile = this.calculateSpreadPercentile(spread);
    if (spreadPctile > this.config.spreadPctileMax) {
      reasons.push(`Spread at ${spreadPctile}th percentile`);
    }
    
    // Check ATR burst
    const atrBurst = indicators.atr > indicators.atrMa * this.config.atrBurstMult;
    if (atrBurst) {
      reasons.push(`ATR burst: ${(indicators.atr / indicators.atrMa).toFixed(2)}x`);
    }
    
    // Check API latency
    if (this.wsLatency > 2000 || this.restLatency > 5000) {
      reasons.push(`High latency: WS=${this.wsLatency}ms REST=${this.restLatency}ms`);
    }
    
    if (reasons.length > 0 && !this.killSwitch.active) {
      this.activateKillSwitch(reasons);
    } else if (reasons.length === 0 && this.killSwitch.active) {
      this.deactivateKillSwitch();
    }
  }
  
  activateKillSwitch(reasons: string[]) {
    this.killSwitch = {
      active: true,
      reasons,
      since: new Date().toISOString()
    };
    
    this.emit('killswitch:activated', this.killSwitch);
    this.emit('risk:alert', {
      type: 'kill_switch',
      severity: 'error',
      message: `Kill-switch activated: ${reasons.join(', ')}`,
      value: this.killSwitch
    });
  }
}
```

---

## Supabase Integration

### Sync Functions

**Location:** `atlas/apps/core-node/src/api/server.ts`

```typescript
async function syncSignalToSupabase(signal: Signal) {
  const { error } = await supabase
    .from('signals')
    .insert({
      user_id: USER_ID,
      symbol: signal.symbol,
      side: signal.side,
      strategy: signal.strategy,
      score: signal.score,
      confidence: signal.confidence,
      meta_prob: signal.metaProb,
      allowed: signal.allowed,
      reason: signal.reason,
      features: signal.features,
      decided_at: signal.decidedAt
    });
  
  if (error) console.error('Error syncing signal:', error);
}

async function syncOrderToSupabase(order: Order) {
  const { error } = await supabase
    .from('orders')
    .insert({
      id: order.id,
      user_id: USER_ID,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: order.status,
      quantity: order.quantity,
      price: order.price,
      stop_price: order.stopPrice,
      external_order_id: order.externalOrderId,
      strategy: order.strategy,
      signal_id: order.signalId,
      meta_prob: order.metaProb,
      post_only: order.postOnly
    });
  
  if (error) console.error('Error syncing order:', error);
}

async function syncFillToSupabase(fill: Fill) {
  const { error } = await supabase
    .from('fills')
    .insert({
      user_id: USER_ID,
      order_id: fill.orderId,
      order_leg_id: fill.orderLegId,
      quantity: fill.quantity,
      price: fill.price,
      fee_amount: fill.feeAmount,
      fee_currency: fill.feeCurrency,
      maker: fill.maker,
      trade_id: fill.tradeId,
      filled_at: fill.filledAt,
      slippage_bps: fill.slippageBps
    });
  
  if (error) console.error('Error syncing fill:', error);
}

async function syncPositionToSupabase(position: Position) {
  const { error } = await supabase
    .from('positions')
    .upsert({
      id: position.id,
      user_id: USER_ID,
      symbol: position.symbol,
      side: position.side,
      strategy: position.strategy,
      qty_open: position.qtyOpen,
      entry_price: position.entryPrice,
      stop_price_at_entry: position.stopPriceAtEntry,
      take_profit_price: position.takeProfitPrice,
      opened_at: position.openedAt,
      closed_at: position.closedAt,
      exit_price: position.exitPrice,
      exit_reason: position.exitReason,
      realized_pnl_usd: position.realizedPnL,
      realized_r: position.realizedR
    });
  
  if (error) console.error('Error syncing position:', error);
}

async function syncRiskEventToSupabase(event: RiskEvent) {
  const { error } = await supabase
    .from('risk_events')
    .insert({
      user_id: USER_ID,
      event_type: event.type,
      details: event.details,
      active: event.active,
      triggered_at: event.triggeredAt,
      cleared_at: event.clearedAt
    });
  
  if (error) console.error('Error syncing risk event:', error);
}

async function syncAlertToSupabase(alert: Alert) {
  const { error } = await supabase
    .from('alerts')
    .insert({
      user_id: USER_ID,
      severity: alert.severity,
      title: alert.title,
      message: alert.message,
      data: alert.data
    });
  
  if (error) console.error('Error syncing alert:', error);
}

async function updateAccountMetrics() {
  const positions = Array.from(positionTracker.getPositions().values());
  const openPositions = positions.filter(p => !p.closedAt);
  
  const dailyPnlUsd = positions
    .filter(p => p.closedAt && isToday(p.closedAt))
    .reduce((sum, p) => sum + (p.realizedPnL || 0), 0);
  
  const dailyPnlR = positions
    .filter(p => p.closedAt && isToday(p.closedAt))
    .reduce((sum, p) => sum + (p.realizedR || 0), 0);
  
  const riskHeat = riskEngine.calculateCurrentHeat();
  
  const { error } = await supabase.rpc('upsert_account_metrics', {
    p_user_id: USER_ID,
    p_total_equity: accountEquity,
    p_daily_pnl: dailyPnlUsd,
    p_daily_pnl_r: dailyPnlR,
    p_risk_heat: riskHeat,
    p_spread_percentile: currentSpreadPctile,
    p_open_positions_count: openPositions.length,
    p_wins_today: positions.filter(p => p.closedAt && isToday(p.closedAt) && p.realizedR > 0).length,
    p_losses_today: positions.filter(p => p.closedAt && isToday(p.closedAt) && p.realizedR < 0).length
  });
  
  if (error) console.error('Error updating account metrics:', error);
}
```

### WebSocket Broadcasting

```typescript
function broadcastToClients(message: any) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  });
}

// Example usage
tradingEngine.on('ticker', (ticker) => {
  broadcastToClients({ type: 'StatusUpdate', payload: { lastTicker: ticker } });
});

tradingEngine.on('position:opened', (position) => {
  broadcastToClients({ type: 'PositionUpdate', payload: position });
  syncPositionToSupabase(position);
});

tradingEngine.on('risk:alert', (alert) => {
  broadcastToClients({ type: 'Alert', payload: alert });
  syncAlertToSupabase(alert);
});
```

---

## Data Contracts

### Supabase → Backend (Read)

```typescript
// Get risk settings
const { data: riskSettings } = await supabase
  .from('risk_settings')
  .select('*')
  .eq('user_id', USER_ID)
  .single();

// Get enabled strategies
const { data: strategies } = await supabase
  .from('strategy_signals')
  .select('*')
  .eq('user_id', USER_ID)
  .eq('enabled', true);

// Get active model
const { data: model } = await supabase
  .from('models')
  .select('*')
  .eq('user_id', USER_ID)
  .eq('active', true)
  .single();

// Get today's positions for daily R calculation
const { data: positions } = await supabase
  .from('positions')
  .select('realized_r')
  .eq('user_id', USER_ID)
  .gte('closed_at', new Date().toISOString().split('T')[0]);
```

### Backend → Supabase (Write)

All sync functions listed in "Supabase Integration" section.

### Backend → Frontend (WebSocket)

```typescript
// Status updates (1s interval)
{
  type: 'StatusUpdate',
  payload: {
    paused: boolean;
    dailyStopHit: boolean;
    killSwitch: { active, reasons, since };
    wsLatencyMs: number;
    restLatencyMs: number;
    spreadPctile: number;
    regime: 'trend' | 'chop';
  }
}

// Order updates
{
  type: 'OrderUpdate',
  payload: Order
}

// Fill updates
{
  type: 'Fill',
  payload: Fill
}

// Position updates
{
  type: 'PositionUpdate',
  payload: Position
}

// Risk alerts
{
  type: 'RiskEvent',
  payload: RiskAlert
}

// General alerts
{
  type: 'Alert',
  payload: Alert
}
```

---

## Testing Strategy

### Phase 1: Unit Tests (1 hour)
- Test indicator calculations (ATR, VWAP, Donchian, ADX)
- Test risk calculations (position size, heat, daily stop)
- Test signal generation logic (breakout, vwap_mr)

### Phase 2: Paper Trading (2-4 hours)
1. Start backend: `cd atlas/apps/core-node && npm run api`
2. Start frontend: `npm run dev` (from project root)
3. Open dashboard: `http://localhost:8080`
4. Click "Start Engine" → select "Paper Mode"
5. Verify:
   - ✅ WebSocket connects (green dot in header)
   - ✅ Ticker updates in chart
   - ✅ Signals appear in Supabase `signals` table
   - ✅ Orders created when signal allowed
   - ✅ Positions open/close correctly
   - ✅ PnL calculations match manual calculation
   - ✅ Kill-switch activates on spread spike
   - ✅ Daily stop blocks new entries
   - ✅ Pause/Resume works
   - ✅ Close All closes all positions

### Phase 3: Live Trading (Careful!)
1. Set `CONFIRM_LIVE=YES` in `.env`
2. Start with $10-$50 position sizes
3. Monitor for 1 hour before leaving unattended
4. Check:
   - ✅ Actual fills match paper fills (slippage < 10 bps)
   - ✅ Stop losses execute correctly
   - ✅ No double-fills or ghost orders

---

## Success Criteria

### Technical
- ✅ All API endpoints respond within 100ms
- ✅ WebSocket latency < 500ms
- ✅ Database writes < 200ms per operation
- ✅ No memory leaks (run 24h, check RSS)
- ✅ No zombie orders (all orders tracked in DB)

### Functional
- ✅ Signals generated match backtest signals (same price/features)
- ✅ Position sizing matches risk formula (1R = stop distance)
- ✅ Heat calculation correct (sum of all open R)
- ✅ Daily stop blocks entries when hit
- ✅ Kill-switch activates/clears automatically
- ✅ Pause/Resume works instantly
- ✅ Close All exits all positions

### Safety
- ✅ ConfirmGate prevents accidental Live mode activation
- ✅ Daily stop prevents runaway losses
- ✅ Kill-switch prevents trading in bad conditions
- ✅ Max heat prevents overexposure
- ✅ Correlation clamp prevents correlated bets

### UX
- ✅ Dashboard KPIs update within 2s
- ✅ Position details drawer shows complete info
- ✅ Alerts are actionable and not noisy
- ✅ Journal attachments upload successfully
- ✅ Backtest completes and exports report

---

## Implementation Checklist

### Step 1: Environment Setup
- [ ] Add `VITE_RUNTIME_API_URL=http://localhost:3001` to `.env`
- [ ] Generate fixed `USER_ID` UUID: `node -e "console.log(require('crypto').randomUUID())"`
- [ ] Add `USER_ID` constant to `server.ts`
- [ ] Run `cd atlas/apps/core-node && npm install`

### Step 2: API Server (`server.ts`)
- [ ] Fix `/api/status` response shape to match `RuntimeStatus`
- [ ] Implement `/api/control/pause`
- [ ] Implement `/api/control/resume`
- [ ] Implement `/api/control/close-all`
- [ ] Implement `/api/config/risk`
- [ ] Implement `/api/config/signals`
- [ ] Add WebSocket broadcasting for all events
- [ ] Add Supabase sync functions (signals, orders, fills, positions, risk_events, alerts)

### Step 3: Trading Engine (`trading-engine.ts`)
- [ ] Complete `start()` method
- [ ] Complete `stop()` method
- [ ] Implement `setupEventHandlers()`
- [ ] Implement `handleSignal(signal)`
- [ ] Implement `handleTicker(ticker)`
- [ ] Implement `handleFill(fill)`
- [ ] Add status update loop (1s interval)
- [ ] Add risk monitoring loop (5s interval)

### Step 4: Signal Processor (`signal-processor.ts`)
- [ ] Implement `processTicker(ticker)`
- [ ] Implement `processOrderBook(book)`
- [ ] Implement `checkBreakoutSignal()`
- [ ] Implement `checkVwapMeanReversionSignal()`
- [ ] Implement `applyMetaLabel()` with ONNX inference
- [ ] Load ONNX model from `var/models/`

### Step 5: Order Manager (`order-manager.ts`)
- [ ] Implement `createOrder()`
- [ ] Implement `cancelOrder()`
- [ ] Implement `handleFill()`
- [ ] Add TWAP execution logic (if needed)
- [ ] Add order state machine (new → submitted → filled)

### Step 6: Position Tracker (`position-tracker.ts`)
- [ ] Implement `processFill()`
- [ ] Implement `updateMarketPrice()`
- [ ] Implement `calculateUnrealizedPnL()`
- [ ] Implement `calculateRealizedPnL()`
- [ ] Implement `getPortfolioSummary()`

### Step 7: Risk Engine (`risk-engine.ts`)
- [ ] Implement `preTradeCheck()`
- [ ] Implement `calculatePositionSize()`
- [ ] Implement `calculateCurrentHeat()`
- [ ] Implement `checkKillSwitchConditions()`
- [ ] Implement `activateKillSwitch()` / `deactivateKillSwitch()`
- [ ] Load risk config from Supabase on startup

### Step 8: Paper Trading Simulator (`paper-trading-simulator.ts`)
- [ ] Implement `simulateFill()` with realistic latency (50-200ms)
- [ ] Add slippage model (1-5 bps)
- [ ] Emit `fill` events

### Step 9: Testing
- [ ] Run unit tests for indicators
- [ ] Start backend and frontend
- [ ] Test paper trading for 1 hour
- [ ] Verify Supabase tables populate correctly
- [ ] Test all controls (Pause, Resume, Close All)
- [ ] Test kill-switch activation
- [ ] Test daily stop blocking

### Step 10: Documentation
- [ ] Update README with startup instructions
- [ ] Document environment variables
- [ ] Add troubleshooting guide
- [ ] Create deployment guide (if needed)

---

## Notes from Lovable Chat History

### Phase 1-8 Completion Summary
- **Phase 1:** Base architecture (routing, design system, Supabase schema)
- **Phase 2:** Dashboard screen (KPIs, controls, chart, panels)
- **Phase 3:** Orders/Positions screen (blotter, details drawer)
- **Phase 4:** Signals screen (strategy cards, thresholds)
- **Phase 5:** Risk screen (settings, kill-switch tile)
- **Phase 6:** Model screen (ONNX info, calibration chart)
- **Phase 7:** Backtest/Journal/Alerts/Settings screens
- **Phase 8:** UI polish (connection status, stale data warnings, debouncing)

### Key Decisions Made
1. **Single-user mode for MVP** - Hardcode `user_id` instead of full auth system
2. **Paper trading first** - Test all logic before live trading
3. **Realtime subscriptions** - Use Supabase Realtime for orders/fills/positions
4. **WebSocket for ephemeral state** - Use WebSocket for paused/kill-switch/regime
5. **ONNX for meta-labeling** - Use pre-trained model for signal filtering
6. **No backtest persistence** - Keep backtest results in memory/export only
7. **Journal attachments in Storage** - Use Supabase Storage for file uploads

### Authentication Context
- **Current state:** No authentication, RLS uses `true` (allow all)
- **Why:** Faster MVP, single trader only
- **Future:** Can add Supabase Auth later if multi-user needed
- **Impact:** Must use fixed `user_id` in all backend writes

### Supabase Linter Warnings
- 4 ERROR: Views with `SECURITY DEFINER` - functional but not best practice
- 1 WARN: `touch_updated_at()` missing `search_path` - functional but not best practice
- **Decision:** Leave as-is for MVP, fix in Phase 9 (production hardening)

### Custom Knowledge Applied
- **Risk-first design:** R-multiples displayed everywhere
- **ConfirmGate pattern:** All dangerous actions require type-to-confirm
- **Trader ergonomics:** Dark theme, high contrast, compact density
- **Progressive disclosure:** Drawers for details, not modal spam
- **Performance budgets:** Table virtualization, debouncing, 2s polling max

---

## Additional Resources

### Documentation Links
- Supabase Realtime: https://supabase.com/docs/guides/realtime
- Coinbase Advanced Trade API: https://docs.cloud.coinbase.com/advanced-trade-api/docs
- ONNX Runtime Node: https://onnxruntime.ai/docs/get-started/with-javascript.html
- Express WebSocket: https://www.npmjs.com/package/ws
- Prometheus Node Client: https://www.npmjs.com/package/prom-client

### Supabase Dashboard Links
- Tables: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/editor
- SQL Editor: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/sql/new
- Storage: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/storage/buckets
- Secrets: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/settings/vault/secrets

### Example Queries
```sql
-- Get today's daily R
SELECT SUM(realized_r) as daily_r
FROM positions
WHERE user_id = 'YOUR_USER_ID'
  AND closed_at::date = CURRENT_DATE;

-- Get open positions summary
SELECT * FROM v_open_positions
WHERE user_id = 'YOUR_USER_ID';

-- Get recent signals
SELECT * FROM signals
WHERE user_id = 'YOUR_USER_ID'
ORDER BY decided_at DESC
LIMIT 50;

-- Get risk events in last hour
SELECT * FROM risk_events
WHERE user_id = 'YOUR_USER_ID'
  AND triggered_at > NOW() - INTERVAL '1 hour'
ORDER BY triggered_at DESC;
```

---

## Troubleshooting

### WebSocket Won't Connect
- Check `VITE_RUNTIME_API_URL` in `.env`
- Verify backend is running on port 3001
- Check browser console for CORS errors
- Verify firewall allows WebSocket connections

### Orders Not Appearing in Supabase
- Check `USER_ID` matches across all inserts
- Verify RLS policies allow writes (should use `true` for MVP)
- Check backend logs for Supabase errors
- Verify `SUPABASE_SERVICE_KEY` is set correctly

### Position PnL Incorrect
- Verify `calculateRealizedPnL()` uses correct formula: `(exitPrice - entryPrice) * quantity * side`
- Check R calculation uses stop distance: `riskAmount / (entryPrice - stopPrice)`
- Verify `updateMarketPrice()` is called on every ticker

### Kill-Switch Not Activating
- Check spread calculation: `spreadPctile = percentile(spread, spreadsLast100)`
- Verify ATR burst threshold: `atr > atrMa * atrBurstMult`
- Check latency thresholds: `wsLatency < 2000ms`, `restLatency < 5000ms`
- Ensure `checkKillSwitchConditions()` runs every 5s

### ONNX Model Fails to Load
- Verify model path: `var/models/meta_label_v1.onnx`
- Check model format: must be ONNX (not PyTorch/TensorFlow)
- Verify input shape matches `prepareFeatures()` output
- Check ONNX Runtime version compatibility

---

## Final Checklist Before Production

- [ ] Change `CONFIRM_LIVE` to `NO` in `.env`
- [ ] Set conservative risk limits (0.5% per trade, 2% heat, 1.5R daily stop)
- [ ] Test kill-switch with simulated spread spike
- [ ] Test daily stop with simulated losses
- [ ] Run paper trading for 3+ days
- [ ] Verify no memory leaks (monitor RSS)
- [ ] Set up alerts for crashes/errors
- [ ] Document restart procedure
- [ ] Create backup/restore scripts
- [ ] Set up monitoring (Prometheus + Grafana)

---

**End of Document**

This guide is comprehensive and ready for Cursor AI to implement the backend. All critical decisions, data contracts, and implementation steps are documented. Good luck! 🚀
