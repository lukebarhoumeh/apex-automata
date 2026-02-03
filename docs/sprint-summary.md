# Backend Stabilization Sprint Summary (Steps 1-8)

This document provides a comprehensive summary of the 8-step backend stabilization sprint. The goal was to transform the trading bot from a fragile prototype into a 24/7 production-ready system with deterministic risk controls, unified P&L, and reliable persistence.

---

## Step 1: Fix Engine Disconnections & Silent Stops (24/7 Reliability)

**Goal**: Eliminate engine "silent stops" and stale/disconnect behavior so the system runs 24/7.

### Problem Solved
- Engine would silently stop without any visible indication
- No supervision or automatic recovery
- No way to know if the engine was healthy

### New Files Created

| File | Purpose |
|------|---------|
| `src/runtime/engine-supervisor.ts` | Watchdog that monitors engine health and orchestrates recovery |

### Key Features

1. **EngineSupervisor** - Top-level watchdog
   - Monitors engine heartbeat
   - Tracks WebSocket health
   - Manages restart attempts with exponential backoff
   - Exposes health status via API

2. **Engine Heartbeat**
   - Trading engine emits heartbeat every N seconds
   - Supervisor detects stale heartbeat (no activity for M seconds)
   - Triggers recovery sequence on stale detection

3. **Recovery Sequence**
   - Step 1: Attempt WebSocket reconnect
   - Step 2: If WS fails, full engine restart
   - Step 3: If restart fails, increment counter, backoff, retry
   - Step 4: After max restarts, enter degraded mode (no auto-restart)

4. **Health API**
   - `GET /api/supervisor/health` returns supervisor status
   - `POST /api/supervisor/reset-restarts` clears restart counter

### Tests Added
- `src/__tests__/engine-supervisor.test.ts`
- `src/__tests__/trading-engine-lifecycle.test.ts`
- `src/__tests__/websocket-reconnect.test.ts`

---

## Step 2: Normalize WebSocket Lifecycle (Legacy vs Modern)

**Goal**: Eliminate dual Coinbase WebSocket implementations and standardize on one.

### Problem Solved
- Two WebSocket implementations: `CoinbaseWebSocket` and `UltraFastWebSocket`
- Inconsistent behavior, duplicate code, maintenance burden
- Confusing for debugging

### Decision Made
**Keep `CoinbaseWebSocket`** (legacy), deprecate `UltraFastWebSocket`.

Reasons:
1. Already had full reconnection + health infrastructure from Step 1
2. `UltraFastWebSocket` lacked subscription persistence for reconnect
3. `UltraFastWebSocket` emitted different event types requiring changes throughout

### New Files Created

| File | Purpose |
|------|---------|
| `src/exchanges/coinbase/ws/coinbase-ws.interface.ts` | Unified WebSocket interface |
| `src/exchanges/coinbase/ws/index.ts` | WebSocket module exports |

### Key Features

1. **Single WebSocket Client**
   - One implementation for all Coinbase WS needs
   - Consistent event types
   - Unified health API

2. **Reconnection with Backoff**
   - Infinite reconnect attempts
   - Exponential backoff with jitter
   - Clean resubscribe on reconnect

3. **Subscription Persistence**
   - Tracks active subscriptions
   - Automatically resubscribes on reconnect
   - Idempotent subscribe (no duplicates)

4. **Health API**
   - `getHealth()` returns connected, lastMessageAt, subscriptions

### Tests Added
- `src/__tests__/websocket-unified.test.ts`

---

## Step 3: Harden Coinbase REST + WS Reliability

**Goal**: Make Coinbase connectivity "boring and resilient" - 24/7 operation with automatic recovery.

### Problem Solved
- REST calls could hang or fail without retry
- Rate limits caused crashes
- Missed fills/orders during WS disconnects
- No reconciliation after reconnect

### New Files Created

