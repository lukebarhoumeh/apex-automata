/**
 * CoinbasePerpsAdapter — extends CoinbaseAdapter for perpetual futures.
 *
 * Inherits all spot trading capabilities from CoinbaseAdapter and adds:
 * - Perpetual futures position tracking (real positions, not empty array)
 * - Funding rate queries
 * - Leverage management
 * - Portfolio margin summary
 * - Perps product detection and filtering
 *
 * Registered as 'coinbase-perps' in the ExchangeRegistry alongside
 * the spot 'coinbase' adapter. Both share the same underlying CoinbaseExchange.
 */

import { Logger } from '../core/logger';
import {
  CoinbasePerpsProduct,
  CoinbaseIntxPosition,
} from './coinbase/types';
import { CoinbaseAdapter } from './coinbase-adapter';
import {
  ExchangeCredentials,
  ExchangeType,
  AdapterPosition,
  AdapterMarketInfo,
  AdapterFundingRate,
  AdapterPortfolioSummary,
  IPerpsAdapter,
} from './types';

export class CoinbasePerpsAdapter extends CoinbaseAdapter implements IPerpsAdapter {
  override readonly id = 'coinbase-perps';
  override readonly name = 'Coinbase Perpetual Futures';
  override readonly exchangeType: ExchangeType = 'perpetual';

  private perpsProductCache: Map<string, CoinbasePerpsProduct> = new Map();
  private leverageCache: Map<string, number> = new Map();
  private perpsLogger: Logger;

  constructor(logger: Logger) {
    super(logger);
    this.perpsLogger = logger;
  }

  // ---- Lifecycle Override ----

  /**
   * Initialize and cache available perps products.
   * Calls parent initialize() first, then loads perps product list.
   */
  override async initialize(credentials: ExchangeCredentials): Promise<void> {
    await super.initialize(credentials);
    try {
      await this.refreshPerpsProducts();
    } catch (err) {
      this.perpsLogger.warn('Perps product fetch failed (INTX not enabled?) — using string fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.perpsLogger.info(`CoinbasePerpsAdapter initialized with ${this.perpsProductCache.size} perps products`);
  }

  // ---- Perps Product Detection ----

  /**
   * Refresh the cached list of available perpetual futures products.
   * Called on init and can be called periodically to pick up new listings.
   */
  async refreshPerpsProducts(): Promise<void> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getPerpsProducts) {
      this.perpsLogger.warn('REST client does not support getPerpsProducts — no perps available');
      return;
    }
    try {
      const products: CoinbasePerpsProduct[] = await restClient.getPerpsProducts();
      this.perpsProductCache.clear();
      for (const p of products) {
        this.perpsProductCache.set(p.product_id, p);
      }
    } catch (err) {
      this.perpsLogger.warn('refreshPerpsProducts failed — perps product cache will be empty', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Check if a symbol is a perpetual futures contract */
  isPerpsSymbol(symbol: string): boolean {
    return this.perpsProductCache.has(symbol) || symbol.includes('-PERP-');
  }

  /** List all available perpetual futures symbols */
  async getPerpsSymbols(): Promise<string[]> {
    if (this.perpsProductCache.size === 0) {
      await this.refreshPerpsProducts();
    }
    return Array.from(this.perpsProductCache.keys());
  }

  // ---- Positions Override (real perps positions) ----

  /**
   * Get open perpetual futures positions from INTX API.
   * Overrides the spot adapter's empty array return.
   */
  override async getPositions(): Promise<AdapterPosition[]> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getIntxPositions) {
      return [];
    }

    const positions: CoinbaseIntxPosition[] = await restClient.getIntxPositions();
    return positions
      .filter((p) => parseFloat(p.number_of_contracts) !== 0)
      .map((p) => this.mapIntxPosition(p));
  }

  // ---- Funding Rate ----

  /**
   * Get current funding rate for a perpetual contract.
   * Funding accrues hourly, settles twice daily on Coinbase.
   */
  async getFundingRate(symbol: string): Promise<AdapterFundingRate | null> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getFundingRate) {
      return null;
    }

    const rate = await restClient.getFundingRate(symbol);
    if (!rate) return null;

    return {
      symbol: rate.product_id,
      rate: rate.funding_rate,
      nextSettlement: new Date(rate.funding_time).getTime(),
      markPrice: rate.mark_price,
      indexPrice: rate.index_price,
    };
  }

  // ---- Leverage Management ----

  /**
   * Set leverage for a perpetual futures symbol.
   * Caches the setting locally for getLeverage() queries.
   */
  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    if (leverage < 1 || leverage > 10) {
      this.perpsLogger.error(`Invalid leverage ${leverage} for ${symbol}. Must be 1-10.`);
      return false;
    }

    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.setLeverage) {
      this.perpsLogger.warn('REST client does not support setLeverage');
      return false;
    }

    const success = await restClient.setLeverage(symbol, leverage);
    if (success) {
      this.leverageCache.set(symbol, leverage);
      this.perpsLogger.info(`Leverage set to ${leverage}x for ${symbol}`);
    }
    return success;
  }

  /**
   * Get current leverage for a symbol.
   * Returns cached value or null if not set.
   */
  async getLeverage(symbol: string): Promise<number | null> {
    return this.leverageCache.get(symbol) ?? null;
  }

  // ---- Portfolio Summary ----

  /**
   * Get portfolio margin summary (collateral, buying power, margin usage).
   */
  async getPortfolioSummary(): Promise<AdapterPortfolioSummary | null> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getIntxPortfolio) {
      return null;
    }

    const portfolio = await restClient.getIntxPortfolio();
    if (!portfolio) return null;

    return {
      totalCollateral: portfolio.collateral,
      unrealizedPnl: portfolio.unrealized_pnl,
      buyingPower: portfolio.buying_power,
      marginUsed: portfolio.margin_used,
      maxWithdrawal: portfolio.max_withdrawal,
    };
  }

  // ---- Market Info Override (perps-aware) ----

  /**
   * Override getMarketInfo to return perps-specific data when symbol is a perp.
   * Perps have different fee structure: 0% maker / 0.03% taker.
   */
  override async getMarketInfo(symbol: string): Promise<AdapterMarketInfo> {
    if (this.isPerpsSymbol(symbol)) {
      const product = this.perpsProductCache.get(symbol);
      if (product) {
        return {
          symbol: product.product_id,
          baseCurrency: product.base_currency,
          quoteCurrency: product.quote_currency,
          minOrderSize: product.contract_size,
          maxOrderSize: '10000',
          tickSize: product.quote_increment,
          stepSize: product.base_increment,
          makerFee: '0.0000',
          takerFee: '0.0003',
          exchangeType: 'perpetual',
          maxLeverage: parseInt(product.max_leverage) || 10,
        };
      }
    }
    return super.getMarketInfo(symbol);
  }

  // ---- Internal Mapping ----

  private mapIntxPosition(p: CoinbaseIntxPosition): AdapterPosition {
    const contracts = parseFloat(p.number_of_contracts);
    return {
      symbol: p.product_id,
      side: p.side === 'LONG' ? 'buy' : p.side === 'SHORT' ? 'sell' : (contracts > 0 ? 'buy' : 'sell'),
      size: String(Math.abs(contracts)),
      entryPrice: p.avg_entry_price,
      markPrice: p.current_price,
      unrealizedPnl: p.unrealized_pnl,
      liquidationPrice: p.liquidation_price,
      leverage: p.leverage ? parseFloat(p.leverage) : undefined,
      marginUsed: p.margin_used,
    };
  }
}
