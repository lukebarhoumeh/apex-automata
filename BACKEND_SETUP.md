# AtlasBot Backend Setup Guide

This guide covers setting up the Node.js trading backend with Supabase integration.

## Prerequisites

- Node.js 20+ installed
- pnpm installed (`npm install -g pnpm`)
- Supabase project created (already done: gdrdaajvutmewgxbjurk)
- Environment variables configured

---

## Environment Setup

### 1. Configure Secrets in Supabase

All secrets should be stored in Supabase Secrets (already configured):

- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` - Service role key for backend DB access
- `SUPABASE_PUBLISHABLE_KEY` - Anon/public key
- `COINBASE_API_KEY` - Coinbase API key (for live trading)
- `COINBASE_API_SECRET` - Coinbase API secret
- `SUPABASE_DB_URL` - Direct Postgres connection string

### 2. Local .env File (For Development)

Create a `.env` file in the project root:

```bash
# Supabase
SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co
SUPABASE_SERVICE_KEY=your_service_role_key_here
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I

# Encryption
ENCRYPTION_KEY=61610d12777cedb4207951f172e708aace1da3bac19acb5022bd84b563f880f9

# Trading Mode (default: paper)
CONFIRM_LIVE=NO

# Coinbase (optional - only for live trading)
COINBASE_API_KEY=
COINBASE_API_SECRET=
COINBASE_API_PASSPHRASE=
```

**Important:** Never commit the `.env` file to git. It's already in `.gitignore`.

---

## Database Migration

The database schema is already deployed to Supabase. To verify or re-run migrations:

```bash
# Option 1: Via Supabase Dashboard
# Go to SQL Editor → paste contents of supabase/migrations/*.sql → Execute

# Option 2: Via Supabase CLI (if installed)
supabase db push
```

### Verify Database Tables

Expected tables:
- `symbols` - Trading symbols metadata
- `strategies` - Strategy configurations
- `signals` - Generated trade signals
- `orders` - Parent orders
- `order_legs` - Child/split orders
- `fills` - Execution records
- `positions` - Open/closed positions
- `risk_events` - Risk alerts and stops
- `alerts` - User-facing notifications
- `models` - ML model registry
- `journal_entries` - Trade notes
- `metrics_intraday` - Time-series metrics
- `profiles`, `user_roles`, `bot_states`, `risk_settings`, `account_metrics`, `strategy_signals`

### Seed Sample Data (Optional)

```bash
# Run the seed script to populate symbols and sample data
# In Supabase Dashboard → SQL Editor → paste supabase/seed.sql → Execute
```

---

## Backend Installation

### 1. Install Dependencies

```bash
# Navigate to backend
cd atlas/apps/core-node

# Install packages
pnpm install
```

### 2. Build Backend

```bash
pnpm build
```

This compiles TypeScript to JavaScript in the `dist/` folder.

---

## Running the Backend

### Option 1: Development Mode (with hot reload)

```bash
cd atlas/apps/core-node

