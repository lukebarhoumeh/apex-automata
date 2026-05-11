/**
 * Execution Adapter Interface
 * 
 * The core abstraction that makes paper and live modes behave identically.
 * Both modes emit the same BrokerOrderEvent stream into the OrderManager.
 * 
 * Design principles:
 * 1. OrderManager owns ONE adapter instance per engine session
 * 2. All order placement/cancellation goes through the adapter
 * 3. Both adapters emit identical event shapes
 * 4. No other module should call exchange directly for orders
 */

import { EventEmitter } from 'events';
import { FeeModel } from '../../core/fee-model';

/**
 * Execution mode: paper or live
 */
export type ExecutionMode = 'paper' | 'live';

/**
 * Market data environment: production or sandbox
 */
export type MarketDataEnv = 'production' | 'sandbox';

/**
 * Execution environment: production or sandbox (only relevant for live mode)
 */
export type ExecutionEnv = 'production' | 'sandbox';

/**
 * Complete environment configuration
 */
export interface EnvironmentConfig {
  /** paper or live execution */
  executionMode: ExecutionMode;
  /** Market data source (default: production) */
  marketDataEnv: MarketDataEnv;
  /** Execution target (only for live mode, default: production) */
  executionEnv: ExecutionEnv;
}

/**
 * Default environment config - paper with production market data
 */
export const DEFAULT_ENV_CONFIG: EnvironmentConfig = {
  executionMode: 'paper',
  marketDataEnv: 'production', // Paper uses REAL market data by default
  executionEnv: 'production',
};

/**
 * Order placement request (unified for paper + live)
 */
export interface PlaceOrderRequest {
  /** Client-generated order ID for idempotency */
  clientOrderId: string;
  /** Trading pair (e.g., 'BTC-USD') */
  symbol: string;
  /** Order side */
  side: 'buy' | 'sell';
  /** Order type */
  type: 'market' | 'limit' | 'stop';
  /** Limit/stop price */
  price?: number;
  /** Stop trigger price */
  stopPrice?: number;
  /** Order quantity in base currency */
  quantity: number;
  /** Post-only flag (maker only) */
  postOnly?: boolean;
  /** Time in force */
  timeInForce?: 'GTC' | 'IOC' | 'FOK' | 'GTT';
  /** Custom metadata */
  metadata?: Record<string, any>;
}

/**
 * Order accepted event
 */
export interface OrderAcceptedEvent {
  type: 'order_accepted';
  clientOrderId: string;
  exchangeOrderId?: string;
  ts: number;
  raw?: any;
}

/**
 * Order rejected event
 */
export interface OrderRejectedEvent {
  type: 'order_rejected';
  clientOrderId: string;
  reason: string;
  code?: string;
  ts: number;
  raw?: any;
}

/**
 * Order canceled event
 */
export interface OrderCanceledEvent {
  type: 'order_canceled';
  clientOrderId: string;
  exchangeOrderId?: string;
  ts: number;
  raw?: any;
}

/**
 * Fill event (partial or complete)
 */
export interface FillEvent {
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
  raw?: any;
}

/**
 * Union of all broker events
 */
export type BrokerOrderEvent = 
  | OrderAcceptedEvent 
  | OrderRejectedEvent 
  | OrderCanceledEvent 
  | FillEvent;

/**
 * Adapter health status
 */
export interface AdapterHealth {
  ok: boolean;
  degraded: boolean;
  reasonCodes: string[];
  lastEventAt: number | null;
  pendingOrderCount: number;
}

/**
 * Execution Adapter interface
 * 
 * Both PaperExecutionAdapter and CoinbaseLiveExecutionAdapter implement this.
 * The OrderManager interacts with this interface only.
 */
export interface IExecutionAdapter extends EventEmitter {
  /** Current execution mode */
  readonly mode: ExecutionMode;

  /**
   * Start the adapter (connect to exchange, start loops)
   */
  start(): Promise<void>;

  /**
   * Stop the adapter (disconnect, cleanup)
   */
  stop(): Promise<void>;

  /**
   * Place an order
   * The adapter will emit order_accepted, order_rejected, or fill events
   */
  placeOrder(request: PlaceOrderRequest): Promise<void>;

  /**
   * Cancel an order by client order ID
   * The adapter will emit order_canceled event
   */
  cancelOrder(clientOrderId: string): Promise<void>;

  /**
   * Cancel all orders for a symbol (optional)
   */
  cancelAllOrders(symbol?: string): Promise<void>;

  /**
   * Get open orders (for reconciliation)
   */
  getOpenOrders(): Promise<OpenOrder[]>;

  /**
   * Get fills since cursor (for reconciliation)
   */
  getFillsSince(cursor: any): Promise<FillRecord[]>;

  /**
   * Register event callback
   */
  onEvent(callback: (event: BrokerOrderEvent) => void): void;

  /**
   * Get adapter health
   */
  getHealth(): AdapterHealth;
}

/**
 * Open order record
 */
export interface OpenOrder {
  clientOrderId: string;
  exchangeOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market' | 'limit' | 'stop';
  price?: number;
  quantity: number;
  filledQuantity: number;
  status: string;
  createdAt: number;
}

