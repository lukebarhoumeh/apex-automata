# Trading Bot Database Schema Documentation

## Overview

This document describes the complete Supabase database schema for the algorithmic trading bot platform. The schema is designed to support real-time trading operations, risk management, signal processing, order execution, and performance tracking.

**Database Type:** PostgreSQL (Supabase)  
**Migration Date:** 2025-01-13  
**Status:** ✅ Production Ready

---

## Architecture Summary

The database follows a **normalized, event-sourced architecture** optimized for:
- Real-time position tracking with WebSocket updates
- Audit-compliant order/fill history
- Risk heat calculations and kill-switch enforcement
- Meta-labeling (ML model gating)
- Journal/trade review workflows

---

## Core Components

### 1. Enums (Type Safety)

```sql
order_side: 'buy' | 'sell'
position_side: 'long' | 'short'
order_status: 'new' | 'working' | 'partially_filled' | 'filled' | 'canceled' | 'rejected' | 'expired'
order_type: 'limit' | 'market' | 'ioc' | 'twap_parent' | 'twap_child' | 'post_only' | 'stop' | 'take_profit'
trade_exit_reason: 'take_profit' | 'stop_loss' | 'time_stop' | 'manual_exit' | 'daily_stop' | 'kill_switch'
strategy_name: 'breakout' | 'vwap_mr' | 'obi_scalper'
alert_severity: 'info' | 'warning' | 'critical'
```

### 2. Tables

#### **symbols** (Tradable Markets)
Metadata for all tradable instruments.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| symbol | text | Unique ticker (e.g., 'BTC-USD') |
| base_asset | text | Base currency (e.g., 'BTC') |
| quote_asset | text | Quote currency (e.g., 'USD') |
| tick_size | numeric | Minimum price increment |
| lot_size | numeric | Minimum quantity increment |
| active | boolean | Trading enabled flag |
| created_at | timestamptz | Creation timestamp |

**Access:** Globally readable (no user scoping)

---

#### **strategies** (Strategy Registry)
Versioned strategy configurations with default parameters.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| name | strategy_name | Strategy identifier |
| version | integer | Version number |
| enabled | boolean | Active flag |
| default_params | jsonb | Strategy parameters |
| created_at | timestamptz | Creation timestamp |

**Unique Constraint:** (user_id, name, version)  
**RLS:** User-scoped read/write

---

#### **signals** (Trade Signal Log)
Every trading decision the bot considers (accepted or rejected).

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| symbol | text | FK to symbols |
| strategy | strategy_name | Strategy that generated signal |
| decided_at | timestamptz | Decision timestamp |
| side | position_side | Long or short |
| score | numeric | Signal strength (-1 to 1) |
| confidence | numeric | Confidence score (0 to 1) |
| meta_prob | numeric | Meta-label probability (nullable) |
| features | jsonb | Feature snapshot for explainability |
| allowed | boolean | Passed risk/meta gates? |
| reason | text | Rejection/acceptance reason |
| created_at | timestamptz | Record creation time |

**Indexes:** (user_id, decided_at DESC), (symbol)  
**RLS:** User-scoped read/write

---

#### **orders** (Parent Orders)
Logical orders placed or intended.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| external_order_id | text | Exchange order ID |
| signal_id | uuid | FK to signals (nullable) |
| strategy | strategy_name | Strategy identifier |
| symbol | text | FK to symbols |
| side | order_side | Buy or sell |
| type | order_type | Order type |
| status | order_status | Current status |
| price | numeric | Limit price (nullable for market) |
| stop_price | numeric | Stop trigger price |
| quantity | numeric | Order quantity |
| post_only | boolean | Post-only flag |
| time_in_force | text | GTC/IOC/etc |
| meta_prob | numeric | Copied meta probability |
| created_at | timestamptz | Order creation |
| updated_at | timestamptz | Last update (auto-trigger) |

**Indexes:** (user_id, created_at DESC), (symbol), (status)  
**RLS:** User-scoped read/write  
**Trigger:** Auto-update `updated_at` on modification

---

#### **order_legs** (Child Orders)
TWAP slices or retry attempts for parent orders.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| order_id | uuid | FK to orders |
| external_order_id | text | Exchange child order ID |
| type | order_type | Child order type |
| status | order_status | Current status |
| price | numeric | Limit price |
| quantity | numeric | Slice quantity |
| slippage_bps | numeric | Realized slippage (bps) |
| maker | boolean | Maker/taker flag |
| created_at | timestamptz | Leg creation |
| updated_at | timestamptz | Last update (auto-trigger) |

