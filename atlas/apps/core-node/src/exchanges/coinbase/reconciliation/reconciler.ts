/**
 * Coinbase Reconciliation Module
 * 
 * Ensures local state matches Coinbase even when WebSocket drops.
 * Provides:
 * - Open orders reconciliation loop
 * - Fills reconciliation loop
 * - Triggered reconciliation on events
 * - Idempotent processing with deduplication
 */

import { EventEmitter } from 'events';
import { Counter, Gauge } from 'prom-client';
import { Logger } from '../../../core/logger';
import { CoinbaseOrder, Fill } from '../types';

// Prometheus metrics
const reconcileOrdersRunsTotal = new Counter({
  name: 'coinbase_reconcile_orders_runs_total',
  help: 'Total number of order reconciliation runs',
  labelNames: ['status'],
});

const reconcileFillsRunsTotal = new Counter({
  name: 'coinbase_reconcile_fills_runs_total',
  help: 'Total number of fills reconciliation runs',
  labelNames: ['status'],
});

const reconcileStateChangesTotal = new Counter({
  name: 'coinbase_reconcile_state_changes_total',
  help: 'Total number of state changes detected by reconciliation',
  labelNames: ['type'],
});

const reconcileLastRunGauge = new Gauge({
  name: 'coinbase_reconcile_last_run_timestamp',
  help: 'Timestamp of last reconciliation run',
  labelNames: ['type'],
});

/**
 * Reconciler configuration
 */
export interface ReconcilerConfig {
  /** Interval for order reconciliation (ms) */
  orderReconcileIntervalMs: number;
  /** Interval for fill reconciliation (ms) */
  fillReconcileIntervalMs: number;
  /** Maximum fills to fetch per reconciliation */
  maxFillsPerReconcile: number;
  /** Enable automatic reconciliation loops */
  autoReconcile: boolean;
  /** Delay before reconciliation after action (ms) */
  postActionDelayMs: number;
}

/**
 * Reconciler state for monitoring
 */
export interface ReconcilerState {
  running: boolean;
  lastOrderReconcileAt: number | null;
  lastFillReconcileAt: number | null;
  ordersReconciled: number;
  fillsReconciled: number;
  lastFillCursor: string | null;
  seenFillIds: number;
  degraded: boolean;
  degradedReason: string | null;
}

/**
 * Interface for the REST client methods we need
 */
export interface ReconcilerRestClient {
  getOrders(status?: string[], productId?: string, limit?: number): Promise<CoinbaseOrder[]>;
  getOrder(orderId: string): Promise<CoinbaseOrder>;
  getFills(orderId?: string, productId?: string, limit?: number): Promise<Fill[]>;
}

/**
 * Interface for the order manager we update
 */
export interface ReconcilerOrderManager {
  getActiveOrders(): Array<{ exchangeOrderId?: string; id: string; status: string }>;
  getOrderByExchangeOrderId(exchangeOrderId: string): any | undefined;
}

/**
 * Events emitted by the reconciler
 */
export interface ReconcilerEvents {
  'order:state_changed': (orderId: string, oldStatus: string, newStatus: string, order: CoinbaseOrder) => void;
  'order:disappeared': (orderId: string, finalOrder: CoinbaseOrder) => void;
  'fill:ingested': (fill: Fill, isNew: boolean) => void;
  'reconcile:started': (type: 'orders' | 'fills') => void;
  'reconcile:completed': (type: 'orders' | 'fills', changes: number) => void;
  'reconcile:error': (type: 'orders' | 'fills', error: Error) => void;
  'degraded': (reason: string) => void;
  'recovered': () => void;
}

/**
 * Default configuration
 */
export const DEFAULT_RECONCILER_CONFIG: ReconcilerConfig = {
  orderReconcileIntervalMs: 5000, // 5 seconds
  fillReconcileIntervalMs: 5000, // 5 seconds
  maxFillsPerReconcile: 100,
  autoReconcile: true,
  postActionDelayMs: 500,
};

/**
 * Coinbase Reconciler
 * 
 * Keeps local state in sync with Coinbase via periodic REST polling.
 * Critical for 24/7 reliability - ensures no missed orders/fills even
 * when WebSocket drops.
 */
export class CoinbaseReconciler extends EventEmitter {
  private config: ReconcilerConfig;
  private logger: Logger;
  private restClient: ReconcilerRestClient;
  private orderManager: ReconcilerOrderManager;

  // State
  private running = false;
  private orderReconcileTimer: NodeJS.Timeout | null = null;
  private fillReconcileTimer: NodeJS.Timeout | null = null;
  
  // Fill deduplication
  private seenFillIds: Set<string> = new Set();
  private lastFillCursor: string | null = null; // trade_id or timestamp
  
  // Metrics
  private lastOrderReconcileAt: number | null = null;
  private lastFillReconcileAt: number | null = null;
  private ordersReconciled = 0;
  private fillsReconciled = 0;
  
  // Degraded mode
  private degraded = false;
  private degradedReason: string | null = null;
  private consecutiveErrors = 0;