| File | Purpose |
|------|---------|
| `src/exchanges/coinbase/http/resilient-http.ts` | HTTP client with retries, timeouts, circuit breaker |
| `src/exchanges/coinbase/http/rate-limiter.ts` | Token bucket rate limiter |
| `src/exchanges/coinbase/http/errors.ts` | Error classification (retryable vs fatal) |
| `src/exchanges/coinbase/http/index.ts` | HTTP module exports |
| `src/exchanges/coinbase/reconciliation/reconciler.ts` | Post-reconnect state reconciliation |
| `src/exchanges/coinbase/reconciliation/gap-filler.ts` | Fill gap detection + REST backfill |
| `src/exchanges/coinbase/reconciliation/index.ts` | Reconciliation module exports |

### Key Features

1. **Resilient HTTP Layer**
   - Configurable timeouts (connect, read, total)
   - Automatic retries with exponential backoff
   - Circuit breaker (open after N failures, half-open after timeout)
   - Request coalescing for duplicate in-flight requests

2. **Rate Limiting**
   - Token bucket algorithm
   - Separate buckets for public vs private endpoints
   - Automatic 429 handling with Retry-After header parsing

3. **Error Classification**
   - Retryable: 5xx, timeouts, network errors
   - Non-retryable: 4xx (except 429), auth failures
   - Automatic retry for retryable errors

4. **Reconciliation After Reconnect**
   - Detects WS reconnect event
   - Fetches open orders via REST
   - Compares with local state
   - Backfills any missing fills

5. **Gap Filling**
   - Tracks last fill timestamp per order
   - On reconnect, queries REST for fills since last known
   - Emits missing fills into the pipeline

### Tests Added
- `src/__tests__/coinbase-resilience.test.ts`

---

## Step 4: Unify Paper vs Live Mode

**Goal**: Make paper mode behave like live mode in every way that matters while ensuring paper never places real trades.

### Problem Solved
- Paper mode had different code paths than live
- Paper bypassed order manager / fill pipeline
- Paper used sandbox prices (different from live)
- Testing in paper didn't predict live behavior

### New Files Created

| File | Purpose |
|------|---------|
| `src/trading/execution/execution-adapter.ts` | Abstract interface for execution |
| `src/trading/execution/coinbase-live-adapter.ts` | Live execution via Coinbase |
| `src/trading/execution/paper-adapter.ts` | Paper execution (simulated fills) |
| `src/trading/execution/adapter-factory.ts` | Factory to create adapter by mode |
| `src/trading/execution/index.ts` | Execution module exports |
| `src/trading/account/account-provider.ts` | Unified account/balance source |
| `src/trading/account/index.ts` | Account module exports |

### Key Features

1. **Execution Adapter Interface**
   ```typescript
   interface ExecutionAdapter {
     placeOrder(order: OrderRequest): Promise<OrderResult>;
     cancelOrder(orderId: string): Promise<void>;
     getOrderStatus(orderId: string): Promise<OrderStatus>;
     onEvent(handler: (event: ExecutionEvent) => void): void;
   }
   ```

2. **Paper Adapter**
   - Uses real Coinbase production market data (not sandbox)
   - Simulates fills at market price
   - Emits same events as live adapter
   - Honors slippage model

3. **Live Adapter**
   - Wraps Coinbase REST + WS
   - Uses reconciliation from Step 3
   - Emits fills/orders from WS

4. **Account Provider**
   - Paper: in-memory balance tracker
   - Live: Coinbase account API
   - Same interface for both

5. **Single Trading Logic**
   - Strategy → Signal → OrderManager → Adapter
   - Same path for paper and live
   - Only the adapter differs

### Configuration

```bash
# Mode selection
MODE=paper  # or live

# Market data (always production for both)
MARKET_DATA_ENV=production
```

### Tests Added
- `src/__tests__/execution-adapters.test.ts`

---

## Step 5: Risk Parity + Kill Switch Semantics

**Goal**: Make the risk system deterministic, mode-parity correct, and operationally safe. Kill switch halts trading, not runtime.

