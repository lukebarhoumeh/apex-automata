/**
 * Execution Adapter Factory
 * 
 * Creates the appropriate execution adapter and account provider based on configuration.
 * This is the single switch point for paper vs live mode.
 */

import { Logger } from '../../core/logger';
import { CoinbaseExchange } from '../../exchanges/coinbase';
import {
  IExecutionAdapter,
  ExecutionMode,
  MarketDataEnv,
  ExecutionEnv,
  EnvironmentConfig,
  DEFAULT_ENV_CONFIG,
  ProductSpec,
  DEFAULT_PRODUCT_SPECS,
} from './execution-adapter';
import { CoinbaseLiveExecutionAdapter, CoinbaseLiveAdapterConfig } from './coinbase-live-adapter';
import { PaperExecutionAdapter, PaperAdapterConfig } from './paper-adapter';
import { 
  IAccountProvider, 
  PaperAccountProvider, 
  LiveAccountProvider,
  PaperAccountConfig,
  LiveAccountConfig,
} from '../account/account-provider';

/**
 * Runtime configuration (replaces scattered mode checks)
 */
export interface RuntimeConfig {
  /** Execution mode: paper or live */
  executionMode: ExecutionMode;
  /** Market data environment (default: production) */
  marketDataEnv: MarketDataEnv;
  /** Execution environment for live mode (default: production) */
  executionEnv: ExecutionEnv;
  /** Initial equity for paper mode */
  paperInitialEquityUsd: number;
  /** Product specifications */
  productSpecs?: Record<string, ProductSpec>;
  /** Paper adapter config overrides */
  paperConfig?: Partial<PaperAdapterConfig>;
}

/**
 * Default runtime config
 */
export const DEFAULT_RUNTIME_CONFIG: RuntimeConfig = {
  executionMode: 'paper',
  marketDataEnv: 'production', // Paper uses REAL market data by default
  executionEnv: 'production',
  paperInitialEquityUsd: 50000,
};

/**
 * Created adapters and providers
 */
export interface AdapterSet {
  executionAdapter: IExecutionAdapter;
  accountProvider: IAccountProvider;
}

/**
 * Create execution adapter and account provider based on config
 */
export function createAdapters(
  config: RuntimeConfig,
  exchange: CoinbaseExchange,
  logger: Logger
): AdapterSet {
  const productSpecs = config.productSpecs || DEFAULT_PRODUCT_SPECS;

  if (config.executionMode === 'live') {
    // Live mode
    logger.info('Creating live execution adapter and account provider');
    
    const executionAdapter = new CoinbaseLiveExecutionAdapter({
      logger,
      exchange,
      productSpecs,
    });

    const accountProvider = new LiveAccountProvider({
      logger,
      exchange,
    });

    return { executionAdapter, accountProvider };
  } else {
    // Paper mode
    logger.info('Creating paper execution adapter and account provider', {
      initialEquityUsd: config.paperInitialEquityUsd,
      marketDataEnv: config.marketDataEnv,
    });

    const executionAdapter = new PaperExecutionAdapter({
      logger,
      productSpecs,
      ...config.paperConfig,
    });

    const accountProvider = new PaperAccountProvider({
      logger,
      initialEquityUsd: config.paperInitialEquityUsd,
    });

    return { executionAdapter, accountProvider };
  }
}

/**
 * Get market data URLs based on environment
 */
export function getMarketDataUrls(env: MarketDataEnv): { wsUrl: string; restUrl: string } {
  if (env === 'production') {
    return {
      wsUrl: 'wss://ws-feed.exchange.coinbase.com',
      restUrl: 'https://api.exchange.coinbase.com',
    };
  } else {
    return {
      wsUrl: 'wss://ws-feed-public.sandbox.exchange.coinbase.com',
      restUrl: 'https://api-public.sandbox.exchange.coinbase.com',
    };
  }
}

/**
 * Get execution URLs based on environment (only for live mode)
 */
export function getExecutionUrls(env: ExecutionEnv): { wsUrl: string; restUrl: string } {
  if (env === 'production') {
    return {
      wsUrl: 'wss://ws-feed.exchange.coinbase.com',
      restUrl: 'https://api.exchange.coinbase.com',
    };
  } else {
    return {
      wsUrl: 'wss://ws-feed-public.sandbox.exchange.coinbase.com',
      restUrl: 'https://api-public.sandbox.exchange.coinbase.com',
    };
  }
}

/**
 * Validate runtime config
 */
export function validateRuntimeConfig(config: RuntimeConfig): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Paper mode should use production market data by default
  if (config.executionMode === 'paper' && config.marketDataEnv === 'sandbox') {
    // Warning, not error - might be intentional for testing
    console.warn('Paper mode using sandbox market data - prices may differ from production');
  }

  // Live mode with sandbox execution is risky
  if (config.executionMode === 'live' && config.executionEnv === 'sandbox') {
    console.warn('Live mode using sandbox execution - this is for testing only');
  }

  // Initial equity validation
  if (config.executionMode === 'paper' && config.paperInitialEquityUsd <= 0) {
    errors.push('Paper mode requires positive initial equity');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse environment config from env vars
 */
export function parseEnvConfig(): Partial<RuntimeConfig> {
  const config: Partial<RuntimeConfig> = {};

  // Execution mode
  const mode = process.env.EXECUTION_MODE?.toLowerCase();
  if (mode === 'paper' || mode === 'live') {
    config.executionMode = mode;
  }

  // Market data environment
  const marketDataEnv = process.env.MARKETDATA_ENV?.toLowerCase();
  if (marketDataEnv === 'production' || marketDataEnv === 'sandbox') {
    config.marketDataEnv = marketDataEnv;
  }

  // Execution environment
  const executionEnv = process.env.EXECUTION_ENV?.toLowerCase();
  if (executionEnv === 'production' || executionEnv === 'sandbox') {
    config.executionEnv = executionEnv;
  }

  // Initial equity
  const initialEquity = process.env.PAPER_INITIAL_EQUITY_USD;
  if (initialEquity) {
    const parsed = parseFloat(initialEquity);
    if (!isNaN(parsed) && parsed > 0) {
      config.paperInitialEquityUsd = parsed;
    }
  }

  return config;
}

/**
 * Build runtime config from env vars with defaults
 */
export function buildRuntimeConfig(overrides?: Partial<RuntimeConfig>): RuntimeConfig {
  const envConfig = parseEnvConfig();
  
  return {
    ...DEFAULT_RUNTIME_CONFIG,
    ...envConfig,
    ...overrides,
  };
}

/**
 * Guard to prevent live trading calls in paper mode
 * Throws if in paper mode and a live endpoint is attempted
 */
export function assertNotPaperMode(
  mode: ExecutionMode,
  operation: string
): void {
  if (mode === 'paper') {
    throw new Error(
      `SAFETY: Attempted live trading operation "${operation}" while in paper mode. ` +
      `This should never happen - check adapter wiring.`
    );
  }
}
