import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Fill } from '../exchanges/coinbase';
import { v4 as uuidv4 } from 'uuid';

export interface PositionTrackerConfig {
  supabaseUrl: string;
  supabaseKey: string;
  updateInterval: number; // milliseconds
  pnlCalculationMethod: 'fifo' | 'lifo' | 'average';
  
  // Risk limits (from guardrails)
  maxPositionValueUsd: number;      // Max value per position
  maxUnrealizedLossUsd: number;     // Max unrealized loss before alert
  drawdownWarningPct: number;       // Drawdown % for warning alert
  drawdownCriticalPct: number;      // Drawdown % for critical alert
}

export interface Position {
  id: string;
  symbol: string;
  // Strategy metadata (populated when available)
  strategy?: string;
  signalId?: string;
  stopPrice?: number;
  takeProfit?: number;
  exitReason?: string;
  side: 'long' | 'short' | 'flat';
  size: number;
  averagePrice: number;
  marketPrice: number;
  unrealizedPnL: number;
  realizedPnL: number;
  totalPnL: number;
  openTime: Date;
  closedAt?: Date;
  exitPrice?: number;
  lastUpdateTime: Date;
  trades: Trade[];
  maxSize: number;
  maxDrawdown: number;
  metadata?: Record<string, any>;
}

export interface Trade {
  id: string;
  orderId: string;
  side: 'buy' | 'sell';
  size: number;
  price: number;
  fee: number;
  timestamp: Date;
  realizedPnL?: number;
}

export interface FillContext {
  strategy?: string;
  signalId?: string;
  stopPrice?: number;
  takeProfit?: number;
  tag?: string;
}

export interface PositionTrackerEvents {
  'position:opened': (position: Position) => void;
  'position:updated': (position: Position) => void;
  'position:closed': (position: Position) => void;
  'pnl:update': (symbol: string, pnl: { unrealized: number; realized: number; total: number }) => void;
  'risk:alert': (symbol: string, alert: RiskAlert) => void;
}

export interface RiskAlert {
  type: 'drawdown' | 'size_limit' | 'loss_limit';
  severity: 'warning' | 'critical';
  message: string;
  value: number;
  threshold: number;
}

export interface FlattenResult {
  symbol: string;
  success: boolean;
  orderId?: string;
  error?: string;
}

/**
 * One open lot of a position. The tracker holds a FIFO queue of these per
 * symbol so that closes consume the oldest entries first — matching the
 * `pnlCalculationMethod: 'fifo'` config and the compliance.tax_method ('FIFO')
 * guardrail. Each lot retains the *unallocated* portion of its entry fee so
 * partial closes can charge a proportional slice and leave the remainder on
 * the still-open lot.
 */
interface Lot {
  size: number;
  price: number;
  fee: number;
}

export class PositionTracker extends EventEmitter {
  private config: PositionTrackerConfig;
  private logger: Logger;
  private supabase: SupabaseClient;
  private positions: Map<string, Position> = new Map();
  // FIFO lot ledger per symbol. Direction is encoded by Position.side; all
  // lots for a symbol share that side. Kept private (never exposed via
  // Position) so the public API surface stays unchanged.
  private lots: Map<string, Lot[]> = new Map();
  private marketPrices: Map<string, number> = new Map();
  private updateTimer: NodeJS.Timeout | null = null;
  // Accumulator to preserve realized P&L after positions are closed and removed from memory.
  private realizedPnLClosed = 0;
  
  // Order creator for placing flatten orders
  private orderCreator: ((symbol: string, side: 'buy' | 'sell', size: number, tag?: string) => Promise<string | null>) | null = null;
  
  // Mutex to prevent double-flattening
  private flatteningInProgress = false;

  constructor(config: PositionTrackerConfig, logger: Logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.supabase = createClient(config.supabaseUrl, config.supabaseKey);

    this.startUpdateLoop();
  }
  
