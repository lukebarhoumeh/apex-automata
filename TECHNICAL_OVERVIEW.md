# AtlasBot Trading System - Technical Overview

## Executive Summary

AtlasBot is a fully automated cryptocurrency trading system built with Node.js/TypeScript backend and React frontend. The system trades on Coinbase Exchange using multiple strategies (breakout, momentum, mean reversion) with comprehensive risk management, real-time monitoring, and paper trading capabilities.

**Current Status**: Phase 2 complete - Production-ready engine with advanced features, risk guardrails, and monitoring.

---

## System Architecture

### High-Level Flow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Frontend  │◄───►│  API Server  │◄───►│  Supabase   │
│   (React)   │ WS  │  (Express)   │     │  (Postgres) │
└─────────────┘     └──────────────┘     └─────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │Trading Engine │
                    └──────────────┘
                            │
        ┌───────────────────┼───────────────────┐
        ▼                   ▼                   ▼
┌──────────────┐   ┌──────────────┐   ┌──────────────┐
│   Exchange   │   │Signal Processor│   │ Risk Engine │
│  (Coinbase)  │   │  (Strategies)  │   │  (Guardrails)│
└──────────────┘   └──────────────┘   └──────────────┘
```

### Core Components

1. **API Server** (`src/api/server.ts`)
   - Express.js HTTP server on port 3001
   - WebSocket server for real-time updates
   - REST endpoints for engine control
   - Prometheus metrics endpoint

2. **Trading Engine** (`src/trading/trading-engine.ts`)
   - Central orchestrator
   - Manages exchange connection, order execution, position tracking
   - Coordinates all subsystems

3. **Signal Processor** (`src/strategies/signal-processor.ts`)
   - Aggregates 1-minute candles from ticker data
   - Calculates technical indicators (RSI, MACD, ATR, Donchian channels)
   - Generates trading signals from multiple strategies
   - Multi-timeframe analysis (5m, 15m, 1h)

4. **Risk Engine** (`src/trading/risk-engine.ts`)
   - Enforces guardrails (daily loss limits, drawdown, position size)
   - Per-symbol risk limits
   - Kill switch management
   - Persists risk state to database

5. **Position Tracker** (`src/trading/position-tracker.ts`)
   - Tracks open positions
   - Calculates P&L (realized/unrealized)
   - Risk limit checks per position

6. **Position Monitor** (`src/trading/position-monitor.ts`)
   - Monitors positions for exit conditions
   - Stop-loss, take-profit, time-stop execution
   - Trailing stop management

7. **Order Manager** (`src/trading/order-manager.ts`)
   - Manages order lifecycle
   - Handles fills, partial fills
   - Order state machine

8. **Paper Trading Simulator** (`src/trading/paper-trading-simulator.ts`)
   - Simulates order execution in paper mode
   - Depth-aware price impact
   - TWAP simulation for large orders
   - Realistic slippage and fees

9. **Exchange Integration** (`src/exchanges/coinbase/`)
   - REST client for account/order management
   - WebSocket client for real-time market data
   - Supports both legacy Exchange API and Advanced Trade API

---

## Trading Flow

### 1. Engine Startup Sequence

```
1. Load & validate environment variables
2. Validate database schema (tables, RPCs)
3. Initialize TradingEngine with config
4. Connect to Coinbase Exchange (REST + WebSocket)
5. Validate products (BTC-USD, ETH-USD, SOL-USD)
6. Subscribe to market data (ticker, orderbook)
7. Load historical data for warmup (200 candles per symbol)
8. Signal processor warms up indicators (50+ candles required)
9. Start data gap monitor (60s grace period)
10. Engine ready - begin live trading
```

### 2. Market Data Processing

```
Ticker Update (WebSocket)
    ↓
Aggregate to 1-minute candles
    ↓
Feed to Signal Processor
    ↓
Update indicators (RSI, MACD, ATR, etc.)
    ↓
Check for trading signals
    ↓
Apply multi-timeframe filter
    ↓
Meta-labeling (optional ML filter)
    ↓