### Problem Solved
- Kill switch killed the entire runtime (process died)
- No way to monitor/recover when halted
- Inconsistent risk calculations
- Paper and live had different risk behavior

### New Files Created

| File | Purpose |
|------|---------|
| `src/trading/risk-state.ts` | Risk state machine (RUNNING/PAUSED/HALTED) |
| `src/trading/risk-math.ts` | Canonical R-unit calculations |

### Key Features

1. **Trading State Machine**
   ```typescript
   type TradingState =
     | { state: 'RUNNING' }
     | { state: 'PAUSED'; reason: string }
     | { state: 'HALTED'; reasonCode: RiskHaltReasonCode; ... };
   ```

2. **Kill Switch Semantics**
   - When HALTED:
     - New entries: ❌ Blocked
     - Exits (reduce-only): ✅ Allowed
     - Runtime: ✅ Running
     - WebSocket: ✅ Connected
     - API: ✅ Responding

3. **Halt Reason Codes**
   | Code | Description | Daily? |
   |------|-------------|--------|
   | `daily_stop` | Daily P&L limit hit | ✅ |
   | `weekly_stop` | Weekly P&L limit hit | ❌ |
   | `max_drawdown` | Max drawdown exceeded | ❌ |
   | `consecutive_losses` | Too many losses | ❌ |
   | `error_rate` | Too many order errors | ❌ |
   | `manual_killswitch` | User-triggered | ❌ |

4. **R-Unit Math**
   ```
   1R = per_trade_risk × day_start_equity
   dailyPnlR = dailyPnlUsd / riskUnitUsd
   ```

5. **Day Rollover**
   - Daily halts auto-clear at day boundary
   - Non-daily halts require manual reset
   - Configurable timezone + rollover hour

### Tests Added
- `src/__tests__/risk-system.test.ts`

### Documentation
- `docs/risk.md`

---

## Step 6: Enforce Unified Risk Controls (Paper/Live Parity)

**Goal**: Make paper mode risk behavior identical to live mode. Paper testing must be trustworthy.

### Problem Solved
- Paper mode had implicit exceptions (ignored kill switch, different error rate limits)
- Testing in paper didn't predict live behavior
- No way to know which guardrails differed

### New Files Created

| File | Purpose |
|------|---------|
| `src/trading/risk/types.ts` | Risk evaluation types |
| `src/trading/risk/evaluate-risk.ts` | Pure risk evaluation function |
| `src/trading/risk/index.ts` | Risk module exports |

### Key Features

1. **Pure Evaluation Function**
   ```typescript
   function evaluateRisk(
     snapshot: RiskEvaluationSnapshot,
     thresholds: RiskThresholds,
     overrides: PaperOverrideFlags
   ): RiskDecision
   ```

2. **Default Parity**
   - All guardrails identical in paper and live
   - Same thresholds, same actions
   - Same persistence behavior

3. **Explicit Override Flags**
   | Flag | Default | Description |
   |------|---------|-------------|
   | `PAPER_RESET_RISK_STATE_ON_START` | `false` | Clear halts on paper startup |
   | `PAPER_DISABLE_ERROR_RATE_LIMIT` | `false` | Ignore error rate guardrail |
   | `PAPER_DISABLE_LATENCY_LIMIT` | `false` | Ignore latency guardrail |
   | `PAPER_DISABLE_DATA_GAP_LIMIT` | `false` | Ignore data staleness guardrail |
   | `PAPER_DISABLE_SOFT_LAUNCH` | `false` | Skip soft launch constraints |

4. **Guardrail Inventory**
   - 15+ guardrails documented
   - Each with threshold source, action, divergence status

5. **Standardized Definitions**
   - Error rate: (errors / operations) × 100 in 5-min window
   - Latency: mean REST latency in rolling window
   - Data staleness: now() - lastMarketDataAt

### Tests Added
- `src/__tests__/risk-parity.test.ts` (36+ tests)

### Documentation
- `docs/risk-parity.md`

