import { Logger } from '../core/logger';
import { BacktestEngine, BacktestConfig, BacktestResult } from './backtest-engine';
import { HistoricalDataLoader, LoadCandlesOptions, DataProvenance, DEFAULT_GRANULARITY_SECONDS } from './data-loader';
import { withBarAggregation, describeBarTimeframe, type SeriesProvider } from './bar-aggregation';
import fs from 'fs/promises';
import path from 'path';

export interface BacktestRunnerConfig {
  resultsPath: string;
  /** Optional when `fixtureDir` is set. */
  supabaseUrl?: string;
  supabaseKey?: string;
  coinbaseConfig?: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase?: string;
    environment: 'production' | 'sandbox';
  };
  /** Directory of `<SYMBOL>.json` bar fixtures (offline / CI source). */
  fixtureDir?: string;
}

/** Per-run data options forwarded to the loader. */
export interface BacktestDataOptions extends LoadCandlesOptions {
  /** Granularity of the stored bars (default 900 = 15m). */
  granularitySeconds?: number;
  /**
   * Bar size the ENGINE runs on (TASK_017 step 5 / E4 frequency lever).
   * When it differs from the stored spacing, series are rolled up
   * UTC-aligned after the fail-closed native load (`bar-aggregation.ts`).
   * Default: stored spacing (no aggregation).
   */
  barMinutes?: number;
  /** Min fraction of sub-bars a rolled-up bucket needs to be kept (default 0.5). */
  minBucketFill?: number;
}

/** Where `saveResults` wrote a run, so harnesses can cross-reference. */
export interface SavedBacktestPaths {
  jsonPath: string;
  reportPath: string;
}

/** Fee-tier label + bps as resolved by the CLI, echoed into the report. */
export interface FeeTierLabel {
  name: string;
  makerBps: number;
  takerBps: number;
}

export interface BacktestReportOptions {
  feeTier?: FeeTierLabel;
  /**
   * Suffix for the saved `backtest_<ts>[_<tag>].json` / `report_…` files.
   * Multi-pass harnesses set this so two passes in the same second cannot
   * overwrite each other (the timestamp alone is second-resolution).
   */
  fileTag?: string;
}

export class BacktestRunner {
  private config: BacktestRunnerConfig;
  private logger: Logger;
  private dataLoader: HistoricalDataLoader;

  constructor(config: BacktestRunnerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.dataLoader = new HistoricalDataLoader(
      {
        supabaseUrl: config.supabaseUrl,
        supabaseKey: config.supabaseKey,
        coinbaseConfig: config.coinbaseConfig,
        fixtureDir: config.fixtureDir,
      },
      logger,
    );
  }

  /**
   * Run a backtest with the given configuration.
   *
   * Data loading is fail-closed: a `DATA_UNAVAILABLE` error from the loader
   * propagates to the caller (no synthetic fallback unless
   * `dataOptions.allowSynthetic` is true).
   */
  public async runBacktest(
    config: BacktestConfig,
    dataOptions: BacktestDataOptions = {},
    reportOptions: BacktestReportOptions = {},
  ): Promise<BacktestResult> {
    const { result } = await this.runBacktestDetailed(config, dataOptions, reportOptions);
    return result;
  }

  /**
   * Same as {@link runBacktest} but also returns where the run was saved.
   * Accepts a pre-built provider (e.g. a memoized one shared across the
   * zero-fee and fee passes of the E4 harness) — when omitted one is built
   * from `dataOptions` via {@link createDataProvider}.
   */
  public async runBacktestDetailed(
    config: BacktestConfig,
    dataOptions: BacktestDataOptions = {},
    reportOptions: BacktestReportOptions = {},
    provider: SeriesProvider = this.createDataProvider(dataOptions),
  ): Promise<{ result: BacktestResult; saved: SavedBacktestPaths | null }> {
    this.logger.info('Running backtest', {
      startDate: config.startDate,
      endDate: config.endDate,
      products: config.products,
      allowSynthetic: Boolean(dataOptions.allowSynthetic),
      fixtureDir: this.config.fixtureDir,
      barMinutes: dataOptions.barMinutes ?? 'native',
    });

    const engine = new BacktestEngine(config, this.logger);
    await engine.loadHistoricalData(provider);
    const result = await engine.run();
    const saved = await this.saveResults(result, reportOptions);

    return { result, saved };
  }

