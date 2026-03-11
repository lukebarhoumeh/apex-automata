# TASK 001 — Phase 4A: Exchange Abstraction Layer

## Priority: CRITICAL PATH (blocks Hyperliquid integration)
## Estimated time: 30-45 minutes
## Files to create: 4 new files
## Files to modify: 1 existing file
## Reference: IMPLEMENTATION_PLAN.md sections 4.1-4.6

---

## Objective

Decouple the trading engine from Coinbase-specific code by introducing a universal exchange adapter interface. This is the foundation that Hyperliquid (and any future exchange) will plug into.

---

## Step 1: Create IExchangeAdapter Interface

**New file:** `atlas/apps/core-node/src/exchanges/types.ts`

> **NOTE:** There is already a `types.ts` inside `exchanges/coinbase/types.ts` — that's the Coinbase-specific types. This new file goes ONE level up at `exchanges/types.ts` and defines the UNIVERSAL exchange interface.

```typescript
import { EventEmitter } from 'events';

// ============ Enums & Primitives ============

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop_limit';
export type OrderStatus = 'pending' | 'open' | 'filled' | 'partially_filled' | 'cancelled' | 'expired' | 'rejected';
export type ExchangeType = 'spot' | 'perpetual';

// ============ Credentials ============

/** Generic credential map — each exchange defines what keys it needs */
export interface ExchangeCredentials {
  [key: string]: string;
}

// ============ Order Types ============

/** Standardized order request across all exchanges */
export interface AdapterOrderRequest {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size: string;              // decimal string for precision
  price?: string;            // limit price (required for limit orders)
  stopPrice?: string;        // stop trigger price
  clientOrderId?: string;    // client-assigned ID for tracking
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;      // perpetuals only — close position only
  leverage?: number;         // perpetuals only — position leverage
}

/** Standardized order result from any exchange */
export interface AdapterOrderResult {
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  size: string;              // requested size
  filledSize: string;        // how much was filled
  avgFillPrice: string;      // volume-weighted average fill price
  fees: string;              // total fees paid
  feeCurrency: string;       // currency fees were paid in
  timestamp: number;         // unix ms
  raw?: unknown;             // original exchange response for debugging
}

// ============ Position & Balance ============

/** Open position (perpetuals) or holding (spot) */
export interface AdapterPosition {
  symbol: string;
  side: OrderSide;
  size: string;
  entryPrice: string;
  markPrice: string;
  unrealizedPnl: string;
  liquidationPrice?: string;   // perpetuals only
  leverage?: number;           // perpetuals only
  marginUsed?: string;         // perpetuals only
}

/** Account balance for a single currency */
export interface AdapterBalance {
  currency: string;
  available: string;           // free to trade
  held: string;                // locked in open orders
  total: string;               // available + held
}

// ============ Market Data ============

/** Static market/instrument info */
export interface AdapterMarketInfo {
  symbol: string;              // e.g., 'ETH-USD', 'ETH-USDC'
  baseCurrency: string;        // e.g., 'ETH'
  quoteCurrency: string;       // e.g., 'USD'
  minOrderSize: string;
  maxOrderSize: string;
  tickSize: string;            // minimum price increment
  stepSize: string;            // minimum size increment
  makerFee: string;            // as decimal, e.g., '0.0002'
  takerFee: string;            // as decimal, e.g., '0.0005'
  exchangeType: ExchangeType;
  maxLeverage?: number;        // perpetuals only
}

/** Standard OHLCV candle */
export interface AdapterCandle {
  timestamp: number;           // unix ms, open time
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Order book snapshot */
export interface AdapterOrderBook {
  symbol: string;
  bids: [string, string][];   // [price, size] sorted best-first
  asks: [string, string][];   // [price, size] sorted best-first
  timestamp: number;
}

/** Ticker snapshot */
export interface AdapterTicker {
  symbol: string;
  bid: string;
  ask: string;
  last: string;
  volume: string;              // 24h volume
  timestamp: number;
}

// ============ The Adapter Interface ============

/**
 * Universal exchange adapter interface.
 * Every exchange (Coinbase, Hyperliquid, Kraken, etc.) implements this.
 * The trading engine talks ONLY to this interface — never to exchange-specific code.
 *
 * Events emitted:
 * - 'orderbook:update'  → AdapterOrderBook
 * - 'ticker:update'     → AdapterTicker
 * - 'trade:update'      → { symbol, price, size, side, timestamp }
 * - 'order:update'      → AdapterOrderResult
 * - 'error'             → Error
 * - 'connected'         → void
 * - 'disconnected'      → void
 */
export interface IExchangeAdapter extends EventEmitter {
  // ---- Identity ----

  /** Unique exchange identifier (e.g., 'coinbase', 'hyperliquid') */
  readonly id: string;

  /** Human-readable name (e.g., 'Coinbase Advanced Trade') */
  readonly name: string;

  /** Whether this is a spot or perpetual exchange */
  readonly exchangeType: ExchangeType;

  // ---- Lifecycle ----

  /** Initialize the adapter with credentials and connect */
  initialize(credentials: ExchangeCredentials): Promise<void>;

  /** Gracefully shut down all connections */
  shutdown(): Promise<void>;

  /** Check if the adapter is connected and operational */
  isConnected(): boolean;

  // ---- Market Data ----

  /** Get all tradable markets/instruments */
  getMarkets(): Promise<AdapterMarketInfo[]>;

  /** Get info for a specific market */
  getMarketInfo(symbol: string): Promise<AdapterMarketInfo>;

  /** Get historical candles */
  getCandles(symbol: string, granularity: string, start?: number, end?: number): Promise<AdapterCandle[]>;

  /** Get current order book snapshot */
  getOrderBook(symbol: string, depth?: number): Promise<AdapterOrderBook>;

  /** Get current ticker */
  getTicker(symbol: string): Promise<AdapterTicker>;

  // ---- Trading ----

  /** Place an order */
  placeOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult>;

  /** Cancel a specific order by exchange order ID */
  cancelOrder(orderId: string): Promise<boolean>;

  /** Cancel all open orders, optionally filtered by symbol. Returns count cancelled. */
  cancelAllOrders(symbol?: string): Promise<number>;

  /** Get current status of an order */
  getOrder(orderId: string): Promise<AdapterOrderResult>;

  /** Get all open orders, optionally filtered by symbol */
  getOpenOrders(symbol?: string): Promise<AdapterOrderResult[]>;

  // ---- Account ----

  /** Get all currency balances */
  getBalances(): Promise<AdapterBalance[]>;

  /** Get open positions. Spot exchanges return []. */
  getPositions(): Promise<AdapterPosition[]>;

  // ---- WebSocket Subscriptions ----

  /** Subscribe to order book updates for a symbol */
  subscribeOrderBook(symbol: string): Promise<void>;

  /** Subscribe to ticker updates for a symbol */
  subscribeTicker(symbol: string): Promise<void>;

  /** Subscribe to public trade feed for a symbol */
  subscribeTrades(symbol: string): Promise<void>;

  /** Subscribe to private order/fill updates */
  subscribeUserOrders(): Promise<void>;

  /** Unsubscribe from all WebSocket channels */
  unsubscribeAll(): Promise<void>;
}
```

