# AtlasBot v2

Professional algorithmic trading system with a React frontend, Node.js trading runtime, and Supabase persistence. Supports real-time paper trading with Coinbase market data, strategy configuration, risk controls, WebSocket updates, and deployment via Docker/Kubernetes.

---

## Contents
- Overview
- Architecture
- Prerequisites
- Environment Variables
- Database Setup (Supabase)
- Local Development
- Starting the Trading Engine
- Frontend Features
- API & WebSocket
- Deployment (Docker/K8s)
- Troubleshooting

---

## Overview
- Frontend: React + Vite + shadcn-ui (this repo root)
- Backend: Node.js runtime at `atlas/apps/core-node/`
- Persistence: Supabase (Postgres, Realtime)
- Exchange: Coinbase Advanced Trade (sandbox for paper mode)
- Single-user MVP with fixed `USER_ID`

Key features:
- Live dashboard with equity/PnL, risk heat, spread percentile, open positions
- Strategy configuration (Breakout+Volume, VWAP Mean Reversion, Meta gating)
- Risk management (position sizing, daily stop, kill-switch)
- Orders, fills, positions, alerts syncing to Supabase
- Real-time WebSocket updates to the UI
- **24/7 Runtime Resilience** - Automatic recovery, infinite reconnection, watchdog monitoring

---

## Architecture
- `src/` – Frontend UI
- `atlas/apps/core-node/` – Trading runtime (Express API + engine)
- `supabase/` – SQL migrations/scripts
- `deploy/` – Dockerfile and K8s manifests

Runtime flow:
1) Engine connects to Coinbase WS → ticker → candles → SignalProcessor
2) RiskEngine gates entries; OrderManager simulates fills (paper)
3) PositionTracker updates positions/PnL; data synced to Supabase
4) UI consumes Supabase tables + runtime WebSocket events

---

## 24/7 Runtime Resilience

The system is designed for continuous 24/7 operation with automatic recovery:

### Engine States

| State | Description |
|-------|-------------|
| `stopped` | Engine not running |
| `starting` | Engine initializing |
| `running` | Engine running, trading active |
| `stopping` | Engine shutting down |
| `halted` | **Trading halted** (kill switch), but runtime stays alive |

### Key Behaviors

1. **Kill Switch ≠ Shutdown**: When the kill switch triggers (daily loss, etc.), trading halts but the runtime stays alive. WebSocket connections remain open, market data keeps flowing, and the UI shows the halted state with reasons.

2. **Infinite Reconnection**: Coinbase WebSocket never gives up reconnecting. Uses exponential backoff with jitter, capped at 60 seconds. Automatic resubscription after reconnect.

3. **Engine Supervisor (Watchdog)**: Monitors engine heartbeat and market data freshness. Triggers automatic recovery when components become stale (configurable thresholds).

4. **Idempotent Lifecycle**: `start()` and `stop()` are idempotent - calling them multiple times is safe and won't create duplicate intervals or listeners.

5. **Single WebSocket Client**: The system uses exactly ONE WebSocket client for Coinbase (`CoinbaseWebSocket`). Subscriptions are idempotent - subscribing twice is a no-op. All subscriptions are automatically restored on reconnect via `SubscriptionManager`.

6. **Risk State Machine**: Trading state is managed explicitly (`RUNNING`/`PAUSED`/`HALTED`). Kill switch halts trading but keeps runtime alive. Reduce-only exits always work.

### Risk System

The risk system uses a unified state machine and canonical R-unit math:

| Component | Purpose |
|-----------|---------|
| `RiskStateMachine` | Manages trading state (`RUNNING`/`PAUSED`/`HALTED`) |
| `RiskMath` | Canonical P&L and R-unit calculations |
| `RiskEngine` | Integration with trading engine |

**Key Concepts:**
- **1R** = per_trade_risk × day_start_equity (e.g., 1% × $50,000 = $500)
- **Daily Stop** = threshold in R units (e.g., -2R = -$1,000)
- **Daily halts** auto-clear on day rollover
- **Non-daily halts** require manual reset

See [docs/risk.md](docs/risk.md) for complete documentation.