  /**
   * Build the series provider for a run: fail-closed native load, then an
   * optional UTC-aligned rollup to `dataOptions.barMinutes`. Exposed so
   * multi-pass harnesses can load once and reuse.
   */
  public createDataProvider(dataOptions: BacktestDataOptions = {}): SeriesProvider {
    const { barMinutes, minBucketFill, ...loaderOptions } = dataOptions;
    const native: SeriesProvider = this.dataLoader.createDataProvider(loaderOptions);
    const nativeMinutes = (loaderOptions.granularitySeconds ?? DEFAULT_GRANULARITY_SECONDS) / 60;
    if (barMinutes === undefined || barMinutes === nativeMinutes) {
      return native;
    }
    return withBarAggregation(native, barMinutes, { minBucketFill }, this.logger);
  }

  /**
   * Save backtest results. Returns the written paths, or null when the
   * write failed (logged; a failed save never aborts the run).
   */
  private async saveResults(result: BacktestResult, reportOptions: BacktestReportOptions): Promise<SavedBacktestPaths | null> {
    try {
      // Ensure directory exists
      await fs.mkdir(this.config.resultsPath, { recursive: true });

      // Filename = second-resolution timestamp [+ caller tag]; a collision
      // guard appends -2, -3, … so back-to-back runs never overwrite.
      const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
      const tag = reportOptions.fileTag ? `_${reportOptions.fileTag.replace(/[^A-Za-z0-9_-]+/g, '-')}` : '';
      const stem = await this.uniqueStem(`${timestamp}${tag}`);
      const filepath = path.join(this.config.resultsPath, `backtest_${stem}.json`);

      // Save full results
      await fs.writeFile(filepath, JSON.stringify(result, null, 2));

      // Also save a summary report
      const reportPath = path.join(this.config.resultsPath, `report_${stem}.txt`);

      const report = this.generateReport(result, reportOptions);
      await fs.writeFile(reportPath, report);

      this.logger.info(`Saved backtest results to ${filepath}`);
      this.logger.info(`Saved report to ${reportPath}`);
      return { jsonPath: filepath, reportPath };
    } catch (error) {
      this.logger.error('Failed to save backtest results:', error);
      return null;
    }
  }

  /** First `stem`, `stem-2`, `stem-3`, … whose `backtest_<stem>.json` does not exist yet. */
  private async uniqueStem(base: string): Promise<string> {
    let stem = base;
    for (let i = 2; ; i++) {
      try {
        await fs.access(path.join(this.config.resultsPath, `backtest_${stem}.json`));
        stem = `${base}-${i}`;
      } catch {
        return stem;
      }
    }
  }