---

## Step 7: Metrics Synchronization + Supabase Persistence Hardening

**Goal**: Eliminate schema mismatches, prevent double-counting, handle DB outages gracefully.

### Problem Solved
- Supabase writes could crash the engine
- Schema mismatches caused runtime errors
- Duplicate writes for same data
- DB outage = dead bot

### New Files Created

| File | Purpose |
|------|---------|
| `src/runtime/session-context.ts` | Unified session identity (sessionId, userId, riskDay) |
| `src/persistence/supabase-writer.ts` | Unified write layer with queue/retry/coalescing |
| `src/persistence/schema-capabilities.ts` | Dynamic schema detection |
| `src/persistence/index.ts` | Persistence module exports |

### Migrations Created

| Migration | Purpose |
|-----------|---------|
| `20260203_step7_persistence_hardening.sql` | Add columns + unique constraints |

### Key Features

1. **SupabaseWriter**
   - Single Supabase client for all writes
   - Bounded queue (default 1000)
   - Retry with exponential backoff (up to 5 retries)
   - Coalescing for high-frequency tables
   - Deduplication via dedupeKey
   - Optional disk spool for critical facts

2. **Error Classification**
   | Error Type | Retryable | Action |
   |------------|-----------|--------|
   | Network timeout | Yes | Retry |
   | 5xx errors | Yes | Retry |
   | Column does not exist | No | Drop |
   | RLS violation | No | Drop |

3. **Table Ownership**
   - RiskEngine owns: `risk_metrics`, `risk_events`, `daily_equity`, `account_metrics`
   - TradeAnalytics owns: `trade_log`, `trading_sessions`
   - Server/API owns: `orders`, `fills`, `positions`, `signals`

4. **Idempotent Writes**
   - Unique constraints on all tables
   - Upsert instead of insert where appropriate
   - Dedupe keys prevent duplicate writes

5. **Session Context**
   - Single sessionId per engine run
   - Consistent timestamps
   - Risk day calculation

6. **DB Outage Handling**
   - Writer marks `connected = false`
   - Queue keeps coalesced snapshots
   - Critical facts spool to disk
   - Periodic reconnect attempts
   - On reconnect, spool replays

### Tests Added
- `src/__tests__/supabase-writer.test.ts`

### Documentation
- `docs/persistence.md`

---

## Step 8: Single Source of Truth for P&L + Equity

**Goal**: Eliminate every competing P&L/equity calculation and replace with one canonical model.

### Problem Solved
- Multiple places computed equity differently
- RiskEngine had its own equity math
- TradeAnalytics had its own equity math
- API endpoints had their own equity math
- UI showed different numbers in different places

### New Files Created

| File | Purpose |
|------|---------|
| `src/trading/pnl/pnl-types.ts` | Canonical P&L types |
| `src/trading/pnl/pnl-service.ts` | Single source of truth for P&L |
| `src/trading/pnl/index.ts` | P&L module exports |

### Migrations Created

| Migration | Purpose |
|-----------|---------|
| `20260203_step8_pnl_columns.sql` | Add P&L columns to account_metrics, daily_equity, equity_curve |

### Key Features

1. **P&L Identity (ALWAYS enforced)**
   ```
   totalEquityUsd = sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd
   ```

2. **PnLSnapshot** - The canonical payload
   ```typescript
   interface PnLSnapshot {
     ts: number;
     userId: string;
     sessionId: string;
     executionMode: 'paper' | 'live';
     
     // Baselines
     sessionStartEquityUsd: number;
     dayStartEquityUsd: number;
     riskDay: string;
     
     // Performance
     realizedPnlUsd: number;
     unrealizedPnlUsd: number;
     totalEquityUsd: number;
     
     // Daily view
     dailyPnlUsd: number;
     dailyPnlR: number;
     riskUnitUsd: number;
     
     // Context
     openPositionsCount: number;
     exposureUsd: number;
     lastMarkPriceBySymbol: Record<string, number>;
     positionsBySymbol: Record<string, PositionSnapshot>;
   }
   ```