---

## Step 2: Create ExchangeRegistry

**New file:** `atlas/apps/core-node/src/exchanges/exchange-registry.ts`

```typescript
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { IExchangeAdapter } from './types';

/**
 * Singleton registry that manages exchange adapter instances.
 * The trading engine uses this to get the active exchange adapter.
 *
 * Events:
 * - 'adapter:registered'       → { id: string }
 * - 'adapter:removed'          → { id: string }
 * - 'adapter:default-changed'  → { id: string }
 */
export class ExchangeRegistry extends EventEmitter {
  private adapters: Map<string, IExchangeAdapter> = new Map();
  private defaultAdapterId: string | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  /**
   * Register an exchange adapter.
   * @throws if an adapter with the same ID is already registered
   */
  register(adapter: IExchangeAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Exchange adapter '${adapter.id}' is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    this.logger.info(`Exchange adapter registered: ${adapter.id} (${adapter.name})`);

    // First registered adapter becomes default
    if (!this.defaultAdapterId) {
      this.defaultAdapterId = adapter.id;
      this.logger.info(`Default exchange set to: ${adapter.id}`);
      this.emit('adapter:default-changed', { id: adapter.id });
    }

    this.emit('adapter:registered', { id: adapter.id });
  }

  /**
   * Get an adapter by ID.
   * @throws if adapter not found
   */
  get(exchangeId: string): IExchangeAdapter {
    const adapter = this.adapters.get(exchangeId);
    if (!adapter) {
      throw new Error(`Exchange adapter '${exchangeId}' not found. Registered: [${Array.from(this.adapters.keys()).join(', ')}]`);
    }
    return adapter;
  }

  /**
   * Get the default exchange adapter.
   * @throws if no default is set
   */
  getDefault(): IExchangeAdapter {
    if (!this.defaultAdapterId) {
      throw new Error('No default exchange adapter set');
    }
    return this.get(this.defaultAdapterId);
  }

  /**
   * Set the default exchange adapter.
   * @throws if adapter not registered
   */
  setDefault(exchangeId: string): void {
    if (!this.adapters.has(exchangeId)) {
      throw new Error(`Cannot set default: adapter '${exchangeId}' not registered`);
    }
    this.defaultAdapterId = exchangeId;
    this.logger.info(`Default exchange changed to: ${exchangeId}`);
    this.emit('adapter:default-changed', { id: exchangeId });
  }

  /** Get all registered adapters */
  getAll(): Map<string, IExchangeAdapter> {
    return new Map(this.adapters);
  }

  /** Check if an adapter is registered */
  has(exchangeId: string): boolean {
    return this.adapters.has(exchangeId);
  }

  /** Get the default adapter ID (or null if none set) */
  getDefaultId(): string | null {
    return this.defaultAdapterId;
  }

  /**
   * Remove an adapter from the registry.
   * If it was the default, clears the default.
   */
  remove(exchangeId: string): void {
    if (!this.adapters.has(exchangeId)) {
      this.logger.warn(`Cannot remove: adapter '${exchangeId}' not found`);
      return;
    }
    this.adapters.delete(exchangeId);
    if (this.defaultAdapterId === exchangeId) {
      this.defaultAdapterId = null;
      this.logger.warn(`Default exchange cleared (removed adapter was the default)`);
    }
    this.logger.info(`Exchange adapter removed: ${exchangeId}`);
    this.emit('adapter:removed', { id: exchangeId });
  }

  /**
   * Gracefully shut down all registered adapters.
   */
  async shutdown(): Promise<void> {
    this.logger.info(`Shutting down ${this.adapters.size} exchange adapter(s)...`);
    const shutdowns = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        await adapter.shutdown();
        this.logger.info(`Adapter '${adapter.id}' shut down successfully`);
      } catch (error) {
        this.logger.error(`Error shutting down adapter '${adapter.id}':`, error);
      }
    });
    await Promise.allSettled(shutdowns);
    this.adapters.clear();
    this.defaultAdapterId = null;
    this.logger.info('All exchange adapters shut down');
  }
}
```