  /**
   * Human-readable report. Line 1 is ALWAYS the data stamp
   * (`DATA: REAL` or `DATA: SYNTHETIC …`) so nobody can quote a number
   * without seeing what it ran on.
   */
  public generateReport(result: BacktestResult, reportOptions: BacktestReportOptions = {}): string {
    const { config, metrics, trades } = result;

    const realism = config.realism ?? {};
    const account = config.account ?? {};

    const byStrategyLines = Object.entries(metrics.byStrategy ?? {})
      .map(([id, m]) =>
        `${id.padEnd(14)}  trades=${String(m.trades).padStart(4)}  winRate=${(m.winRate * 100).toFixed(1)}%  netPnL=$${m.netProfit.toFixed(2)}  avgR=${m.averageRMultiple.toFixed(2)}`,
      )
      .join('\n') || '(no closed trades)';

    const dataStampLine = result.dataStamp === 'SYNTHETIC'
      ? 'DATA: SYNTHETIC — SMOKE/VOID. Random-walk candles were used for at least one symbol; nothing below is evidence.'
      : 'DATA: REAL';

    const provenanceLines = Object.values(result.dataProvenance ?? {})
      .map((p) => describeProvenance(p))
      .join('\n') || '(no data provenance recorded)';

    const barTimeframe = describeBarTimeframe(Object.values(result.dataProvenance ?? {}));

    const venueLines = Object.entries(result.venueBySymbol ?? {})
      .map(([symbol, venue]) => `${symbol}: ${venue}${config.venueOverride ? ' (forced via --venue)' : ''}`)
      .join(', ') || '(none)';

    const feeLines = describeFees(result, reportOptions.feeTier);

    const totalEntries = metrics.longEntries + metrics.shortEntries;
    const longPct = totalEntries > 0 ? ((metrics.longEntries / totalEntries) * 100).toFixed(1) : '0.0';
    const shortPct = totalEntries > 0 ? ((metrics.shortEntries / totalEntries) * 100).toFixed(1) : '0.0';

    const ev = metrics.evGate;
    const evRejectedByStrategy = Object.entries(ev.rejectedByStrategy ?? {})
      .map(([s, n]) => `${s}=${n}`)
      .join(', ') || 'none';

    const regime = result.regimeGate;
    const regimeEntries = Object.entries(metrics.entriesByRegime ?? {})
      .map(([r, n]) => `${r}=${n}`)
      .join(', ') || 'none';

    const report = `${dataStampLine}
BACKTEST REPORT
===============

Data Provenance:
----------------
${provenanceLines}
Bar timeframe: ${barTimeframe}

Configuration:
--------------
Start Date: ${config.startDate.toISOString()}
End Date: ${config.endDate.toISOString()}
Initial Capital: $${config.initialCapital.toFixed(2)}
Products: ${config.products.join(', ')}
Venue per symbol: ${venueLines}
Shorting: allow_short=${config.allowShort ?? true} (effective only on perps venues; spot SELL = exit-only)

Fees (per side, taker assumed on every fill):
---------------------------------------------
${feeLines}

Realism Model:
--------------
Next-bar fill: ${realism.nextBarFill ?? true}
Entry slippage: ${realism.entrySlippageBps ?? 5} bps
Stop overshoot: ${(realism.stopOvershootBarRangePct ?? 0.20) * 100}% of bar range (min ${realism.stopOvershootMinBps ?? 5} bps)

Sizing Model:
-------------
Risk per trade: ${((account.riskPerTrade ?? 0.005) * 100).toFixed(3)}% of CURRENT cash equity (initial + realized)
Max position exposure: ${((account.maxPositionExposurePct ?? 0.30) * 100).toFixed(1)}% of equity
Active strategies: ${(metrics.activeStrategies ?? []).join(', ') || '(none)'}
Disabled strategies: ${(config.disabledStrategies ?? []).join(', ') || '(none)'}

Long/Short Split:
-----------------
Long entries: ${metrics.longEntries} (${longPct}%)
Short entries: ${metrics.shortEntries} (${shortPct}%)
SELL signals that exited a long: ${metrics.sellSignalExits}
SELL signals dropped (no shorting on venue): ${metrics.shortBlocked}

EV Gate:
--------
Mode: ${ev.mode}
Evaluated: ${ev.evaluated}  Allowed: ${ev.allowed}  Rejected: ${ev.rejected}  Default-allowed: ${ev.defaultAllowed}
Shadow would-reject: ${ev.shadowWouldReject}
Rejected by strategy: ${evRejectedByStrategy}

Regime Gate:
------------
Enabled: ${regime.enabled}  minCompatibilityScore=${regime.minCompatibilityScore}  minRegimeConfidence=${regime.minRegimeConfidence}  requireMTFAlignment=${regime.requireMTFAlignment}
Entries by regime: ${regimeEntries}

Performance Metrics:
-------------------
Total Return: ${metrics.returnPercent.toFixed(2)}%
Final Capital: $${metrics.finalCapital.toFixed(2)}
Net Profit: $${metrics.netProfit.toFixed(2)}

Trade Statistics:
----------------
Total Trades: ${metrics.totalTrades}
Winning Trades: ${metrics.winningTrades} (${(metrics.winRate * 100).toFixed(2)}%)
Losing Trades: ${metrics.losingTrades}
Average Win: $${metrics.averageWin.toFixed(2)}
Average Loss: $${metrics.averageLoss.toFixed(2)}
Largest Win: $${metrics.largestWin.toFixed(2)}
Largest Loss: $${metrics.largestLoss.toFixed(2)}
Average Hold Time: ${metrics.averageHoldTime.toFixed(2)} minutes

By-Strategy Breakdown:
---------------------
${byStrategyLines}

Risk Metrics:
------------
Profit Factor: ${metrics.profitFactor.toFixed(2)}
Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}
Sortino Ratio: ${metrics.sortinoRatio.toFixed(2)}
Max Drawdown: $${metrics.maxDrawdown.toFixed(2)} (${(metrics.maxDrawdownPercent * 100).toFixed(2)}%)

Costs:
------
Total Fees: $${metrics.totalFees.toFixed(2)}

Trade Log (Last 10):
-------------------
${trades.slice(-10).map(t =>
  `${t.timestamp.toISOString()} ${t.product} ${t.strategy ?? 'unknown'} ${t.side} @ ${t.entryPrice.toFixed(2)} -> ${t.exitPrice?.toFixed(2) || 'OPEN'} | PnL: $${t.pnl?.toFixed(2) || 'N/A'} (${t.pnlPercent ? (t.pnlPercent * 100).toFixed(2) + '%' : 'N/A'}) [${t.exitReason ?? 'open'}] eq@entry=$${t.equityAtEntry.toFixed(2)}`,
).join('\n')}
`;

    return report;
  }