### WebSocket Health Surface

The status API (`GET /api/status`) includes WebSocket health:

```json
{
  "ws": {
    "connected": true,
    "reconnecting": false,
    "reconnectAttempts": 0,
    "lastMessageAt": 1706832000000,
    "messageAgeMs": 150,
    "isStalled": false,
    "subscriptionCount": 2
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGINE_HEARTBEAT_STALE_MS` | 15000 | Max time without engine heartbeat before recovery |
| `MARKETDATA_STALE_MS` | 10000 | Max time without market data before WS reconnect |
| `STATUS_HEARTBEAT_MS` | 1500 | Interval for status broadcasts to UI |
| `RESTART_COOLDOWN_MS` | 30000 | Minimum time between restart attempts |
| `MAX_CONSECUTIVE_RESTARTS` | 5 | Max restarts before giving up |

### Supervisor Endpoints

- `GET /api/supervisor/status` - Detailed supervisor state and engine health
- `POST /api/supervisor/reset-restarts` - Reset restart tracking for manual recovery
- `POST /api/killswitch/deactivate` - Resume trading after kill switch (requires confirmation)

### Recovery Behavior

- **Stale Engine Heartbeat**: Supervisor triggers engine restart (respects cooldown)
- **Stale Market Data**: Supervisor triggers WebSocket reconnect
- **Uncaught Exceptions**: Logged and reported to UI, but process stays alive
- **Process Crash**: `start.cjs` auto-restarts backend with exponential backoff

---

## Coinbase Connectivity Model

The system uses a resilient connectivity layer for Coinbase that ensures 24/7 operation:

### REST API Resilience

```
Request → Rate Limiter → Retry with Backoff → Circuit Breaker → Response
```

| Feature | Implementation |
|---------|---------------|
| **Timeout** | 10s hard timeout with AbortController |
| **Retry Policy** | 3 retries with exponential backoff (1s → 2s → 4s), max 30s |
| **Rate Limiting** | Token bucket (15/s global, 5/s orders) |
| **Circuit Breaker** | Opens after 5 failures, 30s cooldown |

### Error Classification

| Kind | HTTP Status | Retryable | Examples |
|------|-------------|-----------|----------|
| `timeout` | - | Yes | Request timed out |
| `network` | - | Yes | DNS, connection refused |
| `rate_limit` | 429 | Yes | Rate limited |
| `server` | 5xx | Yes | Internal server error |
| `auth` | 401/403 | No | Invalid API key |
| `post_only` | 400 | No | Post-only would cross |
| `insufficient_funds` | 400 | No | Not enough balance |

### WebSocket + REST Reconciliation

Even when WebSocket is healthy, the reconciler runs to ensure no missed events:

1. **Order Reconciliation** (every 5s): Compares local orders vs Coinbase open orders
2. **Fill Reconciliation** (every 5s): Fetches recent fills, dedupes by trade_id
3. **Triggered Reconciliation**: Runs immediately on WS reconnect or order actions

### Market Data Gap Filling

When WebSocket market data goes stale:

1. Gap filler detects no candles for >30s
2. Fetches missing candles via REST
3. Dedupes and backfills candle buffer
4. Indicators resume without gaps

### Degraded Mode Rules

| Condition | Allow Entries | Allow Exits | Monitor |
|-----------|---------------|-------------|---------|
| WS disconnected only | ✅ | ✅ | ✅ |
| REST circuit open | ❌ | ⚠️ | ✅ |
| WS down + reconciler degraded | ❌ | ⚠️ | ✅ |
| Rate limited | ⚠️ | ⚠️ | ✅ |

### API Endpoints

- `GET /api/exchange/health` - Comprehensive exchange health status
- `POST /api/exchange/reset-circuit` - Force reset REST circuit breaker
- `POST /api/exchange/reconcile` - Trigger immediate reconciliation

---

## Paper vs Live Mode

The system uses a unified execution model where paper and live modes share identical code paths. Only the execution adapter differs.

### Environment Configuration