---

## Step 3: Create CoinbaseAdapter (Wrapper)

**New file:** `atlas/apps/core-node/src/exchanges/coinbase-adapter.ts`

This is a **WRAPPER** around the existing `CoinbaseExchange` class. Do NOT rewrite any Coinbase internals.

Key implementation notes:
- Import `CoinbaseExchange` from `./coinbase`
- Import all adapter types from `./types`
- `id = 'coinbase'`, `name = 'Coinbase Advanced Trade'`, `exchangeType = 'spot'`
- Map Coinbase-specific types to adapter types (e.g., `CoinbaseOrder` → `AdapterOrderResult`)
- Bridge Coinbase events to adapter event format
- `getPositions()` returns `[]` (spot exchange, no perpetual positions)
- Handle Coinbase product_id format (e.g., 'BTC-USD')
- `initialize()` should call `this.exchange.connect()`
- `shutdown()` should call `this.exchange.disconnect()`

```typescript
import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { CoinbaseExchange } from './coinbase';
import { CoinbaseConfig, CoinbaseOrder, OrderRequest as CoinbaseOrderRequest, Fill, Ticker as CoinbaseTicker } from './coinbase/types';
import {
  IExchangeAdapter,
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
  OrderStatus,
} from './types';

/**
 * Coinbase adapter — wraps existing CoinbaseExchange to implement IExchangeAdapter.
 * This is a THIN wrapper. All logic stays in the original CoinbaseExchange class.
 */
export class CoinbaseAdapter extends EventEmitter implements IExchangeAdapter {
  readonly id = 'coinbase';
  readonly name = 'Coinbase Advanced Trade';
  readonly exchangeType: ExchangeType = 'spot';

  private exchange: CoinbaseExchange;
  private logger: Logger;
  private _connected: boolean = false;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
    // Exchange will be initialized in initialize()
    this.exchange = null as any;
  }

  // ---- Lifecycle ----

  async initialize(credentials: ExchangeCredentials): Promise<void> {
    const config: CoinbaseConfig = {
      apiKey: credentials.apiKey || '',
      apiSecret: credentials.apiSecret || '',
      apiPassphrase: credentials.apiPassphrase,
      environment: (credentials.environment as 'production' | 'sandbox') || 'production',
      wsUrl: credentials.wsUrl || 'wss://advanced-trade-ws.coinbase.com',
      restUrl: credentials.restUrl || 'https://api.coinbase.com',
    };

    this.exchange = new CoinbaseExchange(config, this.logger);
    this.bridgeEvents();
    await this.exchange.connect();
    this._connected = true;
    this.logger.info('CoinbaseAdapter initialized and connected');
  }

  async shutdown(): Promise<void> {
    if (this.exchange) {
      this.exchange.disconnect();
      this._connected = false;
      this.logger.info('CoinbaseAdapter shut down');
    }
  }

  isConnected(): boolean {
    return this._connected && (this.exchange?.isConnected() ?? false);
  }

  // ---- Event Bridging ----

  private bridgeEvents(): void {
    this.exchange.on('ticker', (ticker: CoinbaseTicker) => {
      this.emit('ticker:update', {
        symbol: ticker.product_id,
        bid: ticker.best_bid,
        ask: ticker.best_ask,
        last: ticker.price,
        volume: ticker.volume_24h,
        timestamp: new Date(ticker.time).getTime(),
      } as AdapterTicker);
    });

    this.exchange.on('orderbook', (ob: any) => {
      this.emit('orderbook:update', {
        symbol: ob.product_id || '',
        bids: ob.bids || [],
        asks: ob.asks || [],
        timestamp: Date.now(),
      } as AdapterOrderBook);
    });

    this.exchange.on('order', (order: CoinbaseOrder) => {
      this.emit('order:update', this.mapOrderToResult(order));
    });

    this.exchange.on('connected', () => {
      this._connected = true;
      this.emit('connected');
    });

    this.exchange.on('disconnected', () => {
      this._connected = false;
      this.emit('disconnected');
    });

    this.exchange.on('error', (error: Error) => {
      this.emit('error', error);
    });
  }

  // ---- Market Data ----

  async getMarkets(): Promise<AdapterMarketInfo[]> {
    const products = await this.exchange.getProducts();
    return products.map((p: any) => ({
      symbol: p.id || p.product_id,
      baseCurrency: p.base_currency,
      quoteCurrency: p.quote_currency,
      minOrderSize: p.base_min_size || '0',
      maxOrderSize: p.base_max_size || '999999',
      tickSize: p.quote_increment || '0.01',
      stepSize: p.base_increment || '0.00000001',
      makerFee: '0.004',    // Coinbase default, actual depends on tier
      takerFee: '0.006',    // Coinbase default
      exchangeType: 'spot' as ExchangeType,
    }));
  }

  async getMarketInfo(symbol: string): Promise<AdapterMarketInfo> {
    const product = await this.exchange.getProduct(symbol);
    return {
      symbol: product.id || (product as any).product_id,
      baseCurrency: product.base_currency,
      quoteCurrency: product.quote_currency,
      minOrderSize: product.base_min_size || '0',
      maxOrderSize: product.base_max_size || '999999',
      tickSize: product.quote_increment || '0.01',
      stepSize: product.base_increment || '0.00000001',
      makerFee: '0.004',
      takerFee: '0.006',
      exchangeType: 'spot',
    };
  }

  async getCandles(symbol: string, granularity: string, start?: number, end?: number): Promise<AdapterCandle[]> {
    const candles = await this.exchange.getCandles(symbol, {
      granularity: parseInt(granularity) || 300,
      start: start ? new Date(start).toISOString() : undefined,
      end: end ? new Date(end).toISOString() : undefined,
    });
    return candles.map((c: any) => ({
      timestamp: typeof c.time === 'number' ? c.time * 1000 : new Date(c.time).getTime(),
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      volume: parseFloat(c.volume),
    }));
  }

  async getOrderBook(symbol: string, depth?: number): Promise<AdapterOrderBook> {
    const ob = await this.exchange.getOrderBook(symbol, 2);
    return {
      symbol,
      bids: (ob.bids || []).slice(0, depth || 50),
      asks: (ob.asks || []).slice(0, depth || 50),
      timestamp: Date.now(),
    };
  }

  async getTicker(symbol: string): Promise<AdapterTicker> {
    const ticker = await this.exchange.getTicker(symbol);
    return {
      symbol,
      bid: ticker.best_bid || ticker.bid || '0',
      ask: ticker.best_ask || ticker.ask || '0',
      last: ticker.price || ticker.last || '0',
      volume: ticker.volume_24h || ticker.volume || '0',
      timestamp: Date.now(),
    };
  }

  // ---- Trading ----

  async placeOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    const coinbaseOrder: CoinbaseOrderRequest = {
      product_id: order.symbol,
      side: order.side,
      type: order.type === 'stop_limit' ? 'stop' : order.type,
      size: order.size,
      price: order.price,
      stop_price: order.stopPrice,
      time_in_force: order.timeInForce,
      client_oid: order.clientOrderId,
    };

    const result = await this.exchange.createOrder(coinbaseOrder);
    return this.mapOrderToResult(result);
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    return this.exchange.cancelOrder(orderId);
  }

  async cancelAllOrders(symbol?: string): Promise<number> {
    const cancelled = await this.exchange.cancelAllOrders(symbol);
    return cancelled.length;
  }

  async getOrder(orderId: string): Promise<AdapterOrderResult> {
    const order = await this.exchange.getOrder(orderId);
    return this.mapOrderToResult(order);
  }

  async getOpenOrders(symbol?: string): Promise<AdapterOrderResult[]> {
    const orders = await this.exchange.getOpenOrders(symbol);
    return orders.map((o) => this.mapOrderToResult(o));
  }

  // ---- Account ----

  async getBalances(): Promise<AdapterBalance[]> {
    const accounts = await this.exchange.getAccounts();
    return accounts.map((a: any) => ({
      currency: a.currency,
      available: a.available || '0',
      held: a.hold || '0',
      total: String(parseFloat(a.available || '0') + parseFloat(a.hold || '0')),
    }));
  }

  /** Spot exchange — no perpetual positions */
  async getPositions(): Promise<AdapterPosition[]> {
    return [];
  }

  // ---- WebSocket Subscriptions ----

  async subscribeOrderBook(symbol: string): Promise<void> {
    this.exchange.subscribeOrderBook([symbol]);
  }

  async subscribeTicker(symbol: string): Promise<void> {
    this.exchange.subscribeTicker([symbol]);
  }

  async subscribeTrades(symbol: string): Promise<void> {
    // Coinbase uses 'matches' channel for trades
    this.exchange.subscribe(['matches'], [symbol]);
  }

  async subscribeUserOrders(): Promise<void> {
    // Coinbase user channel is handled via order polling in CoinbaseExchange
    this.logger.info('CoinbaseAdapter: User order updates via REST polling (Coinbase pattern)');
  }

  async unsubscribeAll(): Promise<void> {
    // CoinbaseExchange handles cleanup on disconnect
    this.logger.info('CoinbaseAdapter: Unsubscribe handled via disconnect');
  }

  // ---- Internal Mapping ----

  private mapOrderToResult(order: CoinbaseOrder): AdapterOrderResult {
    return {
      orderId: order.id,
      clientOrderId: (order as any).client_oid || undefined,
      symbol: order.product_id,
      side: order.side,
      type: order.type === 'stop' ? 'stop_limit' : order.type,
      status: this.mapOrderStatus(order.status),
      size: order.size || order.funds || '0',
      filledSize: order.filled_size || '0',
      avgFillPrice: this.calcAvgPrice(order),
      fees: order.fill_fees || '0',
      feeCurrency: order.product_id.split('-')[1] || 'USD',
      timestamp: new Date(order.created_at).getTime(),
      raw: order,
    };
  }

  private mapOrderStatus(cbStatus: string): OrderStatus {
    const statusMap: Record<string, OrderStatus> = {
      'pending': 'pending',
      'open': 'open',
      'active': 'open',
      'done': 'filled',
      'canceled': 'cancelled',
      'rejected': 'rejected',
    };
    return statusMap[cbStatus] || 'pending';
  }

  private calcAvgPrice(order: CoinbaseOrder): string {
    const filled = parseFloat(order.filled_size || '0');
    const executed = parseFloat(order.executed_value || '0');
    if (filled > 0 && executed > 0) {
      return (executed / filled).toFixed(8);
    }
    return order.price || '0';
  }

  // ---- Direct Access (for backward compatibility) ----

  /**
   * Get the underlying CoinbaseExchange instance.
   * Use ONLY for features not yet abstracted (reconciler, gap filler, health).
   * This will be deprecated once those features are in the adapter interface.
   */
  getUnderlyingExchange(): CoinbaseExchange {
    return this.exchange;
  }
}
```