/**
 * Fill record for reconciliation
 */
export interface FillRecord {
  tradeId: string;
  orderId: string;
  clientOrderId?: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: number;
  size: number;
  fee: number;
  feeCurrency: string;
  liquidity: 'maker' | 'taker';
  ts: number;
}

/**
 * Product specification for order validation
 */
export interface ProductSpec {
  symbol: string;
  baseCurrency: string;
  quoteCurrency: string;
  /** Minimum order size in base currency */
  minOrderSize: number;
  /** Maximum order size in base currency */
  maxOrderSize: number;
  /** Lot size (base increment) */
  lotSize: number;
  /** Tick size (quote increment) */
  tickSize: number;
  /** Minimum notional value in quote currency */
  minNotional: number;
  /** Maker fee rate (e.g., 0.004 for 0.4%) */
  makerFee: number;
  /** Taker fee rate (e.g., 0.006 for 0.6%) */
  takerFee: number;
}

/**
 * Structural defaults for product specs — everything EXCEPT fees. Fees are
 * pulled from FeeModel (guardrails.yaml) at build time so backtest, paper,
 * and live all use one source of truth. See `buildDefaultProductSpecs`.
 */
type ProductSpecStructural = Omit<ProductSpec, 'makerFee' | 'takerFee'>;

const BTC_USD_STRUCTURAL: ProductSpecStructural = {
  symbol: 'BTC-USD',
  baseCurrency: 'BTC',
  quoteCurrency: 'USD',
  minOrderSize: 0.0001,
  maxOrderSize: 100,
  lotSize: 0.00000001,
  tickSize: 0.01,
  minNotional: 1,
};

const ETH_USD_STRUCTURAL: ProductSpecStructural = {
  symbol: 'ETH-USD',
  baseCurrency: 'ETH',
  quoteCurrency: 'USD',
  minOrderSize: 0.001,
  maxOrderSize: 1000,
  lotSize: 0.00000001,
  tickSize: 0.01,
  minNotional: 1,
};

const SOL_USD_STRUCTURAL: ProductSpecStructural = {
  symbol: 'SOL-USD',
  baseCurrency: 'SOL',
  quoteCurrency: 'USD',
  minOrderSize: 0.01,
  maxOrderSize: 10000,
  lotSize: 0.00000001,
  tickSize: 0.001,
  minNotional: 1,
};

const STRUCTURAL_DEFAULTS: Record<string, ProductSpecStructural> = {
  'BTC-USD': BTC_USD_STRUCTURAL,
  'ETH-USD': ETH_USD_STRUCTURAL,
  'SOL-USD': SOL_USD_STRUCTURAL,
};

/**
 * Build the default product spec map with fees pulled from FeeModel.
 * No code path should hardcode maker/taker fees — they live in guardrails.yaml.
 *
 * `market` selects the Coinbase fee bucket (spot vs INTX perps); default is spot.
 */
export function buildDefaultProductSpecs(
  feeModel: FeeModel,
  market: 'spot' | 'perps' = 'spot',
): Record<string, ProductSpec> {
  const makerFee = feeModel.getFeeRate('coinbase', market, 'maker');
  const takerFee = feeModel.getFeeRate('coinbase', market, 'taker');
  const out: Record<string, ProductSpec> = {};
  for (const [symbol, struct] of Object.entries(STRUCTURAL_DEFAULTS)) {
    out[symbol] = { ...struct, makerFee, takerFee };
  }
  return out;
}

/**
 * Round a value to the specified precision
 */
export function roundToIncrement(value: number, increment: number): number {
  return Math.round(value / increment) * increment;
}

/**
 * Round quantity to lot size
 */
export function roundQuantity(quantity: number, spec: ProductSpec): number {
  return roundToIncrement(quantity, spec.lotSize);
}

/**
 * Round price to tick size
 */
export function roundPrice(price: number, spec: ProductSpec): number {
  return roundToIncrement(price, spec.tickSize);
}

/**
 * Validate order against product spec
 */
export function validateOrderAgainstSpec(
  request: PlaceOrderRequest,
  spec: ProductSpec,
  currentPrice?: number
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Quantity validation
  if (request.quantity < spec.minOrderSize) {
    errors.push(`Quantity ${request.quantity} below minimum ${spec.minOrderSize}`);
  }
  if (request.quantity > spec.maxOrderSize) {
    errors.push(`Quantity ${request.quantity} exceeds maximum ${spec.maxOrderSize}`);
  }

  // Price validation for limit orders
  if (request.type === 'limit' && request.price !== undefined) {
    const priceRounded = roundPrice(request.price, spec);
    if (Math.abs(priceRounded - request.price) > spec.tickSize * 0.1) {
      errors.push(`Price ${request.price} not aligned to tick size ${spec.tickSize}`);
    }
  }

  // Notional validation
  const price = request.price || currentPrice || 0;
  const notional = request.quantity * price;
  if (notional < spec.minNotional && price > 0) {
    errors.push(`Notional ${notional.toFixed(2)} below minimum ${spec.minNotional}`);
  }

  return { valid: errors.length === 0, errors };
}
