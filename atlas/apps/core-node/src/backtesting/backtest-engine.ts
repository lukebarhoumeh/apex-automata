import { EventEmitter } from 'events';
import { register as promRegister } from 'prom-client';
import { Logger } from '../core/logger';
import type { OHLCV } from '../indicators/technical';
// NOTE (indicator-standardization, 2026-05): TechnicalIndicators import was
// dead in this file. The signal pipeline owns indicator computation; this
// engine just consumes signals. Removed to keep call-graph honest.
import { SignalProcessor, Signal } from '../strategies/signal-processor';
import { computeRiskBasedSize } from '../trading/risk/position-sizing';

type OrderSide = 'BUY' | 'SELL';

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
  commission: number; // Decimal fraction (e.g. 0.0005 for 5 bps fee)
  /**
   * @deprecated Use `realism.entrySlippageBps`. Kept on the type so older
   * callers don't break, but the engine now reads bps directly.
   */
  slippage: number;
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
  /** Per-symbol strategy overrides (forwarded to plugin registry). */
  perSymbolOverrides?: PerSymbolStrategyOverrides;
  /** Realism knobs (look-ahead, overshoot, slippage). */
  realism?: BacktestRealismConfig;
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
}

export interface BacktestPosition {
  product: string;
  side: 'long' | 'short';
  size: number;
  entryPrice: number;
  entryTimestamp: Date;
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
  averageHoldTime: number; // in minutes
  totalFees: number;
  finalCapital: number;
  returnPercent: number;
  /** Per-strategy breakdown, used by the deliverable summary table. */
  byStrategy: Record<string, BacktestStrategyMetrics>;
  /** Snapshot of which strategies actually ran (post disabled_strategies filter) */
  activeStrategies: string[];
}

export interface BacktestResult {
  config: BacktestConfig;
  trades: BacktestTrade[];
  metrics: BacktestMetrics;
  equityCurve: { timestamp: Date; equity: number; drawdown: number }[];
  dailyReturns: { date: string; returnPercent: number }[];
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

  constructor(config: BacktestConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.capital = config.initialCapital;
    this.peakCapital = config.initialCapital;
    this.dailyStartEquity = config.initialCapital;
    this.realism = { ...DEFAULT_REALISM, ...(config.realism || {}) };
    this.disabledStrategies = new Set(config.disabledStrategies ?? DEFAULT_DISABLED_STRATEGIES);
  }

  public async loadHistoricalData(dataProvider: (product: string, start: Date, end: Date) => Promise<OHLCV[]>): Promise<void> {
    this.logger.info('Loading historical data', {
      products: this.config.products,
      startDate: this.config.startDate,
      endDate: this.config.endDate,
    });

    for (const product of this.config.products) {
      const data = await dataProvider(product, this.config.startDate, this.config.endDate);
      this.historicalData.set(product, data);
      this.logger.info(`Loaded ${data.length} candles for ${product}`);
    }
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
    const result: BacktestResult = {
      config: this.config,
      trades: this.closedTrades,
      metrics,
      equityCurve: this.equityCurve,
      dailyReturns: this.getDailyReturns(),
    };

    this.logger.info('Backtest completed', {
      totalTrades: metrics.totalTrades,
      netProfit: metrics.netProfit,
      returnPercent: metrics.returnPercent,
      activeStrategies: metrics.activeStrategies,
      byStrategy: metrics.byStrategy,
    });

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
      enableArbiter: true,
      usePluginStrategies: true,
    } as any;

    this.signalProcessor = new SignalProcessor(signalConfig, this.logger);

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

