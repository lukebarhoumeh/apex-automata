import { EventEmitter } from 'events';
import { register as promRegister } from 'prom-client';
import { Logger } from '../core/logger';
import type { OHLCV } from '../indicators/technical';
// NOTE (indicator-standardization, 2026-05): TechnicalIndicators import was
// dead in this file. The signal pipeline owns indicator computation; this
// engine just consumes signals. Removed to keep call-graph honest.
import { SignalProcessor, Signal } from '../strategies/signal-processor';
import {
  PerSymbolDisabledStrategies,
  isSymbolStrategyDisabled,
} from '../strategies/per-symbol-disable';
import { recordSignalFiltered } from '../strategies/signal-filter-telemetry';
import { computeRiskBasedSize } from '../trading/risk/position-sizing';
import {
  evaluateEvGate,
  estimateWinRateWithPrior,
  DEFAULT_WIN_RATE_PRIOR,
  type WinRatePrior,
} from '../trading/risk/ev-gate';
import {
  isShortingAllowed,
  venueForSymbol,
  type MarketVenue,
} from '../trading/execution/venue-capabilities';
import { FeeModel, Exchange } from '../core/fee-model';
import { describeSeries, inferBarMinutes, type DataProvenance } from './data-loader';

type OrderSide = 'BUY' | 'SELL';

/** EV-gate operating mode (TASK_017 B3). Mirrors `live.ev_gate_mode` + `off`. */
export type EvGateMode = 'enforce' | 'shadow' | 'off';

export interface BacktestEvGateConfig {
  /**
   * `enforce` (default) rejects negative-EV entries exactly like the live
   * router; `shadow` lets them through but counts/logs the would-be
   * rejects (`EV_GATE_SHADOW_ALLOW`); `off` skips the gate entirely
   * (raw-signal-edge experiments only — never for go-live claims).
   */
  mode: EvGateMode;
  /** Min EV in USD (guardrails `risk.min_ev_threshold`). Default 0. */
  minEvThreshold?: number;
  /** Beta prior for the p estimator. Default p0=0.40, n0=30 (TASK_011). */
  prior?: WinRatePrior;
}

/**
 * What a data provider hands the engine. Plain `OHLCV[]` is still accepted
 * for programmatic callers/tests (tagged `source: 'in-memory'`); the CLI
 * path always supplies provenance so reports can stamp the data source.
 */
export interface ProvidedSeries {
  candles: OHLCV[];
  provenance: DataProvenance;
}
export type DataProviderOutput = OHLCV[] | ProvidedSeries;

/** Per-run EV-gate counters, surfaced in metrics + report. */
export interface EvGateStats {
  mode: EvGateMode;
  evaluated: number;
  allowed: number;
  rejected: number;
  /** Shadow mode only: entries that WOULD have been rejected in enforce. */
  shadowWouldReject: number;
  /** Entries allowed via a default-allow path (missing geometry etc.). */
  defaultAllowed: number;
  rejectedByStrategy: Record<string, number>;
}

/**
 * Optional per-strategy parameter override block read from guardrails.yaml.
 * Backtest-engine forwards this to SignalProcessor so strategies see the
 * same per-symbol params live trading does (e.g. ETH-USD trend_follow
 * uses emaFast=12 / emaSlow=15).
 */
export type PerSymbolStrategyOverrides = Record<string, Record<string, Record<string, unknown>>>;

/**
 * Backtest-only realism knobs. Defaults are documented inline; override per
 * run from guardrails.yaml `backtest:` block or programmatic config. Slippage
 * is applied symmetrically on entries; stop-fill overshoot is applied
 * pessimistically (fills WORSE than the trigger to model gap-through risk).
 */
export interface BacktestRealismConfig {
  /**
   * Whether entries fill on the next bar's open instead of same-bar close.
   * Default: true. Setting this to false reverts to the (broken) same-bar
   * behaviour and exists only for legacy comparison.
   */
  nextBarFill?: boolean;
  /**
   * Per-side slippage applied to entry fills, in basis points (1 bps = 0.01%).
   * Default 5 bps matches the live `execution.max_slippage_bps` ceiling.
   * Modeled symmetrically: long entries pay this above the open, shorts
   * receive this below.
   */
  entrySlippageBps?: number;
  /**
   * Stop-fill overshoot — fraction of the bar's range that the stop fill
   * is moved past the trigger to model gap-through / wick-through risk.
   * Default 0.20 (20% of [bar.high − bar.low] beyond the stop level).
   * Empirical: backtest-without-overshoot understates max-DD by ~10–20%
   * vs. paper trading on the same dataset (Phase 3 verdict, March 2026).
   */
  stopOvershootBarRangePct?: number;
  /**
   * Floor on stop overshoot, in basis points, when the bar range model
   * yields a smaller value (e.g. low-volatility candle). Default 5 bps so
   * even calm bars charge realistic adverse-selection on stop-outs.
   */
  stopOvershootMinBps?: number;
  /**
   * Number of base-unit decimals to round position sizes to before fill.
   * Default 6 matches RiskEngine.computeOrderSize.
   */
  sizeDecimals?: number;
}

export interface BacktestStrategyToggle {
  enabled: boolean;
  parameters: Record<string, unknown>;
}

export interface BacktestConfig {
  startDate: Date;
  endDate: Date;
  initialCapital: number;
  /**
   * Per-symbol fee resolution. When set (and `commission` is not), every
   * fill is charged `feeModel.getFeeRate(venue, marketForSymbol(symbol),
   * 'taker')` so mixed `--products` lists (spot + perps) route to the
   * correct fee tier per symbol. This mirrors the live/paper fix in
   * `paper-trading-simulator.resolveFeeRate` and was added in #11
   * (2026-05-18) as the pre-F4 blocker — see
   * docs/research/2026-05-18_b4-fee-model-audit.md §"Recommended fix shape"
   * option B.
   */
  feeModel?: FeeModel;
  /**
   * Exchange venue tag for FeeModel lookups. Defaults to 'coinbase' since
   * backtest sources from Coinbase candles. To simulate Hyperliquid fee
   * economics on Coinbase price action, pass `--commission 0.00045` (the
   * flat-override path) since the backtest engine doesn't yet have
   * per-bar venue routing (B1 will land that for Wave 3).
   */
  venue?: Exchange;
  /**
   * Flat-decimal commission override. When set, EVERY fill is charged
   * `size * price * commission` regardless of symbol — overrides any
   * `feeModel`. Kept after #11 (2026-05-18) for sensitivity-analysis use
   * (CLI `--commission 0.00045` to simulate HL fees on Coinbase candles).
   * New callers should populate `feeModel` instead; either commission or
   * feeModel MUST be set or the constructor throws.
   */
  commission?: number;
  /**
   * @deprecated Use `realism.entrySlippageBps`. Kept on the type so older
   * callers don't break, but the engine now reads bps directly. The CLI
   * maps `--slippage <decimal>` onto `realism.entrySlippageBps`.
   */
  slippage?: number;
  /**
   * TASK_017 B2 — force every product onto one venue class. When unset the
   * venue is inferred per symbol (`XXX-PERP-INTX` → perps, else spot).
   * Drives BOTH fee routing (spot vs perps bucket) and shorting capability.
   */
  venueOverride?: MarketVenue;
  /**
   * `guardrails.strategy.allow_short`. Necessary but not sufficient: shorts
   * additionally require the venue to support them (`isShortingAllowed`).
   * Default true (mirrors current guardrails) — spot still never shorts.
   */
  allowShort?: boolean;
  /** TASK_017 B3 — EV gate wiring. Default `{ mode: 'enforce' }`. */
  evGate?: BacktestEvGateConfig;
  /**
   * Regime-gate toggle (RegimeFilter inside SignalProcessor). Default true.
   * `false` disables regime/strategy compatibility filtering for the run —
   * report prints the state either way.
   */
  regimeGates?: boolean;
  products: string[];
  signals: {
    breakout: BacktestStrategyToggle;
    vwapMeanReversion: BacktestStrategyToggle;
    momentum: BacktestStrategyToggle;
    /** Optional. When omitted, trend_follow runs with plugin defaults. */
    trendFollow?: BacktestStrategyToggle;
  };
  risk: {
    /**
     * Hard cap on per-position notional in USD. Acts as a ceiling on top
     * of the risk-based size — same role as `risk.max_position_exposure_pct`
     * in live guardrails.
     */
    maxPositionSize: number;
    /** Hard cap on aggregate open exposure. */
    maxTotalExposure: number;
    /**
     * @deprecated Per-trade stops now come from each strategy signal
     * (signal.stopLoss). This value is the FALLBACK only if a signal lacks a
     * stop. Default fallback 2%.
     */
    stopLossPercent: number;
    /**
     * @deprecated Per-trade TPs now come from each strategy signal
     * (signal.takeProfit). Fallback only.
     */
    takeProfitPercent: number;
  };
  /**
   * Mirrors guardrails.account block. Backtest sizes positions identically
   * to the live engine (`computeRiskBasedSize`). Defaults pulled from the
   * legacy 5%/$5k behaviour if absent so old callers don't break, but cli
   * and api/server should always populate this.
   */
  account?: {
    equityUsd?: number;
    riskPerTrade?: number;
    maxPositionExposurePct?: number;
    minNotionalBuffer?: number;
  };
  /** Strategies disabled by Phase-3 verdict. Skipped before signal entry. */
  disabledStrategies?: string[];
  /**
   * Per-(symbol, strategy) disable map. Strictly additive vs the global
   * `disabledStrategies` list — a signal is rejected if either matches.
   * Built once from guardrails.{per_symbol, perps_symbols, hyperliquid_symbols}
   * via `buildPerSymbolDisabledStrategies()`. Added 2026-05-19 (F4 follow-up §8)
   * to disable momentum on *-PERP-INTX without touching spot.
   */
  perSymbolDisabledStrategies?: PerSymbolDisabledStrategies;
  /** Per-symbol strategy overrides (forwarded to plugin registry). */
  perSymbolOverrides?: PerSymbolStrategyOverrides;
  /** Realism knobs (look-ahead, overshoot, slippage). */
  realism?: BacktestRealismConfig;
  /**
   * Live pre-entry filters mirrored from `guardrails.filters` (api/server.ts
   * routing stage `atr_vol`): an entry whose signal ATR% (`indicators.atr /
   * price`) is below `atrVolatilityMin` or above `atrVolatilityMax` is
   * rejected with the same telemetry reason as live. Absent = no filter
   * (pre-E4 behaviour).
   */
  filters?: {
    atrVolatilityMin?: number;
    atrVolatilityMax?: number;
  };
  /**
   * Execution-rule parity knobs.
   *  - `minHoldBars`: an opposite-direction signal may NOT close a position
   *    held for fewer than this many BARS (bar clock, not wall clock). Live
   *    analog: `strategy.trade_cooldown_min` (15 min = 1 × 15m bar), routing
   *    reason `exit_position_too_young`. Stops/TPs bypass it exactly as live.
   *    E4 4H card: 1 bar (= 240 min). Default 0 (pre-E4 behaviour).
   */
  execution?: {
    minHoldBars?: number;
  };
}

