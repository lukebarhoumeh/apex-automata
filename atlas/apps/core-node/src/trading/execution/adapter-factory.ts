/**
 * Execution Adapter Factory
 * 
 * Creates the appropriate execution adapter and account provider based on configuration.
 * This is the single switch point for paper vs live mode.
 *
 * Live mode FAILS CLOSED, in this order:
 *   1. `LIVE_STAGE0_INCOMPLETE` — Sprint 9 / Stage 0 (TASK_011–016) has not verified green
 *      (see `live-stage0-gate.ts`; a code constant, no runtime override).
 *   2. `LIVE_REQUIRES_ADVANCED_TRADE` — only `COINBASE_API_VERSION=advanced` (CDP key +
 *      ES256 JWT) can produce a live adapter. Legacy Coinbase Exchange (HMAC + passphrase)
 *      keys cannot authenticate this account.
 *   3. `LIVE_CREDENTIALS_MISSING` — no CDP key name / EC P-256 PEM supplied.
 * Each gate is independent; none replaces another. Paper mode consults none of them.
 */

import { Logger } from '../../core/logger';
import { FeeModel } from '../../core/fee-model';
import { CoinbaseExchange } from '../../exchanges/coinbase';
import { AdvancedTradeRestClient } from '../../exchanges/coinbase/advanced-trade-client';
import { AdvancedTradeUserStream } from '../../exchanges/coinbase/advanced-trade-user-stream';
import {
  IExecutionAdapter,
  ExecutionMode,
  MarketDataEnv,
  ExecutionEnv,
  EnvironmentConfig,
  DEFAULT_ENV_CONFIG,
  ProductSpec,
  buildDefaultProductSpecs,
} from './execution-adapter';
import { CoinbaseLiveExecutionAdapter, CoinbaseLiveAdapterConfig } from './coinbase-live-adapter';
import { CoinbaseAdvancedExecutionAdapter } from './coinbase-advanced-adapter';
import { PaperExecutionAdapter, PaperAdapterConfig } from './paper-adapter';
import { assertLiveStage0Complete } from './live-stage0-gate';
import { 
  IAccountProvider, 
  PaperAccountProvider, 
  LiveAccountProvider,
  PaperAccountConfig,
  LiveAccountConfig,
} from '../account/account-provider';

// Stage-0 gate lives in its own module so the constant has exactly one definition;
// re-exported here because this factory is the single paper/live switch point.
export {
  LIVE_STAGE0_INCOMPLETE,
  LIVE_STAGE0_COMPLETE,
  LIVE_STAGE0_REQUIRED_TASKS,
  assertLiveStage0Complete,
  isLiveStage0Complete,
} from './live-stage0-gate';

/** Error code thrown when live mode is requested without Advanced Trade (CDP) auth. */
export const LIVE_REQUIRES_ADVANCED_TRADE = 'LIVE_REQUIRES_ADVANCED_TRADE';
/** Error code thrown when live mode is requested without credentials. */
export const LIVE_CREDENTIALS_MISSING = 'LIVE_CREDENTIALS_MISSING';
/** Error code thrown while the engine's live order path is not yet routed through this factory. */
export const LIVE_EXECUTION_PATH_NOT_WIRED = 'LIVE_EXECUTION_PATH_NOT_WIRED';

/**
 * Capability flag: `true` once `TradingEngine` routes live orders through
 * `createAdapters()` → `CoinbaseAdvancedExecutionAdapter`. Today the engine still builds
 * `OrderManager` on the legacy `CoinbaseExchange` (HMAC) — see
 * `trading-engine.ts` `initializeOrderManager()` — so a live start would run with a dead
 * order path and no exchange-side protection. The preflight refuses live until the wiring
 * PR flips this to `true`.
 */
export const ENGINE_LIVE_EXECUTION_WIRED = false;

/**
 * Fail closed unless the engine's live order path actually uses the Advanced Trade adapter.
 */
export function assertLiveExecutionPathWired(): void {
  if (!ENGINE_LIVE_EXECUTION_WIRED) {
    throw new Error(
      `${LIVE_EXECUTION_PATH_NOT_WIRED}: TradingEngine still routes live orders through the legacy ` +
        'CoinbaseExchange (HMAC) client. Wire createAdapters()/CoinbaseAdvancedExecutionAdapter into ' +
        'OrderManager and set ENGINE_LIVE_EXECUTION_WIRED=true before starting live.',
    );
  }
}

