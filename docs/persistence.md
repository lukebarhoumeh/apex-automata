# Persistence System

This document describes the unified Supabase persistence layer introduced in Step 7.

## Design Principles

1. **No Supabase write crashes the engine** - All failures are handled gracefully
2. **Schema mismatches are detected early** - Non-retryable, logged, and dropped
3. **Idempotent writes** - Retries and spool replay never create duplicates
4. **No double counting** - One module owns each aggregate
5. **DB outages = degraded mode** - Queue + spool, not dead bot
6. **Paper/live parity** - Identical persistence behavior

## Table Ownership

### RiskEngine owns:
| Table | Type | Description |
|-------|------|-------------|
| `risk_metrics` | Aggregate | Latest risk snapshot per user |
| `risk_events` | Event log | Halt/reset history |
| `daily_equity` | Aggregate | Start/end equity per day |
| `account_metrics` | Aggregate | Dashboard-ready totals |

### TradeAnalytics owns:
| Table | Type | Description |
|-------|------|-------------|
| `trade_log` | Fact | One row per closed trade |
| `trading_sessions` | Aggregate | Session rollup counters |

### Server/API owns:
| Table | Type | Description |
|-------|------|-------------|
| `orders` | Fact | Order events |
| `fills` | Fact | Fill events |
| `positions` | State | Current positions |
| `signals` | Fact | Signal events |
| `alerts` | Fact | Alert events |

### TradeOutcomeCollector owns:
| Table | Type | Description |
|-------|------|-------------|
| `trade_outcomes` | Fact | ML-ready trade outcomes |

### MetaFilter owns:
| Table | Type | Description |
|-------|------|-------------|
| `meta_filter_decisions` | Fact | Filter decision log |

## SupabaseWriter

Unified write layer with queue + retry + coalescing.

### Features

1. **Single Supabase client** - One service-role client for all writes
2. **Bounded queue** - Configurable max size (default: 1000)
3. **Retry with backoff** - Exponential + jitter, up to 5 retries
4. **Coalescing** - High-frequency tables keep only latest per key
5. **Disk spool** - Optional, for critical facts during outages
6. **Schema error detection** - Non-retryable, immediately dropped

### Usage

```typescript
import { initWriter, getWriter } from './persistence';

// Initialize once at startup
initWriter({
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY,
  logger,
  flushIntervalMs: 2000,
  enableSpool: true,
  spoolDir: './spool',
});

// Get singleton anywhere
const writer = getWriter();

// Insert a fact (critical = spooled on failure)
writer.insert('fills', {
  user_id: 'u1',
  trade_id: 'trade123',
  price: 50000,
}, { 
  dedupeKey: 'fill:u1:trade123',
  critical: true,
});

// Upsert with coalescing (only latest kept)
writer.upsert('risk_metrics', {
  user_id: 'u1',
  daily_pnl: -500,
}, 'user_id', {
  coalesceKey: 'risk_metrics:u1',
});

// Graceful shutdown
await shutdownWriter();
```

### Coalescing

For high-frequency snapshot tables, only the latest write per `coalesceKey` is kept:

```typescript
// These 100 writes become 1 flush
for (let i = 0; i < 100; i++) {
  writer.upsert('risk_metrics', { daily_pnl: i }, 'user_id', {
    coalesceKey: 'risk_metrics:user1',
  });
}
```

### Deduplication

Same `dedupeKey` prevents duplicate writes:

```typescript
// Second call is dropped
writer.insert('fills', data, { dedupeKey: 'fill:trade123' });
writer.insert('fills', data, { dedupeKey: 'fill:trade123' }); // No-op
```

### Retry Classification

| Error Type | Retryable | Action |
|------------|-----------|--------|
| Network timeout | Yes | Retry with backoff |
| Connection refused | Yes | Retry with backoff |
| 5xx errors | Yes | Retry with backoff |
| Column does not exist | No | Log + drop |
| Table does not exist | No | Log + drop |
| RLS violation | No | Log + drop |

## Session Context

Single source of truth for session identity.