export interface BacktestTrade {
  id: string;
  timestamp: Date;
  product: string;
  side: OrderSide;
  entryPrice: number;
  exitPrice?: number;
  size: number;
  entryFee: number;
  exitFee?: number;
  exitTimestamp?: Date;
  pnl?: number;
  pnlPercent?: number;
  exitReason?: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_data';
  signal: Signal;
  /** Strategy that produced the entry — surfaced in the by-strategy summary. */
  strategy: string;
  /** Stop level used for sizing + exit checks. */
  stopLoss: number;
  /** Take-profit level used for exits. */
  takeProfit: number;
  /** Venue class the fill was simulated on (drives fees + shorting). */
  venue: MarketVenue;
  /** Cash equity the position was sized from (initialCapital + realized). */
  equityAtEntry: number;
  /** EV-gate evaluation for this entry (absent when mode = off). */
  evGate?: {
    ev: number;
    p: number;
    feeUsd: number;
    threshold: number;
    /** True when enforce would have rejected (shadow mode only). */
    shadowWouldReject?: boolean;
  };
}

export interface BacktestPosition {
  product: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  entryTimestamp: Date;
  /** Timeline step the entry filled on (drives `execution.minHoldBars`). */
  entryBarIndex: number;
  unrealizedPnl: number;
  trades: BacktestTrade[];
}

export interface BacktestStrategyMetrics {
  trades: number;
  winningTrades: number;
  winRate: number;
  netProfit: number;
  averageRMultiple: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  grossProfit: number;
  grossLoss: number;
  netProfit: number;
  profitFactor: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  averageWin: number;
  averageLoss: number;
  largestWin: number;
  largestLoss: number;
  /** Mean entry→exit duration in minutes, bar-clock based (never negative). */
  averageHoldTime: number; // in minutes
  totalFees: number;
  finalCapital: number;
  returnPercent: number;
  /** Per-strategy breakdown, used by the deliverable summary table. */
  byStrategy: Record<string, BacktestStrategyMetrics>;
  /** Snapshot of which strategies actually ran (post disabled_strategies filter) */
  activeStrategies: string[];
  /** Entries opened long (BUY). */
  longEntries: number;
  /** Entries opened short (SELL). Must be 0 on spot venues. */
  shortEntries: number;
  /** SELL signals that closed an open long on a no-shorting venue. */
  sellSignalExits: number;
  /** SELL signals dropped on a no-shorting venue with no long to exit. */
  shortBlocked: number;
  /** EV-gate counters for the run. */
  evGate: EvGateStats;
  /** Entries bucketed by the regime label the signal carried. */
  entriesByRegime: Record<string, number>;
  /** Entries rejected by the live-parity ATR volatility filter (`filters`). */
  atrFilterRejects: number;
  /** Opposite-signal exits ignored because the position was younger than `execution.minHoldBars`. */
  exitsIgnoredMinHold: number;
}

/** Regime-gate (RegimeFilter) state snapshot for the report. */
export interface RegimeGateState {
  enabled: boolean;
  minCompatibilityScore: number;
  minRegimeConfidence: number;
  requireMTFAlignment: boolean;
}

/** Fee assumptions actually used for fills, for the report header. */
export interface FeeAssumptions {
  /** 'flat-override' when `commission` is set, else 'fee-model'. */
  routing: 'flat-override' | 'fee-model';
  /** Flat decimal rate when routing = flat-override. */
  flatRate?: number;
  /** Per-venue taker/maker bps when routing = fee-model. */
  perVenue: Record<string, { makerBps: number; takerBps: number }>;
  /** Exchange whose fee table was consulted. */
  exchange: Exchange;
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equityCurve: { timestamp: Date; equity: number; drawdown: number }[];
  dailyReturns: { date: string; returnPercent: number }[];
  /** Per-symbol data provenance (source, coverage, bar spacing). */
  dataProvenance: Record<string, DataProvenance>;
  /**
   * 'SYNTHETIC' when ANY product ran on generated candles — the whole run is
   * SMOKE/VOID and reports must say so on line 1. Otherwise 'REAL'.
   */
  dataStamp: 'REAL' | 'SYNTHETIC';
  /** Venue class resolved per product. */
  venueBySymbol: Record<string, MarketVenue>;
  /** Regime-gate state at run time. */
  regimeGate: RegimeGateState;
  /** Fee assumptions used for fills and the EV gate. */
  fees: FeeAssumptions;
}

/**
 * A signal queued from bar [i] that fills at bar [i+1]'s open. Carries the
 * stop/TP that came with the signal so we don't have to recalc from
 * config.risk.* on the wrong bar.
 */
interface PendingFill {
  signal: Signal;
  stopLoss: number;
  takeProfit: number;
  generatedAt: Date;
}

const DEFAULT_REALISM: Required<BacktestRealismConfig> = {
  nextBarFill: true,
  entrySlippageBps: 5,
  stopOvershootBarRangePct: 0.20,
  stopOvershootMinBps: 5,
  sizeDecimals: 6,
};

const DEFAULT_DISABLED_STRATEGIES = ['vwap_mr', 'breakout'];

/** Median bar spacing in seconds for an in-memory series; 900 (15m) if unknown. */
function inferGranularitySeconds(candles: OHLCV[]): number {
  const minutes = inferBarMinutes(candles);
  return minutes && minutes > 0 ? Math.round(minutes * 60) : 900;
}

export class BacktestEngine extends EventEmitter {
  private config: BacktestConfig;
  private logger: Logger;
  private signalProcessor: SignalProcessor | null = null;
  private historicalData: Map<string, OHLCV[]> = new Map();
  private positions: Map<string, BacktestPosition> = new Map();
  private closedTrades: BacktestTrade[] = [];
  private capital: number;
  private peakCapital: number;
  private equityCurve: { timestamp: Date; equity: number; drawdown: number }[] = [];
  private dailyReturns: Map<string, number> = new Map();
  private dailyStartEquity: number = 0;
  private currentDay: string = '';
  private realism: Required<BacktestRealismConfig>;
  private pendingFills: Map<string, PendingFill> = new Map();
  private disabledStrategies: Set<string>;
  private activeStrategies: string[] = [];
  private tradeIdCounter: number = 0;
  // Funnel diagnostics — populated as bars stream past `processTimeSteps`.
  // The point of these counters is to make the "9 trades in the first 40h
  // then silence for 87 days" pathology immediately visible in the
  // structured run summary at end-of-run, rather than having to scrape
  // 80k-line stdout logs after the fact.
  private barIndex: number = 0;
  private lastSignalBarPerStrategy: Map<string, number> = new Map();
  private lastSignalTimestampPerStrategy: Map<string, Date> = new Map();
  private signalAdmittedPerStrategy: Map<string, number> = new Map();
  // Bar clock: the timestamp of the bar currently being processed. Signal
  // handlers use this instead of `signal.timestamp` (which plugins stamp
  // with wall-clock `new Date()`) so entry/exit times — and therefore the
  // hold-time metric — live on the same clock (TASK_017 B5).
  private currentBarTime: Date | null = null;
  private dataProvenance: Map<string, DataProvenance> = new Map();
  private evGateMode: EvGateMode;
  private evGateThreshold: number;
  private evGatePrior: WinRatePrior;
  private evGateStats: EvGateStats;
  private longEntries: number = 0;
  private shortEntries: number = 0;
  private sellSignalExits: number = 0;
  private shortBlocked: number = 0;
  private entriesByRegime: Record<string, number> = {};
  private atrFilterRejects: number = 0;
  private exitsIgnoredMinHold: number = 0;
  private readonly minHoldBars: number;

