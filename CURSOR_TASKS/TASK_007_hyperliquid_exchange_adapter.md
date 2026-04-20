# TASK_007: Hyperliquid Exchange Adapter — Second Venue via nomeida/hyperliquid SDK

**Priority:** HIGH — Strategic unlock. Only venue where surviving strategies are profitable (0.05% fees).
**Status:** PARKED (begin after 2–4 weeks of validated paper trading on Coinbase)
**Depends on:** TASK_005 (runtime bugs), TASK_006 (indicator swap) — both must be complete and paper-validated
**Created:** 2026-03-24 by Cowork (Architecture AI)
**Phase:** 5B — Open-Source Integration Sprint 2

---

## Context

Phase 3 backtest verdict (March 6, 2026) proved that the two surviving strategies — EMA Trend Follow and RSI/MACD Momentum — are **unprofitable on Coinbase** at 0.60% taker fees, but **profitable on Hyperliquid** at 0.05% taker fees:

| Strategy | Coinbase (0.60%) | Hyperliquid (0.05%) |
|----------|-----------------|---------------------|
| EMA Trend Follow (ETH) | -$836 | +$1,024 |
| RSI/MACD Momentum (ETH) | -$1,732 | +$127 |

Hyperliquid is a perpetual futures DEX with a TypeScript SDK maintained by nomeida (`npm: hyperliquid`). The SDK provides complete REST + WebSocket coverage, auto-handles trailing-zero formatting, and supports candle subscriptions, user fills, L2 book snapshots. **Requires Node 22+** (our engine targets Node 20+ — verify compatibility or bump).

### Source Repository

- **GitHub:** `github.com/nomeida/hyperliquid`
- **npm:** `hyperliquid`
- **License:** MIT
- **Last updated:** March 2026 (actively maintained)
- **Alternative:** `@nktkas/hyperliquid` (separate HttpTransport/WebSocketTransport classes, different ergonomics)

### Architecture Fit

The Apex Automata exchange layer already has a universal adapter interface (`IExchangeAdapter` in `exchanges/types.ts`) with support for perpetual futures (`IPerpsAdapter`). The Coinbase adapter implements both. The Hyperliquid adapter will implement the same interfaces, meaning the trading engine, strategies, risk engine, and PnL service all work unchanged.

```
IExchangeAdapter + IPerpsAdapter
├── CoinbaseAdapter (existing)
├── CoinbasePerpsAdapter (existing)
└── HyperliquidAdapter (this task)  ← NEW
```

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** modify `IExchangeAdapter` or `IPerpsAdapter` interfaces — implement them as-is
2. **DO NOT** modify any strategy plugins — they emit signals, the adapter handles execution
3. **DO NOT** enable live trading by default — start with testnet (`api.hyperliquid-testnet.xyz`)
4. **DO NOT** change the PaperAdapter — it works for any symbol string already
5. **DO NOT** modify `guardrails.yaml` structure — add Hyperliquid config in a new section
6. Maintain paper/live parity: HyperliquidAdapter must emit identical `BrokerOrderEvent` shapes

---

## Pre-Work: SDK Evaluation

Before writing any adapter code, install and evaluate the SDK.

### Step 0A: Install and Test SDK

```bash
cd atlas/apps/core-node
pnpm add hyperliquid
```

**Create file:** `atlas/apps/core-node/src/exchanges/hyperliquid/__tests__/sdk-eval.test.ts`

```typescript
/**
 * Hyperliquid SDK Evaluation Test
 *
 * Verify SDK installation, import paths, and basic API compatibility.
 * Uses TESTNET — no real funds.
 */

import { describe, it, expect } from 'vitest';

describe('Hyperliquid SDK Evaluation', () => {
  it('imports correctly', async () => {
    // Verify the main SDK export
    const hl = await import('hyperliquid');
    expect(hl).toBeDefined();
    // Check for expected classes/functions — adjust based on actual SDK exports
    // The SDK may export: Hyperliquid, HyperliquidAPI, or similar
  });

  it('can instantiate with testnet config', async () => {
    const hl = await import('hyperliquid');
    // Instantiate with testnet URL
    // const client = new hl.Hyperliquid({ testnet: true });
    // expect(client).toBeDefined();
    // NOTE: Fill in actual constructor based on SDK docs
  });

  it('can fetch public market data (no auth needed)', async () => {
    // Fetch available perpetual contracts
    // const client = new hl.Hyperliquid({ testnet: true });
    // const markets = await client.info.meta();
    // expect(markets.universe.length).toBeGreaterThan(0);
    // NOTE: Adapt to actual SDK API surface
  });
});
```

