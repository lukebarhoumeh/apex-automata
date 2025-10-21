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
- `GET /api/status` – runtime status (mode, paused, kill switch, latencies)
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