  /**
   * Drive each bar in the canonical order:
   *
   *   1. Fill any pending entry from bar [i-1] at this bar's open.
   *   2. Mark-to-market open positions on this bar's close.
   *   3. Run stop/TP exits against this bar's high/low (with overshoot).
   *   4. Feed this bar's close to the signal processor; signals it emits
   *      enter pendingFills for [i+1].
   *   5. Record equity at this bar's close.
   *
   * Defect #3 fix: a signal computed from bar [i]'s close can never fill
   * inside bar [i] — the earliest opportunity is bar [i+1]'s open. Without
   * this, every backtest trade gets a one-bar look-ahead advantage.
   */
  private async processTimeSteps(): Promise<void> {
    const processor = this.signalProcessor;
    if (!processor) {
      throw new Error('Signal processor not initialized');
    }

    let minCandles = Infinity;
    for (const data of this.historicalData.values()) {
      minCandles = Math.min(minCandles, data.length);
    }

    const firstSeries = this.historicalData.values().next().value as OHLCV[] | undefined;
    if (!firstSeries || !Number.isFinite(minCandles) || minCandles === Infinity) {
      this.logger.warn('No historical data available for backtest');
      return;
    }

    for (let i = 50; i < minCandles; i++) {
      const baseCandle = firstSeries[i];
      if (!baseCandle) {
        continue;
      }
      const timestamp = new Date(baseCandle.time);
      this.barIndex = i;

      for (const [product, data] of this.historicalData.entries()) {
        const candle = data[i];
        if (!candle) {
          continue;
        }

        // Step 1: Fill pending entry queued at bar [i-1]. Look-ahead fix.
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
   */
  private handleSignal(signal: Signal): void {
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
    this.lastSignalTimestampPerStrategy.set(signal.strategy, signal.timestamp);

    const position = this.positions.get(signal.symbol);
    if (position) {
      // Opposite-direction signal closes the position. Exit fills are
      // modeled at the signal's reference price (close of current bar).
      const isOppositeOfLong = position.side === 'long' && signal.direction === 'sell';
      const isOppositeOfShort = position.side === 'short' && signal.direction === 'buy';
      if (isOppositeOfLong || isOppositeOfShort) {
        this.closePosition(signal.symbol, signal.price, signal.timestamp, 'signal');
      }
      return;
    }

    if (this.realism.nextBarFill) {
      this.pendingFills.set(signal.symbol, {
        signal,
        stopLoss: signal.stopLoss,
        takeProfit: signal.takeProfit,
        generatedAt: signal.timestamp,
      });
    } else {
      // Legacy same-bar fill mode — kept only for parity testing.
      this.openPositionAt(signal, signal.price, signal.timestamp);
    }
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

    const trade: BacktestTrade = {
      id: this.nextTradeId(signal.symbol),
      timestamp: fillTimestamp,
      product: signal.symbol,
      side: signal.direction === 'buy' ? 'BUY' : 'SELL',
      entryPrice: fillPrice,
      size: positionSize,
      entryFee: positionSize * fillPrice * this.config.commission,
      signal,
      strategy: signal.strategy,
      stopLoss,
      takeProfit,
    };

    this.capital -= trade.entryFee;

    const position: BacktestPosition = {
      product: signal.symbol,
      side: signal.direction === 'buy' ? 'long' : 'short',
      size: positionSize,
      entryPrice: trade.entryPrice,
      entryTimestamp: fillTimestamp,
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
   * Defect #5 fix: replaces the old fixed $5k notional cap with the SAME
   * risk-based sizing the live engine uses (`computeRiskBasedSize`).
   *
   * size = (currentEquity * riskPerTrade) / |entry - stop|, capped by
   * maxPositionExposureUsd and config.risk.maxPositionSize.
   */
  private calculatePositionSize(signal: Signal, entryPrice: number, stopLoss: number): number {
    const account = this.config.account || {};
    const riskPerTrade = account.riskPerTrade ?? 0.005;
    const maxExposurePct = account.maxPositionExposurePct ?? 0.30;
    const minNotionalBuffer = account.minNotionalBuffer ?? 1.1;
    const equityForSizing = account.equityUsd ?? this.calculateCurrentEquity();

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

    for (const trade of position.trades) {
      trade.exitPrice = exitPrice;
      trade.exitTimestamp = timestamp;
      trade.exitFee = trade.size * exitPrice * this.config.commission;
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

    let totalHoldTime = 0;
    let validTrades = 0;
    for (const trade of trades) {
      if (trade.exitTimestamp) {
        totalHoldTime += (trade.exitTimestamp.getTime() - trade.timestamp.getTime()) / 60000;
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
    };
  }

  private getDailyReturns(): { date: string; returnPercent: number }[] {
    return Array.from(this.dailyReturns.entries()).map(([date, returnPercent]) => ({
      date,
      returnPercent: returnPercent * 100,
    }));
  }
}