**IMPORTANT:** Run this test first. If the SDK import fails or the API surface doesn't match, check:
- Node version requirement (SDK needs Node 22+, our engine targets 20+)
- Import syntax (CJS vs ESM — our project is `"type": "module"`)
- Whether `@nktkas/hyperliquid` is a better fit for our stack

### Step 0B: Map SDK API to IExchangeAdapter Methods

Review the SDK source and map each `IExchangeAdapter` method to the corresponding SDK call:

| IExchangeAdapter Method | Hyperliquid SDK Equivalent |
|------------------------|---------------------------|
| `initialize(credentials)` | SDK constructor with private key + testnet flag |
| `shutdown()` | Close WebSocket connections |
| `isConnected()` | WS connection state |
| `getMarkets()` | `info.meta()` → universe array |
| `getMarketInfo(symbol)` | `info.meta()` filtered by symbol |
| `getCandles(symbol, ...)` | `info.candleSnapshot()` or WS candle subscription |
| `getOrderBook(symbol)` | `info.l2Book()` |
| `getTicker(symbol)` | `info.allMids()` or derived from order book |
| `placeOrder(order)` | `exchange.placeOrder()` |
| `cancelOrder(orderId)` | `exchange.cancelOrder()` |
| `cancelAllOrders(symbol)` | `exchange.cancelAllOrders()` |
| `getOrder(orderId)` | `info.orderStatus()` |
| `getOpenOrders(symbol)` | `info.openOrders()` |
| `getBalances()` | `info.clearinghouseState()` |
| `getPositions()` | `info.clearinghouseState()` → positions |

| IPerpsAdapter Method | Hyperliquid SDK Equivalent |
|---------------------|---------------------------|
| `getFundingRate(symbol)` | `info.fundingHistory()` or `info.meta()` |
| `setLeverage(symbol, lev)` | `exchange.updateLeverage()` |
| `getLeverage(symbol)` | `info.clearinghouseState()` → positions |
| `getPortfolioSummary()` | `info.clearinghouseState()` → account summary |
| `getPerpsSymbols()` | `info.meta()` → universe |
| `isPerpsSymbol(symbol)` | Check against universe list |

Document any gaps. If the SDK doesn't support a method, implement a workaround or mark as unsupported with graceful degradation.

---

## Step 1: Create Adapter Directory Structure

```
atlas/apps/core-node/src/exchanges/hyperliquid/
├── index.ts                    # Main HyperliquidAdapter class
├── types.ts                    # Hyperliquid-specific types and mappings
├── websocket-handler.ts        # WS subscription management
├── order-mapper.ts             # Map between adapter types and SDK types
└── __tests__/
    ├── sdk-eval.test.ts        # SDK evaluation (from Step 0A)
    ├── adapter.test.ts         # Unit tests for the adapter
    └── order-mapper.test.ts    # Order mapping tests
```

---

## Step 2: Create Type Mappings

**Create file:** `atlas/apps/core-node/src/exchanges/hyperliquid/types.ts`