  /**
   * Run optimization to find best parameters
   */
  public async runOptimization(
    baseConfig: BacktestConfig,
    parameterRanges: Record<string, { min: number; max: number; step: number }>,
    metric: keyof BacktestResult['metrics'] = 'sharpeRatio',
    dataOptions: BacktestDataOptions = {},
  ): Promise<{ bestParams: any; bestMetric: number; allResults: any[] }> {
    this.logger.info('Starting parameter optimization');

    const allResults: any[] = [];
    let bestParams: any = {};
    let bestMetric = -Infinity;

    // Generate all parameter combinations
    const paramCombinations = this.generateParameterCombinations(parameterRanges);

    for (const params of paramCombinations) {
      // Create config with current parameters
      const testConfig = this.applyParameters(baseConfig, params);

      // Run backtest
      const result = await this.runBacktest(testConfig, dataOptions);

      // Track results
      const metricValue = result.metrics[metric] as number;
      allResults.push({
        params,
        metric: metricValue,
        metrics: result.metrics
      });

      // Update best
      if (metricValue > bestMetric) {
        bestMetric = metricValue;
        bestParams = params;
      }

      this.logger.debug(`Tested parameters: ${JSON.stringify(params)}, ${metric}: ${metricValue}`);
    }

    this.logger.info(`Optimization complete. Best ${metric}: ${bestMetric}`);

    return { bestParams, bestMetric, allResults };
  }

  private generateParameterCombinations(ranges: Record<string, { min: number; max: number; step: number }>): any[] {
    const keys = Object.keys(ranges);
    const combinations: any[] = [];

    function generate(index: number, current: any): void {
      if (index === keys.length) {
        combinations.push({ ...current });
        return;
      }

      const key = keys[index];
      const range = ranges[key];
      if (!range) {
        generate(index + 1, current);
        return;
      }

      for (let value = range.min; value <= range.max; value += range.step) {
        current[key] = value;
        generate(index + 1, current);
      }
    }

    generate(0, {});
    return combinations;
  }

