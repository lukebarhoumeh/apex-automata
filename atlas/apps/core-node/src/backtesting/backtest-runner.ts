import { Logger } from '../core/logger';
import { BacktestEngine, BacktestConfig, BacktestResult } from './backtest-engine';
import { HistoricalDataLoader } from './data-loader';
import fs from 'fs/promises';
import path from 'path';

export interface BacktestRunnerConfig {
  resultsPath: string;
  supabaseUrl: string;
  supabaseKey: string;
  coinbaseConfig?: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase?: string;
    environment: 'production' | 'sandbox';
  };
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
      },
      logger,
    );
  }

  /**
   * Run a backtest with the given configuration
   */
  public async runBacktest(config: BacktestConfig): Promise<BacktestResult> {
    this.logger.info('Running backtest', {
      startDate: config.startDate,
      endDate: config.endDate,
      products: config.products
    });

    const engine = new BacktestEngine(config, this.logger);
    await engine.loadHistoricalData(this.dataLoader.createDataProvider());
    const result = await engine.run();
    await this.saveResults(result);

    return result;
  }

  /**
   * Save backtest results
   */
  private async saveResults(result: BacktestResult): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(this.config.resultsPath, { recursive: true });
      
      // Generate filename with timestamp
      const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
      const filename = `backtest_${timestamp}.json`;
      const filepath = path.join(this.config.resultsPath, filename);
      
      // Save full results
      await fs.writeFile(filepath, JSON.stringify(result, null, 2));
      
      // Also save a summary report
      const reportFilename = `report_${timestamp}.txt`;
      const reportPath = path.join(this.config.resultsPath, reportFilename);
      
      const report = this.generateReport(result);
      await fs.writeFile(reportPath, report);
      
      this.logger.info(`Saved backtest results to ${filepath}`);
      this.logger.info(`Saved report to ${reportPath}`);
    } catch (error) {
      this.logger.error('Failed to save backtest results:', error);
    }
  }

  /**
   * Generate human-readable report
   */
  private generateReport(result: BacktestResult): string {
    const { config, metrics, trades } = result;

    const realism = config.realism ?? {};
    const account = config.account ?? {};

    const byStrategyLines = Object.entries(metrics.byStrategy ?? {})
      .map(([id, m]) =>
        `${id.padEnd(14)}  trades=${String(m.trades).padStart(4)}  winRate=${(m.winRate * 100).toFixed(1)}%  netPnL=$${m.netProfit.toFixed(2)}  avgR=${m.averageRMultiple.toFixed(2)}`,
      )
      .join('\n') || '(no closed trades)';

    const report = `
BACKTEST REPORT
===============

Configuration:
--------------
Start Date: ${config.startDate.toISOString()}
End Date: ${config.endDate.toISOString()}
Initial Capital: $${config.initialCapital.toFixed(2)}
Products: ${config.products.join(', ')}
Commission: ${(config.commission * 100).toFixed(2)}%

Realism Model:
--------------
Next-bar fill: ${realism.nextBarFill ?? true}
Entry slippage: ${realism.entrySlippageBps ?? 5} bps
Stop overshoot: ${(realism.stopOvershootBarRangePct ?? 0.20) * 100}% of bar range (min ${realism.stopOvershootMinBps ?? 5} bps)

Sizing Model:
-------------
Risk per trade: ${((account.riskPerTrade ?? 0.005) * 100).toFixed(3)}%
Max position exposure: ${((account.maxPositionExposurePct ?? 0.30) * 100).toFixed(1)}% of equity
Active strategies: ${(metrics.activeStrategies ?? []).join(', ') || '(none)'}
Disabled strategies: ${(config.disabledStrategies ?? []).join(', ') || '(none)'}

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
  `${t.timestamp.toISOString()} ${t.product} ${t.strategy ?? 'unknown'} ${t.side} @ ${t.entryPrice.toFixed(2)} -> ${t.exitPrice?.toFixed(2) || 'OPEN'} | PnL: $${t.pnl?.toFixed(2) || 'N/A'} (${t.pnlPercent ? (t.pnlPercent * 100).toFixed(2) + '%' : 'N/A'}) [${t.exitReason ?? 'open'}]`,
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
    metric: keyof BacktestResult['metrics'] = 'sharpeRatio'
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
      const result = await this.runBacktest(testConfig);
      
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
    // Deep clone base config
    const config = JSON.parse(JSON.stringify(baseConfig));
    
    // Apply parameters (this is a simplified version, you might need to handle nested params)
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
