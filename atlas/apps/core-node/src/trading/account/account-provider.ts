/**
 * Account Provider Interface
 * 
 * Unified interface for account/balance data in both paper and live modes.
 * Ensures RiskEngine and sizing logic work identically regardless of mode.
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import { FillEvent } from '../execution/execution-adapter';

/**
 * Balance for a single currency
 */
export interface CurrencyBalance {
  currency: string;
  available: number;
  hold: number;
  total: number;
}

/**
 * Account snapshot
 */
export interface AccountSnapshot {
  /** Total equity in USD */
  equityUsd: number;
  /** Available for trading in USD */
  availableUsd: number;
  /** Held in open orders in USD */
  holdUsd: number;
  /** Unrealized PnL in USD */
  unrealizedPnlUsd: number;
  /** Realized PnL in USD (session) */
  realizedPnlUsd: number;
  /** All balances */
  balances: CurrencyBalance[];
  /** Timestamp of snapshot */
  timestamp: number;
}

/**
 * Account Provider interface
 */
export interface IAccountProvider extends EventEmitter {
  /**
   * Get current account snapshot
   */
  getSnapshot(): Promise<AccountSnapshot>;

  /**
   * Get balance for a specific currency
   */
  getBalance(currency: string): Promise<CurrencyBalance>;

  /**
   * Get total equity in USD
   */
  getEquityUsd(): Promise<number>;

  /**
   * Get available USD (for sizing calculations)
   */
  getAvailableUsd(): Promise<number>;

  /**
   * Update position value for equity calculation
   */
  updatePositionValue(symbol: string, value: number, unrealizedPnl: number): void;

  /**
   * Process a fill (updates realized PnL and balances)
   */
  processFill(fill: FillEvent, side: 'buy' | 'sell'): void;

  /**
   * Refresh data from source (exchange for live, no-op for paper)
   */
  refresh(): Promise<void>;

  /**
   * Get starting equity (for return calculations)
   */
  getStartingEquity(): number;
}

/**
 * Paper Account Provider Configuration
 */
export interface PaperAccountConfig {
  /** Starting equity in USD */
  initialEquityUsd: number;
  /** Initial balances (currency -> amount) */
  initialBalances?: Map<string, number>;
  /** Logger */
  logger: Logger;
}

/**
 * Paper Account Provider
 * 
 * Maintains an in-memory ledger updated by simulated fills.
 */
export class PaperAccountProvider extends EventEmitter implements IAccountProvider {
  private logger: Logger;
  private initialEquityUsd: number;
  private balances: Map<string, CurrencyBalance> = new Map();
  private positionValues: Map<string, { value: number; unrealizedPnl: number }> = new Map();
  private realizedPnlUsd: number = 0;
  private marketPrices: Map<string, number> = new Map();

  constructor(config: PaperAccountConfig) {
    super();
    this.logger = config.logger;
    this.initialEquityUsd = config.initialEquityUsd;

    // Initialize USD balance
    this.balances.set('USD', {
      currency: 'USD',
      available: config.initialEquityUsd,
      hold: 0,
      total: config.initialEquityUsd,
    });

    // Initialize other balances if provided
    if (config.initialBalances) {
      for (const [currency, amount] of config.initialBalances) {
        if (currency !== 'USD') {
          this.balances.set(currency, {
            currency,
            available: amount,
            hold: 0,
            total: amount,
          });
        }
      }
    }
  }

  public async getSnapshot(): Promise<AccountSnapshot> {
    const equityUsd = await this.getEquityUsd();
    const availableUsd = await this.getAvailableUsd();
    const holdUsd = this.calculateHoldUsd();
    const unrealizedPnlUsd = this.calculateUnrealizedPnl();

    return {
      equityUsd,
      availableUsd,
      holdUsd,
      unrealizedPnlUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      balances: Array.from(this.balances.values()),
      timestamp: Date.now(),
    };
  }

  public async getBalance(currency: string): Promise<CurrencyBalance> {
    return this.balances.get(currency) || {
      currency,
      available: 0,
      hold: 0,
      total: 0,
    };
  }