  constructor(config: BacktestConfig, logger: Logger) {
    super();
    if (config.commission === undefined && !config.feeModel) {
      throw new Error(
        'BacktestConfig: either `feeModel` or `commission` (decimal override) must be set. ' +
          'Pass `feeModel: FeeModel.fromGuardrails(...)` for per-symbol routing, ' +
          'or `commission: 0.00045` for a flat sensitivity-analysis run.',
      );
    }
    this.config = config;
    this.logger = logger;
    this.capital = config.initialCapital;
    this.peakCapital = config.initialCapital;
    this.dailyStartEquity = config.initialCapital;
    this.realism = { ...DEFAULT_REALISM, ...(config.realism || {}) };
    this.disabledStrategies = new Set(config.disabledStrategies ?? DEFAULT_DISABLED_STRATEGIES);
    this.evGateMode = config.evGate?.mode ?? 'enforce';
    this.evGateThreshold = Number.isFinite(config.evGate?.minEvThreshold)
      ? Number(config.evGate?.minEvThreshold)
      : 0;
    this.evGatePrior = config.evGate?.prior ?? DEFAULT_WIN_RATE_PRIOR;
    const minHold = config.execution?.minHoldBars ?? 0;
    this.minHoldBars = Number.isInteger(minHold) && minHold > 0 ? minHold : 0;
    this.evGateStats = {
      mode: this.evGateMode,
      evaluated: 0,
      allowed: 0,
      rejected: 0,
      shadowWouldReject: 0,
      defaultAllowed: 0,
      rejectedByStrategy: {},
    };
  }

  /**
   * Venue class for a product: explicit `venueOverride` wins, otherwise
   * inferred from the symbol. Used for fee routing and shorting capability
   * so the two can never disagree.
   */
  public resolveVenue(symbol: string): MarketVenue {
    return this.config.venueOverride ?? venueForSymbol(symbol);
  }

  /**
   * Effective shorting permission for a product (TASK_017 B2):
   * `allowShort` config AND venue capability. Spot is always long-only.
   */
  public isShortAllowed(symbol: string): boolean {
    return isShortingAllowed(this.config.allowShort ?? true, this.resolveVenue(symbol));
  }

  /**
   * Resolve the fee RATE (decimal) for a fill on `symbol`. Precedence:
   *   1. `config.commission` flat override (sensitivity-analysis path)
   *   2. `config.feeModel.getFeeRate(exchange, resolveVenue(symbol), 'taker')`
   *
   * Backtest fills are assumed taker — same assumption the live/paper
   * simulator uses for market orders. Per-fill maker/taker split awaits
   * a future ladder/limit-fill model upgrade.
   *
   * Constructor invariant guarantees at least one path is populated, so
   * we never silently return 0. Falls through to `commission ?? 0` only
   * if the type system is bypassed.
   */
  private resolveCommissionRate(symbol: string): number {
    if (this.config.commission !== undefined) {
      return this.config.commission;
    }
    if (this.config.feeModel) {
      return this.config.feeModel.getFeeRate(
        this.config.venue ?? 'coinbase',
        this.resolveVenue(symbol),
        'taker',
      );
    }
    return 0;
  }

  /** Fee assumptions used by this run, for the report header. */
  private describeFees(): FeeAssumptions {
    const exchange: Exchange = this.config.venue ?? 'coinbase';
    if (this.config.commission !== undefined) {
      return { routing: 'flat-override', flatRate: this.config.commission, perVenue: {}, exchange };
    }
    const perVenue: FeeAssumptions['perVenue'] = {};
    const venues = new Set<MarketVenue>(this.config.products.map((p) => this.resolveVenue(p)));
    for (const venue of venues) {
      try {
        perVenue[venue] = {
          makerBps: this.config.feeModel!.getFeeBps(exchange, venue, 'maker'),
          takerBps: this.config.feeModel!.getFeeBps(exchange, venue, 'taker'),
        };
      } catch (err) {
        this.logger.warn('FeeModel has no bucket for venue', { exchange, venue, err: (err as Error)?.message });
      }
    }
    return { routing: 'fee-model', perVenue, exchange };
  }

  /**
   * Load candles for every product. The provider may return plain `OHLCV[]`
   * (programmatic callers/tests → provenance `source: 'in-memory'`) or a
   * `{ candles, provenance }` pair from `HistoricalDataLoader`. Any error
   * from the provider — notably `DATA_UNAVAILABLE` — propagates: the engine
   * never starts a run on data it did not receive.
   */
  public async loadHistoricalData(
    dataProvider: (product: string, start: Date, end: Date) => Promise<DataProviderOutput>,
  ): Promise<void> {
    this.logger.info('Loading historical data', {
      products: this.config.products,
      startDate: this.config.startDate,
      endDate: this.config.endDate,
    });

    for (const product of this.config.products) {
      const loadStart = Date.now();
      const output = await dataProvider(product, this.config.startDate, this.config.endDate);
      const candles = Array.isArray(output) ? output : output.candles;
      const provenance = Array.isArray(output)
        ? describeSeries(
            product, 'in-memory', candles, this.config.startDate, this.config.endDate,
            inferGranularitySeconds(candles), Date.now() - loadStart,
          )
        : output.provenance;
      this.historicalData.set(product, candles);
      this.dataProvenance.set(product, provenance);
      this.logger.info(`Loaded ${candles.length} candles for ${product}`, {
        source: provenance.source,
        coverage: provenance.coverage,
        inferredBarMinutes: provenance.inferredBarMinutes,
      });
      if (provenance.source === 'synthetic') {
        this.logger.warn(`DATA: SYNTHETIC for ${product} — this run is SMOKE/VOID`, { product });
      }
    }
  }

  /** Per-symbol provenance captured by `loadHistoricalData`. */
  public getDataProvenance(): Record<string, DataProvenance> {
    return Object.fromEntries(this.dataProvenance);
  }

  /**
   * Inspection accessor for the SignalProcessor instance the engine drives.
   * Returns null until `run()` has called `initializeSignalProcessor()`.
   *
   * Surfaces MetaFilter / SignalArbiter / RegimeDetector state for tests
   * and post-run analysis (e.g. F5 backtest-runs UI wiring will read funnel
   * + meta-filter performance through this).
   */
  public getSignalProcessor(): SignalProcessor | null {
    return this.signalProcessor;
  }

  public async run(): Promise<BacktestResult> {
    this.logger.info('Starting backtest', {
      products: this.config.products,
      disabledStrategies: Array.from(this.disabledStrategies),
      realism: this.realism,
    });

    this.initializeSignalProcessor();
    await this.processTimeSteps();
    this.closeAllPositions('end_of_data');

    if (this.currentDay) {
      const finalEquity = this.calculateCurrentEquity();
      const finalReturn = (finalEquity - this.dailyStartEquity) / this.dailyStartEquity;
      this.dailyReturns.set(this.currentDay, finalReturn);
    }

    const metrics = this.calculateMetrics();
    const dataProvenance = this.getDataProvenance();
    const anySynthetic = Object.values(dataProvenance).some((p) => p.source === 'synthetic');
    const venueBySymbol: Record<string, MarketVenue> = {};
    for (const product of this.config.products) {
      venueBySymbol[product] = this.resolveVenue(product);
    }
    const result: BacktestResult = {
      config: this.config,
      trades: this.closedTrades,
      metrics,
      equityCurve: this.equityCurve,
      dailyReturns: this.getDailyReturns(),
      dataProvenance,
      dataStamp: anySynthetic ? 'SYNTHETIC' : 'REAL',
      venueBySymbol,
      regimeGate: this.describeRegimeGate(),
      fees: this.describeFees(),
    };

    this.logger.info('Backtest completed', {
      dataStamp: result.dataStamp,
      totalTrades: metrics.totalTrades,
      longEntries: metrics.longEntries,
      shortEntries: metrics.shortEntries,
      shortBlocked: metrics.shortBlocked,
      evGate: metrics.evGate,
      netProfit: metrics.netProfit,
      returnPercent: metrics.returnPercent,
      activeStrategies: metrics.activeStrategies,
      byStrategy: metrics.byStrategy,
    });
    if (anySynthetic) {
      this.logger.warn('DATA: SYNTHETIC — run is SMOKE/VOID; do not cite these results', {
        synthetic: Object.values(dataProvenance).filter((p) => p.source === 'synthetic').map((p) => p.symbol),
      });
    }

    await this.logFunnelDiagnostics();

    return result;
  }