```typescript
/**
 * Hyperliquid-specific types and mapping utilities.
 *
 * Maps between the Apex Automata universal adapter types
 * (from exchanges/types.ts) and Hyperliquid SDK types.
 */

import {
  OrderSide,
  OrderType,
  OrderStatus,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterPosition,
  AdapterBalance,
  AdapterMarketInfo,
  AdapterCandle,
  AdapterOrderBook,
  AdapterTicker,
  AdapterFundingRate,
  AdapterPortfolioSummary,
} from '../types';

// ============ Symbol Mapping ============

/**
 * Map Apex Automata symbol format to Hyperliquid format.
 * Apex: 'ETH-USD' → Hyperliquid: 'ETH'
 * Hyperliquid perpetuals use base asset only (no quote suffix).
 */
export function toHyperliquidSymbol(apexSymbol: string): string {
  // ETH-USD → ETH, BTC-USD → BTC, SOL-USD → SOL
  return apexSymbol.split('-')[0];
}

/**
 * Map Hyperliquid symbol back to Apex Automata format.
 * Hyperliquid: 'ETH' → Apex: 'ETH-USD'
 */
export function fromHyperliquidSymbol(hlSymbol: string): string {
  return `${hlSymbol}-USD`;
}

// ============ Order Side Mapping ============

export function toHyperliquidSide(side: OrderSide): boolean {
  // Hyperliquid uses isBuy: true/false
  return side === 'buy';
}

export function fromHyperliquidSide(isBuy: boolean): OrderSide {
  return isBuy ? 'buy' : 'sell';
}

// ============ Order Type Mapping ============

/**
 * Hyperliquid order types:
 * - Limit: { limit: { tif: 'Gtc' | 'Ioc' | 'Alo' } }
 * - Market: { limit: { tif: 'Ioc' } } with aggressive pricing
 * - Stop: { trigger: { triggerPx, isMarket, tpsl } }
 *
 * NOTE: Hyperliquid doesn't have native market orders.
 * Market orders are simulated as IOC limit orders at aggressive prices.
 */
export function toHyperliquidOrderType(type: OrderType): string {
  switch (type) {
    case 'market': return 'ioc_limit'; // Simulated market via IOC
    case 'limit': return 'limit';
    case 'stop_limit': return 'stop_limit';
    default: return 'limit';
  }
}

// ============ Order Status Mapping ============

export function fromHyperliquidStatus(status: string): OrderStatus {
  switch (status.toLowerCase()) {
    case 'open':
    case 'resting': return 'open';
    case 'filled': return 'filled';
    case 'partially_filled': return 'partially_filled';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'rejected': return 'rejected';
    case 'expired': return 'expired';
    default: return 'pending';
  }
}

// ============ Config ============

export interface HyperliquidConfig {
  /** Use testnet (api.hyperliquid-testnet.xyz) or mainnet */
  testnet: boolean;
  /** Private key (hex string) for signing — required for trading */
  privateKey?: string;
  /** Wallet address for public data queries */
  walletAddress?: string;
  /** WebSocket reconnection settings */
  wsReconnect?: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

export const DEFAULT_HYPERLIQUID_CONFIG: HyperliquidConfig = {
  testnet: true, // SAFETY: default to testnet
  wsReconnect: {
    maxRetries: Infinity,
    baseDelayMs: 1000,
    maxDelayMs: 30000,
  },
};
```

---

## Step 3: Create Main Adapter Class

**Create file:** `atlas/apps/core-node/src/exchanges/hyperliquid/index.ts`

This is the core implementation. The adapter must implement both `IExchangeAdapter` and `IPerpsAdapter`.