/** Coinbase REST API flavour. Only `advanced` can trade with CDP keys. */
export type CoinbaseApiVersion = 'exchange' | 'advanced';

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
  /**
   * Fee model — single source of truth for maker/taker fees. Required when
   * productSpecs is not supplied, since the default specs no longer carry
   * hardcoded fee values (see execution-adapter.ts -> buildDefaultProductSpecs).
   */
  feeModel?: FeeModel;
  /** Paper adapter config overrides */
  paperConfig?: Partial<PaperAdapterConfig>;
  /**
   * Coinbase API flavour (from COINBASE_API_VERSION). Live mode requires `advanced`;
   * absent/`exchange` makes `createAdapters` throw for live.
   */
  coinbaseApiVersion?: CoinbaseApiVersion;
  /** Live credentials: CDP key name + EC P-256 PEM. Required in live mode. Never logged. */
  liveCredentials?: { apiKey: string; apiSecret: string };
  /** Symbols the live adapter loads product specs for at start() (defaults to productSpecs keys). */
  liveSymbols?: string[];
}

/**
 * Pre-built collaborators for the live adapter (tests / preflight reuse).
 */
export interface LiveAdapterDependencies {
  advancedTradeClient?: AdvancedTradeRestClient;
  /** Pass `null` to run without a user stream (polling only, reported as degraded). */
  userStream?: AdvancedTradeUserStream | null;
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
 * Create execution adapter and account provider based on config.
 *
 * Live: refused outright with `LIVE_STAGE0_INCOMPLETE` until Sprint 9 / Stage 0
 * (TASK_011–016) verifies green. Past that gate it requires
 * `coinbaseApiVersion === 'advanced'` and `liveCredentials`, otherwise throws
 * (`LIVE_REQUIRES_ADVANCED_TRADE` / `LIVE_CREDENTIALS_MISSING`). The legacy
 * `exchange` instance is NOT used for live execution any more — it remains a
 * parameter only for market data plumbing and paper-mode call sites.
 */
export function createAdapters(
  config: RuntimeConfig,
  exchange: CoinbaseExchange,
  logger: Logger,
  deps: LiveAdapterDependencies = {},
): AdapterSet {
  // Resolve product specs once. Fees come from FeeModel (guardrails.yaml);
  // there is intentionally no static fallback for fee values.
  let productSpecs = config.productSpecs;
  if (!productSpecs) {
    if (!config.feeModel) {
      throw new Error(
        'createAdapters: RuntimeConfig.feeModel is required when productSpecs is not supplied. ' +
          'Pass FeeModel.fromGuardrails(guardrails) so fees come from guardrails.yaml.',
      );
    }
    productSpecs = buildDefaultProductSpecs(config.feeModel);
  }

  if (config.executionMode === 'live') {
    // Hard refuse first: nothing on the live branch — not even credential parsing —
    // runs while Stage 0 is incomplete. The CDP/credential gates below remain in force
    // once this one opens.
    assertLiveStage0Complete();

    if (config.coinbaseApiVersion !== 'advanced') {
      throw new Error(
        `${LIVE_REQUIRES_ADVANCED_TRADE}: EXECUTION_MODE=live requires COINBASE_API_VERSION=advanced ` +
          `(CDP key + ES256 JWT). Got "${config.coinbaseApiVersion ?? 'exchange'}" — legacy Coinbase Exchange ` +
          'HMAC keys cannot authenticate this account, so the live adapter refuses to start.',
      );
    }

    let client = deps.advancedTradeClient;
    if (!client) {
      const apiKey = config.liveCredentials?.apiKey ?? '';
      const apiSecret = config.liveCredentials?.apiSecret ?? '';
      if (!apiKey || !apiSecret) {
        throw new Error(
          `${LIVE_CREDENTIALS_MISSING}: live mode requires COINBASE_API_KEY (CDP key name) and ` +
            'COINBASE_API_SECRET (EC P-256 PEM).',
        );
      }
      client = new AdvancedTradeRestClient(
        { apiKey, apiSecret, environment: config.executionEnv === 'sandbox' ? 'sandbox' : 'production' },
        logger,
      );
    }

    const symbols = config.liveSymbols && config.liveSymbols.length > 0 ? config.liveSymbols : Object.keys(productSpecs);
    const userStream =
      deps.userStream === undefined
        ? new AdvancedTradeUserStream({ logger, auth: client.getAuth(), productIds: symbols })
        : deps.userStream;

    logger.info('Creating Advanced Trade live execution adapter and account provider', {
      symbols,
      userStream: Boolean(userStream),
    });

    const executionAdapter = new CoinbaseAdvancedExecutionAdapter({
      logger,
      client,
      symbols,
      userStream,
    });

    // The hardened client exposes the legacy `getAccounts()` shape (paginated), so the
    // existing live account provider can consume it directly. TASK_011 replaces this
    // with LiveAccountTruth (USD+USDC, fee tier).
    const accountProvider = new LiveAccountProvider({
      logger,
      exchange: client,
    });

    return { executionAdapter, accountProvider };
  } else {
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

  // Coinbase API flavour (live mode requires 'advanced')
  const apiVersion = process.env.COINBASE_API_VERSION?.toLowerCase();
  if (apiVersion === 'exchange' || apiVersion === 'advanced') {
    config.coinbaseApiVersion = apiVersion;
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