  /**
   * Dump per-stage rejection counts, per-strategy candidate emission counts,
   * and the bar index of the last admitted signal per strategy at end of
   * run. This is the "smoking-gun" surface for funnel-latch debugging — see
   * fix/funnel-latch-bug investigation, May 2026.
   *
   * Reads the prom-client default registry (the same one the live engine
   * exposes via `/metrics`). Counter values reflect the entire backtest run
   * because the registry is process-wide.
   */
  private async logFunnelDiagnostics(): Promise<void> {
    const candidatesPerStrategy: Record<string, number> = {};
    const filteredByStage: Record<string, Record<string, number>> = {};
    const funnelByStage: Record<string, Record<string, number>> = {};

    try {
      const metrics = await promRegister.getMetricsAsJSON();
      for (const m of metrics) {
        if (m.name === 'atlas_strategy_signals_generated_total') {
          for (const sample of (m as any).values ?? []) {
            const strategy = sample.labels?.strategy ?? 'unknown';
            candidatesPerStrategy[strategy] =
              (candidatesPerStrategy[strategy] ?? 0) + Number(sample.value || 0);
          }
        } else if (m.name === 'atlas_signal_filtered_total') {
          for (const sample of (m as any).values ?? []) {
            const stage = sample.labels?.stage ?? 'unknown';
            const reason = sample.labels?.reason ?? 'unknown';
            filteredByStage[stage] = filteredByStage[stage] || {};
            filteredByStage[stage][reason] =
              (filteredByStage[stage][reason] ?? 0) + Number(sample.value || 0);
          }
        } else if (m.name === 'atlas_signal_funnel_total') {
          for (const sample of (m as any).values ?? []) {
            const stage = sample.labels?.stage ?? 'unknown';
            const strategy = sample.labels?.strategy ?? 'unknown';
            funnelByStage[stage] = funnelByStage[stage] || {};
            funnelByStage[stage][strategy] =
              (funnelByStage[stage][strategy] ?? 0) + Number(sample.value || 0);
          }
        }
      }
    } catch (err) {
      this.logger.warn('Funnel diagnostics: failed to read prom registry', err);
    }

    const lastAdmittedBars: Record<string, { barIndex: number; signalTime: string }> = {};
    for (const [strategy, idx] of this.lastSignalBarPerStrategy) {
      const ts = this.lastSignalTimestampPerStrategy.get(strategy);
      lastAdmittedBars[strategy] = {
        barIndex: idx,
        signalTime: ts ? ts.toISOString() : 'unknown',
      };
    }

    this.logger.info('Backtest funnel diagnostics', {
      totalBars: this.barIndex,
      candidatesPerStrategy,
      admittedPerStrategy: Object.fromEntries(this.signalAdmittedPerStrategy),
      lastAdmittedBarPerStrategy: lastAdmittedBars,
      filteredByStage,
      funnelByStage,
    });
  }

  private initializeSignalProcessor(): void {
    // SignalProcessor's plugin registry instantiates ALL four built-in
    // strategies via `createBuiltinStrategies`
    // (atlas/apps/core-node/src/strategies/plugins/builtin/index.ts:60).
    // That includes trend_follow — defect #1's "never wired" symptom was
    // really "no trend_follow toggle in BacktestConfig + no per-symbol
    // overrides loaded." Both are fixed below: we let the plugin registry
    // own instantiation, then apply trend_follow params via
    // updateStrategyConfig, then forward per-symbol overrides.
    const signalConfig = {
      supabaseUrl: '',
      supabaseKey: '',
      strategies: {
        breakout: {
          enabled: this.config.signals.breakout.enabled,
          period: (this.config.signals.breakout.parameters as any).period ?? 20,
          atrPeriod: (this.config.signals.breakout.parameters as any).atrPeriod ?? 14,
          atrMultiplier: (this.config.signals.breakout.parameters as any).atrMultiplier ?? 2,
          volumeThreshold: (this.config.signals.breakout.parameters as any).volumeThreshold ?? 1.5,
        },
        vwapMeanReversion: {
          enabled: this.config.signals.vwapMeanReversion.enabled,
          deviationEntry: (this.config.signals.vwapMeanReversion.parameters as any).deviationEntry ?? 2,
          deviationExit: (this.config.signals.vwapMeanReversion.parameters as any).deviationExit ?? 0.5,
          minVolume: (this.config.signals.vwapMeanReversion.parameters as any).minVolume ?? 1000,
        },
        momentum: {
          enabled: this.config.signals.momentum.enabled,
          rsiPeriod: (this.config.signals.momentum.parameters as any).rsiPeriod ?? 14,
          rsiOverbought: (this.config.signals.momentum.parameters as any).rsiOverbought ?? 70,
          rsiOversold: (this.config.signals.momentum.parameters as any).rsiOversold ?? 30,
          macdFast: (this.config.signals.momentum.parameters as any).macdFast ?? 12,
          macdSlow: (this.config.signals.momentum.parameters as any).macdSlow ?? 26,
          macdSignal: (this.config.signals.momentum.parameters as any).macdSignal ?? 9,
        },
      },
      metaLabeling: {
        enabled: false,
        threshold: 0.5,
      },
      // Defect #2 fix: plumb disabled_strategies through. SignalProcessor
      // hard-rejects signals whose strategy is in this list before they
      // reach the order pipeline (signal-processor.ts:942).
      disabledStrategies: Array.from(this.disabledStrategies),
      // F4 follow-up §8 (2026-05-19): forward the per-(symbol, strategy)
      // disable map so the SignalProcessor's per_symbol_disable gate also
      // fires in backtest. Without this the backtest would only see the
      // gate at backtest-engine.handleSignal (defence-in-depth) and miss
      // the per-stage funnel telemetry the live path produces.
      perSymbolDisabledStrategies: this.config.perSymbolDisabledStrategies,
      enableArbiter: true,
      usePluginStrategies: true,
    } as any;

    this.signalProcessor = new SignalProcessor(signalConfig, this.logger);

    // Strategy selector toggles (E4 harness, 2026-09-10). `BaseStrategy.enabled`
    // defaults to true and the constructor config's `enabled: false` never
    // flips it, so before this only trend_follow (below) honoured its
    // toggle: `--strategy trend_follow` still ran momentum, contaminating
    // every single-strategy expectancy. Apply the toggles explicitly at the
    // registry, the same way trend_follow always has. Strategies on the
    // guardrails kill list were never registered; disable() is a no-op there.
    const selectorToggles: Array<[string, boolean]> = [
      ['breakout', this.config.signals.breakout.enabled],
      ['vwap_mr', this.config.signals.vwapMeanReversion.enabled],
      ['momentum', this.config.signals.momentum.enabled],
    ];
    for (const [strategyId, enabled] of selectorToggles) {
      if (this.disabledStrategies.has(strategyId)) continue;
      if (enabled) {
        this.signalProcessor.enableStrategy(strategyId);
      } else {
        this.signalProcessor.disableStrategy(strategyId);
      }
    }

    // Defect #1 — apply optional global trend_follow params. Per-symbol
    // overrides (e.g. ETH-USD emaFast=12 / emaSlow=15) flow through
    // perSymbolOverrides below.
    const trendFollowToggle = this.config.signals.trendFollow;
    if (trendFollowToggle) {
      this.signalProcessor.updateStrategyConfig('trend_follow', {
        enabled: trendFollowToggle.enabled,
        ...(trendFollowToggle.parameters || {}),
      });
      if (!trendFollowToggle.enabled) {
        this.signalProcessor.disableStrategy('trend_follow');
      } else {
        this.signalProcessor.enableStrategy('trend_follow');
      }
    }

    if (this.config.perSymbolOverrides) {
      // Same code path live trading uses for ETH-USD / BTC-USD overrides.
      this.signalProcessor.loadPerSymbolOverrides(this.config.perSymbolOverrides);
    }

    if (this.config.regimeGates === false) {
      this.signalProcessor.setRegimeFilterEnabled(false);
    }

    // Snapshot the active strategy set AFTER the disabled filter so the
    // report can't lie about which strategies actually ran.
    const enabledPlugins = this.signalProcessor.getEnabledStrategies().map(s => s.id);
    this.activeStrategies = enabledPlugins.filter(id => !this.disabledStrategies.has(id));
    this.logger.info('Backtest active strategies', {
      registered: this.signalProcessor.getRegisteredStrategies().map(s => s.id),
      enabled: enabledPlugins,
      disabled: Array.from(this.disabledStrategies),
      active: this.activeStrategies,
    });

    this.signalProcessor.on('signal:generated', this.handleSignal.bind(this));
  }