```typescript
/**
 * Hyperliquid Exchange Adapter
 *
 * Implements IExchangeAdapter + IPerpsAdapter for the Hyperliquid
 * perpetual futures DEX using the nomeida/hyperliquid SDK.
 *
 * Key differences from Coinbase:
 * - All products are perpetual futures (no spot)
 * - No native market orders (use IOC limit at aggressive price)
 * - Symbol format is base-only: 'ETH' not 'ETH-USD'
 * - Auth via Ethereum private key signing, not API key/secret
 * - Funding rates settle every 1h (vs 8h on most CEXs)
 * - Cross-margin by default
 *
 * Production checklist before going live:
 * [ ] Testnet paper trading validated for 2+ weeks
 * [ ] Funding rate handling tested with real settlements
 * [ ] Liquidation buffer verified against real margin requirements
 * [ ] Rate limiter calibrated to Hyperliquid's limits
 * [ ] WebSocket reconnection tested across network interruptions
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import {
  IExchangeAdapter,
  IPerpsAdapter,
  ExchangeCredentials,
  ExchangeType,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterPosition,
  AdapterBalance,
  AdapterMarketInfo,
  AdapterCandle,
  AdapterOrderBook,
  AdapterTicker,
  AdapterFundingRate,
  AdapterPortfolioSummary,
} from '../types';
import {
  HyperliquidConfig,
  DEFAULT_HYPERLIQUID_CONFIG,
  toHyperliquidSymbol,
  fromHyperliquidSymbol,
  toHyperliquidSide,
  fromHyperliquidSide,
  fromHyperliquidStatus,
} from './types';

export class HyperliquidAdapter extends EventEmitter implements IExchangeAdapter, IPerpsAdapter {
  // ---- Identity ----
  readonly id = 'hyperliquid';
  readonly name = 'Hyperliquid Perpetual DEX';
  readonly exchangeType: ExchangeType = 'perpetual';

  // ---- Internal State ----
  private logger: Logger;
  private config: HyperliquidConfig;
  private sdk: any; // Typed after SDK evaluation in Step 0
  private connected = false;
  private marketCache: Map<string, AdapterMarketInfo> = new Map();

  constructor(logger: Logger, config?: Partial<HyperliquidConfig>) {
    super();
    this.logger = logger;
    this.config = { ...DEFAULT_HYPERLIQUID_CONFIG, ...config };
  }

  // ============ Lifecycle ============

  async initialize(credentials: ExchangeCredentials): Promise<void> {
    this.logger.info('Initializing Hyperliquid adapter', {
      testnet: this.config.testnet,
      hasPrivateKey: !!credentials.privateKey,
    });

    // TODO: Import SDK and instantiate
    // const { Hyperliquid } = await import('hyperliquid');
    // this.sdk = new Hyperliquid({
    //   privateKey: credentials.privateKey,
    //   testnet: this.config.testnet,
    // });

    // Load market metadata
    await this.refreshMarketCache();
    this.connected = true;
    this.emit('connected');

    this.logger.info(`Hyperliquid adapter initialized with ${this.marketCache.size} markets`);
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Hyperliquid adapter');
    // TODO: Close WS connections
    // await this.sdk?.disconnect();
    this.connected = false;
    this.emit('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ============ Market Data ============

  async getMarkets(): Promise<AdapterMarketInfo[]> {
    return Array.from(this.marketCache.values());
  }

  async getMarketInfo(symbol: string): Promise<AdapterMarketInfo> {
    const hlSymbol = toHyperliquidSymbol(symbol);
    const cached = this.marketCache.get(hlSymbol);
    if (cached) return cached;
    throw new Error(`Market not found: ${symbol} (HL: ${hlSymbol})`);
  }

  async getCandles(
    symbol: string,
    granularity: string,
    start?: number,
    end?: number
  ): Promise<AdapterCandle[]> {
    const hlSymbol = toHyperliquidSymbol(symbol);
    // TODO: SDK call
    // const candles = await this.sdk.info.candleSnapshot(hlSymbol, granularity, start, end);
    // return candles.map(c => ({
    //   timestamp: c.t,
    //   open: parseFloat(c.o),
    //   high: parseFloat(c.h),
    //   low: parseFloat(c.l),
    //   close: parseFloat(c.c),
    //   volume: parseFloat(c.v),
    // }));
    return []; // Placeholder
  }

  async getOrderBook(symbol: string, depth?: number): Promise<AdapterOrderBook> {
    const hlSymbol = toHyperliquidSymbol(symbol);
    // TODO: SDK call — this.sdk.info.l2Book(hlSymbol)
    return { symbol, bids: [], asks: [], timestamp: Date.now() }; // Placeholder
  }

  async getTicker(symbol: string): Promise<AdapterTicker> {
    const hlSymbol = toHyperliquidSymbol(symbol);
    // TODO: SDK call — this.sdk.info.allMids()
    return { symbol, bid: '0', ask: '0', last: '0', volume: '0', timestamp: Date.now() }; // Placeholder
  }

  // ============ Trading ============

  async placeOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    if (!this.connected) throw new Error('Adapter not connected');

    const hlSymbol = toHyperliquidSymbol(order.symbol);
    const isBuy = toHyperliquidSide(order.side);

    this.logger.info('Placing Hyperliquid order', {
      symbol: hlSymbol,
      side: order.side,
      type: order.type,
      size: order.size,
      price: order.price,
    });

    // TODO: SDK call
    // For market orders: use IOC limit at aggressive price (e.g., +/- 1% from mid)
    // For limit orders: use GTC limit
    //
    // const result = await this.sdk.exchange.placeOrder({
    //   coin: hlSymbol,
    //   isBuy,
    //   sz: parseFloat(order.size),
    //   limitPx: parseFloat(order.price || '0'),
    //   orderType: { limit: { tif: order.type === 'market' ? 'Ioc' : 'Gtc' } },
    //   reduceOnly: order.reduceOnly || false,
    // });

    // Return standardized result
    return {
      orderId: '', // from SDK response
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: 'pending',
      size: order.size,
      filledSize: '0',
      avgFillPrice: '0',
      fees: '0',
      feeCurrency: 'USDC',
      timestamp: Date.now(),
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    // TODO: SDK call — this.sdk.exchange.cancelOrder(orderId)
    return false; // Placeholder
  }

  async cancelAllOrders(symbol?: string): Promise<number> {
    // TODO: SDK call
    return 0; // Placeholder
  }

  async getOrder(orderId: string): Promise<AdapterOrderResult> {
    // TODO: SDK call — this.sdk.info.orderStatus(orderId)
    throw new Error('Not implemented');
  }

  async getOpenOrders(symbol?: string): Promise<AdapterOrderResult[]> {
    // TODO: SDK call — this.sdk.info.openOrders(walletAddress)
    return []; // Placeholder
  }

  // ============ Account ============

  async getBalances(): Promise<AdapterBalance[]> {
    // TODO: SDK call — this.sdk.info.clearinghouseState(walletAddress)
    return []; // Placeholder
  }

  async getPositions(): Promise<AdapterPosition[]> {
    // TODO: SDK call — this.sdk.info.clearinghouseState(walletAddress)
    return []; // Placeholder
  }

  // ============ WebSocket Subscriptions ============

  async subscribeOrderBook(symbol: string): Promise<void> {
    // TODO: SDK WS subscription
  }

  async subscribeTicker(symbol: string): Promise<void> {
    // TODO: SDK WS subscription
  }

  async subscribeTrades(symbol: string): Promise<void> {
    // TODO: SDK WS subscription
  }

  async subscribeUserOrders(): Promise<void> {
    // TODO: SDK WS subscription for fills and order updates
  }

  async unsubscribeAll(): Promise<void> {
    // TODO: Cleanup all WS subscriptions
  }

  // ============ IPerpsAdapter ============

  async getFundingRate(symbol: string): Promise<AdapterFundingRate | null> {
    const hlSymbol = toHyperliquidSymbol(symbol);
    // TODO: SDK call — this.sdk.info.fundingHistory(hlSymbol)
    return null; // Placeholder
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    const hlSymbol = toHyperliquidSymbol(symbol);
    // TODO: SDK call — this.sdk.exchange.updateLeverage(hlSymbol, leverage)
    return false; // Placeholder
  }

  async getLeverage(symbol: string): Promise<number | null> {
    // TODO: Derive from clearinghouseState positions
    return null; // Placeholder
  }

  async getPortfolioSummary(): Promise<AdapterPortfolioSummary | null> {
    // TODO: SDK call — this.sdk.info.clearinghouseState(walletAddress)
    return null; // Placeholder
  }

  async getPerpsSymbols(): Promise<string[]> {
    return Array.from(this.marketCache.keys()).map(fromHyperliquidSymbol);
  }

  isPerpsSymbol(symbol: string): boolean {
    const hlSymbol = toHyperliquidSymbol(symbol);
    return this.marketCache.has(hlSymbol);
  }

  // ============ Private Helpers ============

  private async refreshMarketCache(): Promise<void> {
    // TODO: SDK call — this.sdk.info.meta()
    // Parse universe array into AdapterMarketInfo objects
    // Cache by Hyperliquid symbol (e.g., 'ETH')
    this.logger.info('Refreshed Hyperliquid market cache');
  }
}
```