  public async getEquityUsd(): Promise<number> {
    let equity = 0;

    // USD balance
    const usdBalance = this.balances.get('USD');
    if (usdBalance) {
      equity += usdBalance.total;
    }

    // Value of crypto holdings
    for (const [currency, balance] of this.balances) {
      if (currency === 'USD') continue;
      
      const price = this.marketPrices.get(`${currency}-USD`) || 0;
      equity += balance.total * price;
    }

    // Add unrealized PnL from positions
    equity += this.calculateUnrealizedPnl();

    return equity;
  }

  public async getAvailableUsd(): Promise<number> {
    const usdBalance = this.balances.get('USD');
    return usdBalance?.available ?? 0;
  }

  public updatePositionValue(symbol: string, value: number, unrealizedPnl: number): void {
    this.positionValues.set(symbol, { value, unrealizedPnl });
  }

  public processFill(fill: FillEvent, side: 'buy' | 'sell'): void {
    const symbol = this.getSymbolFromFill(fill);
    if (!symbol) return;

    const [baseCurrency, quoteCurrency] = symbol.split('-');
    
    const baseBalance = this.balances.get(baseCurrency) || {
      currency: baseCurrency,
      available: 0,
      hold: 0,
      total: 0,
    };

    const quoteBalance = this.balances.get(quoteCurrency) || {
      currency: quoteCurrency,
      available: 0,
      hold: 0,
      total: 0,
    };

    const fillValue = fill.size * fill.price;
    const fee = fill.fee;

    if (side === 'buy') {
      // Deduct quote currency (USD)
      quoteBalance.available -= fillValue + fee;
      quoteBalance.total -= fillValue + fee;
      
      // Add base currency
      baseBalance.available += fill.size;
      baseBalance.total += fill.size;
    } else {
      // Deduct base currency
      baseBalance.available -= fill.size;
      baseBalance.total -= fill.size;
      
      // Add quote currency (minus fee)
      quoteBalance.available += fillValue - fee;
      quoteBalance.total += fillValue - fee;
    }

    this.balances.set(baseCurrency, baseBalance);
    this.balances.set(quoteCurrency, quoteBalance);

    // Track realized PnL from fee
    this.realizedPnlUsd -= fee;

    this.logger.debug('Paper account updated', {
      side,
      symbol,
      size: fill.size,
      price: fill.price,
      fee,
      baseBalance: baseBalance.available,
      quoteBalance: quoteBalance.available,
    });
  }

  public async refresh(): Promise<void> {
    // No-op for paper - state is maintained locally
  }

  public getStartingEquity(): number {
    return this.initialEquityUsd;
  }

  /**
   * Update market price for equity calculations
   */
  public updateMarketPrice(symbol: string, price: number): void {
    this.marketPrices.set(symbol, price);
  }

  private calculateHoldUsd(): number {
    const usdBalance = this.balances.get('USD');
    return usdBalance?.hold ?? 0;
  }

  private calculateUnrealizedPnl(): number {
    let total = 0;
    for (const { unrealizedPnl } of this.positionValues.values()) {
      total += unrealizedPnl;
    }
    return total;
  }

  private getSymbolFromFill(fill: FillEvent): string | null {
    // Fill events from paper adapter have symbol in clientOrderId metadata
    // For now, we'll extract from a standard pattern or require it
    return (fill.raw as any)?.symbol || null;
  }

  /**
   * Reset to initial state (for testing)
   */
  public reset(): void {
    this.balances.clear();
    this.balances.set('USD', {
      currency: 'USD',
      available: this.initialEquityUsd,
      hold: 0,
      total: this.initialEquityUsd,
    });
    this.positionValues.clear();
    this.realizedPnlUsd = 0;
    this.marketPrices.clear();
  }
}

/**
 * Live Account Provider Configuration
 */
export interface LiveAccountConfig {
  /** Exchange instance */
  exchange: any; // CoinbaseExchange
  /** Logger */
  logger: Logger;
  /** Refresh interval in ms (default: 30000) */
  refreshIntervalMs?: number;
}

