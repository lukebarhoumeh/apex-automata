# AtlasBot v2 - Cursor Development Handoff

**Date:** October 16, 2025  
**From:** Lovable (UI/UX Complete)  
**To:** Cursor (Backend Development)

---

## 🎯 What's Complete (Lovable Phase)

### ✅ Full UI/UX Implementation
All 8 core screens are built and ready:

1. **Dashboard** (`src/pages/Index.tsx`)
   - Real-time metrics grid (equity, P&L, risk heat, spread percentile)
   - Live chart with ticker integration (ready for real data)
   - Market conditions panel (regime, spread, ATR)
   - Positions panel with details drawer
   - Orders blotter
   - System health monitoring
   - Risk controls & strategies panels
   - Alerts feed

2. **Orders** (`src/pages/Orders.tsx`)
   - Full order blotter with filtering
   - Order details drawer
   - CSV export capability
   - Real-time updates via Supabase

3. **Signals** (`src/pages/Signals.tsx`)
   - Strategy configuration with threshold sliders
   - Meta-model probability threshold
   - Signal acceptance stats (last 7 days)
   - Impact preview functionality

4. **Risk** (`src/pages/Risk.tsx`)
   - Per-trade risk settings (bps)
   - Heat cap management
   - Daily stop (R-multiples)
   - Spread & ATR thresholds
   - Kill-switch configuration
   - Live preview of risk calculations

5. **Model** (`src/pages/Model.tsx`)
   - ONNX model metadata display
   - Calibration chart (ROC curve)
   - Threshold adjustment with acceptance stats
   - Recent signal performance metrics

6. **Backtest** (`src/pages/Backtest.tsx`)
   - Date range & symbol selection
   - Strategy configuration
   - Run backtest with progress tracking
   - Results display (equity curve, KPIs)
   - Export to CSV/Markdown

7. **Journal** (`src/pages/Journal.tsx`)
   - Trade notes with rich text editor
   - File attachments (storage configured)
   - Search & filter by date
   - CRUD operations on entries

8. **Alerts** (`src/pages/Alerts.tsx`)
   - Real-time alert stream
   - Severity filtering
   - Acknowledgement tracking

### ✅ Infrastructure Complete

#### Supabase Database (100% Ready)
- **All tables created and optimized:**
  - `orders`, `order_legs`, `fills` (with foreign keys)
  - `positions`, `signals`, `strategies`
  - `risk_events`, `risk_settings`
  - `account_metrics` (with composite unique constraint)
  - `bot_states`, `profiles`, `user_roles`
  - `journal_entries`, `models`, `strategy_signals`
  - `alerts`, `symbols`, `metrics_intraday`
  - Views: `v_daily_r`, `v_open_positions`, `v_recent_activity`, `v_signal_funnel`

- **Performance indexes added** on:
  - User + timestamp queries
  - Status filters (open orders/positions)
  - Symbol & strategy lookups
  - Active risk events

- **Realtime enabled** on critical tables:
  - `orders`, `order_legs`, `fills`
  - `positions`, `signals`, `alerts`
  - `risk_events`, `account_metrics`

- **Triggers configured:**
  - `updated_at` auto-update on all relevant tables
  - `handle_new_user()` for user onboarding

- **Storage bucket created:**
  - `journal-attachments` (10MB limit, restricted to user folders)

- **Helper functions:**
  - `upsert_account_metrics()` for backend to push daily stats

#### API Integration Layer
- **Runtime Client** (`src/services/runtimeClient.ts`)
  - GET `/api/status` - engine status
  - GET `/api/positions/open` - fast position snapshot
  - POST `/api/control/*` - pause/resume/close-all/kill
  - POST `/api/config/risk` - risk settings
  - POST `/api/config/signals` - signal thresholds

- **Trading API** (`src/services/tradingApi.ts`)
  - WebSocket event system ready
  - Connection management with auto-reconnect
  - Event types: ticker, signal, order, position, risk alert

- **React Query Hooks** (all in `src/hooks/`)
  - `useRuntimeStatus()` - polls every 2s
  - `usePositions()` - Supabase + realtime
  - `useAccountMetrics()` - daily metrics
  - `useRiskSettings()` - CRUD for risk config
  - `useModelData()` - ONNX model + calibration
  - `useBacktest()` - backtest execution
  - `useJournal()` - journal CRUD + attachments
  - `useTradingEngine()` - WebSocket state management