**IMPORTANT:** The TODO comments mark every place where SDK calls need to be wired in. The adapter skeleton is complete and type-safe against `IExchangeAdapter + IPerpsAdapter`. Cursor should fill in the SDK calls based on the `hyperliquid` npm package API surface.

---

## Step 4: Register Adapter in Exchange Registry

**File:** `atlas/apps/core-node/src/exchanges/exchange-registry.ts`

Add the Hyperliquid adapter as a registered exchange option:

```typescript
import { HyperliquidAdapter } from './hyperliquid';

// In the registry initialization:
// registry.register('hyperliquid', (logger, config) => new HyperliquidAdapter(logger, config));
```

---

## Step 5: Add Hyperliquid Configuration to Guardrails

**File:** `atlas/config/guardrails.yaml`

Add a new section (do NOT modify existing sections):

```yaml
# Hyperliquid Perpetual Futures Configuration
# Applies when trading via 'hyperliquid' adapter
hyperliquid:
  testnet: true                    # SAFETY: default to testnet
  risk_per_trade: 0.03             # 3% per trade (quarter-Kelly)
  default_leverage: 3
  max_leverage: 5
  maker_fee: 0.0002                # 0.02% maker
  taker_fee: 0.0005                # 0.05% taker
  funding_check_interval_sec: 300

# Per-symbol Hyperliquid configuration
hyperliquid_symbols:
  ETH-USD:
    max_notional_usd: 3000
    max_daily_loss_usd: 200
    strategy_overrides:
      trend_follow:
        emaFast: 12
        emaSlow: 15
        stopAtr: 2.5
        takeProfitAtr: 5.0
      momentum:
        rsiPeriod: 10
        rsiOversold: 40
        rsiOverbought: 55
        macdFast: 8
        macdSlow: 21
        macdSignal: 5
        stopAtr: 2.0
        takeProfitAtr: 4.0
  BTC-USD:
    max_notional_usd: 3000
    max_daily_loss_usd: 200
    strategy_overrides:
      trend_follow:
        emaFast: 12
        emaSlow: 26
        stopAtr: 2.0
        takeProfitAtr: 4.0
```