| Variable | Values | Default | Description |
|----------|--------|---------|-------------|
| `EXECUTION_MODE` | `paper` \| `live` | `paper` | Whether orders are simulated or real |
| `MARKETDATA_ENV` | `production` \| `sandbox` | `production` | Source of market data |
| `EXECUTION_ENV` | `production` \| `sandbox` | `production` | Target for live orders (ignored in paper) |

### Key Design: Paper Uses Real Market Data

By default, **paper mode uses production Coinbase market data**. This ensures:
- Realistic price movements
- Accurate signal testing  
- Valid performance metrics

### Execution Adapter Interface

Both modes emit identical `BrokerOrderEvent` streams:

```typescript
type BrokerOrderEvent = 
  | OrderAcceptedEvent   // Order acknowledged
  | OrderRejectedEvent   // Order rejected with reason
  | OrderCanceledEvent   // Order canceled
  | FillEvent;           // Partial or complete fill
```

### Paper Adapter Features

| Feature | Implementation |
|---------|---------------|
| **Latency** | 50-150ms simulated delay |
| **Slippage** | Base 0.05% + depth-aware impact |
| **Fees** | Maker 0.4%, Taker 0.6% |
| **Post-only** | Rejects if would cross spread |
| **Validation** | Respects tick size, lot size, min notional |

### Configuration Examples

**Paper Trading (Default)**:
```bash
EXECUTION_MODE=paper
MARKETDATA_ENV=production  # Real prices!
```

**Live Trading**:
```bash
EXECUTION_MODE=live
MARKETDATA_ENV=production
EXECUTION_ENV=production
CONFIRM_LIVE=YES  # Safety gate required
```

See [docs/modes.md](docs/modes.md) for complete documentation.

---

## Prerequisites
- Node.js 20+
- pnpm 9+ (recommended)
- Supabase project (URL + keys)

---

## Environment Variables
Create `.env` at repo root:

```
# Frontend Environment Variables
VITE_RUNTIME_API_URL=http://localhost:3001

# Backend Environment Variables
SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I

# IMPORTANT: Add your Supabase Service Role Key here
# You can find it in your Supabase dashboard under Settings > API
SUPABASE_SERVICE_KEY=your_service_role_key_here

# Trading Configuration
CONFIRM_LIVE=NO

# Fixed USER_ID for single-user MVP
USER_ID=b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f

# Optional: Coinbase API credentials (for live trading)
# COINBASE_API_KEY=
# COINBASE_API_SECRET=
# COINBASE_API_PASSPHRASE=
ENCRYPTION_KEY=32-byte-hex-or-strong-secret
```

---

## Database Setup (Supabase)
Run the migration script in Supabase SQL Editor (copy/paste and run):
- `supabase/migrations/20251016_fix_trading_tables.sql`

This will:
- Reconcile `positions` (add `user_id` if missing)
- Create `upsert_account_metrics(user_id uuid)` RPC
- Add indexes and policies

Optional, but available:
- `supabase/migrations/20251016_risk_metrics.sql` – extended risk analytics table

---

## Quick Start (One Command)

### Cross-platform (Recommended):
```bash
pnpm start
# or
npm run start
```

### Platform-specific:
```bash
# macOS/Linux
./start.sh

# Windows
start.bat
```

This will automatically:
- Install all dependencies
- Build the backend
- Start the API server
- Start the trading engine
- Launch the frontend
- Open your browser

To stop everything:
```bash
node stop.cjs
# or press Ctrl+C in the terminal
```

## Manual Development Setup

If you prefer to start services individually:

Install UI deps and run:
```
pnpm install
pnpm dev
```

Install backend deps and run API:
```
cd atlas/apps/core-node
pnpm install
pnpm build
pnpm api
```

Open the app at `http://localhost:8080` (configured Vite port).

---

## Starting the Trading Engine
With API running on `:3001`, start paper mode:
```
curl -X POST http://localhost:3001/api/engine/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"paper"}'
```

Notes:
- Paper mode uses Coinbase sandbox ticker data (BTC-USD).
- Signals start after ~50 candles (~50 minutes of live data).
- Orders/fills/positions sync to Supabase.

Kill switch (immediate halt):
```
curl -X POST http://localhost:3001/api/engine/kill
```