**Indexes:** (order_id)  
**RLS:** User-scoped read/write  
**Trigger:** Auto-update `updated_at` on modification

---

#### **fills** (Exchange Executions)
Individual fill events from the exchange.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| order_leg_id | uuid | FK to order_legs (nullable) |
| order_id | uuid | FK to orders |
| trade_id | text | Exchange execution ID |
| price | numeric | Fill price |
| quantity | numeric | Fill quantity |
| fee_currency | text | Fee currency |
| fee_amount | numeric | Fee charged |
| maker | boolean | Maker/taker flag |
| slippage_bps | numeric | Computed slippage |
| filled_at | timestamptz | Exchange fill timestamp |

**Indexes:** (order_id), (filled_at DESC)  
**RLS:** User-scoped read/write

---

#### **positions** (Position Lifecycle)
Net position per symbol/strategy with R-based P&L tracking.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| symbol | text | FK to symbols |
| strategy | strategy_name | Strategy identifier |
| side | position_side | Long or short |
| qty_open | numeric | Current open quantity |
| entry_price | numeric | VWAP entry price |
| stop_price_at_entry | numeric | Initial stop for R calculation |
| take_profit_price | numeric | First TP level (nullable) |
| opened_at | timestamptz | Position open time |
| closed_at | timestamptz | Position close time (nullable) |
| exit_price | numeric | Exit price (nullable) |
| exit_reason | trade_exit_reason | Exit reason (nullable) |
| realized_pnl_usd | numeric | Realized P&L in USD |
| realized_r | numeric | **Generated column** - P&L in R units |
| created_at | timestamptz | Record creation |

**Generated Column Formula (realized_r):**
```sql
case
  when closed_at is null or stop_price_at_entry is null then null
  when side = 'long' and exit_price is not null
    then (exit_price - entry_price) / nullif(abs(entry_price - stop_price_at_entry), 0)
  when side = 'short' and exit_price is not null
    then (entry_price - exit_price) / nullif(abs(entry_price - stop_price_at_entry), 0)
  else null
end
```

**Indexes:** (user_id, symbol) WHERE closed_at IS NULL, (user_id, closed_at DESC)  
**RLS:** User-scoped read/write  
**Realtime:** Enabled via supabase_realtime publication

---

#### **risk_events** (Risk Controls)
Logs kill-switches, daily stops, time-based pauses.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| event_type | text | 'daily_stop', 'kill_switch', etc |
| details | jsonb | Event metadata |
| active | boolean | Currently enforced? |
| triggered_at | timestamptz | Event trigger time |
| cleared_at | timestamptz | Event clear time (nullable) |

**Indexes:** (user_id, active)  
**RLS:** User-scoped read/write  
**Realtime:** Enabled

---

#### **alerts** (User Notifications)
Alert stream for risk, execution errors, and system events.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| severity | alert_severity | Info/warning/critical |
| title | text | Alert title |
| message | text | Alert body |
| data | jsonb | Additional metadata |
| created_at | timestamptz | Alert creation |
| acked_at | timestamptz | Acknowledged time (nullable) |

**Indexes:** (user_id, created_at DESC)  
**RLS:** User-scoped read/write  
**Realtime:** Enabled

---

#### **models** (ML Model Registry)
Meta-label model versions and performance metrics.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| name | text | Model name (default: 'metalabel') |
| version | text | Version string |
| path | text | Storage path to ONNX/model file |
| sha256 | text | Model file hash |
| input_schema | jsonb | Expected input features |
| metrics | jsonb | Performance metrics |
| active | boolean | Currently deployed? |
| created_at | timestamptz | Model creation |

**Unique Constraint:** (user_id, name, version)  
**RLS:** User-scoped read/write

---

#### **journal_entries** (Trade Journal)
Post-trade reviews, notes, and linked artifacts.

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| user_id | uuid | FK to auth.users |
| position_id | uuid | FK to positions (nullable) |
| order_id | uuid | FK to orders (nullable) |
| signal_id | uuid | FK to signals (nullable) |
| title | text | Entry title |
| note | text | Journal notes |
| attachments | text[] | Supabase Storage paths |
| created_at | timestamptz | Entry creation |

**RLS:** User-scoped read/write

---

#### **metrics_intraday** (Time-Series Metrics)
Optional table for charting slippage, latency, spread percentiles.

| Column | Type | Description |
|--------|------|-------------|
| id | bigserial | Primary key |
| user_id | uuid | FK to auth.users |
| symbol | text | FK to symbols (nullable) |
| metric | text | Metric name (e.g., 'spread_pctile') |
| value | numeric | Metric value |
| bucket_start | timestamptz | Time bucket start |
| created_at | timestamptz | Record creation |