  constructor(
    config: Partial<ReconcilerConfig>,
    logger: Logger,
    restClient: ReconcilerRestClient,
    orderManager: ReconcilerOrderManager
  ) {
    super();
    this.config = { ...DEFAULT_RECONCILER_CONFIG, ...config };
    this.logger = logger;
    this.restClient = restClient;
    this.orderManager = orderManager;
  }

  /**
   * Start reconciliation loops
   */
  public start(): void {
    if (this.running) {
      this.logger.warn('Reconciler already running');
      return;
    }

    this.running = true;
    this.logger.info('Starting Coinbase reconciler', {
      orderIntervalMs: this.config.orderReconcileIntervalMs,
      fillIntervalMs: this.config.fillReconcileIntervalMs,
    });

    if (this.config.autoReconcile) {
      this.startOrderReconcileLoop();
      this.startFillReconcileLoop();
    }

    // Run immediate reconciliation on start
    this.reconcileOrders();
    this.reconcileFills();
  }

  /**
   * Stop reconciliation loops
   */
  public stop(): void {
    this.running = false;
    
    if (this.orderReconcileTimer) {
      clearInterval(this.orderReconcileTimer);
      this.orderReconcileTimer = null;
    }
    
    if (this.fillReconcileTimer) {
      clearInterval(this.fillReconcileTimer);
      this.fillReconcileTimer = null;
    }

    this.logger.info('Coinbase reconciler stopped');
  }

  /**
   * Trigger immediate reconciliation (e.g., after WS reconnect)
   */
  public async triggerReconciliation(): Promise<void> {
    this.logger.info('Triggered immediate reconciliation');
    
    await Promise.all([
      this.reconcileOrders(),
      this.reconcileFills(),
    ]);
  }

  /**
   * Trigger reconciliation after an action (order placed/cancelled)
   */
  public async triggerPostActionReconciliation(): Promise<void> {
    // Short delay to allow Coinbase to process
    await this.sleep(this.config.postActionDelayMs);
    await this.reconcileOrders();
  }

