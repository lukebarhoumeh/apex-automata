import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';

// Per-strategy parameter overrides (e.g., different ATR multiplier for BTC vs SOL)
const StrategyOverridesSchema = z.record(
  z.string(), // strategy id (e.g., 'breakout', 'vwap_mr', 'momentum')
  z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])) // param key -> value
).optional();

// Per-symbol risk limit configuration with optional strategy overrides
const PerSymbolLimitSchema = z.object({
  max_notional_usd: z.number().nonnegative(),
  max_daily_loss_usd: z.number().nonnegative(),
  // Optional per-symbol strategy parameter overrides
  strategy_overrides: StrategyOverridesSchema,
});

// Per-symbol perpetual futures configuration
const PerpsSymbolLimitSchema = z.object({
  max_notional_usd: z.number().nonnegative(),
  max_daily_loss_usd: z.number().nonnegative(),
  default_leverage: z.number().int().min(1).max(10).optional(),
  max_leverage: z.number().int().min(1).max(10).optional(),
  strategy_overrides: StrategyOverridesSchema,
});

// Per-symbol Hyperliquid configuration (perpetual DEX)
const HyperliquidSymbolLimitSchema = z.object({
  max_notional_usd: z.number().nonnegative(),
  max_daily_loss_usd: z.number().nonnegative(),
  default_leverage: z.number().int().min(1).max(50).optional(),
  max_leverage: z.number().int().min(1).max(50).optional(),
  strategy_overrides: StrategyOverridesSchema,
});

export type PerpsSymbolLimit = z.infer<typeof PerpsSymbolLimitSchema>;
export type HyperliquidSymbolLimit = z.infer<typeof HyperliquidSymbolLimitSchema>;

export type PerSymbolLimit = z.infer<typeof PerSymbolLimitSchema>;
export type StrategyOverrides = z.infer<typeof StrategyOverridesSchema>;

const GuardrailsSchema = z.object({
  disabled_strategies: z.array(z.string()).optional().default([]),
  account: z.object({
    equity_usd: z.number().positive(),
    risk_per_trade: z.number().positive(),
    max_open_positions: z.number().int().nonnegative(),
    max_account_leverage: z.number().positive(),
    min_notional_buffer: z.number().positive()
  }),
  risk: z.object({
    daily_loss_limit: z.number(),
    weekly_loss_limit: z.number(),
    max_drawdown_limit: z.number(),
    max_position_exposure_pct: z.number().min(0).max(1),
    funding_cost_tolerance_bps: z.number().nonnegative(),
    slippage_estimate_bps: z.number().nonnegative()
  }),
  // Per-symbol risk limits (optional)
  per_symbol: z.record(z.string(), PerSymbolLimitSchema).optional(),
  strategy: z.object({
    mode: z.string(),
    donchian_len: z.number().int().positive(),
    ema_len_1h: z.number().int().positive(),
    atr_len_15m: z.number().int().positive(),
    atr_entry_band: z.tuple([z.number(), z.number()]),
    stop_init_atr: z.number().positive(),
    stop_trail_atr: z.number().positive(),
    time_stop_bars: z.number().int().positive(),
    allow_short: z.boolean(),
    trade_cooldown_min: z.number().int().nonnegative()
  }),
  perps: z.object({
    risk_per_trade: z.number().positive(),
    default_leverage: z.number().int().min(1).max(10),
    max_leverage: z.number().int().min(1).max(10),
    liquidation_buffer_pct: z.number().min(0).max(1),
    max_funding_rate_bps: z.number().nonnegative(),
    funding_check_interval_sec: z.number().int().positive(),
    maker_fee: z.number().min(0),
    taker_fee: z.number().min(0),
    nano_contract_size: z.number().positive(),
  }).optional(),
  perps_symbols: z.record(z.string(), PerpsSymbolLimitSchema).optional(),
  // Hyperliquid (perpetual DEX). Default `enabled: false` is the kill switch — even if
  // the block exists in YAML, the adapter stays inert until BOTH this flag AND the
  // `HYPERLIQUID_ENABLED=true` env var are set. The adapter is registered either way
  // so callers can introspect the registry, but `.initialize()` only runs when enabled.
  hyperliquid: z.object({
    enabled: z.boolean().default(false),
    testnet: z.boolean().default(true),
    risk_per_trade: z.number().positive().optional(),
    default_leverage: z.number().int().min(1).max(50).optional(),
    max_leverage: z.number().int().min(1).max(50).optional(),
    maker_fee: z.number().min(0).optional(),
    taker_fee: z.number().min(0).optional(),
    funding_check_interval_sec: z.number().int().positive().optional(),
  }).optional(),
  hyperliquid_symbols: z.record(z.string(), HyperliquidSymbolLimitSchema).optional(),
  execution: z.object({
    order_type: z.string(),
    price_offset_ticks: z.number().int().nonnegative(),
    max_slippage_bps: z.number().nonnegative(),
    order_timeout_sec: z.number().int().positive(),
    retry_backoff_ms: z.array(z.number().int().positive()).nonempty()
  }),
  circuit_breakers: z.object({
    rapid_loss_trigger: z.number(),
    fill_rate_collapse: z.number().min(0).max(1),
    adverse_selection_spike: z.number().min(0).max(1),
    correlation_spike: z.number().min(0).max(1),
    vol_spike_atr: z.number().positive(),
    data_gap_sec: z.number().positive()
  }),
  filters: z.object({
    atr_volatility_min: z.number().nonnegative(),
    atr_volatility_max: z.number().nonnegative(),
    funding_bias_enabled: z.boolean(),
    time_filter_enabled: z.boolean(),
    allowed_hours_utc: z.array(z.number().int().min(0).max(23)).nonempty()
  }),
  compliance: z.object({
    tax_method: z.string(),
    export_frequency_days: z.number().int().positive(),
    log_level: z.string(),
    audit_trail_enabled: z.boolean(),
    flatten_on_shutdown: z.boolean()
  }),
  ui: z.object({
    heartbeat_sec: z.number().int().positive(),
    show_pnl_per_symbol: z.boolean(),
    show_risk_status: z.boolean(),
    kill_switch_button: z.boolean(),
    alert_channels: z.array(z.string()).nonempty()
  }),
  go_live_criteria: z.object({
    paper_parity_max_diff_bps: z.number().nonnegative(),
    min_profitable_days: z.number().int().nonnegative(),
    max_error_count_per_day: z.number().int().nonnegative(),
    manual_approval_required: z.boolean()
  }),
  // Backtest realism model — consumed by BacktestEngine. All keys optional;
  // engine defaults take over when this block is absent.
  backtest: z.object({
    next_bar_fill: z.boolean().optional(),
    entry_slippage_bps: z.number().nonnegative().optional(),
    stop_overshoot_bar_range_pct: z.number().min(0).max(1).optional(),
    stop_overshoot_min_bps: z.number().nonnegative().optional(),
    size_decimals: z.number().int().min(0).max(10).optional(),
  }).optional(),
});

export type GuardrailConfig = z.infer<typeof GuardrailsSchema>;

export function loadGuardrails(atlasRoot: string): GuardrailConfig {
  const guardrailPath = path.join(atlasRoot, 'config', 'guardrails.yaml');
  const raw = fs.readFileSync(guardrailPath, 'utf8');
  const parsed = YAML.parse(raw);
  return GuardrailsSchema.parse(parsed);
}