/**
 * Live Account Provider
 * 
 * Fetches real account data from Coinbase.
 */
export class LiveAccountProvider extends EventEmitter implements IAccountProvider {
  private logger: Logger;
  private exchange: any;
  private refreshIntervalMs: number;
  private cachedSnapshot: AccountSnapshot | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private startingEquity: number = 0;
  private realizedPnlUsd: number = 0;
  private positionValues: Map<string, { value: number; unrealizedPnl: number }> = new Map();

  constructor(config: LiveAccountConfig) {
    super();
    this.logger = config.logger;
    this.exchange = config.exchange;
    this.refreshIntervalMs = config.refreshIntervalMs ?? 30000;
  }

  /**
   * Start periodic refresh
   */
  public start(): void {
    if (this.refreshTimer) return;
    
    this.refreshTimer = setInterval(() => {
      this.refresh().catch(e => {
        this.logger.warn('Account refresh failed', { error: e.message });
      });
    }, this.refreshIntervalMs);

    // Initial fetch
    this.refresh();
  }

  /**
   * Stop periodic refresh
   */
  public stop(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  public async getSnapshot(): Promise<AccountSnapshot> {
    if (!this.cachedSnapshot || Date.now() - this.cachedSnapshot.timestamp > this.refreshIntervalMs) {
      await this.refresh();
    }
    return this.cachedSnapshot!;
  }

  public async getBalance(currency: string): Promise<CurrencyBalance> {
    const snapshot = await this.getSnapshot();
    const balance = snapshot.balances.find(b => b.currency === currency);
    return balance || { currency, available: 0, hold: 0, total: 0 };
  }

  public async getEquityUsd(): Promise<number> {
    const snapshot = await this.getSnapshot();
    return snapshot.equityUsd;
  }

  public async getAvailableUsd(): Promise<number> {
    const snapshot = await this.getSnapshot();
    return snapshot.availableUsd;
  }

  public updatePositionValue(symbol: string, value: number, unrealizedPnl: number): void {
    this.positionValues.set(symbol, { value, unrealizedPnl });
  }

  public processFill(fill: FillEvent, side: 'buy' | 'sell'): void {
    // Track realized PnL from fees
    this.realizedPnlUsd -= fill.fee;
    
    // Trigger refresh to get updated balances
    this.refresh().catch(e => {
      this.logger.warn('Post-fill refresh failed', { error: e.message });
    });
  }

  public async refresh(): Promise<void> {
    try {
      const accounts = await this.exchange.getAccounts();
      
      const balances: CurrencyBalance[] = accounts.map((acc: any) => ({
        currency: acc.currency,
        available: parseFloat(acc.available),
        hold: parseFloat(acc.hold || '0'),
        total: parseFloat(acc.balance),
      }));

      // Calculate USD equity
      const usdBalance = balances.find(b => b.currency === 'USD');
      let equityUsd = usdBalance?.total ?? 0;

      // Add value of crypto holdings (would need price feed)
      // For now, just use USD balance

      // Add unrealized PnL from positions
      let unrealizedPnlUsd = 0;
      for (const { unrealizedPnl } of this.positionValues.values()) {
        unrealizedPnlUsd += unrealizedPnl;
      }
      equityUsd += unrealizedPnlUsd;

      // Store starting equity on first refresh
      if (this.startingEquity === 0) {
        this.startingEquity = equityUsd;
      }

      this.cachedSnapshot = {
        equityUsd,
        availableUsd: usdBalance?.available ?? 0,
        holdUsd: usdBalance?.hold ?? 0,
        unrealizedPnlUsd,
        realizedPnlUsd: this.realizedPnlUsd,
        balances,
        timestamp: Date.now(),
      };

      this.emit('snapshot', this.cachedSnapshot);
    } catch (error: any) {
      this.logger.error('Failed to refresh account data', { error: error.message });
      throw error;
    }
  }

  public getStartingEquity(): number {
    return this.startingEquity;
  }
}