  /** Regime-gate (RegimeFilter) state for the report. */
  private describeRegimeGate(): RegimeGateState {
    const stats = this.signalProcessor?.getRegimeFilterStats();
    return {
      enabled: stats?.enabled ?? this.config.regimeGates !== false,
      minCompatibilityScore: stats?.config.minCompatibilityScore ?? NaN,
      minRegimeConfidence: stats?.config.minRegimeConfidence ?? NaN,
      requireMTFAlignment: stats?.config.requireMTFAlignment ?? false,
    };
  }

  /**
   * Drive each bar in the canonical order:
   *
   *   1. Fill any pending entry from the previous bar at this bar's open.
   *   2. Mark-to-market open positions on this bar's close.
   *   3. Run stop/TP exits against this bar's high/low (with overshoot).
   *   4. Feed this bar's close to the signal processor; signals it emits
   *      enter pendingFills for the next bar.
   *   5. Record equity at this bar's close.
   *
   * Defect #3 fix: a signal computed from bar [i]'s close can never fill
   * inside bar [i] — the earliest opportunity is bar [i+1]'s open. Without
   * this, every backtest trade gets a one-bar look-ahead advantage.
   *
   * TASK_017: products are stepped on a shared TIMESTAMP timeline (union of
   * all series' bar times), not by array index. Index alignment silently
   * truncated every product to the shortest series and paired bars from
   * different points in time whenever one symbol had gaps or a later
   * start (e.g. SOL-USD bars begin six months after BTC/ETH).
   */
  private async processTimeSteps(): Promise<void> {
    const processor = this.signalProcessor;
    if (!processor) {
      throw new Error('Signal processor not initialized');
    }

    const seriesByProduct = new Map<string, Map<number, OHLCV>>();
    const timeSet = new Set<number>();
    for (const [product, data] of this.historicalData.entries()) {
      const byTime = new Map<number, OHLCV>();
      for (const candle of data) {
        byTime.set(candle.time, candle);
        timeSet.add(candle.time);
      }
      seriesByProduct.set(product, byTime);
    }

    if (timeSet.size === 0) {
      this.logger.warn('No historical data available for backtest');
      return;
    }

    const timeline = Array.from(timeSet).sort((a, b) => a - b);

    for (let step = 0; step < timeline.length; step++) {
      const barTime = timeline[step];
      const timestamp = new Date(barTime);
      this.barIndex = step;
      this.currentBarTime = timestamp;

      for (const [product, byTime] of seriesByProduct.entries()) {
        const candle = byTime.get(barTime);
        if (!candle) {
          continue;
        }

        // Step 1: Fill pending entry queued at the previous bar. Look-ahead fix.
        if (this.realism.nextBarFill) {
          this.fillPendingAtOpen(product, candle, timestamp);
        }

        // Step 2: Mark-to-market on close.
        this.updatePositions(product, candle.close, timestamp);

        // Step 3: Exit checks against this bar's range, with overshoot.
        this.checkExitConditions(product, candle, timestamp);

        // Step 4: Feed close into the signal pipeline. Any signal it emits
        // is queued for next bar via handleSignal -> pendingFills.
        //
        // Pass the bar's own timestamp as `nowMs`. The signal funnel's
        // dedup, flip-cooldown, cold-streak cooldown and decision-log ID
        // generation all consult this clock — feeding wall-clock here
        // collapses the entire backtest into a single ~36-48h trade-active
        // window (May 2026 funnel-latch bug; see SPRINT-PLAN-FINAL.md §3 F1).
        processor.addCandle(product, candle, candle.time);
      }

      this.recordEquity(timestamp);
    }
  }

  /**
   * Defect #3: signals must NOT fill on the same bar they were observed on.
   * `handleSignal` only stages a pending fill — the actual position is
   * opened when the next bar arrives, in `fillPendingAtOpen`.
   *
   * TASK_017 B2: SELL signals on a venue without shorting capability
   * (Coinbase spot) are exit-only — they close an open long or are dropped
   * with `spot_short_blocked` telemetry. This mirrors the live router
   * semantics (`shortAllowed = allow_short && capabilities.shorting`).
   */
  private handleSignal(signal: Signal): void {
    // Bar clock, not wall clock — see `currentBarTime`.
    const barTime = this.currentBarTime ?? signal.timestamp;
    // Per-(symbol, strategy) disable — narrower than the global kill list.
    // SignalProcessor.processSignal already gates this (with funnel
    // telemetry); we re-check here as defence-in-depth, matching the
    // pattern used by the global `disabledStrategies` check below.
    // Added 2026-05-19 (F4 follow-up §8).
    if (isSymbolStrategyDisabled(this.config.perSymbolDisabledStrategies, signal.symbol, signal.strategy)) {
      recordSignalFiltered(this.logger, {
        stage: 'per_symbol_disable',
        reason: 'symbol_strategy_disabled',
        symbol: signal.symbol,
        strategy: signal.strategy,
        signalId: signal.id,
        direction: signal.direction,
        strength: signal.strength,
        context: {
          source: 'backtest_engine',
          disabledOn: this.config.perSymbolDisabledStrategies?.[signal.symbol],
        },
      });
      return;
    }

    // Disabled strategies are filtered upstream by the signal processor;
    // gate here as defence-in-depth.
    if (this.disabledStrategies.has(signal.strategy)) {
      this.logger.debug('Backtest gated signal from disabled strategy', {
        strategy: signal.strategy,
        symbol: signal.symbol,
      });
      return;
    }

    // Funnel diagnostics — track final admissions per strategy. Logged at
    // end-of-run via `logFunnelDiagnostics`.
    this.signalAdmittedPerStrategy.set(
      signal.strategy,
      (this.signalAdmittedPerStrategy.get(signal.strategy) ?? 0) + 1,
    );
    this.lastSignalBarPerStrategy.set(signal.strategy, this.barIndex);
    this.lastSignalTimestampPerStrategy.set(signal.strategy, barTime);

    const position = this.positions.get(signal.symbol);
    if (position) {
      // Opposite-direction signal closes the position. Exit fills are
      // modeled at the signal's reference price (close of current bar).
      const isOppositeOfLong = position.side === 'long' && signal.direction === 'sell';
      const isOppositeOfShort = position.side === 'short' && signal.direction === 'buy';
      if (isOppositeOfLong || isOppositeOfShort) {
        // Live parity: `trade_cooldown_min` min-hold (api/server.ts routing,
        // reason `exit_position_too_young`), expressed in BARS on the bar
        // clock. Stops/TPs are handled in checkExitConditions and bypass it.
        const barsHeld = this.barIndex - position.entryBarIndex;
        if (this.minHoldBars > 0 && barsHeld < this.minHoldBars) {
          this.exitsIgnoredMinHold += 1;
          recordSignalFiltered(this.logger, {
            stage: 'routing',
            reason: 'exit_position_too_young',
            symbol: signal.symbol,
            strategy: signal.strategy,
            signalId: signal.id,
            direction: signal.direction,
            strength: signal.strength,
            context: { source: 'backtest_engine', barsHeld, minHoldBars: this.minHoldBars },
          });
          return;
        }
        if (isOppositeOfLong && !this.isShortAllowed(signal.symbol)) {
          this.sellSignalExits += 1;
        }
        this.closePosition(signal.symbol, signal.price, barTime, 'signal');
      }
      return;
    }

    // Live parity: ATR volatility filter (api/server.ts routing stage
    // `atr_vol`) — same inputs (signal ATR / signal price) and reasons.
    if (this.config.filters && !this.passesAtrVolatilityFilter(signal)) {
      return;
    }

    // No position: a SELL is a short ENTRY. Only venues with shorting
    // capability may take it (TASK_017 B2 / TASK_012 step 3).
    if (signal.direction === 'sell' && !this.isShortAllowed(signal.symbol)) {
      this.shortBlocked += 1;
      recordSignalFiltered(this.logger, {
        stage: 'spot_short_blocked',
        reason: 'venue_no_shorting',
        symbol: signal.symbol,
        strategy: signal.strategy,
        signalId: signal.id,
        direction: signal.direction,
        strength: signal.strength,
        context: {
          source: 'backtest_engine',
          venue: this.resolveVenue(signal.symbol),
          allowShort: this.config.allowShort ?? true,
        },
      });
      return;
    }

    if (this.realism.nextBarFill) {
      this.pendingFills.set(signal.symbol, {
        signal,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        generatedAt: barTime,
      });
    } else {
      // Legacy same-bar fill mode — kept only for parity testing.
      this.openPositionAt(signal, signal.price, barTime);
    }
  }

