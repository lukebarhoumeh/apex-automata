---
# Supabase Sync Audit Queries
# Run these in Supabase SQL Editor to verify data freshness
---

## 1. Account Metrics Freshness

Check if account_metrics is being updated in real-time:

```sql
SELECT
  now() AS current_time,
  user_id,
  updated_at,
  EXTRACT(EPOCH FROM (now() - updated_at)) AS age_seconds,
  total_equity,
  daily_pnl,
  daily_pnl_r,
  risk_heat,
  open_positions_count
FROM public.account_metrics
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY updated_at DESC
LIMIT 1;
```

**Expected**: `age_seconds` should be < 5 for active trading sessions.

---

## 2. Risk Metrics Freshness

```sql
SELECT
  now() AS current_time,
  user_id,
  updated_at,
  EXTRACT(EPOCH FROM (now() - updated_at)) AS age_seconds,
  daily_pnl,
  exposure_usd,
  kill_switch_active,
  consecutive_losses
FROM public.risk_metrics
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY updated_at DESC
LIMIT 1;
```

---

## 3. Recent Positions (Open + Recently Closed)

```sql
SELECT
  id,
  symbol,
  strategy,
  side,
  qty_open,
  entry_price,
  exit_price,
  opened_at,
  closed_at,
  realized_pnl_usd,
  realized_r
FROM public.positions
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY COALESCE(closed_at, opened_at) DESC
LIMIT 20;
```

---

## 4. Recent Orders

```sql
SELECT
  id,
  symbol,
  strategy,
  side,
  type,
  status,
  price,
  quantity,
  created_at,
  updated_at,
  EXTRACT(EPOCH FROM (now() - updated_at)) AS age_seconds
FROM public.orders
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY created_at DESC
LIMIT 50;
```

---

## 5. Recent Fills

```sql
SELECT
  f.id,
  f.order_id,
  f.price,
  f.quantity,
  f.fee_amount,
  f.filled_at,
  EXTRACT(EPOCH FROM (now() - f.filled_at)) AS age_seconds
FROM public.fills f
WHERE f.user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY f.filled_at DESC
LIMIT 50;
```

---

## 6. Trade Log Correctness

```sql
SELECT
  id,
  symbol,
  side,
  strategy,
  entry_time,
  exit_time,
  entry_price,
  exit_price,
  size,
  realized_pnl,
  outcome,
  exit_reason,
  duration_seconds
FROM public.trade_log
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY created_at DESC
LIMIT 50;
```

---

## 7. Trade Outcomes Correctness

```sql
SELECT
  id,
  symbol,
  strategy,
  signal_direction,
  regime,
  entry_time,
  exit_time,
  entry_price,
  exit_price,
  realized_pnl,
  r_multiple,
  outcome_label,
  exit_reason
FROM public.trade_outcomes
ORDER BY created_at DESC
LIMIT 50;
```

**Note**: `trade_outcomes` does not have `user_id` column. This is a security concern for multi-user scenarios.

---

## 8. Active Risk Events

```sql
SELECT
  id,
  event_type,
  details,
  active,
  triggered_at,
  cleared_at,
  EXTRACT(EPOCH FROM (now() - triggered_at)) AS age_seconds
FROM public.risk_events
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
  AND active = true
ORDER BY triggered_at DESC
LIMIT 20;
```

---

## 9. Recent Alerts

```sql
SELECT
  id,
  severity,
  title,
  message,
  created_at,
  acked_at,
  EXTRACT(EPOCH FROM (now() - created_at)) AS age_seconds
FROM public.alerts
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY created_at DESC
LIMIT 50;
```

---

## 10. Trading Sessions

```sql
SELECT
  session_id,
  mode,
  started_at,
  ended_at,
  initial_equity,
  final_equity,
  total_trades,
  total_pnl,
  updated_at
FROM public.trading_sessions
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
ORDER BY started_at DESC
LIMIT 10;
```

---

## 11. Check Realtime Publication Status

Verify which tables have realtime enabled:

```sql
SELECT 
  schemaname,
  tablename 
FROM pg_publication_tables 
WHERE pubname = 'supabase_realtime';
```

**Expected tables**:
- positions
- orders
- fills
- signals
- risk_events
- risk_metrics
- alerts
- account_metrics
- trading_sessions

---

## 12. RLS Policy Verification

Check that RLS is enabled and policies exist:

```sql
SELECT
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN (
    'positions', 'orders', 'fills', 'signals',
    'risk_events', 'risk_metrics', 'alerts',
    'account_metrics', 'trading_sessions'
  )
ORDER BY tablename, policyname;
```
