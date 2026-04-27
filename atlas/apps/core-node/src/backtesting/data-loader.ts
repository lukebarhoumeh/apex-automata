/**
 * Historical Data Loader for Backtesting
 * 
 * Provides functions to load real historical candle data from:
 * 1. Supabase `bars` table (preferred for speed)
 * 2. Coinbase Exchange API (fallback)
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../core/logger';
import { OHLCV } from '../indicators/technical';
import { CoinbaseRestClient } from '../exchanges/coinbase/rest-client';

export interface DataLoaderConfig {
  supabaseUrl: string;
  supabaseKey: string;
  coinbaseConfig?: {
    apiKey: string;
    apiSecret: string;
    apiPassphrase?: string;
    environment: 'production' | 'sandbox';
  };
}

export interface DataLoaderResult {
  candles: OHLCV[];
  source: 'supabase' | 'exchange' | 'synthetic';
  loadTime: number;
}

/**
 * Validates a single OHLCV candle for data integrity.
 * Returns true if the candle has valid OHLCV values.
 */
export function validateCandle(candle: OHLCV): boolean {
  if (candle.open <= 0 || candle.close <= 0) return false;
  if (candle.high < candle.low) return false;
  if (candle.volume < 0) return false;
  if (candle.high < Math.max(candle.open, candle.close)) return false;
  if (candle.low > Math.min(candle.open, candle.close)) return false;
  return true;
}

/**
 * Filters an array of candles, removing invalid entries and logging warnings.
 */
function filterValidCandles(candles: OHLCV[], product: string, logger: Logger): OHLCV[] {
  const valid: OHLCV[] = [];
  let invalidCount = 0;

  for (const candle of candles) {
    if (validateCandle(candle)) {
      valid.push(candle);
    } else {
      invalidCount++;
    }
  }

  if (invalidCount > 0) {
    logger.warn(`Filtered ${invalidCount} invalid candles for ${product}`, {
      totalLoaded: candles.length,
      validCount: valid.length,
    });
  }

  return valid;
}

/**
 * HistoricalDataLoader loads candle data from various sources.
 */
export class HistoricalDataLoader {
  private config: DataLoaderConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private coinbaseClient: CoinbaseRestClient | null = null;

  constructor(config: DataLoaderConfig, logger: Logger) {
    this.config = config;
    this.logger = logger;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);