#### UI Components (Design System)
- **All shadcn/ui components** configured with semantic tokens
- **Custom components:**
  - `StaleDataWarning` - alerts when data >15s old
  - `ConnectionStatusBanner` - WebSocket status
  - `MetricsGrid` - KPI tiles with R/$
  - `PositionDetailsDrawer` - full trade context
  - `CloseAllDialog` - ConfirmGate pattern
  - `CalibrationChart` - ROC/PR curves
  - etc.

- **Design tokens** (`src/index.css`, `tailwind.config.ts`)
  - HSL semantic colors (primary, success, danger, warning)
  - Monospace for numbers (tabular-lining)
  - Animations (fade-in, pulse-glow, card-glow)

---

## 🚧 What Needs to Be Built (Cursor Phase)

### Backend Runtime (`atlas/apps/core-node/`)

**Your existing files are a great starting point. Focus on:**

#### 1. Trading Engine (`src/trading/trading-engine.ts`)
- **Core loop:**
  - Subscribe to WebSocket market data (Coinbase)
  - Feed bars to indicators (`src/indicators/technical.ts`)
  - Run signal processor (`src/strategies/signal-processor.ts`)
  - Execute orders via order manager (`src/trading/order-manager.ts`)
  - Track positions (`src/trading/position-tracker.ts`)
  - Enforce risk (`src/trading/risk-engine.ts`)

- **Sync to Supabase:**
  - Every signal → `signals` table
  - Every order → `orders` + `order_legs`
  - Every fill → `fills`
  - Every position update → `positions`
  - Risk violations → `risk_events`
  - General alerts → `alerts`

- **Broadcast via WebSocket:**
  - Send events to UI clients (`/events` endpoint)
  - Status updates every 1-2s

#### 2. Signal Generation
- **Strategy implementations:**
  - Breakout+Vol (Donchian + ADX + ATR percentile)
  - VWAP Mean Reversion (Z-score + ADX)
  - OBI (later phase)

- **Meta-model integration:**
  - Load ONNX model from `var/models/`
  - Extract features from bars
  - Score signals with calibrated probability
  - Filter by threshold from `strategy_signals` table

#### 3. Risk Engine (`src/trading/risk-engine.ts`)
- **Pre-trade checks:**
  - Daily stop hit? (check `v_daily_r` for today)
  - Heat cap exceeded? (sum open position risk)
  - Position size calculation (ATR-based, clamped by `risk_settings`)
  - Correlation clamp (optional: check other open positions)

- **Intra-trade monitoring:**
  - Spread percentile > threshold? → kill-switch
  - ATR burst detection (3x average)
  - Time stops per strategy
  - Trail stops (if configured)

- **Write to DB:**
  - `risk_events` with `active=true` when triggered
  - Update `account_metrics` every 5-10 minutes
  - Clear risk events when resolved (`active=false`)

#### 4. Order Manager (`src/trading/order-manager.ts`)
- **Order execution:**
  - POST to Coinbase API
  - Create `orders` + `order_legs` in Supabase
  - Handle partial fills (update `order_legs`, create `fills`)
  - Post-only logic (reduce adverse selection)
  - TWAP splits for large orders (optional)

- **Order lifecycle:**
  - Poll for status updates (or use WebSocket fills)
  - Update `orders.status` (new → open → filled/cancelled)
  - Calculate slippage (expected vs actual price)
  - Emit events to UI

#### 5. Position Tracker (`src/trading/position-tracker.ts`)
- **Position management:**
  - Open position on first fill → `positions` row
  - Update `qty_open`, `realized_pnl_usd`, `realized_r` on partials
  - Close position when `qty_open = 0`
  - Track exit reason (stop, target, manual, time, kill)

- **Mark-to-market:**
  - Update UPL for UI (not persisted, just in memory)
  - Broadcast position updates via WebSocket

#### 6. Backtesting (`src/backtesting/backtest-engine.ts`)
- **Replay historical bars** (from CSV or Coinbase API)
- Run same signal logic as live
- Simulate fills (conservative: assume midpoint or worse)
- Track equity curve, drawdown, Sharpe
- Output:
  - JSON with KPIs (win rate, avg R, max DD, Sharpe, Sortino)
  - CSV of trades
  - Markdown report

- **Store results** (optional: `backtest_results` table or just files)