Generate Signal event
```

### 3. Signal to Trade Execution

```
Signal Generated
    ↓
Risk Engine Check:
  - Kill switch active? → Reject
  - Daily loss limit hit? → Reject
  - Symbol blocked? → Reject
  - Position size within limits? → Continue
    ↓
Calculate position size (Kelly Criterion)
    ↓
Create order via Order Manager
    ↓
Order placed on exchange (or paper simulator)
    ↓
Fill received
    ↓
Position Tracker updates
    ↓
Position Monitor starts tracking exit conditions
```

### 4. Position Management

```
Position Opened
    ↓
Position Monitor registers:
  - Stop-loss price
  - Take-profit price
  - Time-stop (bars in trade)
  - Trailing stop (if enabled)
    ↓
On each ticker update:
  - Update position P&L
  - Check exit conditions
  - Update trailing stop
    ↓
Exit condition met:
  - Place market order to close
  - Position closed
  - Realized P&L calculated
```

### 5. Risk Monitoring

```
Continuous Monitoring:
  - Daily P&L tracking
  - Drawdown calculation
  - Per-symbol loss limits
  - Data gap detection
  - WebSocket reconnection storms
    ↓
Risk threshold breached:
  - Kill switch activated
  - All positions flattened
  - Trading halted
  - Alert sent (Telegram/Slack/Email)
```

---

## API Endpoints

### REST Endpoints

**Base URL**: `http://localhost:3001`

#### `GET /api/status`
Returns current engine status.

**Response**:
```json
{
  "mode": "paper" | "live",
  "paused": false,
  "dailyStopHit": false,
  "killSwitch": {
    "active": false,
    "reasons": [],
    "since": null
  },
  "wsLatencyMs": 45,
  "restLatencyMs": 120,
  "spreadPctile": 75,
  "regime": "trend" | "chop",
  "risk": {
    "exposureUsd": 5000,
    "dailyPnLUsd": 150.50,
    "maxDrawdownPct": 2.5,
    "killSwitchActive": false
  },
  "activeSymbols": ["BTC-USD", "ETH-USD", "SOL-USD"],
  "warmupComplete": true,
  "candlesBuffered": {
    "BTC-USD": 200,
    "ETH-USD": 200,
    "SOL-USD": 200
  }
}
```

#### `POST /api/engine/start`
Starts the trading engine.

**Request Body**:
```json
{
  "mode": "paper" | "live"
}
```

**Response**: `200 OK` or `400 Bad Request` with error message

#### `POST /api/engine/stop`
Stops the trading engine gracefully (closes positions first).

**Response**: `200 OK`

#### `POST /api/engine/kill`
Immediately activates kill switch and stops engine.

**Response**: `200 OK`

#### `GET /metrics`
Prometheus metrics endpoint (for Grafana).

#### `GET /health`
Health check endpoint.

---

## WebSocket Events

**Connection**: `ws://localhost:3001/events`

### Event Types

All events follow this structure:
```json
{
  "type": "EventType",
  "payload": { ... }
}
```

### 1. StatusUpdate
Sent on connection and periodically (every 15s).

```json
{
  "type": "StatusUpdate",
  "payload": {
    "mode": "paper",
    "paused": false,
    "killSwitch": { "active": false, "reasons": [], "since": null },
    "wsLatencyMs": 45,
    "restLatencyMs": 120,
    "spreadPctile": 75,
    "regime": "trend",
    "activeSymbols": ["BTC-USD", "ETH-USD"],
    "warmupComplete": true,
    "candlesBuffered": { "BTC-USD": 200 }
  }
}
```

### 2. TickerUpdate
Real-time price updates from exchange.

```json
{
  "type": "TickerUpdate",
  "payload": {
    "symbol": "BTC-USD",
    "price": 50000.50,
    "bid": 50000.00,
    "ask": 50001.00,
    "volume": 1234.56,
    "time": "2025-12-12T15:30:00Z"
  }
}
```

### 3. CandleUpdate
1-minute candle completion.