**IMPORTANT:** The `CoinbaseOrderRequest` type imported from coinbase/types.ts may not have `client_oid`, `stop_price`, or `time_in_force` fields. Check the actual type definition and adjust the mapping accordingly. Use `as any` if needed for fields not in the type but accepted by the REST API.

---

## Step 4: Create Barrel Export

**New file:** `atlas/apps/core-node/src/exchanges/index.ts`

> **NOTE:** There is already an `index.ts` at `exchanges/coinbase/index.ts`. This new file goes at `exchanges/index.ts` (one level up).

```typescript
// Universal exchange adapter types
export * from './types';

// Exchange registry
export { ExchangeRegistry } from './exchange-registry';

// Adapters
export { CoinbaseAdapter } from './coinbase-adapter';

// Re-export coinbase internals for backward compatibility
export { CoinbaseExchange } from './coinbase';
```

---

## Step 5: Update OrderManager for Adapter Support

**Modify file:** `atlas/apps/core-node/src/trading/order-manager.ts`

### 5a. Add imports at top of file

Add these imports alongside existing ones:

```typescript
import { IExchangeAdapter, AdapterOrderRequest, AdapterOrderResult } from '../exchanges/types';
```

### 5b. Add adapter property to class

After `private exchange: CoinbaseExchange;` (line 74), add:

```typescript
private exchangeAdapter: IExchangeAdapter | null = null;
```

### 5c. Add adapter setter method

Add this public method to the class (after the constructor):

```typescript
/**
 * Set an exchange adapter for decoupled exchange access.
 * When set, order operations use the adapter instead of direct Coinbase calls.
 * This enables multi-exchange support without modifying existing code.
 */
public setExchangeAdapter(adapter: IExchangeAdapter): void {
  this.exchangeAdapter = adapter;
  this.logger.info(`OrderManager: Exchange adapter set to '${adapter.id}'`);

  // Bridge adapter order events to existing event flow
  adapter.on('order:update', (result: AdapterOrderResult) => {
    // Map AdapterOrderResult back to CoinbaseOrder-like shape for existing handlers
    const mappedOrder: any = {
      id: result.orderId,
      product_id: result.symbol,
      side: result.side,
      type: result.type,
      status: result.status === 'filled' ? 'done' : result.status === 'cancelled' ? 'canceled' : result.status,
      filled_size: result.filledSize,
      executed_value: String(parseFloat(result.filledSize) * parseFloat(result.avgFillPrice)),
      fill_fees: result.fees,
      created_at: new Date(result.timestamp).toISOString(),
      settled: result.status === 'filled',
      size: result.size,
      price: result.avgFillPrice,
    };
    this.handleExchangeOrder(mappedOrder);
  });
}
```