#### 7. API Server (`src/api/server.ts`)
- **Express endpoints** (you have this):
  - `GET /api/status` → current engine state
  - `POST /api/engine/start` → start trading loop
  - `POST /api/engine/stop` → graceful shutdown
  - `POST /api/engine/kill` → emergency stop
  - `POST /api/control/pause` → pause new entries
  - `POST /api/control/resume`
  - `POST /api/control/close-all` → market exit all
  - `POST /api/config/risk` → update `risk_settings`
  - `POST /api/config/signals` → update `strategy_signals`

- **WebSocket** (`/events`):
  - Push all events (ticker, signal, order, fill, position, risk, alert)
  - Handle client subscriptions

#### 8. Configuration (`config/paper.local.yaml`, `config/live.local.yaml`)
- **Secrets:**
  - `COINBASE_API_KEY` (already in Supabase secrets)
  - `COINBASE_API_SECRET` (already in Supabase secrets)
  - `SUPABASE_URL` (already in Supabase secrets)
  - `SUPABASE_SERVICE_ROLE_KEY` (already in Supabase secrets)

- **Runtime config:**
  - `mode: paper | live`
  - `symbols: [BTC-USD]`
  - `strategies: [breakout_vol, vwap_mr]`
  - `timeframe: 5m`
  - `risk: {...}` (or load from DB)

---

## 📋 Integration Checklist

### Backend → Supabase
- [ ] Connect to Supabase with service role key
- [ ] Insert rows on every signal, order, fill, position event
- [ ] Call `upsert_account_metrics()` function to update daily stats
- [ ] Create `risk_events` when kill-switch triggers
- [ ] Create `alerts` for important events (order rejected, fill, risk violation)
- [ ] Read `risk_settings`, `strategy_signals`, `models` for config
- [ ] Write to `bot_states` when mode changes (paper ↔ live)

### Backend → UI (WebSocket)
- [ ] Broadcast `StatusUpdate` every 1-2s
- [ ] Broadcast `OrderUpdate` on every order status change
- [ ] Broadcast `Fill` on every fill
- [ ] Broadcast `PositionUpdate` on position changes
- [ ] Broadcast `RiskEvent` when kill-switch/daily-stop hit
- [ ] Broadcast `Alert` for all alerts
- [ ] Broadcast `Ticker` for live price (debounced)

### Backend → Coinbase
- [ ] WebSocket: subscribe to ticker + level2 (orderbook)
- [ ] REST: create orders, cancel orders, get fills
- [ ] Handle rate limits (429 errors, retry-after)
- [ ] Reconnect logic with exponential backoff

### Testing
- [ ] Run in paper mode first (no real orders)
- [ ] Verify Supabase writes (check tables in Supabase dashboard)
- [ ] Verify UI updates in real-time (watch WebSocket events in browser console)
- [ ] Test kill-switch (spread spike or manual trigger)
- [ ] Test daily stop (mock losing trades)
- [ ] Test backtest (historical data from CSV)

---

## 🗂️ File Structure Reference

```
atlas/
├── apps/core-node/
│   ├── src/
│   │   ├── api/
│   │   │   └── server.ts          ← Express + WebSocket server
│   │   ├── backtesting/
│   │   │   ├── backtest-engine.ts ← Replay historical bars
│   │   │   └── backtest-runner.ts ← CLI runner
│   │   ├── cli/
│   │   │   ├── index.ts           ← CLI entry
│   │   │   ├── paper-test.ts
│   │   │   └── backtest.ts
│   │   ├── config/
│   │   │   ├── loadConfig.ts      ← YAML config loader
│   │   │   └── secrets.ts         ← Env var loader
│   │   ├── core/
│   │   │   ├── clock.ts           ← Time helpers
│   │   │   ├── env.ts             ← Environment detection
│   │   │   ├── logger.ts          ← Winston logger
│   │   │   └── types.ts           ← Core TypeScript types
│   │   ├── exchanges/
│   │   │   └── coinbase/
│   │   │       ├── index.ts       ← Main exchange client
│   │   │       ├── rest-client.ts ← REST API wrapper
│   │   │       ├── websocket.ts   ← WebSocket client
│   │   │       └── types.ts       ← Coinbase-specific types
│   │   ├── indicators/
│   │   │   └── technical.ts       ← ATR, VWAP, Donchian, ADX, etc.
│   │   ├── io/
│   │   │   ├── csvWriter.ts       ← CSV export
│   │   │   ├── jsonlWriter.ts     ← JSONL logs
│   │   │   ├── logRotate.ts       ← Log rotation
│   │   │   └── snapshot.ts        ← State snapshots
│   │   ├── strategies/
│   │   │   └── signal-processor.ts ← Strategy logic + meta-model
│   │   └── trading/
│   │       ├── trading-engine.ts   ← Main trading loop ← YOU BUILD THIS
│   │       ├── order-manager.ts    ← Order execution
│   │       ├── position-tracker.ts ← Position lifecycle
│   │       ├── risk-engine.ts      ← Pre/intra-trade risk
│   │       └── paper-trading-simulator.ts ← Paper mode fills
│   ├── package.json
│   └── tsconfig.json
├── config/
│   ├── paper.local.yaml     ← Paper trading config (copy from .example)
│   └── live.local.yaml      ← Live trading config (copy from .example)
└── var/
    ├── bars/                ← Historical bar CSVs
    ├── models/              ← ONNX model files (.onnx)
    └── state/               ← Runtime state snapshots

src/                         ← Lovable UI (DONE)
├── components/
│   ├── dashboard/           ← All dashboard components
│   └── ui/                  ← shadcn components
├── hooks/                   ← React Query + custom hooks
├── pages/                   ← All screens (Index, Orders, Signals, etc.)
└── services/
    ├── runtimeClient.ts     ← Calls your Node API
    └── tradingApi.ts        ← WebSocket event system
```