```json
{
  "type": "CandleUpdate",
  "payload": {
    "symbol": "BTC-USD",
    "time": 1702392000000,
    "open": 50000,
    "high": 50100,
    "low": 49900,
    "close": 50050,
    "volume": 1000
  }
}
```

### 4. Signal
Trading signal generated by strategy.

```json
{
  "type": "Signal",
  "payload": {
    "symbol": "BTC-USD",
    "strategy": "breakout",
    "direction": "buy",
    "strength": 0.85,
    "price": 50050,
    "stopLoss": 49000,
    "takeProfit": 52000,
    "metaLabel": 0.72,
    "metadata": {
      "indicators": { "rsi": 45, "macd": 12.5 },
      "reason": "Upper Donchian breakout with volume confirmation"
    }
  }
}
```

### 5. OrderUpdate
Order state change.

```json
{
  "type": "OrderUpdate",
  "payload": {
    "id": "order-123",
    "productId": "BTC-USD",
    "side": "buy",
    "type": "market",
    "size": "0.1",
    "price": null,
    "status": "filled",
    "filledSize": "0.1",
    "executedValue": "5005.00",
    "createdAt": "2025-12-12T15:30:00Z"
  }
}
```

### 6. Fill
Order fill notification.

```json
{
  "type": "Fill",
  "payload": {
    "tradeId": "fill-456",
    "productId": "BTC-USD",
    "orderId": "order-123",
    "price": "50050.00",
    "size": "0.1",
    "fee": "3.00",
    "side": "buy",
    "liquidity": "T",
    "createdAt": "2025-12-12T15:30:00Z"
  }
}
```

### 7. PositionUpdate
Position state change.

```json
{
  "type": "PositionUpdate",
  "payload": {
    "id": "pos-789",
    "symbol": "BTC-USD",
    "side": "long",
    "size": 0.1,
    "averagePrice": 50000,
    "marketPrice": 50100,
    "unrealizedPnL": 10,
    "realizedPnL": 0,
    "totalPnL": 10,
    "openTime": "2025-12-12T15:30:00Z",
    "lastUpdateTime": "2025-12-12T15:31:00Z"
  }
}
```

### 8. RiskEvent
Risk alert or kill switch activation.

```json
{
  "type": "RiskEvent",
  "payload": {
    "type": "kill_switch" | "drawdown" | "daily_loss",
    "severity": "critical",
    "message": "Kill switch activated: Daily loss limit exceeded",
    "reasons": ["Daily loss limit exceeded"],
    "timestamp": "2025-12-12T15:30:00Z"
  }
}
```

### 9. Alert
General system alert.

```json
{
  "type": "Alert",
  "payload": {
    "severity": "warning",
    "title": "Data Gap Detected",
    "message": "No market data received for 5 seconds",
    "timestamp": "2025-12-12T15:30:00Z",
    "metadata": { "symbols": ["BTC-USD"] }
  }
}
```

---

## Database Schema

### Required Tables

#### `users`
```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Note**: Fixed USER_ID `b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f` must exist.

#### `orders`
```sql
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  product_id TEXT NOT NULL,
  side TEXT NOT NULL, -- 'buy' | 'sell'
  type TEXT NOT NULL, -- 'market' | 'limit'
  size NUMERIC NOT NULL,
  price NUMERIC,
  status TEXT NOT NULL, -- 'pending' | 'open' | 'done' | 'cancelled'
  filled_size NUMERIC DEFAULT 0,
  executed_value NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `fills`
```sql
CREATE TABLE fills (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  order_id TEXT REFERENCES orders(id),
  product_id TEXT NOT NULL,
  price NUMERIC NOT NULL,
  size NUMERIC NOT NULL,
  fee NUMERIC NOT NULL,
  side TEXT NOT NULL,
  liquidity TEXT, -- 'M' | 'T'
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `positions`
```sql
CREATE TABLE positions (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL, -- 'long' | 'short' | 'flat'
  size NUMERIC NOT NULL,
  average_price NUMERIC NOT NULL,
  market_price NUMERIC NOT NULL,
  unrealized_pnl NUMERIC DEFAULT 0,
  realized_pnl NUMERIC DEFAULT 0,
  total_pnl NUMERIC DEFAULT 0,
  open_time TIMESTAMPTZ DEFAULT NOW(),
  last_update_time TIMESTAMPTZ DEFAULT NOW()
);
```

#### `signals`
```sql
CREATE TABLE signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  direction TEXT NOT NULL, -- 'buy' | 'sell'
  strength NUMERIC NOT NULL, -- 0-1
  price NUMERIC NOT NULL,
  stop_loss NUMERIC,
  take_profit NUMERIC,
  meta_label NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `account_metrics`