  /**
   * Live-parity ATR volatility filter. Mirrors api/server.ts: reads
   * `signal.metadata.indicators.atr`, computes ATR% against the signal price
   * and rejects outside `[atrVolatilityMin, atrVolatilityMax]`. A signal
   * without a usable ATR passes (same as live).
   */
  private passesAtrVolatilityFilter(signal: Signal): boolean {
    const atrMin = this.config.filters?.atrVolatilityMin;
    const atrMax = this.config.filters?.atrVolatilityMax;
    const indicators = signal.metadata?.indicators as Record<string, unknown> | undefined;
    const atrValue = indicators?.atr;
    if (typeof atrValue !== 'number' || !(atrValue > 0) || !(signal.price > 0)) {
      return true;
    }
    const atrPct = atrValue / signal.price;
    const belowMin = typeof atrMin === 'number' && atrPct < atrMin;
    const aboveMax = typeof atrMax === 'number' && atrPct > atrMax;
    if (!belowMin && !aboveMax) {
      return true;
    }
    this.atrFilterRejects += 1;
    recordSignalFiltered(this.logger, {
      stage: 'atr_vol',
      reason: belowMin ? 'atr_below_min' : 'atr_above_max',
      symbol: signal.symbol,
      strategy: signal.strategy,
      signalId: signal.id,
      direction: signal.direction,
      strength: signal.strength,
      context: { source: 'backtest_engine', atrPct, atrMin, atrMax },
    });
    return false;
  }

  private fillPendingAtOpen(product: string, candle: OHLCV, timestamp: Date): void {
    const pending = this.pendingFills.get(product);
    if (!pending) return;

    // Slippage applied symmetrically: long pays UP, short receives DOWN.
    const slipFactor = this.realism.entrySlippageBps / 10_000;
    const direction = pending.signal.direction;
    const fillPrice = direction === 'buy'
      ? candle.open * (1 + slipFactor)
      : candle.open * (1 - slipFactor);

    this.openPositionAt(pending.signal, fillPrice, timestamp, pending.stopLoss, pending.takeProfit);
    this.pendingFills.delete(product);
  }

  /**
   * Open a position at a given fill price. Sizing uses the SHARED
   * `computeRiskBasedSize` helper so backtest and live agree on
   * risk_per_trade math (defect #5).
   */
  private openPositionAt(
    signal: Signal,
    fillPrice: number,
    fillTimestamp: Date,
    stopLossOverride?: number,
    takeProfitOverride?: number,
  ): void {
    const stopLoss = this.resolveStopLoss(signal, stopLossOverride, fillPrice);
    const takeProfit = this.resolveTakeProfit(signal, takeProfitOverride, fillPrice);

    // Defence in depth: a short can only reach here on a shorting venue
    // (handleSignal already routes spot SELLs to exit-only).
    if (signal.direction === 'sell' && !this.isShortAllowed(signal.symbol)) {
      this.shortBlocked += 1;
      this.logger.warn('Backtest: short entry blocked at fill (venue has no shorting)', {
        symbol: signal.symbol,
        strategy: signal.strategy,
        venue: this.resolveVenue(signal.symbol),
      });
      return;
    }

    const equityAtEntry = this.capital;
    const positionSize = this.calculatePositionSize(signal, fillPrice, stopLoss);
    if (positionSize <= 0) {
      this.logger.debug('Backtest: position size 0, skipping', {
        symbol: signal.symbol,
        strategy: signal.strategy,
      });
      return;
    }

    let totalExposure = positionSize * fillPrice;
    for (const pos of this.positions.values()) {
      totalExposure += pos.size * pos.entryPrice;
    }
    if (totalExposure > this.config.risk.maxTotalExposure) {
      this.logger.debug('Backtest: rejected — exceeds max total exposure', {
        symbol: signal.symbol,
        totalExposure,
        max: this.config.risk.maxTotalExposure,
      });
      return;
    }

    // TASK_017 B3 — fee-adjusted EV gate at the same point the live router
    // applies it (post-sizing, pre-order).
    const evDecision = this.evaluateEntryEv(signal, fillPrice, stopLoss, takeProfit, positionSize);
    if (!evDecision.allowed) {
      return;
    }

    const entryFeeRate = this.resolveCommissionRate(signal.symbol);
    const trade: BacktestTrade = {
      id: this.nextTradeId(signal.symbol),
      timestamp: fillTimestamp,
      product: signal.symbol,
      side: signal.direction === 'buy' ? 'BUY' : 'SELL',
      entryPrice: fillPrice,
      size: positionSize,
      entryFee: positionSize * fillPrice * entryFeeRate,
      signal,
      strategy: signal.strategy,
      stopLoss,
      takeProfit,
      venue: this.resolveVenue(signal.symbol),
      equityAtEntry,
      ...(evDecision.record ? { evGate: evDecision.record } : {}),
    };

    if (signal.direction === 'buy') {
      this.longEntries += 1;
    } else {
      this.shortEntries += 1;
    }
    const regimeLabel = typeof signal.metadata?.regime === 'string' ? String(signal.metadata.regime) : 'unknown';
    this.entriesByRegime[regimeLabel] = (this.entriesByRegime[regimeLabel] ?? 0) + 1;

    this.capital -= trade.entryFee;

    const position: BacktestPosition = {
      product: signal.symbol,
      side: signal.direction === 'buy' ? 'long' : 'short',
      size: positionSize,
      entryPrice: trade.entryPrice,
      entryTimestamp: fillTimestamp,
      entryBarIndex: this.barIndex,
      unrealizedPnl: 0,
      trades: [trade],
    };

    this.positions.set(signal.symbol, position);

    this.logger.debug('Backtest opened position', {
      product: signal.symbol,
      strategy: signal.strategy,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
    });
  }