---

## 🔗 Quick Links (Supabase Dashboard)

- **Tables:** https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/editor
- **Storage:** https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/storage/buckets
- **SQL Editor:** https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/sql/new
- **Database Functions:** https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/database/functions
- **API Logs:** https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/logs/edge-logs

---

## 🧪 Testing Strategy

1. **Start with Paper Mode:**
   ```bash
   cd atlas/apps/core-node
   pnpm install
   pnpm run cli paper-test
   ```

2. **Verify Supabase Writes:**
   - Check `signals` table for new rows
   - Check `orders` table after signal generated
   - Check `account_metrics` updates

3. **Connect UI:**
   - Start Node API: `pnpm run start` (or your server command)
   - UI polls `/api/status` every 2s
   - WebSocket events flow to UI hooks

4. **Run Backtest:**
   ```bash
   pnpm run cli backtest --start 2024-01-01 --end 2024-01-31
   ```
   - Verify CSV output in `var/state/`
   - Check KPIs match expectations

5. **Live Mode (CAREFUL!):**
   - Set `mode: live` in `config/live.local.yaml`
   - Start with **TINY** position sizes
   - Monitor `orders` table in Supabase real-time
   - Have kill-switch ready (UI button or API call)

---

## 🎯 Success Criteria

Your backend is ready when:

- [ ] UI shows **LIVE** badge when backend connected
- [ ] Dashboard metrics update every 2s from backend
- [ ] Chart shows live ticker data
- [ ] Positions panel reflects open trades from DB
- [ ] Orders blotter shows order status changes in real-time
- [ ] Risk controls respect heat cap and daily stop
- [ ] Kill-switch triggers on spread spike
- [ ] Backtest produces valid equity curve + trade CSV
- [ ] Paper trading simulates fills without real money
- [ ] Live trading places real orders (at your discretion)

---

## 🚀 Next Steps in Cursor

1. **Set up environment:**
   ```bash
   cd atlas/apps/core-node
   cp ../../config/paper.local.yaml.example ../../config/paper.local.yaml
   # Add Coinbase keys + Supabase URL/key to paper.local.yaml
   pnpm install
   ```

2. **Build `trading-engine.ts`:**
   - Start with skeleton loop
   - Add Coinbase WebSocket subscription
   - Feed bars to indicators
   - Run signal processor
   - Log everything to console first

3. **Wire up Supabase:**
   - Create Supabase client with service role key
   - Insert test signal row
   - Verify in Supabase dashboard

4. **Add WebSocket broadcast:**
   - Emit `StatusUpdate` every 2s
   - Emit `Ticker` on price update
   - Test UI connection

5. **Implement order execution:**
   - POST to Coinbase (paper mode: simulate)
   - Create `orders` + `order_legs`
   - Handle fills

6. **Polish:**
   - Add risk checks
   - Add backtest support
   - Add error handling + logging

---

## 📞 Support

- **Lovable Docs:** https://docs.lovable.dev/
- **Supabase Docs:** https://supabase.com/docs
- **Coinbase API:** https://docs.cloud.coinbase.com/exchange/docs
- **ONNX Runtime:** https://onnxruntime.ai/docs/

---

**You're all set!** The UI is production-ready. Focus on building a solid, safe backend in Cursor. Start with paper trading, test extensively, and only go live when you're confident. Good luck! 🚀