  /**
   * Rehydrate open positions from Supabase. Called by TradingEngine on
   * startup so the in-memory map matches reality before any ticker/fill
   * events flow through. Without this, every restart silently abandoned
   * live positions.
   *
   * - Filters by user + closed_at IS NULL (the real "open" signal — the
   *   `status` column has a default of 'open' but isn't reliably updated
   *   by syncPositionToSupabase, so closed_at is the source of truth).
   * - Returns count of positions hydrated. Failure to fetch throws — the
   *   caller (TradingEngine) handles failure semantics (best-effort).
   * - Idempotent: clears the map first, so calling twice yields the same
   *   final state.
   */
  public async hydrateOpenPositions(userId: string): Promise<number> {
    if (!userId) {
      this.logger.warn('hydrateOpenPositions called with empty userId — skipping');
      return 0;
    }

    const { data, error } = await this.supabase
      .from('positions')
      .select('id, symbol, side, qty_open, entry_price, opened_at, stop_price_at_entry, take_profit_price, strategy, realized_pnl_usd, exit_reason')
      .eq('user_id', userId)
      .is('closed_at', null);

    if (error) {
      // Bubble up so engine's allSettled treats this as a rejected branch.
      throw new Error(`positions hydrate query failed: ${error.message}`);
    }

    // Idempotent reset — never silently merge stale in-memory state with DB.
    this.positions.clear();
    this.lots.clear();

    let hydrated = 0;
    for (const row of data ?? []) {
      try {
        const size = Number(row.qty_open ?? 0);
        const avgPrice = Number(row.entry_price ?? 0);
        if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(avgPrice) || avgPrice <= 0) {
          this.logger.warn('Skipping malformed open position during hydrate', {
            id: row.id,
            symbol: row.symbol,
            qty_open: row.qty_open,
            entry_price: row.entry_price,
          });
          continue;
        }
        const side: Position['side'] = row.side === 'short' ? 'short' : 'long';
        const openedAt = row.opened_at ? new Date(row.opened_at) : new Date();
        const stop = Number(row.stop_price_at_entry);
        const tp = Number(row.take_profit_price);
        const realized = Number(row.realized_pnl_usd ?? 0);

        const position: Position = {
          id: row.id,
          symbol: row.symbol,
          strategy: row.strategy ?? undefined,
          side,
          size,
          averagePrice: avgPrice,
          marketPrice: avgPrice, // Best estimate until first ticker arrives.
          unrealizedPnL: 0,
          realizedPnL: Number.isFinite(realized) ? realized : 0,
          totalPnL: 0,
          openTime: openedAt,
          lastUpdateTime: new Date(),
          trades: [],
          maxSize: size,
          maxDrawdown: 0,
          stopPrice: Number.isFinite(stop) && stop > 0 ? stop : undefined,
          takeProfit: Number.isFinite(tp) && tp > 0 ? tp : undefined,
          metadata: { hydratedFromSupabase: true, openedAtIso: openedAt.toISOString() },
        };
        this.positions.set(row.symbol, position);
        // Seed the FIFO ledger with a single synthetic lot reflecting the
        // hydrated cost basis. Subsequent fills are accounted FIFO from here.
        // Entry fee is 0 because the original fee is already baked into the
        // persisted realized_pnl_usd / entry_price snapshot.
        this.lots.set(row.symbol, [{ size, price: avgPrice, fee: 0 }]);
        hydrated++;
      } catch (err) {
        this.logger.error('Failed to materialize hydrated position', {
          id: row?.id,
          symbol: row?.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.logger.info('PositionTracker hydrated open positions', {
      userId,
      rowsReturned: data?.length ?? 0,
      hydrated,
      symbols: Array.from(this.positions.keys()),
    });

    return hydrated;
  }

  /**
   * Set the order creator function for placing flatten orders.
   * Returns the order ID if successful, null if failed.
   */
  public setOrderCreator(
    creator: (symbol: string, side: 'buy' | 'sell', size: number, tag?: string) => Promise<string | null>
  ): void {
    this.orderCreator = creator;
  }

  private startUpdateLoop(): void {
    this.updateTimer = setInterval(() => {
      this.updateAllPositions();
    }, this.config.updateInterval);
  }

  public stopUpdateLoop(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  // Process a fill to update positions
  public async processFill(fill: Fill, context?: FillContext): Promise<void> {
    const symbol = fill.product_id;
    const side = fill.side;
    const size = parseFloat(fill.size);
    const price = parseFloat(fill.price);
    const fee = parseFloat(fill.fee);
    
    if (!Number.isFinite(size) || size <= 0 || !Number.isFinite(price) || price <= 0) {
      this.logger.warn('Ignoring fill with non-finite/invalid size or price', {
        symbol,
        side,
        size: fill.size,
        price: fill.price,
        fee: fill.fee,
        orderId: fill.order_id,
        tradeId: fill.trade_id,
      });
      return;
    }

    const trade: Trade = {
      id: fill.trade_id.toString(),
      orderId: fill.order_id,
      side,
      size,
      price,
      fee,
      timestamp: new Date(fill.created_at)
    };

    let position = this.positions.get(symbol);

    if (!position) {
      // Create new position
      position = this.createNewPosition(symbol, trade.timestamp);
      // Attach strategy context if available
      if (context?.strategy) {
        position.strategy = context.strategy;
      }
      if (context?.signalId) {
        position.signalId = context.signalId;
      }
      if (typeof context?.stopPrice === 'number' && Number.isFinite(context.stopPrice) && context.stopPrice > 0) {
        position.stopPrice = context.stopPrice;
      }
      if (typeof context?.takeProfit === 'number' && Number.isFinite(context.takeProfit) && context.takeProfit > 0) {
        position.takeProfit = context.takeProfit;
      }
      position.metadata = {
        ...(position.metadata ?? {}),
        entryOrderId: fill.order_id,
        entryTag: context?.tag,
      };
      this.positions.set(symbol, position);
    } else {
      // Backfill context if we didn't have it at open
      if (!position.strategy && context?.strategy) {
        position.strategy = context.strategy;
      }
      if (!position.signalId && context?.signalId) {
        position.signalId = context.signalId;
      }
      if ((!position.stopPrice || position.stopPrice <= 0) && typeof context?.stopPrice === 'number' && Number.isFinite(context.stopPrice) && context.stopPrice > 0) {
        position.stopPrice = context.stopPrice;
      }
      if ((!position.takeProfit || position.takeProfit <= 0) && typeof context?.takeProfit === 'number' && Number.isFinite(context.takeProfit) && context.takeProfit > 0) {
        position.takeProfit = context.takeProfit;
      }
    }

    const preTradeSide = position.side;

    // Update position based on trade
    this.updatePositionWithTrade(position, trade);

    // Calculate P&L
    this.calculatePnL(position);

    // Check risk limits
    this.checkRiskLimits(position);

    // Persist to database (handled upstream in API layer)
    await this.persistPosition(position);

    // Emit events
    if (position.size === 0) {
      position.closedAt = trade.timestamp;
      position.exitPrice = trade.price;
      // Set exitReason from context tag if available (stop_loss, take_profit, time_stop, signal_exit, etc.)
      if (!position.exitReason && context?.tag) {
        position.exitReason = context.tag;
      }
      if (preTradeSide !== 'flat') {
        // Preserve last non-flat side for downstream persistence (Supabase enum doesn't allow 'flat')
        position.side = preTradeSide;
      }
      // Preserve realized P&L after we delete the position object (needed for correct daily P&L / equity).
      if (Number.isFinite(position.realizedPnL)) {
        this.realizedPnLClosed += position.realizedPnL;
      }
      this.emit('position:closed', position);
      // Remove closed positions so a new trade creates a fresh position (new id/openTime)
      this.positions.delete(symbol);
      this.lots.delete(symbol);
    } else if (position.trades.length === 1) {
      this.emit('position:opened', position);
    } else {
      this.emit('position:updated', position);
    }
  }

  private createNewPosition(symbol: string, openedAt: Date): Position {
    return {
      id: uuidv4(),
      symbol,
      side: 'flat',
      size: 0,
      averagePrice: 0,
      marketPrice: this.marketPrices.get(symbol) || 0,
      unrealizedPnL: 0,
      realizedPnL: 0,
      totalPnL: 0,
      openTime: openedAt,
      lastUpdateTime: openedAt,
      trades: [],
      maxSize: 0,
      maxDrawdown: 0
    };
  }

  /**
   * Apply a fill to the FIFO lot ledger and update the public Position
   * snapshot to match.
   *
   * Matching rules:
   *  - A trade in the same direction as existing lots opens a new lot.
   *  - A trade in the opposite direction consumes oldest lots first (FIFO).
   *    Each consumed slice produces realized PnL using *that lot's* original
   *    entry price, charged with: (a) the proportional remainder of the
   *    lot's entry fee, and (b) the proportional slice of the closing
   *    trade's fee.
   *  - If the closing trade exhausts all open lots and still has size left,
   *    the remainder opens a single new lot in the opposite direction with
   *    the residual closing fee booked as that new lot's entry fee.
   *
   * `Position.averagePrice` is the fee-adjusted weighted average of remaining
   * lots so existing callers (UI, persistence, analytics) keep working
   * without any schema change.
   */
  private updatePositionWithTrade(position: Position, trade: Trade): void {
    const tradeSize = Number.isFinite(trade.size) ? trade.size : 0;
    const tradePrice = Number.isFinite(trade.price) ? trade.price : 0;
    const tradeFee = Number.isFinite(trade.fee) ? Math.abs(trade.fee) : 0;

    if (tradeSize <= 0 || tradePrice <= 0) {
      this.logger.warn('Ignoring trade with non-positive size/price', {
        symbol: position.symbol,
        size: tradeSize,
        price: tradePrice,
        fee: tradeFee,
        orderId: trade.orderId,
      });
      return;
    }

    const lots = this.getLots(position.symbol);
    const tradeSide: 'long' | 'short' = trade.side === 'buy' ? 'long' : 'short';

    // Determine current ledger direction. Lots are always uniform; if there
    // are no lots, we're flat regardless of position.side.
    const ledgerSide: 'long' | 'short' | 'flat' =
      lots.length === 0 ? 'flat' : (position.side === 'short' ? 'short' : 'long');

    // newSide tracks what the position's direction is after this trade.
    let newSide: 'long' | 'short' | 'flat';

    if (ledgerSide === 'flat' || ledgerSide === tradeSide) {
      // Opening or adding to existing direction → push a new lot.
      lots.push({ size: tradeSize, price: tradePrice, fee: tradeFee });
      newSide = tradeSide;
    } else {
      // Closing/reducing/flipping direction → FIFO-consume opposing lots.
      let remaining = tradeSize;
      let totalRealized = 0;

      // Snapshot the original trade fee for proportional allocation across
      // the consumed slices. Whatever's left after fully consuming all lots
      // becomes the entry fee for the flip lot.
      const closeFeePerUnit = tradeSize > 0 ? tradeFee / tradeSize : 0;
      let allocatedCloseFee = 0;

      while (remaining > 0 && lots.length > 0) {
        const lot = lots[0];
        const consumed = Math.min(lot.size, remaining);

        // Proportional allocation of *this lot's* remaining entry fee
        // and the closing trade's fee for this slice.
        const lotFeeShare = lot.size > 0 ? lot.fee * (consumed / lot.size) : 0;
        const closeFeeShare = closeFeePerUnit * consumed;
        allocatedCloseFee += closeFeeShare;

        const grossPnl = ledgerSide === 'long'
          ? consumed * (tradePrice - lot.price)
          : consumed * (lot.price - tradePrice);

        totalRealized += grossPnl - lotFeeShare - closeFeeShare;

        lot.size -= consumed;
        lot.fee -= lotFeeShare;
        remaining -= consumed;

        if (lot.size <= 0) {
          lots.shift();
        }
      }

      trade.realizedPnL = totalRealized;
      position.realizedPnL += totalRealized;

      if (remaining > 0) {
        // Trade overshot all lots → flip side, open one lot with the
        // residual closing fee as its entry fee.
        const flipFee = Math.max(0, tradeFee - allocatedCloseFee);
        lots.push({ size: remaining, price: tradePrice, fee: flipFee });
        newSide = tradeSide;
      } else if (lots.length === 0) {
        newSide = 'flat';
      } else {
        newSide = ledgerSide;
      }
    }

    // Recompute the public Position fields from the lot ledger.
    this.syncPositionFromLots(position, lots, newSide);

    // Trade-level bookkeeping (unchanged from prior behavior).
    position.trades.push(trade);
    position.lastUpdateTime = new Date();
    position.maxSize = Math.max(position.maxSize, Math.abs(position.size));

    if (!Number.isFinite(position.averagePrice) || position.averagePrice < 0) {
      position.averagePrice = tradePrice;
    }
    if (!Number.isFinite(position.size) || position.size < 0) {
      position.size = 0;
    }
  }

  /**
   * Get (or lazily create) the FIFO lot queue for a symbol.
   */
  private getLots(symbol: string): Lot[] {
    let lots = this.lots.get(symbol);
    if (!lots) {
      lots = [];
      this.lots.set(symbol, lots);
    }
    return lots;
  }

  /**
   * Mirror lot ledger state onto the public Position snapshot:
   *  - size = sum of remaining lot sizes
   *  - side = explicit new direction (or 'flat' if empty)
   *  - averagePrice = fee-adjusted weighted average across remaining lots
   *    (long: cost basis = price + fee/size; short: proceeds = price − fee/size)
   *
   * The fee-adjusted convention preserves the contract of existing
   * position-tracker tests (e.g. flip avgPrice = entry_price ± fee/size).
   */
  private syncPositionFromLots(position: Position, lots: Lot[], newSide: 'long' | 'short' | 'flat'): void {
    if (lots.length === 0 || newSide === 'flat') {
      position.size = 0;
      position.side = 'flat';
      position.averagePrice = 0;
      return;
    }

    let totalSize = 0;
    let basis = 0;
    for (const lot of lots) {
      totalSize += lot.size;
      basis += lot.size * lot.price + (newSide === 'short' ? -lot.fee : lot.fee);
    }
    position.side = newSide;
    position.size = totalSize;
    position.averagePrice = totalSize > 0 ? basis / totalSize : 0;
  }

  private calculatePnL(position: Position): void {
    if (position.side === 'flat' || position.size === 0) {
      position.unrealizedPnL = 0;
    } else {
      const marketPrice = this.marketPrices.get(position.symbol) || position.averagePrice;
      
      if (position.side === 'long') {
        position.unrealizedPnL = position.size * (marketPrice - position.averagePrice);
      } else {
        position.unrealizedPnL = position.size * (position.averagePrice - marketPrice);
      }
    }

    position.totalPnL = position.realizedPnL + position.unrealizedPnL;

    // Track max drawdown
    if (position.totalPnL < 0) {
      position.maxDrawdown = Math.max(position.maxDrawdown, Math.abs(position.totalPnL));
    }

    this.emit('pnl:update', position.symbol, {
      unrealized: position.unrealizedPnL,
      realized: position.realizedPnL,
      total: position.totalPnL
    });
  }

  private checkRiskLimits(position: Position): void {
    // Check drawdown using config values
    if (position.maxDrawdown > 0) {
      const drawdownPercent = (position.maxDrawdown / (position.maxSize * position.averagePrice)) * 100;
      
      const criticalThreshold = this.config.drawdownCriticalPct;
      const warningThreshold = this.config.drawdownWarningPct;
      
      if (drawdownPercent > criticalThreshold) {
        this.emit('risk:alert', position.symbol, {
          type: 'drawdown',
          severity: 'critical',
          message: `Drawdown exceeded ${criticalThreshold}%: ${drawdownPercent.toFixed(2)}%`,
          value: drawdownPercent,
          threshold: criticalThreshold
        });
      } else if (drawdownPercent > warningThreshold) {
        this.emit('risk:alert', position.symbol, {
          type: 'drawdown',
          severity: 'warning',
          message: `Drawdown warning: ${drawdownPercent.toFixed(2)}%`,
          value: drawdownPercent,
          threshold: warningThreshold
        });
      }
    }

    // Check position size limits from config
    const positionValue = position.size * position.averagePrice;
    const maxPositionValue = this.config.maxPositionValueUsd;

    if (positionValue > maxPositionValue) {
      this.emit('risk:alert', position.symbol, {
        type: 'size_limit',
        severity: 'critical',
        message: `Position size exceeded limit: $${positionValue.toFixed(2)}`,
        value: positionValue,
        threshold: maxPositionValue
      });
    }

    // Check loss limits from config
    const maxLoss = this.config.maxUnrealizedLossUsd;
    if (position.unrealizedPnL < -maxLoss) {
      this.emit('risk:alert', position.symbol, {
        type: 'loss_limit',
        severity: 'critical',
        message: `Unrealized loss exceeded limit: $${position.unrealizedPnL.toFixed(2)}`,
        value: position.unrealizedPnL,
        threshold: -maxLoss
      });
    }
  }

  // Update market price for a symbol
  public updateMarketPrice(symbol: string, price: number): void {
    this.marketPrices.set(symbol, price);
    
    const position = this.positions.get(symbol);
    if (position) {
      position.marketPrice = price;
      this.calculatePnL(position);
    }
  }

  // Update all positions with latest market prices
  private async updateAllPositions(): Promise<void> {
    for (const position of this.positions.values()) {
      if (position.side !== 'flat') {
        this.calculatePnL(position);
        await this.persistPosition(position);
      }
    }
  }

  // Persist position to database
  private async persistPosition(position: Position): Promise<void> {
    // Persistence is handled by the API layer when positions are broadcast.
    return;
  }

  private async persistTrade(positionId: string, trade: Trade): Promise<void> {
    // Persistence is handled by the API layer when fills are processed.
    return;
  }

  // Get current positions
  public getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  public getPosition(symbol: string): Position | undefined {
    return this.positions.get(symbol);
  }

  public getOpenPositions(): Position[] {
    return this.getPositions().filter(p => p.side !== 'flat');
  }

  // Get portfolio summary
  public getPortfolioSummary(): {
    totalUnrealizedPnL: number;
    totalRealizedPnL: number;
    totalPnL: number;
    positionCount: number;
    totalValue: number;
  } {
    let totalUnrealizedPnL = 0;
    let totalRealizedPnL = this.realizedPnLClosed;
    let totalValue = 0;
    let positionCount = 0;

    for (const position of this.positions.values()) {
      if (position.side !== 'flat') {
        totalUnrealizedPnL += position.unrealizedPnL;
        totalValue += position.size * position.marketPrice;
        positionCount++;
      }
      totalRealizedPnL += position.realizedPnL;
    }

    return {
      totalUnrealizedPnL,
      totalRealizedPnL,
      totalPnL: totalUnrealizedPnL + totalRealizedPnL,
      positionCount,
      totalValue
    };
  }

  /**
   * Close all positions by placing real market orders.
   * Returns array of results for each position flatten attempt.
   */
  public async closeAllPositions(): Promise<FlattenResult[]> {
    // Prevent double-flattening
    if (this.flatteningInProgress) {
      this.logger.warn('Flatten already in progress, skipping duplicate request');
      return [];
    }
    
    this.flatteningInProgress = true;
    this.logger.warn('Closing all positions with real orders');
    
    const results: FlattenResult[] = [];
    const openPositions = this.getOpenPositions();
    
    if (openPositions.length === 0) {
      this.logger.info('No open positions to close');
      this.flatteningInProgress = false;
      return results;
    }
    
    for (const position of openPositions) {
      const result: FlattenResult = {
        symbol: position.symbol,
        success: false,
      };
      
      try {
        // Determine exit side (opposite of position)
        const exitSide: 'buy' | 'sell' = position.side === 'long' ? 'sell' : 'buy';
        const size = Math.abs(position.size);
        
        if (this.orderCreator) {
          this.logger.info(`Flattening ${position.symbol}: ${exitSide} ${size}`, {
            positionId: position.id,
            side: position.side,
          });
          
          // Place market order to flatten
          const orderId = await this.orderCreator(position.symbol, exitSide, size, 'flatten');
          
          if (orderId) {
            result.success = true;
            result.orderId = orderId;
            this.logger.info(`Flatten order placed for ${position.symbol}`, { orderId });
          } else {
            result.error = 'Order creation returned null';
            this.logger.error(`Failed to flatten ${position.symbol}: order creation returned null`);
          }
        } else {
          // Fallback: just mark as closed (legacy behavior)
          this.logger.warn(`No order creator set - marking ${position.symbol} as closed without order`);
          const preCloseSide = position.side;
          position.size = 0;
          position.unrealizedPnL = 0;
          position.closedAt = new Date();
          position.exitPrice = position.marketPrice;
          position.lastUpdateTime = new Date();
          
          await this.persistPosition(position);
          if (preCloseSide !== 'flat') {
            position.side = preCloseSide;
          }
          if (Number.isFinite(position.realizedPnL)) {
            this.realizedPnLClosed += position.realizedPnL;
          }
          this.emit('position:closed', position);
          this.positions.delete(position.symbol);
          this.lots.delete(position.symbol);
          result.success = true;
        }
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        this.logger.error(`Error flattening ${position.symbol}:`, error);
      }
      
      results.push(result);
    }
    
    this.flatteningInProgress = false;
    
    const successCount = results.filter(r => r.success).length;
    this.logger.info(`Flatten complete: ${successCount}/${results.length} positions closed`);
    
    return results;
  }
  
  /**
   * Check if a flatten operation is in progress.
   */
  public isFlatteningInProgress(): boolean {
    return this.flatteningInProgress;
  }
}