  private applyParameters(baseConfig: BacktestConfig, params: any): BacktestConfig {
    // Structured clone so Date instances and the FeeModel survive (a JSON
    // round-trip turned dates into strings and dropped the FeeModel's
    // prototype, which broke `config.startDate.toISOString()` downstream).
    const config: BacktestConfig = {
      ...baseConfig,
      startDate: new Date(baseConfig.startDate),
      endDate: new Date(baseConfig.endDate),
      signals: JSON.parse(JSON.stringify(baseConfig.signals)),
      risk: { ...baseConfig.risk },
      account: baseConfig.account ? { ...baseConfig.account } : undefined,
    };

    // Apply parameters (dotted paths, e.g. 'risk.stopLossPercent')
    for (const [key, value] of Object.entries(params)) {
      const keys = key.split('.');
      let obj: any = config;

      for (let i = 0; i < keys.length - 1; i++) {
        if (obj[keys[i]] === undefined) {
          obj[keys[i]] = {};
        }
        obj = obj[keys[i]];
      }

      obj[keys[keys.length - 1]] = value;
    }

    return config;
  }
}

function describeProvenance(p: DataProvenance): string {
  const coveragePct = `${(p.coverage * 100).toFixed(1)}%`;
  const fixture = p.fixturePath ? `  fixture=${path.basename(p.fixturePath)} sha256=${(p.fixtureSha256 ?? '').slice(0, 12)}` : '';
  const stamp = p.source === 'synthetic' ? '  [SYNTHETIC — VOID]' : '';
  const agg = p.aggregation && p.aggregation.subBarsPerBucket > 1
    ? `  aggregated=${p.aggregation.sourceMinutes}m→${p.aggregation.targetMinutes}m from ${p.aggregation.sourceCandleCount} bars ` +
      `(dropped=${p.aggregation.bucketsDropped} partialKept=${p.aggregation.partialBucketsKept})`
    : '';
  return (
    `${p.symbol.padEnd(14)} source=${p.source.padEnd(9)} bars=${String(p.candleCount).padStart(6)}/${String(p.expectedCount).padEnd(6)} ` +
    `coverage=${coveragePct.padStart(6)}  spacing=${p.inferredBarMinutes ?? 'n/a'}m  ` +
    `first=${p.firstBarTime ?? 'n/a'} last=${p.lastBarTime ?? 'n/a'}${fixture}${agg}${stamp}`
  );
}

function describeFees(result: BacktestResult, feeTier?: FeeTierLabel): string {
  const fees = result.fees;
  const lines: string[] = [];
  if (fees.routing === 'flat-override') {
    const bps = (fees.flatRate ?? 0) * 10_000;
    lines.push(`Routing: flat --commission override = ${bps.toFixed(2)} bps/side on every fill (spot AND perps)`);
    if (feeTier) {
      lines.push(`Fee tier flag: ${feeTier.name} (${feeTier.makerBps}/${feeTier.takerBps} bps) — IGNORED because --commission is set`);
    }
  } else {
    lines.push(`Routing: FeeModel per venue (exchange=${fees.exchange})`);
    for (const [venue, b] of Object.entries(fees.perVenue)) {
      lines.push(`  ${venue.padEnd(6)} maker=${b.makerBps} bps  taker=${b.takerBps} bps  (charged: taker)`);
    }
    if (feeTier) {
      lines.push(`Fee tier: ${feeTier.name} (maker ${feeTier.makerBps} / taker ${feeTier.takerBps} bps) applied to coinbase.spot`);
    }
  }
  lines.push('EV gate uses the same per-fill rate as P&L (round trip = 2 × taker).');
  return lines.join('\n');
}