  /**
   * Reconcile open orders with Coinbase
   */
  public async reconcileOrders(): Promise<number> {
    if (!this.running && !this.config.autoReconcile) {
      return 0;
    }

    this.emit('reconcile:started', 'orders');
    reconcileOrdersRunsTotal.inc({ status: 'started' });

    try {
      // Fetch open orders from Coinbase
      const coinbaseOrders = await this.restClient.getOrders(['open', 'pending']);
      const coinbaseOrderIds = new Set(coinbaseOrders.map(o => o.id));

      // Get local active orders
      const localOrders = this.orderManager.getActiveOrders();
      let changesDetected = 0;

      // Check each local order against Coinbase
      for (const localOrder of localOrders) {
        if (!localOrder.exchangeOrderId) continue;

        // If order is not in Coinbase's open set, it may have been filled/cancelled
        if (!coinbaseOrderIds.has(localOrder.exchangeOrderId)) {
          try {
            const finalOrder = await this.restClient.getOrder(localOrder.exchangeOrderId);
            
            if (finalOrder.status !== localOrder.status) {
              this.logger.info('reconcile_detected_order_state_change', {
                orderId: localOrder.exchangeOrderId,
                localStatus: localOrder.status,
                coinbaseStatus: finalOrder.status,
              });

              this.emit('order:state_changed', 
                localOrder.exchangeOrderId, 
                localOrder.status, 
                finalOrder.status,
                finalOrder
              );
              
              reconcileStateChangesTotal.inc({ type: 'order_status' });
              changesDetected++;
            }

            this.emit('order:disappeared', localOrder.exchangeOrderId, finalOrder);
          } catch (error) {
            // Order may truly not exist (cancelled, etc.)
            this.logger.warn('Could not fetch final order status', {
              orderId: localOrder.exchangeOrderId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      // Check for orders we don't know about locally
      for (const cbOrder of coinbaseOrders) {
        const localOrder = this.orderManager.getOrderByExchangeOrderId(cbOrder.id);
        if (!localOrder) {
          this.logger.warn('Found unknown order on Coinbase', {
            orderId: cbOrder.id,
            status: cbOrder.status,
            productId: cbOrder.product_id,
          });
          // Could emit an event here for the order manager to track
        }
      }

      this.lastOrderReconcileAt = Date.now();
      this.ordersReconciled++;
      this.consecutiveErrors = 0;
      
      if (this.degraded) {
        this.degraded = false;
        this.degradedReason = null;
        this.emit('recovered');
      }

      reconcileOrdersRunsTotal.inc({ status: 'success' });
      reconcileLastRunGauge.set({ type: 'orders' }, this.lastOrderReconcileAt);
      
      this.emit('reconcile:completed', 'orders', changesDetected);
      
      return changesDetected;
    } catch (error) {
      this.handleReconcileError('orders', error as Error);
      throw error;
    }
  }

  /**
   * Reconcile fills with Coinbase
   */
  public async reconcileFills(): Promise<number> {
    if (!this.running && !this.config.autoReconcile) {
      return 0;
    }

    this.emit('reconcile:started', 'fills');
    reconcileFillsRunsTotal.inc({ status: 'started' });

    try {
      // Fetch recent fills from Coinbase
      const fills = await this.restClient.getFills(
        undefined,
        undefined,
        this.config.maxFillsPerReconcile
      );

      let newFillsIngested = 0;

      for (const fill of fills) {
        const fillId = fill.trade_id || `${fill.order_id}-${fill.created_at}`;
        const isNew = !this.seenFillIds.has(fillId);

        if (isNew) {
          this.seenFillIds.add(fillId);
          
          this.logger.info('reconcile_ingested_fill', {
            fillId,
            orderId: fill.order_id,
            productId: fill.product_id,
            side: fill.side,
            size: fill.size,
            price: fill.price,
          });

          newFillsIngested++;
          reconcileStateChangesTotal.inc({ type: 'fill_ingested' });
        }

        this.emit('fill:ingested', fill, isNew);
      }

      // Update cursor for next reconciliation
      if (fills.length > 0) {
        this.lastFillCursor = fills[0].trade_id || fills[0].created_at;
      }

      // Limit the size of seen fills set
      if (this.seenFillIds.size > 10000) {
        const arr = Array.from(this.seenFillIds);
        this.seenFillIds = new Set(arr.slice(-5000));
      }

      this.lastFillReconcileAt = Date.now();
      this.fillsReconciled++;
      this.consecutiveErrors = 0;

      if (this.degraded) {
        this.degraded = false;
        this.degradedReason = null;
        this.emit('recovered');
      }

      reconcileFillsRunsTotal.inc({ status: 'success' });
      reconcileLastRunGauge.set({ type: 'fills' }, this.lastFillReconcileAt);
      
      this.emit('reconcile:completed', 'fills', newFillsIngested);
      
      return newFillsIngested;
    } catch (error) {
      this.handleReconcileError('fills', error as Error);
      throw error;
    }
  }

  /**
   * Handle reconciliation error
   */
  private handleReconcileError(type: 'orders' | 'fills', error: Error): void {
    this.consecutiveErrors++;

    const metricLabel = type === 'orders' ? 'orders' : 'fills';
    if (type === 'orders') {
      reconcileOrdersRunsTotal.inc({ status: 'error' });
    } else {
      reconcileFillsRunsTotal.inc({ status: 'error' });
    }

    this.logger.error(`Reconcile ${type} failed`, {
      error: error.message,
      consecutiveErrors: this.consecutiveErrors,
    });

    this.emit('reconcile:error', type, error);

    // Enter degraded mode after multiple failures
    if (this.consecutiveErrors >= 3 && !this.degraded) {
      this.degraded = true;
      this.degradedReason = `${type} reconciliation failing`;
      this.emit('degraded', this.degradedReason);
    }
  }

  /**
   * Start order reconciliation loop
   */
  private startOrderReconcileLoop(): void {
    if (this.orderReconcileTimer) {
      clearInterval(this.orderReconcileTimer);
    }

    this.orderReconcileTimer = setInterval(async () => {
      try {
        await this.reconcileOrders();
      } catch (error) {
        // Error already handled in reconcileOrders
      }
    }, this.config.orderReconcileIntervalMs);
  }

  /**
   * Start fill reconciliation loop
   */
  private startFillReconcileLoop(): void {
    if (this.fillReconcileTimer) {
      clearInterval(this.fillReconcileTimer);
    }

    this.fillReconcileTimer = setInterval(async () => {
      try {
        await this.reconcileFills();
      } catch (error) {
        // Error already handled in reconcileFills
      }
    }, this.config.fillReconcileIntervalMs);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ============ State & Health APIs ============

  /**
   * Get reconciler state for monitoring
   */
  public getState(): ReconcilerState {
    return {
      running: this.running,
      lastOrderReconcileAt: this.lastOrderReconcileAt,
      lastFillReconcileAt: this.lastFillReconcileAt,
      ordersReconciled: this.ordersReconciled,
      fillsReconciled: this.fillsReconciled,
      lastFillCursor: this.lastFillCursor,
      seenFillIds: this.seenFillIds.size,
      degraded: this.degraded,
      degradedReason: this.degradedReason,
    };
  }

  /**
   * Check if reconciler is degraded
   */
  public isDegraded(): boolean {
    return this.degraded;
  }

  /**
   * Clear seen fills (for testing or recovery)
   */
  public clearSeenFills(): void {
    this.seenFillIds.clear();
    this.lastFillCursor = null;
  }

  /**
   * Mark a fill as seen (to prevent reprocessing)
   */
  public markFillSeen(fillId: string): void {
    this.seenFillIds.add(fillId);
  }

  /**
   * Check if a fill has been seen
   */
  public hasFillBeenSeen(fillId: string): boolean {
    return this.seenFillIds.has(fillId);
  }
}
