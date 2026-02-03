# P&L System - Single Source of Truth

This document describes the canonical P&L model introduced in Step 8.

## Design Principle

> One service computes P&L. All other modules consume it.

The P&L identity is **always** enforced:

```
totalEquityUsd = sessionStartEquityUsd + realizedPnlUsd + unrealizedPnlUsd
```

## PnLService

The `PnLService` is the **ONLY** place equity and P&L are computed.

### Location

```
atlas/apps/core-node/src/trading/pnl/pnl-service.ts
```

### Consumers

| Module | Usage |
|--------|-------|
| RiskEngine | Kill switch, exposure gating |
| TradeAnalytics | Session stats (realized only) |
| API `/api/status` | P&L block in status |
| API `/api/analytics/session` | Session P&L |
| API `/api/analytics/equity-curve` | Equity time-series |
| Supabase | `account_metrics`, `daily_equity` |

### Definition Rules

| Term | Definition |
|------|------------|
| `unrealizedPnlUsd` | Σ (markPrice - entryPrice) × qty × direction for open positions |
| `realizedPnlUsd` | Σ closed trade P&L (net of fees) |
| `totalEquityUsd` | sessionStartEquity + realized + unrealized |
| `dailyPnlUsd` | totalEquity - dayStartEquity |
| `dailyPnlR` | dailyPnlUsd / riskUnitUsd |
| `riskUnitUsd` | dayStartEquity × perTradeRiskFraction |

## PnLSnapshot

The canonical payload that all modules use.

```typescript
interface PnLSnapshot {
  ts: number;
  userId: string;
  sessionId: string;
  executionMode: 'paper' | 'live';
  marketDataEnv: 'production' | 'sandbox';

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

## Usage

### Initialize

```typescript
import { initPnLService, getPnLService } from './trading/pnl';

const pnlService = initPnLService({
  userId: 'user1',
  sessionId: 'session1',
  executionMode: 'paper',
  marketDataEnv: 'production',
  sessionStartEquityUsd: 50000,
  perTradeRiskFraction: 0.01,
}, logger, positionTracker);
```

### Get Snapshot

```typescript
const pnlService = getPnLService();
const snapshot = pnlService.getSnapshot();

console.log(snapshot.totalEquityUsd);
console.log(snapshot.dailyPnlR);
```

### Update Mark Prices

```typescript
// On each market tick
pnlService.updateMarkPrice('BTC-USD', 51000);

// Bulk update
pnlService.updateMarkPrices({
  'BTC-USD': 51000,
  'ETH-USD': 2100,
});
```

### Listen for Snapshots

```typescript
pnlService.on('pnl:snapshot', (snapshot: PnLSnapshot) => {
  // Broadcast to WebSocket clients
  ws.emit('pnl:snapshot', snapshot);
  
  // Update persistence
  writer.upsert('account_metrics', { ... });
});
```

## Data Flow

```
┌──────────────────┐     ┌──────────────────┐
│  PositionTracker │     │   Market Data    │
│  (positions)     │     │   (prices)       │
└────────┬─────────┘     └────────┬─────────┘
         │                        │
         │  position:closed       │  ticker
         │  position:opened       │
         ▼                        ▼
┌─────────────────────────────────────────────┐
│               PnLService                     │
│  - computes unrealized from positions        │
│  - accumulates realized from closes          │
│  - enforces: total = start + real + unreal   │
└─────────────────────┬───────────────────────┘
                      │
                      │ pnl:snapshot
                      ▼
       ┌──────────────┴──────────────┐
       │                             │
       ▼                             ▼
┌──────────────┐            ┌──────────────┐
│  RiskEngine  │            │     API      │
│  (decisions) │            │  (endpoints) │
└──────────────┘            └──────────────┘
```

## Day Rollover

On risk day boundary:

1. `dayStartEquityUsd` = current `totalEquityUsd`
2. `dailyPnlUsd` resets to 0
3. `dailyPnlR` resets to 0
4. `riskUnitUsd` recalculates from new `dayStartEquity`
5. `pnl:day_rollover` event emitted

## Equity Curve

In-memory ring buffer stores recent snapshots:

```typescript
const curve = pnlService.getEquityCurve();
// Returns EquityCurvePoint[]
```

Buffer size: configurable, default 3600 (1 hour at 1s)

## Startup Position Policy

When engine starts with existing positions:

| Policy | Behavior |
|--------|----------|
| `import_mark_to_market` | Entry = mark price, unrealized starts at 0 |
| `flatten` | Close all positions (dangerous) |

Default: `import_mark_to_market`

This ensures the P&L identity holds from the first snapshot.

## Prometheus Metrics

```
atlas_total_equity_usd       # Current total equity
atlas_realized_pnl_usd       # Session realized P&L
atlas_unrealized_pnl_usd     # Current unrealized P&L
atlas_daily_pnl_usd          # Daily P&L
atlas_pnl_snapshot_emit_total # Snapshots emitted
```

## WebSocket Event

Event type: `pnl:snapshot`

Payload: `PnLSnapshot`

Frequency:
- Throttled to 1s
- Immediate on position close, day rollover

## Paper/Live Parity

Same P&L computation code path. Only fill source differs:

| Mode | Fill Source |
|------|-------------|
| Paper | Paper simulator |
| Live | Coinbase API |

## Tests

```bash
cd atlas/apps/core-node
npx vitest run src/__tests__/pnl-service.test.ts
```

14 tests covering:
- P&L identity enforcement
- Long/short positions
- Multiple positions
- Day rollover
- Equity curve
- Event emission

## Migration from Legacy

Remove these patterns:

```typescript
// ❌ BAD: Independent equity calculation
const equity = guardrails.account.equity_usd + stats.totalPnL;

// ✅ GOOD: Use PnLService
const equity = pnlService.getSnapshot().totalEquityUsd;
```

```typescript
// ❌ BAD: RiskEngine computing equity
this.dailyPnL = currentEquity - this.dailyStartEquity;

// ✅ GOOD: Consume PnLSnapshot
const { dailyPnlUsd } = pnlService.getSnapshot();
```

## Related Documentation

- [Risk System](./risk.md) - Risk state machine and R-unit math
- [Risk Parity](./risk-parity.md) - Paper/live equivalence
- [Persistence](./persistence.md) - Supabase write layer
