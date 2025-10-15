import { Logger } from '../core/logger';
import { BacktestEngine, BacktestConfig, BacktestResult } from './backtest-engine';
import { OHLCV } from '../indicators/technical';
import { CoinbaseExchange } from '../exchanges/coinbase';
import fs from 'fs/promises';
import path from 'path';

export interface BacktestRunnerConfig {
  dataPath: string; // Path to historical data directory
  resultsPath: string; // Path to save backtest results
  coinbaseConfig?: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase: string;
    environment: 'production' | 'sandbox';
  };
}

export class BacktestRunner {
  private config: BacktestRunnerConfig;
  private logger: Logger;
  private exchange?: CoinbaseExchange;

  constructor(config: BacktestRunnerConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;

    // Initialize exchange if config provided (for downloading data)
    if (config.coinbaseConfig) {
      this.exchange = new CoinbaseExchange({
        ...config.coinbaseConfig,
        wsUrl: 'wss://ws-feed.exchange.coinbase.com', // Not used for historical data
        restUrl: 'https://api.exchange.coinbase.com'
      }, logger);
    }
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

    // Create backtest engine
    const engine = new BacktestEngine(config, this.logger);

    // Load historical data
    await engine.loadHistoricalData(this.loadHistoricalData.bind(this));

    // Run backtest
    const result = await engine.run();

    // Save results
    await this.saveResults(result);

    return result;
  }

  /**
   * Load historical data from local cache or download from exchange
   */
  private async loadHistoricalData(product: string, startDate: Date, endDate: Date): Promise<OHLCV[]> {
    // Try to load from local cache first
    const cachedData = await this.loadCachedData(product, startDate, endDate);
    if (cachedData && cachedData.length > 0) {
      this.logger.info(`Loaded ${cachedData.length} candles from cache for ${product}`);
      return cachedData;
    }

    // Download from exchange if not cached
    if (this.exchange) {
      this.logger.info(`Downloading historical data for ${product}`);
      const data = await this.downloadHistoricalData(product, startDate, endDate);
      
      // Cache the data
      await this.cacheData(product, data);
      
      return data;
    }

    throw new Error(`No historical data available for ${product}`);
  }

  /**
   * Load cached data from disk
   */
  private async loadCachedData(product: string, startDate: Date, endDate: Date): Promise<OHLCV[] | null> {
    try {
      const filename = `${product.replace('/', '_')}_1m.json`;
      const filepath = path.join(this.config.dataPath, filename);
      
      const content = await fs.readFile(filepath, 'utf-8');
      const allData: OHLCV[] = JSON.parse(content);
      
      // Filter by date range
      const startTime = startDate.getTime();
      const endTime = endDate.getTime();
      
      return allData.filter(candle => {
        const time = candle.time;
        return time >= startTime && time <= endTime;
      });
    } catch (error) {
      this.logger.debug(`No cached data found for ${product}`);
      return null;
    }
  }

  /**
   * Download historical data from exchange
   */
  private async downloadHistoricalData(product: string, startDate: Date, endDate: Date): Promise<OHLCV[]> {
    if (!this.exchange) {
      throw new Error('Exchange not configured for downloading data');
    }

    const candles: OHLCV[] = [];
    const granularity = 60; // 1 minute
    const maxCandlesPerRequest = 300;
    
    let currentEnd = endDate;
    
    while (currentEnd > startDate) {
      const currentStart = new Date(Math.max(
        startDate.getTime(),
        currentEnd.getTime() - maxCandlesPerRequest * granularity * 1000
      ));

      try {
        const response = await this.exchange.rest.getCandles(product, {
          start: currentStart.toISOString(),
          end: currentEnd.toISOString(),
          granularity
        });

        // Convert response to OHLCV format
        for (const candle of response) {
          candles.unshift({
            time: candle[0] * 1000, // Convert to milliseconds
            low: candle[1],
            high: candle[2],
            open: candle[3],
            close: candle[4],
            volume: candle[5]
          });
        }

        // Move to next batch
        currentEnd = new Date(currentStart.getTime() - granularity * 1000);
        
        // Rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        this.logger.error(`Failed to download data for ${product}:`, error);
        break;
      }
    }

    return candles;
  }

  /**
   * Cache data to disk
   */
  private async cacheData(product: string, data: OHLCV[]): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(this.config.dataPath, { recursive: true });
      
      const filename = `${product.replace('/', '_')}_1m.json`;
      const filepath = path.join(this.config.dataPath, filename);
      
      // Load existing data if any
      let existingData: OHLCV[] = [];
      try {
        const content = await fs.readFile(filepath, 'utf-8');
        existingData = JSON.parse(content);
      } catch (error) {
        // File doesn't exist yet
      }
      
      // Merge data (remove duplicates)
      const timeMap = new Map<number, OHLCV>();
      for (const candle of existingData) {
        timeMap.set(candle.time, candle);
      }
      for (const candle of data) {
        timeMap.set(candle.time, candle);
      }
      
      // Sort by time
      const mergedData = Array.from(timeMap.values()).sort((a, b) => a.time - b.time);
      
      // Save to file
      await fs.writeFile(filepath, JSON.stringify(mergedData, null, 2));
      
      this.logger.info(`Cached ${mergedData.length} candles for ${product}`);
    } catch (error) {
      this.logger.error(`Failed to cache data for ${product}:`, error);
    }
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
Slippage: ${(config.slippage * 100).toFixed(2)}%

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

Risk Metrics:
------------
Profit Factor: ${metrics.profitFactor.toFixed(2)}
Sharpe Ratio: ${metrics.sharpeRatio.toFixed(2)}
Max Drawdown: $${metrics.maxDrawdown.toFixed(2)} (${(metrics.maxDrawdownPercent * 100).toFixed(2)}%)

Costs:
------
Total Fees: $${metrics.totalFees.toFixed(2)}

Trade Log (Last 10):
-------------------
${trades.slice(-10).map(t => 
  `${t.timestamp.toISOString()} ${t.product} ${t.side} @ ${t.entryPrice.toFixed(2)} -> ${t.exitPrice?.toFixed(2) || 'OPEN'} | PnL: $${t.pnl?.toFixed(2) || 'N/A'} (${t.pnlPercent ? (t.pnlPercent * 100).toFixed(2) + '%' : 'N/A'})`
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
        obj = obj[keys[i]];
      }
      
      obj[keys[keys.length - 1]] = value;
    }

    return config;
  }
}