3. **Definition Rules**
   | Term | Definition |
   |------|------------|
   | `unrealizedPnlUsd` | Σ (markPrice - entryPrice) × qty × direction |
   | `realizedPnlUsd` | Σ closed trade P&L (net of fees) |
   | `totalEquityUsd` | sessionStart + realized + unrealized |
   | `dailyPnlUsd` | totalEquity - dayStartEquity |
   | `dailyPnlR` | dailyPnlUsd / riskUnitUsd |

4. **Consumers**
   - RiskEngine: Kill switch decisions
   - TradeAnalytics: Session stats
   - API `/api/status`: P&L block
   - API `/api/analytics/session`: Session P&L
   - API `/api/analytics/equity-curve`: Time-series
   - Supabase: `account_metrics`, `daily_equity`, `equity_curve`

5. **Day Rollover**
   - `dayStartEquityUsd` = current `totalEquityUsd`
   - `dailyPnlUsd` resets to 0
   - `riskUnitUsd` recalculates

6. **Equity Curve**
   - In-memory ring buffer (default 3600 points)
   - Persisted to `equity_curve` table

7. **WebSocket Event**
   - Event: `pnl:snapshot`
   - Payload: Full PnLSnapshot
   - Frequency: 1s throttled, immediate on close

8. **Startup Position Policy**
   - `import_mark_to_market`: Entry = mark price (unrealized = 0)
   - `flatten`: Close all positions (dangerous)

### Tests Added
- `src/__tests__/pnl-service.test.ts` (14 tests)

### Documentation
- `docs/pnl.md`

---

## Summary of All New Files

### Runtime Layer
| File | Step |
|------|------|
| `src/runtime/engine-supervisor.ts` | Step 1 |
| `src/runtime/session-context.ts` | Step 7 |

### WebSocket Layer
| File | Step |
|------|------|
| `src/exchanges/coinbase/ws/coinbase-ws.interface.ts` | Step 2 |
| `src/exchanges/coinbase/ws/index.ts` | Step 2 |

### HTTP Layer
| File | Step |
|------|------|
| `src/exchanges/coinbase/http/resilient-http.ts` | Step 3 |
| `src/exchanges/coinbase/http/rate-limiter.ts` | Step 3 |
| `src/exchanges/coinbase/http/errors.ts` | Step 3 |
| `src/exchanges/coinbase/http/index.ts` | Step 3 |

### Reconciliation Layer
| File | Step |
|------|------|
| `src/exchanges/coinbase/reconciliation/reconciler.ts` | Step 3 |
| `src/exchanges/coinbase/reconciliation/gap-filler.ts` | Step 3 |
| `src/exchanges/coinbase/reconciliation/index.ts` | Step 3 |

### Execution Layer
| File | Step |
|------|------|
| `src/trading/execution/execution-adapter.ts` | Step 4 |
| `src/trading/execution/coinbase-live-adapter.ts` | Step 4 |
| `src/trading/execution/paper-adapter.ts` | Step 4 |
| `src/trading/execution/adapter-factory.ts` | Step 4 |
| `src/trading/execution/index.ts` | Step 4 |
| `src/trading/account/account-provider.ts` | Step 4 |
| `src/trading/account/index.ts` | Step 4 |

### Risk Layer
| File | Step |
|------|------|
| `src/trading/risk-state.ts` | Step 5 |
| `src/trading/risk-math.ts` | Step 5 |
| `src/trading/risk/types.ts` | Step 6 |
| `src/trading/risk/evaluate-risk.ts` | Step 6 |
| `src/trading/risk/index.ts` | Step 6 |

### Persistence Layer
| File | Step |
|------|------|
| `src/persistence/supabase-writer.ts` | Step 7 |
| `src/persistence/schema-capabilities.ts` | Step 7 |
| `src/persistence/index.ts` | Step 7 |