    // Initialize Coinbase client if config provided
    if (config.coinbaseConfig) {
      this.coinbaseClient = new CoinbaseRestClient({
        apiKey: config.coinbaseConfig.apiKey,
        apiSecret: config.coinbaseConfig.apiSecret,
        apiPassphrase: config.coinbaseConfig.apiPassphrase,
        environment: config.coinbaseConfig.environment,
        wsUrl: '',
        restUrl: config.coinbaseConfig.environment === 'production'
          ? 'https://api.exchange.coinbase.com'
          : 'https://api-public.sandbox.exchange.coinbase.com',
      }, logger);
    }
  }

  /**
   * Load historical candles for a product within a date range.
   * Tries Supabase first, then exchange API, then synthetic data.
   */
  async loadCandles(
    product: string,
    startDate: Date,
    endDate: Date,
    granularitySeconds: number = 60
  ): Promise<DataLoaderResult> {
    const startTime = Date.now();

    // Try Supabase first
    const supabaseData = await this.loadFromSupabase(product, startDate, endDate);
    if (supabaseData.length > 0) {
      return {
        candles: supabaseData,
        source: 'supabase',
        loadTime: Date.now() - startTime,
      };
    }

    // Try exchange API
    if (this.coinbaseClient) {
      const exchangeData = await this.loadFromExchange(
        product,
        startDate,
        endDate,
        granularitySeconds
      );
      if (exchangeData.length > 0) {
        return {
          candles: exchangeData,
          source: 'exchange',
          loadTime: Date.now() - startTime,
        };
      }
    }

    // Fall back to synthetic data
    this.logger.warn(`No real data available for ${product}, generating synthetic data`);
    const syntheticData = this.generateSyntheticData(product, startDate, endDate, granularitySeconds);
    
    return {
      candles: syntheticData,
      source: 'synthetic',
      loadTime: Date.now() - startTime,
    };
  }

  /**
   * Load candles from Supabase bars table.
   *
   * The bars.time column is BIGINT epoch-seconds (per migration
   * 20260308_phase2a_create_bars_table.sql). Filters and the returned
   * OHLCV.time field need to convert between seconds (DB) and millis (engine).
   */
  private async loadFromSupabase(
    product: string,
    startDate: Date,
    endDate: Date
  ): Promise<OHLCV[]> {
    try {
      this.logger.info(`Loading ${product} data from Supabase`, {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });

      const startEpochSec = Math.floor(startDate.getTime() / 1000);
      const endEpochSec = Math.floor(endDate.getTime() / 1000);

      // Supabase JS client defaults to 1000 rows per response. Page via .range
      // so longer windows (90d × 15m bars × multiple symbols) load fully.
      const PAGE_SIZE = 1000;
      const allRows: any[] = [];
      let offset = 0;
      while (true) {
        const { data, error } = await this.supabase
          .from('bars')
          .select('time, open, high, low, close, volume')
          .eq('symbol', product)
          .gte('time', startEpochSec)
          .lte('time', endEpochSec)
          .order('time', { ascending: true })
          .range(offset, offset + PAGE_SIZE - 1);

        if (error) {
          if (error.code === '42P01') {
            this.logger.debug('bars table does not exist');
            return [];
          }
          throw error;
        }

        if (!data || data.length === 0) break;
        allRows.push(...data);
        if (data.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }

      if (allRows.length === 0) {
        this.logger.info(`No data found in Supabase for ${product}`);
        return [];
      }

      this.logger.info(`Loaded ${allRows.length} candles from Supabase for ${product}`);

      const candles = allRows.map((row: any) => ({
        time: Number(row.time) * 1000,
        open: parseFloat(row.open),
        high: parseFloat(row.high),
        low: parseFloat(row.low),
        close: parseFloat(row.close),
        volume: parseFloat(row.volume),
      }));
      return filterValidCandles(candles, product, this.logger);
    } catch (error) {
      this.logger.warn(`Failed to load from Supabase:`, error);
      return [];
    }
  }

  /**
   * Load candles from Coinbase exchange API.
   * Note: Exchange limits data to ~300 candles per request.
   */
  private async loadFromExchange(
    product: string,
    startDate: Date,
    endDate: Date,
    granularitySeconds: number
  ): Promise<OHLCV[]> {
    if (!this.coinbaseClient) {
      return [];
    }

    try {
      this.logger.info(`Loading ${product} data from exchange`, {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      });

      const allCandles: OHLCV[] = [];
      let currentStart = new Date(startDate);
      const maxCandlesPerRequest = 300;
      const intervalMs = granularitySeconds * 1000;

      while (currentStart < endDate) {
        // Calculate end of this batch
        const batchEnd = new Date(
          Math.min(
            currentStart.getTime() + maxCandlesPerRequest * intervalMs,
            endDate.getTime()
          )
        );

        try {
          const candles = await this.coinbaseClient.getProductCandles(product, {
            start: currentStart.toISOString(),
            end: batchEnd.toISOString(),
            granularity: granularitySeconds,
          });

          // Convert to OHLCV format
          const formattedCandles = candles.map(c => ({
            time: c.time * 1000, // Convert to milliseconds
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
          }));

          allCandles.push(...formattedCandles);

          // Rate limiting
          await new Promise(r => setTimeout(r, 100));
        } catch (error) {
          this.logger.warn(`Failed to fetch batch from exchange:`, error);
        }

        // Move to next batch
        currentStart = new Date(batchEnd.getTime() + intervalMs);
      }

      // Sort by time
      allCandles.sort((a, b) => a.time - b.time);

      const validated = filterValidCandles(allCandles, product, this.logger);
      this.logger.info(`Loaded ${validated.length} candles from exchange for ${product}`);
      return validated;
    } catch (error) {
      this.logger.warn(`Failed to load from exchange:`, error);
      return [];
    }
  }

  /**
   * Generate synthetic candlestick data for testing.
   * Uses random walk with realistic properties.
   */
  private generateSyntheticData(
    product: string,
    startDate: Date,
    endDate: Date,
    granularitySeconds: number
  ): OHLCV[] {
    const candles: OHLCV[] = [];
    const intervalMs = granularitySeconds * 1000;

    // Starting price based on product
    let price = product.startsWith('BTC') ? 50000 : product.startsWith('ETH') ? 3000 : 100;
    const volatility = 0.001; // 0.1% per candle
    const drift = 0.00001; // Slight upward drift

    let currentTime = startDate.getTime();

    while (currentTime <= endDate.getTime()) {
      // Random walk
      const change = (Math.random() - 0.5) * 2 * volatility + drift;
      const open = price;
      
      // Intra-candle movements
      const intraVolatility = volatility * 2;
      const high = open * (1 + Math.random() * intraVolatility);
      const low = open * (1 - Math.random() * intraVolatility);
      const close = open * (1 + change);
      
      // Ensure high/low bounds
      const actualHigh = Math.max(open, close, high);
      const actualLow = Math.min(open, close, low);
      
      // Random volume
      const baseVolume = product.startsWith('BTC') ? 100 : product.startsWith('ETH') ? 500 : 10000;
      const volume = baseVolume * (0.5 + Math.random() * 1.5);

      candles.push({
        time: currentTime,
        open,
        high: actualHigh,
        low: actualLow,
        close,
        volume,
      });

      price = close;
      currentTime += intervalMs;
    }

    const validated = filterValidCandles(candles, product, this.logger);
    this.logger.info(`Generated ${validated.length} synthetic candles for ${product}`);
    return validated;
  }

  /**
   * Create a data provider function for the backtest engine.
   */
  createDataProvider(): (product: string, start: Date, end: Date) => Promise<OHLCV[]> {
    return async (product: string, start: Date, end: Date): Promise<OHLCV[]> => {
      const result = await this.loadCandles(product, start, end);
      this.logger.info(`Data provider loaded ${result.candles.length} candles from ${result.source}`, {
        product,
        loadTime: result.loadTime,
      });
      return result.candles;
    };
  }

  /**
   * Save candles to Supabase for future use.
   */
  async saveToSupabase(product: string, candles: OHLCV[]): Promise<void> {
    if (candles.length === 0) {
      return;
    }

    try {
      // bars.time is BIGINT epoch-seconds; OHLCV.time is millis.
      const rows = candles.map(c => ({
        symbol: product,
        time: Math.floor(c.time / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      }));

      // Batch insert in chunks
      const chunkSize = 1000;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const { error } = await this.supabase.from('bars').upsert(chunk, {
          onConflict: 'symbol,time',
        });

        if (error) {
          this.logger.warn(`Failed to save candles batch:`, error);
        }
      }

      this.logger.info(`Saved ${candles.length} candles to Supabase for ${product}`);
    } catch (error) {
      this.logger.error(`Failed to save candles to Supabase:`, error);
    }
  }
}
