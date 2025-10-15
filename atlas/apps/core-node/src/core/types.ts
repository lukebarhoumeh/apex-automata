export type Mode = 'paper' | 'live';

export interface AppConfig {
  mode: Mode;
  exchange: 'coinbase-advanced';
  symbols: string[];
  bars: { tf_primary: '5m' | '1m' | '15m' };
  risk: {
    per_trade_risk_bp: number;
    max_heat_bp: number;
    daily_stop_R: number;
  };
  signals?: Record<string, unknown>;
  meta?: {
    enabled: boolean;
    threshold: number;
    model_path: string;
  };
  execution?: Record<string, unknown>;
  killswitch?: Record<string, unknown>;
  limits?: {
    min_order_usd: number;
    per_symbol_usd_cap: number;
  };
}