### P&L Layer
| File | Step |
|------|------|
| `src/trading/pnl/pnl-types.ts` | Step 8 |
| `src/trading/pnl/pnl-service.ts` | Step 8 |
| `src/trading/pnl/index.ts` | Step 8 |

---

## Summary of All Tests

| Test File | Step | Tests |
|-----------|------|-------|
| `src/__tests__/engine-supervisor.test.ts` | Step 1 | Supervisor health, restart logic |
| `src/__tests__/trading-engine-lifecycle.test.ts` | Step 1 | Engine start/stop/restart |
| `src/__tests__/websocket-reconnect.test.ts` | Step 1 | WS reconnection behavior |
| `src/__tests__/websocket-unified.test.ts` | Step 2 | Unified WS interface |
| `src/__tests__/coinbase-resilience.test.ts` | Step 3 | HTTP retries, rate limiting, reconciliation |
| `src/__tests__/execution-adapters.test.ts` | Step 4 | Paper + live adapter parity |
| `src/__tests__/risk-system.test.ts` | Step 5 | State machine, R-units, day rollover |
| `src/__tests__/risk-parity.test.ts` | Step 6 | 36+ paper/live parity tests |
| `src/__tests__/supabase-writer.test.ts` | Step 7 | Queue, retry, coalescing, dedupe |
| `src/__tests__/pnl-service.test.ts` | Step 8 | P&L identity, positions, rollover |

---

## Summary of All Migrations

| Migration | Step | Purpose |
|-----------|------|---------|
| `20260203_step7_persistence_hardening.sql` | Step 7 | Unique constraints, missing columns |
| `20260203_step8_pnl_columns.sql` | Step 8 | P&L columns, equity_curve table |

---

## Summary of All Documentation

| Document | Step | Purpose |
|----------|------|---------|
| `docs/risk.md` | Step 5 | Risk state machine, R-units, halt codes |
| `docs/risk-parity.md` | Step 6 | Paper/live parity specification |
| `docs/persistence.md` | Step 7 | Supabase write layer, table ownership |
| `docs/pnl.md` | Step 8 | Canonical P&L model |

---

## Prometheus Metrics Added

### Step 1: Engine Supervisor
```
atlas_engine_restarts_total
atlas_engine_heartbeat_stale
atlas_supervisor_state
```

### Step 5: Risk System
```
atlas_risk_halt_total{reason_code}
atlas_risk_reset_total{reason_code}
atlas_daily_rollover_total
atlas_risk_state
```

### Step 7: Persistence
```
atlas_db_connection_status
atlas_db_write_queue_depth
atlas_db_write_total{table, result}
atlas_db_schema_errors_total{table}
atlas_db_retries_total{table}
atlas_db_spool_depth
```

### Step 8: P&L
```
atlas_total_equity_usd
atlas_realized_pnl_usd
atlas_unrealized_pnl_usd
atlas_daily_pnl_usd
atlas_pnl_snapshot_emit_total
```

---

## Key Architectural Principles Established

1. **Kill switch halts trading, not runtime** - Bot stays alive, WS stays connected, API keeps responding
2. **Paper/live parity by default** - Explicit override flags for any divergence
3. **Single source of truth for P&L** - One service computes, all others consume
4. **Idempotent writes** - Retries and replays never create duplicates
5. **Graceful degradation** - DB outage = degraded mode, not dead bot
6. **Pure evaluation functions** - Risk decisions are deterministic and auditable
7. **Explicit over implicit** - No hidden mode-specific behavior

---

## What's Next (Frontend Integration)

With the backend stabilized, the frontend can now:

1. **Subscribe to `pnl:snapshot`** - Single source of P&L truth
2. **Display consistent numbers** - Header, risk tab, equity curve all match
3. **Show clear halt state** - Reason code, since timestamp, daily flag
4. **Trust paper testing** - Paper behaves like live

The "header vs risk tab vs equity curve mismatch" is now permanently eliminated.
