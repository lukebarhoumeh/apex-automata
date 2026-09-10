import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';

// Per-strategy parameter overrides (e.g., different ATR multiplier for BTC vs SOL)
const StrategyOverridesSchema = z.record(
  z.string(), // strategy id (e.g., 'breakout', 'vwap_mr', 'momentum')
  z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])) // param key -> value
).optional();

// Per-symbol disabled-strategies list. Same shape as the global
// `disabled_strategies` field, scoped to a single symbol. Absent = inherit
// global behaviour (only the global kill list applies). Present = these
// strategies are rejected on this symbol *in addition* to the global list.
// Added 2026-05-19 to support disabling momentum on PERP-INTX symbols without
// touching spot — see docs/research/2026-05-19_f4-followup-perps-action.md §8.
const PerSymbolDisabledStrategiesSchema = z.array(z.string()).optional();

// Per-symbol risk limit configuration with optional strategy overrides
const PerSymbolLimitSchema = z.object({
  max_notional_usd: z.number().nonnegative(),
  max_daily_loss_usd: z.number().nonnegative(),
  // Optional per-symbol strategy parameter overrides
  strategy_overrides: StrategyOverridesSchema,
  disabled_strategies: PerSymbolDisabledStrategiesSchema,
});

// Per-symbol perpetual futures configuration
const PerpsSymbolLimitSchema = z.object({
  max_notional_usd: z.number().nonnegative(),
  max_daily_loss_usd: z.number().nonnegative(),
  default_leverage: z.number().int().min(1).max(10).optional(),
  max_leverage: z.number().int().min(1).max(10).optional(),
  strategy_overrides: StrategyOverridesSchema,
  disabled_strategies: PerSymbolDisabledStrategiesSchema,
});

// Per-symbol Hyperliquid configuration (perpetual DEX)
const HyperliquidSymbolLimitSchema = z.object({
  max_notional_usd: z.number().nonnegative(),
  max_daily_loss_usd: z.number().nonnegative(),
  default_leverage: z.number().int().min(1).max(50).optional(),
  max_leverage: z.number().int().min(1).max(50).optional(),
  strategy_overrides: StrategyOverridesSchema,
  disabled_strategies: PerSymbolDisabledStrategiesSchema,
});

export type PerpsSymbolLimit = z.infer<typeof PerpsSymbolLimitSchema>;
export type HyperliquidSymbolLimit = z.infer<typeof HyperliquidSymbolLimitSchema>;

export type PerSymbolLimit = z.infer<typeof PerSymbolLimitSchema>;
export type StrategyOverrides = z.infer<typeof StrategyOverridesSchema>;

// Fee model — single source of truth for fee assumptions across
// backtest, paper, and live so all three are directly comparable.
// Negative maker values represent rebates (Hyperliquid). All values in bps.
const FeeSideSchema = z.object({
  maker_bps: z.number(),
  taker_bps: z.number(),
});

const FeesSchema = z.object({
  coinbase: z.object({
    spot: FeeSideSchema,
    perps_intx: FeeSideSchema,
  }),
  hyperliquid: z.object({
    perps: FeeSideSchema,
  }),
});

export type FeesConfig = z.infer<typeof FeesSchema>;

// Momentum strategy parameter overrides — optional top-level block.
// When present these values are forwarded to the MomentumStrategy plugin
// instead of values being hard-coded in api/server.ts. Plugin configSchema
// defaults remain the source of truth for any key omitted here.
const MomentumConfigSchema = z.object({
  rsiPeriod: z.number().int().min(2).max(60).optional(),
  rsiOversold: z.number().min(0).max(100).optional(),
  rsiOverbought: z.number().min(0).max(100).optional(),
  macdFast: z.number().int().min(2).max(60).optional(),
  macdSlow: z.number().int().min(2).max(120).optional(),
  macdSignal: z.number().int().min(2).max(60).optional(),
  requireMacdConfirm: z.boolean().optional(),
  requireMacdCrossover: z.boolean().optional(),
  stopAtr: z.number().positive().optional(),
  takeProfitAtr: z.number().positive().optional(),
}).strict();

export type MomentumConfigOverrides = z.infer<typeof MomentumConfigSchema>;

// Meta-filter config — currently only carries the optional CoinDesk sentiment
// soft-weight rule. Default OFF, validated up-front so a malformed YAML block
// fails startup loudly instead of silently disabling the rule at runtime.
const CoinDeskSentimentSchema = z.object({
  enabled: z.boolean().default(false),
  lookback_minutes: z.number().int().min(1).max(1440).default(60),
  stale_threshold_ms: z.number().int().nonnegative().default(30 * 60 * 1000),
  weight_delta_bounds: z
    .tuple([z.number(), z.number()])
    .refine(([lo, hi]) => lo <= 0 && hi >= 0 && hi <= 1 && lo >= -1, {
      message: 'weight_delta_bounds must be [lo, hi] with lo <= 0 <= hi and within [-1, 1]',
    })
    .default([-0.25, 0.25]),
  cache_ttl_ms: z.number().int().nonnegative().default(60_000),
  request_timeout_ms: z.number().int().positive().max(60_000).default(5_000),
  rule_weight: z.number().min(0).max(1).default(0.2),
  enabled_symbols: z.array(z.string()).default([]),
});

const MetaFilterYamlSchema = z
  .object({
    coindesk_sentiment: CoinDeskSentimentSchema.optional(),
  })
  .optional();

