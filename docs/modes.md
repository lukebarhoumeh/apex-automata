# Trading Modes: Paper vs Live

This document describes the unified execution model introduced in Step 4 of the stabilization plan.

## Design Philosophy

**Paper mode should behave exactly like live mode** except for where orders are executed:

- Paper uses a **simulated execution adapter**
- Live uses the **Coinbase execution adapter**

Everything else—signal generation, risk checks, sizing, position tracking, exits, analytics—runs through **identical code paths**.

## Environment Configuration

Three independent settings control the trading environment:

| Setting | Values | Default | Description |
|---------|--------|---------|-------------|
| `EXECUTION_MODE` | `paper` \| `live` | `paper` | Whether orders are simulated or real |
| `MARKETDATA_ENV` | `production` \| `sandbox` | `production` | Source of market data |
| `EXECUTION_ENV` | `production` \| `sandbox` | `production` | Target for live orders (ignored in paper mode) |

### Key Insight: Paper Uses Real Market Data

By default, **paper mode uses production Coinbase market data**. This ensures:

- Realistic price movements
- Accurate signal testing
- Valid performance metrics

Sandbox market data may have different prices, lower liquidity, and different behavior. Only use sandbox for specific testing scenarios.

## Configuration Examples

### Paper Trading (Default)
```bash
EXECUTION_MODE=paper
MARKETDATA_ENV=production  # Real prices
# EXECUTION_ENV is ignored in paper mode
```

### Live Trading
```bash
EXECUTION_MODE=live
MARKETDATA_ENV=production
EXECUTION_ENV=production
CONFIRM_LIVE=YES  # Safety gate required
```

### Paper with Sandbox Data (Testing Only)
```bash
EXECUTION_MODE=paper
MARKETDATA_ENV=sandbox  # Sandbox prices for testing
```

### Live Sandbox Testing
```bash
EXECUTION_MODE=live
MARKETDATA_ENV=sandbox
EXECUTION_ENV=sandbox
CONFIRM_LIVE=YES
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      TradingEngine                               │
│                                                                   │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐   │
│  │ SignalProc   │  │ RiskEngine   │  │ PositionTracker      │   │
│  │              │  │              │  │                      │   │
│  │ (identical)  │  │ (identical)  │  │ (identical)          │   │
│  └──────────────┘  └──────────────┘  └──────────────────────┘   │
│                            │                                     │
│                            ▼                                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    OrderManager                           │   │
│  │                                                           │   │
│  │  Uses ExecutionAdapter interface - doesn't know if       │   │
│  │  paper or live                                            │   │
│  └────────────────────────────┬─────────────────────────────┘   │
│                               │                                  │
└───────────────────────────────┼──────────────────────────────────┘
                                │
          ┌─────────────────────┴─────────────────────┐
          │                                           │
          ▼                                           ▼
┌──────────────────────┐                 ┌──────────────────────┐
│ PaperExecutionAdapter │                 │ CoinbaseLiveAdapter  │
│                      │                 │                      │
│ • Simulates fills    │                 │ • REST + WS          │
│ • Uses real prices   │                 │ • Reconciliation     │
│ • Realistic slippage │                 │ • Idempotency        │
│ • Same event stream  │                 │ • Same event stream  │
└──────────────────────┘                 └──────────────────────┘
```

## ExecutionAdapter Interface

Both adapters implement the same interface:

```typescript
interface IExecutionAdapter {
  mode: 'paper' | 'live';
  
  start(): Promise<void>;
  stop(): Promise<void>;
  
  placeOrder(request: PlaceOrderRequest): Promise<void>;
  cancelOrder(clientOrderId: string): Promise<void>;
  
  getOpenOrders(): Promise<OpenOrder[]>;
  getFillsSince(cursor: any): Promise<FillRecord[]>;
  
  onEvent(callback: (event: BrokerOrderEvent) => void): void;
  getHealth(): AdapterHealth;
}
```

## BrokerOrderEvent Types

Both adapters emit identical event shapes:

```typescript
type BrokerOrderEvent = 
  | OrderAcceptedEvent   // Order acknowledged
  | OrderRejectedEvent   // Order rejected with reason
  | OrderCanceledEvent   // Order canceled
  | FillEvent;           // Partial or complete fill
```

### Fill Event Structure
```typescript
interface FillEvent {
  type: 'fill';
  clientOrderId: string;
  exchangeOrderId?: string;
  tradeId: string;
  price: number;
  size: number;
  fee: number;
  feeCurrency: string;
  liquidity: 'maker' | 'taker';
  ts: number;
}
```

## Paper Adapter Realism

The paper adapter simulates realistic execution:

| Feature | Implementation |
|---------|---------------|
| **Latency** | 50-150ms configurable delay |
| **Slippage** | Base 0.05% + depth-aware impact |
| **Fees** | Maker 0.4%, Taker 0.6% (configurable) |
| **Post-only** | Rejects if would cross spread |
| **Lot size** | Respects product specifications |
| **Tick size** | Rounds prices to tick |
| **Min notional** | Validates minimum order value |

### Depth-Aware Slippage

Larger orders incur more slippage:

```
slippage = base_slippage + (notional / book_depth) * 0.001
```

This simulates eating through the order book.

## Account Provider

Account data is also abstracted:

```typescript
interface IAccountProvider {
  getSnapshot(): Promise<AccountSnapshot>;
  getEquityUsd(): Promise<number>;
  getAvailableUsd(): Promise<number>;
  processFill(fill: FillEvent, side: 'buy' | 'sell'): void;
}
```

- **Paper**: In-memory ledger updated by fills
- **Live**: Fetches from Coinbase with caching

## Mode Switching Safety

Switching between modes is safe:

1. Stop current engine
2. Start engine with new mode
3. New adapter + provider are created
4. No state leaks between modes

Guard against accidental live calls in paper mode:

```typescript
function assertNotPaperMode(mode: ExecutionMode, operation: string): void {
  if (mode === 'paper') {
    throw new Error(`SAFETY: Attempted "${operation}" in paper mode`);
  }
}
```

## Testing

### Deterministic Paper Testing

Set a random seed for reproducible results:

```typescript
const adapter = new PaperExecutionAdapter({
  randomSeed: 12345, // Same seed = same slippage/latency
});
```

### Verify Identical Code Paths

1. Run paper mode with recorded market data
2. Compare order events against expected
3. Verify fills flow through PositionTracker correctly

## Migration Notes

The following legacy patterns are deprecated:

- `if (config.mode === 'paper')` branches in engine core
- Direct `PaperTradingSimulator` usage
- `sandbox` forcing when mode is `paper`

These should be migrated to use the adapter abstraction.