---

## Step 6: Create Adapter Unit Tests

**Create file:** `atlas/apps/core-node/src/exchanges/hyperliquid/__tests__/adapter.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HyperliquidAdapter } from '../index';
import { Logger } from '../../../core/logger';

describe('HyperliquidAdapter', () => {
  let adapter: HyperliquidAdapter;
  let logger: Logger;

  beforeEach(() => {
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any;
    adapter = new HyperliquidAdapter(logger, { testnet: true });
  });

  it('has correct identity', () => {
    expect(adapter.id).toBe('hyperliquid');
    expect(adapter.exchangeType).toBe('perpetual');
  });

  it('defaults to not connected', () => {
    expect(adapter.isConnected()).toBe(false);
  });

  it('emits connected event on initialize', async () => {
    const connectedSpy = vi.fn();
    adapter.on('connected', connectedSpy);
    await adapter.initialize({ privateKey: 'test-key' });
    expect(adapter.isConnected()).toBe(true);
    expect(connectedSpy).toHaveBeenCalledOnce();
  });

  it('emits disconnected event on shutdown', async () => {
    await adapter.initialize({ privateKey: 'test-key' });
    const disconnectedSpy = vi.fn();
    adapter.on('disconnected', disconnectedSpy);
    await adapter.shutdown();
    expect(adapter.isConnected()).toBe(false);
    expect(disconnectedSpy).toHaveBeenCalledOnce();
  });

  it('rejects placeOrder when not connected', async () => {
    await expect(adapter.placeOrder({
      symbol: 'ETH-USD',
      side: 'buy',
      type: 'limit',
      size: '0.1',
      price: '3500',
    })).rejects.toThrow('not connected');
  });
});
```