```sql
CREATE TABLE account_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  date DATE NOT NULL,
  equity NUMERIC NOT NULL,
  daily_pnl NUMERIC DEFAULT 0,
  total_pnl NUMERIC DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);
```

#### `risk_metrics`
```sql
CREATE TABLE risk_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  daily_pnl NUMERIC DEFAULT 0,
  max_drawdown NUMERIC DEFAULT 0,
  consecutive_losses INTEGER DEFAULT 0,
  error_rate NUMERIC DEFAULT 0,
  kill_switch_active BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `daily_equity`
```sql
CREATE TABLE daily_equity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  date DATE NOT NULL,
  start_equity NUMERIC NOT NULL,
  end_equity NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, date)
);
```

#### `alerts`
```sql
CREATE TABLE alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  severity TEXT NOT NULL, -- 'info' | 'warning' | 'critical'
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  read_at TIMESTAMPTZ
);
```

#### `exchange_credentials`
```sql
CREATE TABLE exchange_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  exchange TEXT NOT NULL,
  encrypted_api_key TEXT NOT NULL,
  encrypted_api_secret TEXT NOT NULL,
  encrypted_passphrase TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

#### `bars` (Historical Candles)
```sql
CREATE TABLE bars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol TEXT NOT NULL,
  time TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, time)
);
```

### Required RPC Functions

#### `upsert_account_metrics`
```sql
CREATE OR REPLACE FUNCTION upsert_account_metrics(
  p_user_id UUID,
  p_date DATE,
  p_equity NUMERIC,
  p_daily_pnl NUMERIC,
  p_total_pnl NUMERIC
) RETURNS VOID AS $$
  INSERT INTO account_metrics (user_id, date, equity, daily_pnl, total_pnl, updated_at)
  VALUES (p_user_id, p_date, p_equity, p_daily_pnl, p_total_pnl, NOW())
  ON CONFLICT (user_id, date)
  DO UPDATE SET
    equity = EXCLUDED.equity,
    daily_pnl = EXCLUDED.daily_pnl,
    total_pnl = EXCLUDED.total_pnl,
    updated_at = NOW();
$$ LANGUAGE sql;
```

---

## Configuration

### Environment Variables (`.env`)

```bash
# Supabase (REQUIRED)
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_KEY=your-service-key
SUPABASE_ANON_KEY=your-anon-key

# Encryption (REQUIRED - 64 hex chars = 32 bytes)
ENCRYPTION_KEY=your-64-character-hex-encryption-key

# Coinbase (Optional for paper mode, required for live)
COINBASE_API_KEY=your-api-key
COINBASE_API_SECRET=your-api-secret
COINBASE_API_PASSPHRASE=your-passphrase

# Coinbase API version toggle
COINBASE_API_VERSION=exchange  # or 'advanced'

# Live trading safeguard
CONFIRM_LIVE=NO  # Must be 'YES' to enable live trading
```

### Guardrails (`atlas/config/guardrails.yaml`)

```yaml
account:
  equity_usd: 10000
  risk_per_trade: 0.01
  max_open_positions: 2
  max_account_leverage: 3.0

risk:
  daily_loss_limit: -0.008  # -0.8%
  weekly_loss_limit: -0.025
  max_drawdown_limit: -0.1
  max_position_exposure_pct: 0.5

per_symbol:
  BTC-USD:
    max_notional_usd: 5000
    max_daily_loss_usd: 200
  ETH-USD:
    max_notional_usd: 3000
    max_daily_loss_usd: 150

strategy:
  mode: momentum_futures
  donchian_len: 20
  stop_init_atr: 1.5
  time_stop_bars: 96
```