**Indexes:** (user_id, symbol, metric, bucket_start DESC)  
**RLS:** User-scoped read/write

---

### 3. Views (Optimized Queries)

#### **v_open_positions**
Real-time view of all open positions (used in Dashboard).

```sql
SELECT
  p.id as position_id,
  p.user_id,
  p.symbol,
  p.strategy,
  p.side,
  p.qty_open,
  p.entry_price,
  p.stop_price_at_entry,
  p.take_profit_price,
  p.opened_at
FROM positions p
WHERE p.closed_at IS NULL;
```

---

#### **v_recent_activity**
Recent orders + aggregated fills (used in Orders/Blotter page).

```sql
SELECT
  o.id as order_id,
  o.created_at,
  o.symbol,
  o.side,
  o.type,
  o.status,
  o.price,
  o.quantity,
  COALESCE(SUM(f.quantity), 0) as filled_qty,
  COUNT(f.id) as fill_count
FROM orders o
LEFT JOIN fills f ON f.order_id = o.id
GROUP BY o.id
ORDER BY o.created_at DESC;
```

---

#### **v_daily_r**
Daily P&L in R units (closed positions only).

```sql
SELECT
  user_id,
  DATE_TRUNC('day', COALESCE(closed_at, opened_at))::date as day,
  SUM(COALESCE(realized_r, 0)) as daily_r
FROM positions
WHERE closed_at IS NOT NULL
GROUP BY 1, 2
ORDER BY 2 DESC;
```

---

#### **v_signal_funnel**
Signal acceptance/rejection funnel by hour.

```sql
SELECT
  user_id,
  DATE_TRUNC('hour', decided_at) as hour,
  COUNT(*) FILTER (WHERE allowed = false) as rejected,
  COUNT(*) FILTER (WHERE allowed = true) as allowed
FROM signals
GROUP BY 1, 2
ORDER BY 2 DESC;
```

---

### 4. Triggers

#### **touch_updated_at()**
Auto-updates `updated_at` columns on `orders` and `order_legs` tables.

```sql
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger 
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END $$;

CREATE TRIGGER trg_orders_touch 
  BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();

CREATE TRIGGER trg_order_legs_touch 
  BEFORE UPDATE ON order_legs
  FOR EACH ROW EXECUTE PROCEDURE touch_updated_at();
```

---

### 5. Row-Level Security (RLS)

All tables (except `symbols`) enforce **user-scoped RLS** using `auth.uid()`:

```sql
CREATE POLICY "strategies_rw_own" ON strategies
  FOR ALL USING (user_id = auth.uid()) 
  WITH CHECK (user_id = auth.uid());
```

**Public Read Tables:**
- `symbols` - globally readable for all users

**Protected Tables (user-scoped):**
- `strategies`, `signals`, `orders`, `order_legs`, `fills`, `positions`
- `risk_events`, `alerts`, `models`, `journal_entries`, `metrics_intraday`

---

### 6. Realtime Subscriptions

The following tables are enabled for **Supabase Realtime** (WebSocket updates):

- `positions` - live P&L updates
- `orders` - order status changes
- `fills` - execution events
- `risk_events` - kill-switch triggers
- `alerts` - real-time notifications

**Frontend Usage:**
```typescript
const channel = supabase
  .channel('positions-changes')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'positions'
  }, (payload) => {
    console.log('Position update:', payload);
  })
  .subscribe();
```

---

## Query Patterns (UI Examples)

### Dashboard Header
```sql
-- Open positions
SELECT * FROM v_open_positions 
WHERE user_id = auth.uid();

-- Last 14 days R
SELECT day, daily_r FROM v_daily_r 
WHERE user_id = auth.uid() 
ORDER BY day DESC LIMIT 14;

-- Active risk events
SELECT * FROM risk_events 
WHERE user_id = auth.uid() AND active = true;
```

### Orders/Positions Page
```sql
-- Recent activity blotter
SELECT * FROM v_recent_activity 
WHERE user_id = auth.uid() 
LIMIT 100;

-- Open positions
SELECT * FROM v_open_positions 
WHERE user_id = auth.uid() 
ORDER BY opened_at DESC;
```

### Signals Page
```sql
SELECT 
  decided_at, symbol, strategy, side, 
  score, meta_prob, allowed, reason
FROM signals 
WHERE user_id = auth.uid() 
ORDER BY decided_at DESC 
LIMIT 500;
```

### Model Page
```sql
SELECT * FROM models 
WHERE user_id = auth.uid() 
ORDER BY created_at DESC;
```