---

## Step 7: Wire into Adapter Factory (Paper Mode First)

**File:** `atlas/apps/core-node/src/trading/execution/adapter-factory.ts`

Add Hyperliquid as an exchange option. For paper mode, the existing `PaperExecutionAdapter` already works with any symbol — just add Hyperliquid product specs.

```typescript
// Add to imports:
import { HyperliquidAdapter } from '../../exchanges/hyperliquid';

// Add Hyperliquid product specs:
export const HYPERLIQUID_PRODUCT_SPECS: Record<string, ProductSpec> = {
  'ETH-USD': {
    ...DEFAULT_ETH_USD_SPEC,
    makerFee: 0.0002,  // 0.02%
    takerFee: 0.0005,  // 0.05%
  },
  'BTC-USD': {
    ...DEFAULT_BTC_USD_SPEC,
    makerFee: 0.0002,
    takerFee: 0.0005,
  },
  'SOL-USD': {
    ...DEFAULT_SOL_USD_SPEC,
    makerFee: 0.0002,
    takerFee: 0.0005,
  },
};
```

---

## Verification Script

Create `CURSOR_TASKS/verify/verify_007.sh`:

```bash
#!/usr/bin/env bash
set -e

echo "=== TASK_007 Verification ==="

# Check directory structure
echo -n "1. Hyperliquid adapter directory created... "
if [ -d "atlas/apps/core-node/src/exchanges/hyperliquid" ]; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check main adapter file
echo -n "2. HyperliquidAdapter class exists... "
if grep -q "class HyperliquidAdapter" atlas/apps/core-node/src/exchanges/hyperliquid/index.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check implements IExchangeAdapter
echo -n "3. Implements IExchangeAdapter... "
if grep -q "implements.*IExchangeAdapter" atlas/apps/core-node/src/exchanges/hyperliquid/index.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check implements IPerpsAdapter
echo -n "4. Implements IPerpsAdapter... "
if grep -q "IPerpsAdapter" atlas/apps/core-node/src/exchanges/hyperliquid/index.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check types file
echo -n "5. Type mappings created... "
if [ -f "atlas/apps/core-node/src/exchanges/hyperliquid/types.ts" ]; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check hyperliquid is in package.json
echo -n "6. hyperliquid SDK in dependencies... "
if grep -q "hyperliquid" atlas/apps/core-node/package.json; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check guardrails has hyperliquid section
echo -n "7. Hyperliquid config in guardrails.yaml... "
if grep -q "hyperliquid:" atlas/config/guardrails.yaml; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check testnet default
echo -n "8. Testnet is default (safety check)... "
if grep -q "testnet: true" atlas/apps/core-node/src/exchanges/hyperliquid/types.ts; then
  echo "PASS"
else
  echo "FAIL — testnet must default to true"
  exit 1
fi

echo ""
echo "=== All TASK_007 checks passed ==="
```

---

## Execution Order

1. **Step 0A** — Install SDK, create eval test, verify imports and API surface
2. **Step 0B** — Map SDK methods to IExchangeAdapter (documentation only)
3. **Step 2** — Create type mappings
4. **Step 3** — Create adapter skeleton with TODO marks
5. **Step 3 (fill)** — Wire SDK calls into all TODO marks
6. **Step 4** — Register in exchange registry
7. **Step 5** — Add guardrails config
8. **Step 6** — Create and run adapter unit tests
9. **Step 7** — Wire into adapter factory

**GATING CRITERIA before moving to live:** 2+ weeks of paper trading using Hyperliquid testnet with real market data, verifying that the adapter produces identical `BrokerOrderEvent` shapes to the Coinbase adapter.