# Run API server
pnpm api
```

This starts the API server on http://localhost:3001 with:
- HTTP REST endpoints at `/api/*`
- WebSocket at `ws://localhost:3001`
- Prometheus metrics at `/metrics`
- Health check at `/health`

### Option 2: Production Mode

```bash
cd atlas/apps/core-node

# Build first
pnpm build

# Start API server
node dist/api/server.js
```

### Option 3: Docker (Recommended for Production)

```bash
# Build Docker image
docker build -f deploy/docker/Dockerfile.api -t atlas-api:latest .

# Run container
docker run -d \
  --name atlas-api \
  -p 3001:3001 \
  --env-file .env \
  atlas-api:latest
```

---

## API Endpoints

### Status & Health

```bash
# Check API health
curl http://localhost:3001/health

# Get trading engine status
curl http://localhost:3001/api/status
```

Expected response:
```json
{
  "engineRunning": false,
  "mode": "paper",
  "positions": [],
  "riskMetrics": null,
  "activeOrders": []
}
```

### Engine Control

```bash
# Start trading engine (paper mode)
curl -X POST http://localhost:3001/api/engine/start \
  -H "Content-Type: application/json" \
  -d '{"mode":"paper"}'

# Stop trading engine
curl -X POST http://localhost:3001/api/engine/stop

# Activate kill switch
curl -X POST http://localhost:3001/api/engine/kill
```

### Monitoring

```bash
# Prometheus metrics
curl http://localhost:3001/metrics
```

---

## WebSocket Connection

The backend exposes a WebSocket for real-time updates. The frontend automatically connects.

**Events emitted:**
- `status` - Engine status updates
- `ticker` - Market price updates
- `signal` - New trading signals
- `order:created` - Order placed
- `order:filled` - Order executed
- `position:update` - Position changed
- `risk:alert` - Risk event triggered

**Frontend usage:**
```typescript
import { tradingApi } from '@/services/tradingApi';

// Subscribe to events
tradingApi.on('signal', (signal) => {
  console.log('New signal:', signal);
});
```

---

## Database Queries (From Backend)

The backend uses Supabase SDK to interact with the database.

```typescript
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Insert order
await supabase.from('orders').insert({
  user_id: userId,
  symbol: 'BTC-USD',
  side: 'buy',
  type: 'limit',
  price: 50000,
  quantity: 0.001,
  status: 'new'
});

// Query open positions
const { data } = await supabase
  .from('positions')
  .select('*')
  .is('closed_at', null);
```

---

## Troubleshooting

### Backend won't start

**Check environment variables:**
```bash
cd atlas/apps/core-node
node -e "require('dotenv').config({path:'../../.env'}); console.log(process.env.SUPABASE_URL)"
```

**Check logs:**
```bash
# Development mode shows logs in terminal
pnpm api

# Production mode
tail -f atlas/var/logs/api-server.jsonl
```

### Database connection fails

**Test connection:**
```bash
# Install psql if needed
psql "postgresql://postgres:[SERVICE_KEY]@gdrdaajvutmewgxbjurk.supabase.co:5432/postgres?sslmode=require"
```

**Check Supabase dashboard:**
- Go to https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk
- Check "Database" → "Tables" to verify schema
- Check "API" → "Logs" for connection errors

### Frontend can't connect

**Verify backend is running:**
```bash
curl http://localhost:3001/health
```

**Check CORS:**
The backend allows all origins in development. For production, update:
```typescript
app.use(cors({
  origin: 'https://yourdomain.com'
}));
```

### WebSocket disconnects

**Check firewall/proxy:**
- WebSocket requires `Upgrade` header support
- Nginx config includes WebSocket proxy settings

**Check logs:**
```bash
# Backend logs show WebSocket connections
grep "WebSocket" atlas/var/logs/api-server.jsonl
```

---

## Architecture Flow

```
Frontend (React)
  ↓ REST API + WebSocket
Backend (Node.js API Server) ← You are here
  ↓ Supabase SDK
Supabase (Postgres + Realtime)
  ↓ Direct queries
Trading Engine (Orders, Risk, Signals)
  ↓ Exchange API
Coinbase Advanced Trade
```

**Key Points:**
1. Frontend reads from Supabase directly for historical data
2. Frontend connects to backend WebSocket for real-time updates
3. Backend writes to Supabase after processing orders/fills
4. Backend enforces risk rules before placing orders
5. All state changes are logged to database

---

## Next Steps

1. ✅ Database schema deployed
2. ✅ Backend API server running
3. ✅ Frontend connected to Supabase
4. ⏳ Test paper trading flow
5. ⏳ Configure risk settings
6. ⏳ Deploy to production (see DEPLOYMENT.md)

---

## Support

- Check `DATABASE_SCHEMA.md` for schema details
- Check `DEPLOYMENT.md` for production deployment
- Check backend logs: `atlas/var/logs/api-server.jsonl`
- Check Supabase logs in dashboard

For issues, verify:
1. Environment variables are set correctly
2. Database tables exist and have RLS policies
3. Backend can connect to Supabase
4. Frontend can reach backend (no CORS errors)