---

## Storage Buckets (Recommended Setup)

### **journal/** Bucket
- Journal screenshots, exports, attachments
- Referenced in `journal_entries.attachments` array

### **models/** Bucket (Optional)
- ONNX model files if not using local storage
- Referenced in `models.path` column

**RLS Policies Needed:**
```sql
-- Users can upload to their own folder
CREATE POLICY "journal_upload_own" ON storage.objects
  FOR INSERT WITH CHECK (
    bucket_id = 'journal' AND 
    auth.uid()::text = (storage.foldername(name))[1]
  );
```

---

## Security Notes

⚠️ **DO NOT** store exchange API keys in Supabase tables!

- Use local `.env` files or a dedicated secrets manager
- If DB storage is required, use `pgcrypto` (PGP encrypt/decrypt)
- Never expose plaintext keys via the Supabase API

---

## Migration Status

✅ **Completed:**
- All core tables created
- Enums defined
- RLS policies applied
- Views created
- Triggers configured
- Realtime enabled
- Indexes optimized

🔄 **Pending (Backend Implementation):**
- Position aggregation from fills (trigger/stored procedure)
- Seed data for `symbols` table
- Storage buckets creation
- Edge functions for order execution

---

## Next Steps for Backend Development

### 1. Seed Symbols Table
```sql
INSERT INTO symbols (symbol, base_asset, quote_asset, tick_size, lot_size) 
VALUES 
  ('BTC-USD', 'BTC', 'USD', 0.01, 0.0001),
  ('ETH-USD', 'ETH', 'USD', 0.01, 0.001),
  ('SOL-USD', 'SOL', 'USD', 0.01, 0.01);
```

### 2. Create Storage Buckets
```sql
INSERT INTO storage.buckets (id, name, public) 
VALUES ('journal', 'journal', false);
```

### 3. Implement Order Execution Logic
- Create edge function for exchange API integration
- Handle order → order_legs → fills lifecycle
- Auto-update positions from fills (via trigger or edge function)

### 4. Build Risk Engine
- Calculate heat from open positions
- Enforce daily stop (check `risk_events`)
- Trigger kill-switch via `risk_events` + `alerts`

### 5. Meta-Label Pipeline
- Load model from `models` table (ONNX)
- Evaluate features on new signals
- Update `signals.meta_prob` and `signals.allowed`

---

## Frontend Integration (Already Complete)

✅ The following frontend components are **live and connected**:

- `MetricsGridConnected` - real-time account metrics
- `PositionsPanelConnected` - open positions table
- Custom hooks: `usePositions`, `useAccountMetrics`, `useRiskSettings`
- Loading states with skeleton components
- Real-time WebSocket updates via Supabase subscriptions

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      FRONTEND (React + Vite)                │
├─────────────────────────────────────────────────────────────┤
│  Dashboard │ Positions │ Signals │ Risk │ Journal │ Model   │
└────────────┬────────────────────────────────────────────────┘
             │
             ▼ (Supabase Client SDK + Realtime)
┌─────────────────────────────────────────────────────────────┐
│                    SUPABASE (PostgreSQL)                     │
├─────────────────────────────────────────────────────────────┤
│  Tables: positions, orders, fills, signals, risk_events...  │
│  Views: v_open_positions, v_recent_activity, v_daily_r      │
│  RLS: User-scoped policies (auth.uid())                     │
│  Realtime: positions, orders, fills, alerts                 │
└────────────┬────────────────────────────────────────────────┘
             │
             ▼ (Edge Functions - to be implemented)
┌─────────────────────────────────────────────────────────────┐
│                  BACKEND LOGIC (Edge Functions)              │
├─────────────────────────────────────────────────────────────┤
│  • Exchange API integration (orders → fills)                │
│  • Position aggregation from fills                          │
│  • Risk heat calculation + kill-switch                      │
│  • Meta-label scoring (ONNX inference)                      │
│  • Real-time WebSocket → Alert notifications                │
└─────────────────────────────────────────────────────────────┘
```

---

## Credits

**Schema Design:** Production-ready trading bot schema  
**Framework:** Supabase (PostgreSQL + Realtime + RLS)  
**Frontend:** React + TypeScript + TanStack Query  
**Migration Date:** January 13, 2025  
**Status:** ✅ Ready for Cursor backend development

---

## Support & Documentation

- [Supabase Docs](https://supabase.com/docs)
- [PostgreSQL Docs](https://www.postgresql.org/docs/)
- [Lovable Cloud Docs](https://docs.lovable.dev/features/cloud)