---

## UI Requirements

### Dashboard Components Needed

#### 1. **System Status Panel**
- Engine running indicator (green/red)
- Mode badge (Paper/Live)
- Kill switch status with reasons
- Pause indicator
- Connection status (WebSocket)

#### 2. **Warmup Status**
- Progress indicator per symbol
- `warmupComplete` status
- `candlesBuffered` count per symbol
- Visual progress bar

#### 3. **Active Symbols Display**
- List of `activeSymbols`
- Last price per symbol
- Price change indicators

#### 4. **Engine Controls**
- Start Engine button (POST `/api/engine/start`)
- Stop Engine button (POST `/api/engine/stop`)
- Kill Switch button (POST `/api/engine/kill`)
- Mode selector (Paper/Live)

#### 5. **Real-Time Metrics**
- `wsLatencyMs` (WebSocket latency)
- `restLatencyMs` (REST API latency)
- `spreadPctile` (spread percentile)
- `regime` (trend/chop indicator)

#### 6. **Risk Dashboard**
- Daily P&L (`risk.dailyPnLUsd`)
- Total Exposure (`risk.exposureUsd`)
- Max Drawdown (`risk.maxDrawdownPct`)
- Kill switch status

#### 7. **Positions Panel**
- Table of open positions
- Columns: Symbol, Side, Size, Avg Price, Market Price, Unrealized P&L
- Color coding (green profit, red loss)
- Real-time updates via WebSocket

#### 8. **Orders Blotter**
- Table of recent orders
- Columns: ID, Symbol, Side, Type, Size, Price, Status, Filled Size
- Filter by status (pending, filled, cancelled)
- Real-time updates

#### 9. **Fills Log**
- Table of order fills
- Columns: Time, Symbol, Side, Price, Size, Fee, Order ID
- Chronological order (newest first)

#### 10. **Signals Panel**
- List of generated signals
- Display: Symbol, Strategy, Direction, Strength, Price, Stop Loss, Take Profit
- Color coding by direction (green buy, red sell)
- Strength indicator (0-1)

#### 11. **Alerts Panel**
- List of system alerts
- Severity badges (info/warning/critical)
- Filter by severity
- Mark as read functionality

#### 12. **Price Charts**
- Real-time price chart per symbol
- 1-minute candles
- Volume bars
- Technical indicators overlay (optional)

#### 13. **Data Gap Warning**
- Banner when `warmupComplete` is false
- Warning when data gap detected
- Auto-dismiss when resolved

---

## State Management

### Frontend State Structure

```typescript
interface AppState {
  // Connection
  wsConnected: boolean;
  lastStatusUpdate: number;
  
  // Engine Status
  engineRunning: boolean;
  mode: 'paper' | 'live';
  paused: boolean;
  killSwitch: {
    active: boolean;
    reasons: string[];
    since: number | null;
  };
  
  // Warmup
  warmupComplete: boolean;
  candlesBuffered: Record<string, number>;
  activeSymbols: string[];
  
  // Metrics
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: 'trend' | 'chop';
  
  // Risk
  risk: {
    exposureUsd: number;
    dailyPnLUsd: number;
    maxDrawdownPct: number;
    killSwitchActive: boolean;
  };
  
  // Market Data
  prices: Record<string, number>;
  tickers: Record<string, TickerUpdate>;
  
  // Trading Data
  positions: Position[];
  orders: Order[];
  fills: Fill[];
  signals: Signal[];
  alerts: Alert[];
}
```

### WebSocket Hook Usage

The frontend should use the existing `useRuntimeEvents` hook:

```typescript
import { useRuntimeEvents } from './hooks/useRuntimeEvents';

const {
  isConnected,
  onStatusUpdate,
  onTickerUpdate,
  onPositionUpdate,
  onOrderUpdate,
  onFill,
  onSignal,
  onRiskEvent,
  onAlert
} = useRuntimeEvents({
  onStatusUpdate: (status) => {
    // Update engine status state
  },
  onTickerUpdate: (ticker) => {
    // Update price data
  },
  // ... other handlers
});
```