  private resolveStopLoss(signal: Signal, override: number | undefined, fillPrice: number): number {
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override;
    }
    if (Number.isFinite(signal.stopLoss) && signal.stopLoss > 0) {
      return signal.stopLoss;
    }
    return signal.direction === 'buy'
      ? fillPrice * (1 - this.config.risk.stopLossPercent)
      : fillPrice * (1 + this.config.risk.stopLossPercent);
  }

  private resolveTakeProfit(signal: Signal, override: number | undefined, fillPrice: number): number {
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return override;
    }
    if (Number.isFinite(signal.takeProfit) && signal.takeProfit > 0) {
      return signal.takeProfit;
    }
    return signal.direction === 'buy'
      ? fillPrice * (1 + this.config.risk.takeProfitPercent)
      : fillPrice * (1 - this.config.risk.takeProfitPercent);
  }

  /**
   * TASK_017 B3 — evaluate the fee-adjusted EV gate for an entry about to
   * fill. Uses the SAME pure `evaluateEvGate` the live RiskEngine wraps,
   * the fee rate this engine will actually charge on the fill (so fee
   * assumptions cannot drift between P&L and the gate), and the shared
   * Beta-prior p estimator fed by the run's own MetaFilter outcomes.
   *
   * Returns `{ allowed }` plus the record to attach to the trade. In
   * `shadow` mode a would-be reject is allowed but counted/logged
   * (`EV_GATE_SHADOW_ALLOW`). `off` returns allowed without evaluating.
   */
  private evaluateEntryEv(
    signal: Signal,
    fillPrice: number,
    stopLoss: number,
    takeProfit: number,
    size: number,
  ): { allowed: boolean; record?: NonNullable<BacktestTrade['evGate']> } {
    if (this.evGateMode === 'off') {
      return { allowed: true };
    }

    const perf = this.signalProcessor?.getStrategyPerformance(signal.strategy);
    const p = estimateWinRateWithPrior(
      perf ? { wins: perf.wins, losses: perf.losses } : null,
      this.evGatePrior,
    );

    const result = evaluateEvGate({
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      entryPrice: fillPrice,
      stopPrice: stopLoss,
      takeProfit,
      size,
      winRate: p,
      feeRateOverride: this.resolveCommissionRate(signal.symbol),
      minEvThreshold: this.evGateThreshold,
      venue: this.config.venue ?? 'coinbase',
    }, this.logger);

    this.evGateStats.evaluated += 1;
    const record: NonNullable<BacktestTrade['evGate']> = {
      ev: result.ev,
      p: result.p,
      feeUsd: result.feeUsd,
      threshold: result.threshold,
    };

    if (result.allowed) {
      this.evGateStats.allowed += 1;
      if (result.reason) {
        this.evGateStats.defaultAllowed += 1;
      }
      return { allowed: true, record };
    }

    const rejectedContext = {
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      reason: result.reason,
      ev: result.ev,
      threshold: result.threshold,
      p: result.p,
      feeUsd: result.feeUsd,
      notionalUsd: size * fillPrice,
      mode: this.evGateMode,
    };

    if (this.evGateMode === 'shadow') {
      this.evGateStats.allowed += 1;
      this.evGateStats.shadowWouldReject += 1;
      this.logger.warn('EV_GATE_SHADOW_ALLOW: entry would be rejected in enforce mode', rejectedContext);
      return { allowed: true, record: { ...record, shadowWouldReject: true } };
    }

    this.evGateStats.rejected += 1;
    this.evGateStats.rejectedByStrategy[signal.strategy] =
      (this.evGateStats.rejectedByStrategy[signal.strategy] ?? 0) + 1;
    recordSignalFiltered(this.logger, {
      stage: 'ev_gate',
      reason: 'ev_below_threshold',
      symbol: signal.symbol,
      strategy: signal.strategy,
      signalId: signal.id,
      direction: signal.direction,
      strength: signal.strength,
      context: { ...rejectedContext, source: 'backtest_engine' },
    });
    return { allowed: false, record };
  }

  /**
   * Defect #5 fix: replaces the old fixed $5k notional cap with the SAME
   * risk-based sizing the live engine uses (`computeRiskBasedSize`).
   *
   * size = (currentEquity * riskPerTrade) / |entry - stop|, capped by
   * maxPositionExposureUsd and config.risk.maxPositionSize.
   *
   * TASK_017 B4: `currentEquity` is the run's CASH equity
   * (`initialCapital + realized P&L − fees`, i.e. `this.capital`), never
   * the static `account.equityUsd`. That field is now only the reference
   * the CLI seeds `initialCapital` from; sizing compounds and de-risks with
   * the equity curve exactly like the live engine's dynamic equity.
   */
  private calculatePositionSize(signal: Signal, entryPrice: number, stopLoss: number): number {
    const account = this.config.account || {};
    const riskPerTrade = account.riskPerTrade ?? 0.005;
    const maxExposurePct = account.maxPositionExposurePct ?? 0.30;
    const minNotionalBuffer = account.minNotionalBuffer ?? 1.1;
    const equityForSizing = this.capital;

    const accountExposureCap = equityForSizing * maxExposurePct;
    const exposureCapUsd = Math.min(accountExposureCap, this.config.risk.maxPositionSize);
    const minNotionalUsd = equityForSizing * riskPerTrade * minNotionalBuffer;

    const result = computeRiskBasedSize({
      equity: equityForSizing,
      riskPerTrade,
      entryPrice,
      stopPrice: stopLoss,
      maxPositionExposureUsd: exposureCapUsd,
      minNotionalUsd,
      sizeDecimals: this.realism.sizeDecimals,
    });

    if (result.size <= 0) {
      this.logger.debug('Backtest sizing rejected', {
        symbol: signal.symbol,
        strategy: signal.strategy,
        reason: result.rejectedReason,
        entryPrice,
        stopLoss,
        equityForSizing,
      });
    }

    return result.size;
  }

  private nextTradeId(symbol: string): string {
    // Deterministic — same inputs always produce same ids.
    this.tradeIdCounter += 1;
    return `${symbol}_${this.tradeIdCounter}`;
  }

  private closePosition(
    product: string,
    rawExitPrice: number,
    timestamp: Date,
    reason: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_data',
  ): void {
    const position = this.positions.get(product);
    if (!position) return;

    // Slippage on signal/end-of-data exits is symmetric with entries.
    // Stop-loss / take-profit fills already include the overshoot model
    // baked in by `checkExitConditions`.
    let exitPrice = rawExitPrice;
    if (reason === 'signal' || reason === 'end_of_data') {
      const slipFactor = this.realism.entrySlippageBps / 10_000;
      exitPrice = position.side === 'long'
        ? rawExitPrice * (1 - slipFactor)
        : rawExitPrice * (1 + slipFactor);
    }

    const exitFeeRate = this.resolveCommissionRate(product);
    for (const trade of position.trades) {
      trade.exitPrice = exitPrice;
      trade.exitTimestamp = timestamp;
      trade.exitFee = trade.size * exitPrice * exitFeeRate;
      trade.exitReason = reason;
      if (position.side === 'long') {
        trade.pnl = (exitPrice - trade.entryPrice) * trade.size - trade.entryFee - (trade.exitFee || 0);
      } else {
        trade.pnl = (trade.entryPrice - exitPrice) * trade.size - trade.entryFee - (trade.exitFee || 0);
      }
      trade.pnlPercent = trade.entryPrice > 0
        ? trade.pnl / (trade.size * trade.entryPrice)
        : 0;
      this.closedTrades.push(trade);
    }

    const firstTrade = position.trades[0];
    const exitFee = firstTrade?.exitFee ?? 0;
    const sideMultiplier = position.side === 'long' ? 1 : -1;
    const pnl = (exitPrice - position.entryPrice) * position.size * sideMultiplier;
    this.capital += pnl - exitFee;

    // Live ↔ backtest parity (F2): mirror the live engine's
    // `position:closed` → `signalProcessor.recordTradeOutcome` flow at
    // `trading-engine.ts:940-973`. Without this, MetaFilter's strategy
    // performance counters (consecutive losses, win rate, hourly perf)
    // never update during a backtest, so the cold-streak rule never
    // fires — which means the backtest funnel does NOT reflect live
    // funnel behaviour. See SPRINT-PLAN-FINAL.md §3 F2 / §3 A5.
    //
    // Use `firstTrade.pnl` (fee-adjusted, the same number that flows
    // into `result.metrics.winningTrades / losingTrades`) so the
    // win/loss classification matches the result metrics exactly.
    // The live engine passes `position.realizedPnL`, which is also
    // fee-adjusted (`position-tracker.ts` deducts fees there).
    this.recordOutcomeToSignalProcessor(position, firstTrade, firstTrade?.pnl ?? 0);

    this.positions.delete(product);

    this.logger.debug('Backtest closed position', {
      product,
      exitPrice,
      reason,
      pnl: firstTrade?.pnl ?? 0,
    });
  }

  /**
   * Forward a closed-position outcome to the SignalProcessor → MetaFilter
   * so the backtest's strategy-perf and cold-streak state evolve the same
   * way the live engine's do. Shape mirrors `trading-engine.ts:956-972`
   * (the canonical live caller) so any future change to TradeOutcome
   * is one-touch.
   *
   * Errors here must NOT poison the close path — MetaFilter is a
   * downstream consumer; failing to record is a telemetry gap, not a
   * trade-accounting bug. We log and swallow.
   */
  private recordOutcomeToSignalProcessor(
    position: BacktestPosition,
    firstTrade: BacktestTrade | undefined,
    realizedPnl: number,
  ): void {
    if (!this.signalProcessor || !firstTrade) {
      return;
    }

    const exitTime = firstTrade.exitTimestamp ?? position.entryTimestamp;
    const outcome: 'win' | 'loss' | 'breakeven' =
      realizedPnl > 0 ? 'win' : realizedPnl < 0 ? 'loss' : 'breakeven';

    const signal = firstTrade.signal;
    const direction: 'buy' | 'sell' = position.side === 'long' ? 'buy' : 'sell';

    try {
      this.signalProcessor.recordTradeOutcome({
        signalId: signal?.id ?? firstTrade.id,
        strategy: firstTrade.strategy ?? signal?.strategy ?? 'unknown',
        symbol: position.product,
        direction,
        signalStrength: typeof signal?.strength === 'number' ? signal.strength : 0.5,
        entryTime: position.entryTimestamp,
        exitTime,
        pnl: realizedPnl,
        outcome,
        regime:
          typeof signal?.metadata?.regime === 'string'
            ? (signal.metadata.regime as string)
            : undefined,
        hourOfDay: position.entryTimestamp.getUTCHours(),
        dayOfWeek: position.entryTimestamp.getUTCDay(),
        metaScore:
          typeof signal?.metadata?.metaQualityScore === 'number'
            ? (signal.metadata.metaQualityScore as number)
            : undefined,
        filtersPassed: [],
        filtersBlocked: [],
      });
    } catch (err) {
      // Telemetry-only path — never block the close.
      this.logger.error('Failed to record backtest trade outcome to MetaFilter', {
        product: position.product,
        strategy: firstTrade.strategy,
        err: (err as Error)?.message,
      });
    }
  }

  private updatePositions(product: string, currentPrice: number, timestamp: Date): void {
    const position = this.positions.get(product);
    if (position) {
      if (position.side === 'long') {
        position.unrealizedPnl = (currentPrice - position.entryPrice) * position.size;
      } else {
        position.unrealizedPnl = (position.entryPrice - currentPrice) * position.size;
      }
    }

    const dateKey = timestamp.toISOString().split('T')[0] ?? '';
    const currentEquity = this.calculateCurrentEquity();
    if (!this.currentDay) {
      this.currentDay = dateKey;
      this.dailyStartEquity = currentEquity;
    } else if (dateKey !== this.currentDay) {
      const dailyReturn = (currentEquity - this.dailyStartEquity) / this.dailyStartEquity;
      this.dailyReturns.set(this.currentDay, dailyReturn);
      this.dailyStartEquity = currentEquity;
      this.currentDay = dateKey;
    }
  }

  /**
   * Defect #4 fix: stop fills include an OVERSHOOT factor. Real stops fill
   * worse than the trigger when price wicks/gaps through, so the model
   * pessimistically assumes:
   *
   *   overshootPx = max(stopOvershootBarRangePct * (high − low),
   *                     stopLevel * minBps/10000)
   *
   * For a long stop, fill = stopLoss − overshootPx. For a short stop, fill
   * = stopLoss + overshootPx. Take-profit fills stay at the level (filling
   * BETTER than the level on a wick is unrealistic too, but TP filling at
   * the level is the conventional pessimistic assumption).
   */
  private checkExitConditions(product: string, candle: OHLCV, timestamp: Date): void {
    const position = this.positions.get(product);
    if (!position) return;

    const trade = position.trades[0];
    const stopLoss = trade?.stopLoss ?? this.fallbackStopLoss(position);
    const takeProfit = trade?.takeProfit ?? this.fallbackTakeProfit(position);

    const longStopHit = position.side === 'long' && candle.low <= stopLoss;
    const shortStopHit = position.side === 'short' && candle.high >= stopLoss;
    if (longStopHit || shortStopHit) {
      const overshoot = this.computeStopOvershoot(candle, stopLoss);
      const exitPrice = position.side === 'long'
        ? Math.max(0, stopLoss - overshoot)
        : stopLoss + overshoot;
      this.closePosition(product, exitPrice, timestamp, 'stop_loss');
      return;
    }

    const longTpHit = position.side === 'long' && candle.high >= takeProfit;
    const shortTpHit = position.side === 'short' && candle.low <= takeProfit;
    if (longTpHit || shortTpHit) {
      this.closePosition(product, takeProfit, timestamp, 'take_profit');
    }
  }

  private fallbackStopLoss(position: BacktestPosition): number {
    return position.side === 'long'
      ? position.entryPrice * (1 - this.config.risk.stopLossPercent)
      : position.entryPrice * (1 + this.config.risk.stopLossPercent);
  }

  private fallbackTakeProfit(position: BacktestPosition): number {
    return position.side === 'long'
      ? position.entryPrice * (1 + this.config.risk.takeProfitPercent)
      : position.entryPrice * (1 - this.config.risk.takeProfitPercent);
  }

  private computeStopOvershoot(candle: OHLCV, stopLevel: number): number {
    const barRange = Math.max(0, candle.high - candle.low);
    const rangeBased = barRange * this.realism.stopOvershootBarRangePct;
    const minBased = stopLevel * (this.realism.stopOvershootMinBps / 10_000);
    return Math.max(rangeBased, minBased);
  }

  private calculateCurrentEquity(): number {
    let equity = this.capital;
    for (const position of this.positions.values()) {
      equity += position.unrealizedPnl;
    }
    return equity;
  }

  private recordEquity(timestamp: Date): void {
    const equity = this.calculateCurrentEquity();
    if (equity > this.peakCapital) {
      this.peakCapital = equity;
    }
    const drawdown = this.peakCapital > 0
      ? (this.peakCapital - equity) / this.peakCapital
      : 0;
    this.equityCurve.push({ timestamp, equity, drawdown });
  }

  private closeAllPositions(reason: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_data'): void {
    for (const [product] of this.positions.entries()) {
      const data = this.historicalData.get(product);
      if (data && data.length > 0) {
        const lastCandle = data[data.length - 1];
        if (!lastCandle) continue;
        this.closePosition(product, lastCandle.close, new Date(lastCandle.time), reason);
      }
    }
  }

  private calculateMetrics(): BacktestMetrics {
    const trades = this.closedTrades;
    const winningTrades = trades.filter(t => (t.pnl ?? 0) > 0);
    const losingTrades = trades.filter(t => (t.pnl ?? 0) <= 0);

    const grossProfit = winningTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0));
    const netProfit = grossProfit - grossLoss;
    const totalFees = trades.reduce((sum, t) => sum + t.entryFee + (t.exitFee ?? 0), 0);

    // Hold time on the bar clock (entry fill bar → exit bar). Both stamps
    // come from `processTimeSteps`' timeline, so a negative value is a
    // bookkeeping bug, not a metric — log it and exclude the trade.
    let totalHoldTime = 0;
    let validTrades = 0;
    for (const trade of trades) {
      if (trade.exitTimestamp) {
        const holdMinutes = (trade.exitTimestamp.getTime() - trade.timestamp.getTime()) / 60000;
        if (holdMinutes < 0) {
          this.logger.error('Backtest hold-time bookkeeping error (exit before entry)', {
            tradeId: trade.id,
            entry: trade.timestamp.toISOString(),
            exit: trade.exitTimestamp.toISOString(),
          });
          continue;
        }
        totalHoldTime += holdMinutes;
        validTrades++;
      }
    }

    const returns = Array.from(this.dailyReturns.values());
    const avgReturn = returns.length > 0
      ? returns.reduce((a, b) => a + b, 0) / returns.length
      : 0;
    const stdDev = returns.length > 1
      ? Math.sqrt(returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length)
      : 0;
    const sharpeRatio = stdDev > 0 ? (avgReturn / stdDev) * Math.sqrt(252) : 0;

    const downsideReturns = returns.filter(r => r < 0);
    const downsideDev = downsideReturns.length > 0
      ? Math.sqrt(downsideReturns.reduce((sum, r) => sum + r * r, 0) / downsideReturns.length)
      : 0;
    const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * Math.sqrt(252) : 0;

    let maxDrawdown = 0;
    let maxDrawdownPercent = 0;
    for (const point of this.equityCurve) {
      if (point.drawdown > maxDrawdownPercent) {
        maxDrawdownPercent = point.drawdown;
        maxDrawdown = this.peakCapital * point.drawdown;
      }
    }

    const finalCapital = this.calculateCurrentEquity();
    const byStrategy: Record<string, BacktestStrategyMetrics> = {};
    for (const trade of trades) {
      const key = trade.strategy || 'unknown';
      if (!byStrategy[key]) {
        byStrategy[key] = { trades: 0, winningTrades: 0, winRate: 0, netProfit: 0, averageRMultiple: 0 };
      }
      const bucket = byStrategy[key];
      bucket.trades += 1;
      bucket.netProfit += trade.pnl ?? 0;
      if ((trade.pnl ?? 0) > 0) bucket.winningTrades += 1;
      const stopDistance = Math.abs(trade.entryPrice - (trade.stopLoss ?? trade.entryPrice));
      const riskUsd = stopDistance * trade.size;
      if (riskUsd > 0) {
        bucket.averageRMultiple += (trade.pnl ?? 0) / riskUsd;
      }
    }
    for (const bucket of Object.values(byStrategy)) {
      bucket.winRate = bucket.trades > 0 ? bucket.winningTrades / bucket.trades : 0;
      bucket.averageRMultiple = bucket.trades > 0 ? bucket.averageRMultiple / bucket.trades : 0;
    }

    return {
      totalTrades: trades.length,
      winningTrades: winningTrades.length,
      losingTrades: losingTrades.length,
      winRate: trades.length > 0 ? winningTrades.length / trades.length : 0,
      grossProfit,
      grossLoss,
      netProfit,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : 0,
      sharpeRatio,
      sortinoRatio,
      maxDrawdown,
      maxDrawdownPercent,
      averageWin: winningTrades.length > 0 ? grossProfit / winningTrades.length : 0,
      averageLoss: losingTrades.length > 0 ? grossLoss / losingTrades.length : 0,
      largestWin: winningTrades.length > 0 ? Math.max(...winningTrades.map(t => t.pnl ?? 0)) : 0,
      largestLoss: losingTrades.length > 0 ? Math.min(...losingTrades.map(t => t.pnl ?? 0)) : 0,
      averageHoldTime: validTrades > 0 ? totalHoldTime / validTrades : 0,
      totalFees,
      finalCapital,
      returnPercent: ((finalCapital - this.config.initialCapital) / this.config.initialCapital) * 100,
      byStrategy,
      activeStrategies: this.activeStrategies,
      longEntries: this.longEntries,
      shortEntries: this.shortEntries,
      sellSignalExits: this.sellSignalExits,
      shortBlocked: this.shortBlocked,
      evGate: {
        ...this.evGateStats,
        rejectedByStrategy: { ...this.evGateStats.rejectedByStrategy },
      },
      entriesByRegime: { ...this.entriesByRegime },
      atrFilterRejects: this.atrFilterRejects,
      exitsIgnoredMinHold: this.exitsIgnoredMinHold,
    };
  }

  private getDailyReturns(): { date: string; returnPercent: number }[] {
    return Array.from(this.dailyReturns.entries()).map(([date, returnPercent]) => ({
      date,
      returnPercent: returnPercent * 100,
    }));
  }
}