### 5d. IMPORTANT — Do NOT change existing methods

The existing `createOrder`, `cancelOrder`, `getOrder` etc. methods continue to work exactly as they do now via `this.exchange` (CoinbaseExchange). The adapter is an ALTERNATIVE path that will be wired in Phase 4C when we connect the trading engine.

**Why:** This preserves backward compatibility. The engine currently calls OrderManager methods that call CoinbaseExchange directly. We're not changing that flow yet — we're just adding the adapter infrastructure so it's ready.

---

## Constraints
- Do NOT modify `exchanges/coinbase/` internals (rest-client.ts, websocket.ts, types.ts, etc.)
- Do NOT delete any existing code
- Do NOT change existing method signatures in OrderManager
- All new files must use the existing Logger pattern
- JSDoc comments on ALL public methods
- No new npm dependencies

## Files Created/Modified Summary
1. **NEW:** `atlas/apps/core-node/src/exchanges/types.ts` — IExchangeAdapter interface + all adapter types
2. **NEW:** `atlas/apps/core-node/src/exchanges/exchange-registry.ts` — ExchangeRegistry class
3. **NEW:** `atlas/apps/core-node/src/exchanges/coinbase-adapter.ts` — CoinbaseAdapter wrapper
4. **NEW:** `atlas/apps/core-node/src/exchanges/index.ts` — barrel exports (NOTE: different from coinbase/index.ts)
5. **MODIFIED:** `atlas/apps/core-node/src/trading/order-manager.ts` — added adapter import, property, setter method