export type CoinDeskSentimentConfig = z.infer<typeof CoinDeskSentimentSchema>;

// Live-mode runtime knobs (Sprint 9 / TASK_011). Paper mode never reads this
// block. Everything here has a fail-closed default so a missing block behaves
// like the strictest setting:
//   - account_refresh_sec: LiveAccountTruth refresh cadence (also refreshed
//     after every fill). Snapshot older than 3x this => ACCOUNT_TRUTH_STALE.
//   - min_quote_usd: preflight FAILs when USD+USDC available is below this.
//   - ev_gate_mode: `enforce` rejects negative-EV entries; `shadow` allows them
//     but logs EV_GATE_SHADOW_ALLOW for every would-be reject and prints a
//     startup banner (Door B in docs/plans/SPRINT-9-LIVE-COINBASE.md).
export const EvGateModeSchema = z.enum(['enforce', 'shadow']);
export type EvGateMode = z.infer<typeof EvGateModeSchema>;

const LiveConfigSchema = z.object({
  account_refresh_sec: z.number().int().positive().default(60),
  min_quote_usd: z.number().nonnegative().default(20),
  ev_gate_mode: EvGateModeSchema.default('enforce'),
});

export type LiveConfig = z.infer<typeof LiveConfigSchema>;

/** Effective live config: the parsed block or its fail-closed defaults when absent. */
export function resolveLiveConfig(guardrails: { live?: LiveConfig }): LiveConfig {
  return guardrails.live ?? LiveConfigSchema.parse({});
}

export const GuardrailsSchema = z.object({
  disabled_strategies: z.array(z.string()).optional().default([]),
  momentum: MomentumConfigSchema.optional(),
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
    slippage_estimate_bps: z.number().nonnegative(),
    // #A3 (2026-05-18): pre-trade fee-adjusted EV gate. Signals whose
    // expected USD value (p*win - (1-p)*loss - 2*fee*notional) is below
    // this threshold are rejected at the router. 0 = reject negative-EV.
    min_ev_threshold: z.number().default(0),
  }),
  // Required: every code path (backtest, paper, live) reads fees from here.
  // Startup must fail if absent — silent drift between layers is what we just
  // fixed (see PHASE3_BACKTEST_VERDICT.md).
  fees: FeesSchema,
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
  // Meta-filter config block. Only carries the CoinDesk sentiment rule today.
  // Strictly optional — when absent, MetaFilter defaults (rule disabled) apply.
  meta_filter: MetaFilterYamlSchema,
  // Live-mode knobs (TASK_011). Optional; absent = fail-closed defaults via
  // `resolveLiveConfig()`. Paper mode ignores this block entirely.
  live: LiveConfigSchema.optional(),
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

/**
 * Repo-relative location of the ONLY guardrails file the runtime reads.
 * Everything else named `guardrails.yaml` in the tree must be a
 * `DO_NOT_EDIT` pointer stub (enforced by `pnpm check:config`, see `config-drift.ts`).
 */
export const CANONICAL_GUARDRAILS_REPO_PATH = 'atlas/config/guardrails.yaml';

/**
 * Absolute path of the canonical guardrails file, resolved from this
 * module's own location rather than `process.cwd()` or a caller-supplied
 * root. `src/config/` and `dist/config/` sit at the same depth under
 * `atlas/apps/core-node/`, so four levels up is `atlas/` for both the tsx
 * and the compiled entrypoints.
 */
export function resolveCanonicalGuardrailsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', '..', 'config', 'guardrails.yaml');
}

/**
 * Best-effort canonicalisation for path equality: resolves symlinks and, on
 * Windows, drive-letter / directory casing. Falls back to `path.resolve`
 * when the path does not exist so the caller can still report it.
 */
function canonicalisePath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Load and validate the runtime guardrails.
 *
 * Always reads `atlas/config/guardrails.yaml` (see
 * `resolveCanonicalGuardrailsPath`). The optional `atlasRoot` is accepted
 * for backwards compatibility with call sites that derive it from
 * `process.cwd()` or a `--config` flag; if it points anywhere other than
 * the canonical file this throws instead of silently loading a second,
 * possibly divergent, copy — historically `atlas/apps/core-node/config/
 * guardrails.yaml` carried different limits from the real file.
 *
 * @param atlasRoot Optional `atlas/` directory a caller believes it is
 *   running under. Must resolve to the canonical file when provided.
 * @throws Error when `atlasRoot` disagrees with the canonical location, or
 *   when the YAML fails schema validation (zod error).
 */
export function loadGuardrails(atlasRoot?: string): GuardrailConfig {
  const canonicalPath = resolveCanonicalGuardrailsPath();

  if (atlasRoot !== undefined) {
    const requestedPath = path.resolve(atlasRoot, 'config', 'guardrails.yaml');
    if (canonicalisePath(requestedPath) !== canonicalisePath(canonicalPath)) {
      throw new Error(
        `loadGuardrails: refusing to read ${requestedPath}. ` +
        `The only runtime guardrails file is ${CANONICAL_GUARDRAILS_REPO_PATH} (${canonicalPath}); ` +
        'fix the caller\'s atlasRoot / cwd instead of adding a second YAML.'
      );
    }
  }

  const raw = fs.readFileSync(canonicalPath, 'utf8');
  const parsed = YAML.parse(raw);
  return GuardrailsSchema.parse(parsed);
}