---

## Testing

### Test Suite

Located in `atlas/apps/core-node/src/__tests__/`:

- `signal-processor.test.ts` - Signal generation tests
- `risk-engine.test.ts` - Risk management tests
- `position-monitor.test.ts` - Position exit condition tests

**Run tests**: `pnpm test` (18 tests passing)

---

## Monitoring & Observability

### Prometheus Metrics

Available at `http://localhost:3001/metrics`:

- `atlas_engine_running` - Engine status (0/1)
- `atlas_kill_switch_active` - Kill switch status (0/1)
- `atlas_orders_created_total` - Total orders created
- `atlas_orders_filled_total` - Total orders filled
- `atlas_db_connection_status` - DB connection (0/1)
- `atlas_exposure_usd` - Current exposure
- `atlas_daily_pnl_usd` - Daily P&L
- `atlas_ws_reconnect_count` - WS reconnection attempts
- `atlas_risk_metrics_write_failures_total` - Risk DB write failures

### Grafana Dashboard

Import `deploy/grafana-dashboard.json` for pre-configured monitoring dashboard.

### Alerting

Alert transports configured in `src/alerts/transports.ts`:
- Telegram (Bot API)
- Email (SMTP)
- Slack (Webhooks)

---

## Deployment

### Development

```bash
cd atlas/apps/core-node
pnpm install
pnpm api  # Start API server
```

### Production

```bash
pnpm build
pnpm start:paper  # Paper trading mode
pnpm start:live    # Live trading (requires CONFIRM_LIVE=YES)
```

---

## Key Features Implemented

### Phase 2 Cursor Sprints (C1-C3)

**C1 - Engine Runtime & Data Feed**
- ✅ Strict environment validation
- ✅ Database schema validation on startup
- ✅ Per-symbol data gap monitoring
- ✅ Product validation and active symbols tracking
- ✅ WebSocket reconnection with metrics
- ✅ Historical data warmup
- ✅ Risk metrics reliability tracking

**C2 - Trading Logic & Risk Guardrails**
- ✅ Position monitor (stop-loss, take-profit, time-stop)
- ✅ Proper position flattening with market orders
- ✅ Guardrails alignment (no hardcoded values)
- ✅ Per-symbol risk limits
- ✅ Risk state persistence across restarts
- ✅ Real-time metrics calculation
- ✅ Comprehensive test suite

**C3 - Advanced Features**
- ✅ Coinbase Advanced Trade API support
- ✅ Paper trading realism (depth-aware, TWAP)
- ✅ Multi-timeframe analysis
- ✅ Meta-labeling ONNX integration
- ✅ Historical data loader
- ✅ Alert system (Telegram/Email/Slack)
- ✅ Grafana dashboard

---

## Next Steps for Loveable

### Priority 1: Database Setup
1. Create missing tables (`risk_metrics`, `daily_equity`, `exchange_credentials`)
2. Seed `users` table with fixed USER_ID
3. Ensure all foreign key constraints are correct

### Priority 2: Core UI Components
1. System status panel with engine controls
2. Warmup progress indicator
3. Positions and orders blotters
4. Real-time metrics display

### Priority 3: Enhanced Features
1. Price charts with candles
2. Alerts panel with filtering
3. Risk dashboard with equity curve
4. Signals panel with strategy indicators

### Priority 4: Polish
1. Error handling and loading states
2. Responsive design
3. Dark/light theme support
4. Data export functionality

---

## Support & Documentation

- **API Server**: `http://localhost:3001`
- **WebSocket**: `ws://localhost:3001/events`
- **Metrics**: `http://localhost:3001/metrics`
- **Health**: `http://localhost:3001/health`

For questions or issues, refer to:
- Code comments in source files
- Test files for usage examples
- This technical overview document

---

**Last Updated**: December 12, 2025
**Version**: Phase 2 Complete
**Status**: Production Ready (Paper Trading)
