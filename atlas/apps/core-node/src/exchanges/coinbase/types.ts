export interface CoinbaseConfig {
  apiKey: string;
  apiSecret: string;
  apiPassphrase?: string; // For legacy Coinbase Pro
  environment: 'production' | 'sandbox';
  wsUrl: string;
  restUrl: string;
}

export interface CoinbaseCredentials {
  key: string;
  secret: string;
  passphrase?: string;
}

export interface WebSocketMessage {
  type: string;
  product_id?: string;
  sequence?: number;
  time?: string;
  [key: string]: any;
}

export interface OrderBook {
  bids: Array<[string, string]>; // [price, size]
  asks: Array<[string, string]>; // [price, size]
  sequence: number;
  time: string;
}

export interface Ticker {
  type: 'ticker';
  sequence: number;
  product_id: string;
  price: string;
  open_24h: string;
  volume_24h: string;
  low_24h: string;
  high_24h: string;
  volume_30d: string;
  best_bid: string;
  best_ask: string;
  side: 'buy' | 'sell';
  time: string;
  trade_id: number;
  last_size: string;
}

export interface CoinbaseOrder {
  id: string;
  product_id: string;
  side: 'buy' | 'sell';
  stp?: 'dc' | 'co' | 'cn' | 'cb';
  type: 'limit' | 'market' | 'stop';
  post_only?: boolean;
  created_at: string;
  fill_fees: string;
  filled_size: string;
  executed_value: string;
  status: 'pending' | 'open' | 'active' | 'done' | 'canceled' | 'rejected';
  settled: boolean;
  size?: string;
  price?: string;
  time_in_force?: 'GTC' | 'GTT' | 'IOC' | 'FOK';
  stop?: 'loss' | 'entry';
  stop_price?: string;
  funds?: string;
}

export interface Fill {
  trade_id: number;
  product_id: string;
  order_id: string;
  user_id: string;
  profile_id: string;
  liquidity: 'T' | 'M';
  price: string;
  size: string;
  fee: string;
  created_at: string;
  side: 'buy' | 'sell';
  settled: boolean;
  usd_volume: string;
}

export interface Account {
  id: string;
  currency: string;
  balance: string;
  available: string;
  hold: string;
  profile_id: string;
  trading_enabled: boolean;
}

export interface Product {
  id: string;
  base_currency: string;
  quote_currency: string;
  base_min_size: string;
  base_max_size: string;
  quote_increment: string;
  base_increment: string;
  display_name: string;
  min_market_funds: string;
  max_market_funds: string;
  margin_enabled: boolean;
  post_only: boolean;
  limit_only: boolean;
  cancel_only: boolean;
  status: string;
  status_message: string;
  trading_disabled: boolean;
}

export interface Candle {
  time: number;
  low: number;
  high: number;
  open: number;
  close: number;
  volume: number;
}

export type Granularity = 60 | 300 | 900 | 3600 | 21600 | 86400;

export interface HistoricRatesParams {
  start: string;
  end: string;
  granularity: Granularity;
}

export interface OrderRequest {
  product_id: string;
  side: 'buy' | 'sell';
  type: 'limit' | 'market' | 'stop';
  size?: string;
  price?: string;
  funds?: string;
  time_in_force?: 'GTC' | 'GTT' | 'IOC' | 'FOK';
  cancel_after?: 'min' | 'hour' | 'day';
  post_only?: boolean;
  stop?: 'loss' | 'entry';
  stop_price?: string;
  client_oid?: string;
}

export interface WebSocketChannelMessage {
  type: 'subscribe' | 'unsubscribe';
  product_ids: string[];
  channels: Array<string | { name: string; product_ids: string[] }>;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: number;
}

// ============ Perpetual Futures Types ============

/** Coinbase perpetual futures product metadata */
export interface CoinbasePerpsProduct {
  product_id: string;                    // e.g., 'BTC-PERP-INTX'
  product_type: 'FUTURE';
  contract_expiry_type: 'PERPETUAL';
  base_currency: string;                 // e.g., 'BTC'
  quote_currency: string;                // e.g., 'USD'
  contract_size: string;                 // e.g., '0.01' for nano contracts
  max_leverage: string;                  // e.g., '10'
  base_increment: string;
  quote_increment: string;
  status: string;
  trading_disabled: boolean;
}

/** Coinbase INTX position from /api/v3/brokerage/intx/positions */
export interface CoinbaseIntxPosition {
  product_id: string;                    // e.g., 'BTC-PERP-INTX'
  side: 'LONG' | 'SHORT' | 'UNKNOWN';
  number_of_contracts: string;
  avg_entry_price: string;
  current_price: string;                 // mark price
  unrealized_pnl: string;
  liquidation_price?: string;
  margin_type?: string;
  leverage?: string;
  margin_used?: string;
}

/** Coinbase INTX portfolio summary */
export interface CoinbaseIntxPortfolio {
  portfolio_uuid: string;
  collateral: string;                    // total collateral in USD
  unrealized_pnl: string;
  buying_power: string;
  margin_used: string;
  max_withdrawal: string;
}

/** Funding rate data for a perpetual contract */
export interface CoinbaseFundingRate {
  product_id: string;
  funding_rate: string;                  // decimal (e.g., '0.0001' = 0.01%)
  funding_time: string;                  // ISO timestamp of next settlement
  mark_price: string;
  index_price: string;
}

/** Leverage setting request */
export interface CoinbaseLeverageRequest {
  product_id: string;
  leverage: string;                      // e.g., '3'
}