```typescript
import { createSessionContext, getRiskDay, formatTimestamp } from './runtime/session-context';

const ctx = createSessionContext({
  mode: 'paper',
  userId: 'user1',
});

// All writes use the same sessionId
console.log(ctx.sessionId); // "a1b2c3d4-..."

// Consistent timestamps
const ts = formatTimestamp(); // "2025-02-03T12:00:00.000Z"

// Risk day calculation
const day = getRiskDay(ctx); // "2025-02-03"
```

## Idempotent Writes

Unique constraints enable safe retries:

| Table | Unique Constraint | Purpose |
|-------|-------------------|---------|
| `risk_metrics` | `(user_id)` | Latest snapshot per user |
| `account_metrics` | `(user_id, date)` | Daily snapshot |
| `daily_equity` | `(user_id, date)` | Daily equity record |
| `fills` | `(user_id, trade_id)` | Prevent duplicate fills |
| `orders` | `(user_id, external_order_id)` | Prevent duplicate orders |
| `positions` | `(user_id, symbol)` | One position per symbol |
| `trade_outcomes` | `(signal_id)` | One outcome per signal |

## Write Frequency

| Table | Interval | Method |
|-------|----------|--------|
| `risk_metrics` | 2-5s | Coalesced upsert |
| `account_metrics` | 2-5s | Coalesced upsert |
| `daily_equity` | 60s + on trade + on shutdown | Upsert |
| `fills/orders` | Immediate | Queued insert |
| `trade_log` | On trade close | Upsert |
| `signals` | On signal | Insert |

Configure via environment:

```bash
METRICS_FLUSH_MS=2000
EQUITY_SNAPSHOT_FLUSH_MS=60000
```

## DB Outage Handling

When Supabase is unreachable:

1. Writer marks `connected = false`
2. Queue keeps coalesced snapshots
3. Critical facts spool to disk (JSONL)
4. Periodic retry attempts reconnect
5. On reconnect, spool replays first

### Queue Overflow

If queue exceeds `maxQueueSize`:
1. Drop non-critical snapshot writes first
2. Never drop critical facts without spooling

### Health Endpoint

`/api/status` includes writer health:

```json
{
  "persistence": {
    "dbConnected": true,
    "queueDepth": 3,
    "lastDbWriteOkAt": 1706900000000,
    "lastDbWriteError": null,
    "spoolDepth": 0
  }
}
```

## Schema Capabilities

Detect schema at startup to prevent retry loops:

```typescript
import { loadSchemaCapabilities, hasColumn } from './persistence/schema-capabilities';

const caps = await loadSchemaCapabilities(supabase, ['risk_metrics', 'fills'], logger);

if (hasColumn(caps, 'risk_metrics', 'average_latency_ms')) {
  row.average_latency_ms = latency;
}
```

## Migration

Run the Step 7 migration to add missing columns and constraints:

```bash
supabase db push
# or
supabase migration up
```

Migration file: `supabase/migrations/20260203_step7_persistence_hardening.sql`

### Changes Made

1. Added missing columns to `risk_metrics`:
   - `daily_pnl_r`
   - `realized_pnl_usd`
   - `unrealized_pnl_usd`
   - `average_latency_ms`
   - `market_data_stale_ms`

2. Added unique constraints for upserts:
   - `risk_metrics(user_id)`
   - `account_metrics(user_id, date)`
   - `daily_equity(user_id, date)`
   - `fills(user_id, trade_id)`
   - `positions(user_id, symbol)`
   - `trade_outcomes(signal_id)`

3. Added indexes for common queries

## Prometheus Metrics

```
# Connection status
atlas_db_connection_status (1=up, 0=down)

# Queue depth
atlas_db_write_queue_depth

# Write results
atlas_db_write_total{table, result}

# Schema errors (non-retryable)
atlas_db_schema_errors_total{table, error_type}

# Retries
atlas_db_retries_total{table}

# Spool depth
atlas_db_spool_depth
```

## Testing

```bash
cd atlas/apps/core-node
npx vitest run src/__tests__/supabase-writer.test.ts
```

Tests cover:
- Coalescing (100 writes → 1 flush)
- Retry with backoff
- Schema error handling (non-retryable)
- Deduplication
- Queue overflow
- Health tracking