Pause/Resume:
```
curl -X POST http://localhost:3001/api/control/pause
curl -X POST http://localhost:3001/api/control/resume
```

Close all positions (with confirmation):
```
curl -X POST http://localhost:3001/api/control/close-all \
  -H "Content-Type: application/json" \
  -d '{"confirm":"CLOSE ALL"}'
```

---

## Frontend Features
- Dashboard KPIs: total equity, daily P&L, risk heat, spread percentile, open positions
- Orders & Positions: live blotter + open positions
- Signals: configure strategy thresholds and meta gating
- Risk: per-trade risk, heat cap, daily stop, kill-switch
- Journal & Alerts: persisted in Supabase with Realtime updates

---

## API & WebSocket
REST:
- `GET /api/health` – healthcheck
- `GET /api/status` – runtime status (mode, paused, kill switch, latencies). Always carries `sessionId`, `sessionStartedAt` (ISO-8601 UTC string, `null` when stopped), `session {id, startedAt, mode, initialEquityUsd}` and `pnl` (canonical snapshot or `null`); the same builder feeds every WS `StatusUpdate`.
- `GET /api/pnl` – canonical PnL / equity snapshot. **Equity single source of truth: `totalEquityUsd`** (also at `/api/status.pnl.totalEquityUsd`): paper = `sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd` (mark-to-market), live = exchange snapshot; `sessionStartEquityUsd` = `trading_sessions.initial_equity` (paper: `guardrails.account.equity_usd`); `sizingEquityUsd` is the risk engine's clamped sizing figure.
- `GET /api/orders|fills|signals|positions?session_id=&execution_mode=&limit=` (+`status=open|closed|all` on positions, default `open`) – session-scoped Supabase reads (rows keep Supabase column names). Default = active session; response `{ <table>: rows, count, scope }` where `scope.filter` is `session_id` (migration `20260911170000` applied), `time_window` (interim `<time col> >= sessionStartedAt`) or `none` (no session → empty `200`). `/api/positions` for the active session adds `engineOpenPositions`.
- `GET /api/analytics/session|equity-curve|trades` – active session only (400 when the engine is stopped); `sessionId` equals `/api/status.sessionId`; `equity-curve.currentEquity` equals `pnl.totalEquityUsd`.
- `GET /api/analytics/strategies?session_id=` – `{ sessionId, strategies: [{ strategyId, closedTrades, pnlToday, winRate }] }` (session-scoped; zeros at zero closed trades; shelved ids included; extras `realizedPnl`, `signalsTaken`, `openTrades`, `enabled`, `disabledByGuardrails`). Also mirrored as `sessionStats` on each `GET /api/strategies` entry; `stats.signalsGenerated` there counts signals, not trades.
- `POST /api/engine/start {mode: paper|live}`
- `POST /api/engine/kill`
- `POST /api/control/{pause|resume|close-all}`
- `POST /api/config/{risk|signals}`

WebSocket:
- `ws://localhost:3001/events`
- Messages: `StatusUpdate`, `TickerUpdate`, `Signal`, `OrderUpdate`, `Fill`, `PositionUpdate`, `RiskEvent`

---

## Deployment

Docker (API):
```
docker build -f deploy/docker/Dockerfile.api -t atlas-api:latest .
docker run -p 3001:3001 --env-file .env atlas-api:latest
```

Kubernetes:
1) Update image in `deploy/k8s/api-deployment.yaml`
2) Create namespace/secrets; apply manifests
3) Use readiness/liveness probes on `/api/status`

---

## Troubleshooting
- No signals yet → wait ~50 minutes for 1m candles to accumulate
- 401 from Coinbase polling → running in paper mode without live creds (expected)
- Supabase errors on metrics → ensure migration `20251016_fix_trading_tables.sql` ran
- ETH-USD subscribe error in sandbox → BTC-USD only (by design)

---

## Security Notes
- Single-user MVP with fixed `USER_ID`
- `CONFIRM_LIVE=NO` by default; set to `YES` for live only after review
- Store exchange credentials via encrypted backend workflow (do not insert raw into DB)

---

## License
Proprietary – internal project.
