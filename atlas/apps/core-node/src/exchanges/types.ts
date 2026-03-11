/**
 * Universal Exchange Adapter Interface
 *
 * Defines the contract every exchange (Coinbase, Hyperliquid, Kraken, etc.)
 * must implement. The trading engine talks ONLY to this interface.
 */

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

// ============ Perpetual Futures Extension ============

/** Funding rate snapshot for a perpetual contract */
export interface AdapterFundingRate {
  symbol: string;
  rate: string;                          // decimal (e.g., '0.0001' = 1 bps)
  nextSettlement: number;                // unix ms
  markPrice: string;
  indexPrice: string;
}

/** Portfolio margin summary for perpetual trading */
export interface AdapterPortfolioSummary {
  totalCollateral: string;               // USD value
  unrealizedPnl: string;
  buyingPower: string;
  marginUsed: string;
  maxWithdrawal: string;
}

/**
 * Extension interface for exchanges that support perpetual futures.
 * Adapters that handle perps implement BOTH IExchangeAdapter AND IPerpsAdapter.
 * Use `isPerpsAdapter(adapter)` type guard to check capability at runtime.
 */
export interface IPerpsAdapter {
  /** Get current funding rate for a perpetual contract */
  getFundingRate(symbol: string): Promise<AdapterFundingRate | null>;

  /** Set leverage for a symbol. Returns true on success. */
  setLeverage(symbol: string, leverage: number): Promise<boolean>;

  /** Get current leverage for a symbol. Returns null if not set. */
  getLeverage(symbol: string): Promise<number | null>;

  /** Get portfolio margin summary (collateral, buying power, etc.) */
  getPortfolioSummary(): Promise<AdapterPortfolioSummary | null>;

  /** List all available perpetual futures symbols */
  getPerpsSymbols(): Promise<string[]>;

  /** Check if a symbol is a perpetual futures contract */
  isPerpsSymbol(symbol: string): boolean;
}

/**
 * Type guard to check if an adapter supports perpetual futures.
 * Usage: if (isPerpsAdapter(adapter)) { adapter.getFundingRate('BTC-PERP-INTX'); }
 */
export function isPerpsAdapter(adapter: IExchangeAdapter): adapter is IExchangeAdapter & IPerpsAdapter {
  return (
    'getFundingRate' in adapter &&
    'setLeverage' in adapter &&
    'getPerpsSymbols' in adapter &&
    typeof (adapter as any).getFundingRate === 'function'
  );
}
