/**
 * EngineSupervisor - Watchdog and recovery manager for 24/7 operation
 * 
 * Monitors engine health, market data freshness, and coordinates recovery
 * when components become stale or unresponsive. Ensures the runtime stays
 * alive even when trading is halted (kill switch active).
 * 
 * Key invariants:
 * - Runtime (WS server, REST API) NEVER dies on recoverable errors
 * - Engine may halt trading, but status/heartbeat continues
 * - Kill switch halts trading but does NOT stop runtime visibility
 * - Automatic recovery for stale data and engine hangs
 */

import { EventEmitter } from 'events';
import { Counter, Gauge } from 'prom-client';
import { Logger } from '../core/logger';

// Prometheus metrics for supervisor monitoring
const supervisorRestartCounter = new Counter({
  name: 'atlas_supervisor_restart_total',
  help: 'Total number of engine restarts triggered by supervisor',
  labelNames: ['reason'],
});

const supervisorRecoveryCounter = new Counter({
  name: 'atlas_supervisor_recovery_total',
  help: 'Total number of recovery actions taken by supervisor',
  labelNames: ['type'],
});

const engineStateGauge = new Gauge({
  name: 'atlas_engine_state',
  help: 'Current engine state (0=stopped, 1=running, 2=paused, 3=halted)',
});

const marketDataAgeGauge = new Gauge({
  name: 'atlas_market_data_age_seconds',
  help: 'Age of last market data update in seconds',
});

const engineHeartbeatAgeGauge = new Gauge({
  name: 'atlas_engine_heartbeat_age_seconds',
  help: 'Age of last engine heartbeat in seconds',
});

/**
 * Engine runtime states
 * - stopped: Engine is not running, no trading
 * - running: Engine is running and trading is active
 * - paused: Engine is running but trading is temporarily paused (user action)
 * - halted: Engine is running but trading halted due to kill switch
 */
export type EngineState = 'stopped' | 'running' | 'paused' | 'halted';

/**
 * Trading mode
 */
export type TradingMode = 'paper' | 'live';

/**
 * Supervisor configuration
 */
export interface SupervisorConfig {
  /** Max time without engine heartbeat before recovery (ms) */
  engineHeartbeatStaleMs: number;
  /** Max time without market data before WS reconnect (ms) */
  marketDataStaleMs: number;
  /** Interval for status heartbeat broadcasts (ms) */
  statusHeartbeatMs: number;
  /** Minimum time between restarts to prevent restart loops (ms) */
  restartCooldownMs: number;
  /** How often supervisor.tick() runs (ms) */
  tickIntervalMs: number;
  /** Max consecutive restart attempts before giving up */
  maxConsecutiveRestarts: number;
  /** Time window for counting consecutive restarts (ms) */
  restartWindowMs: number;
}

/**
 * Default supervisor configuration with safe production values
 */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  engineHeartbeatStaleMs: parseInt(process.env.ENGINE_HEARTBEAT_STALE_MS || '15000', 10),
  marketDataStaleMs: parseInt(process.env.MARKETDATA_STALE_MS || '10000', 10),
  statusHeartbeatMs: parseInt(process.env.STATUS_HEARTBEAT_MS || '1500', 10),
  restartCooldownMs: parseInt(process.env.RESTART_COOLDOWN_MS || '30000', 10),
  tickIntervalMs: parseInt(process.env.SUPERVISOR_TICK_MS || '2000', 10),
  maxConsecutiveRestarts: parseInt(process.env.MAX_CONSECUTIVE_RESTARTS || '5', 10),
  restartWindowMs: parseInt(process.env.RESTART_WINDOW_MS || '300000', 10), // 5 minutes
};

/**
 * Restart reason codes for logging and UI
 */
export type RestartReason =
  | 'engine_heartbeat_stale'
  | 'market_data_stale'
  | 'ws_connection_lost'
  | 'engine_error'
  | 'manual_restart'
  | 'recovery_timeout';

/**
 * Supervisor state exposed for status endpoints
 */
export interface SupervisorState {
  runtimeAlive: boolean;
  engineState: EngineState;
  engineDesiredState: EngineState;
  tradingMode: TradingMode | null;
  killSwitch: {
    active: boolean;
    reasons: string[];
    since: number | null;
  };
  lastMarketDataAt: number;
  lastEngineHeartbeatAt: number;
  lastStatusBroadcastAt: number;
  restartCount: number;
  lastRestartReason: RestartReason | null;
  lastRestartAt: number | null;
  consecutiveRestarts: number;
  restartHistory: Array<{ timestamp: number; reason: RestartReason }>;
}

/**
 * Events emitted by the supervisor
 */
export interface SupervisorEvents {
  'supervisor:tick': () => void;
  'supervisor:engine_stale': (reason: RestartReason, elapsedMs: number) => void;
  'supervisor:marketdata_stale': (elapsedMs: number) => void;
  'supervisor:restart_triggered': (reason: RestartReason) => void;
  'supervisor:restart_completed': (success: boolean, reason: RestartReason) => void;
  'supervisor:restart_blocked': (reason: string) => void;
  'supervisor:recovery_failed': (reason: string) => void;
  'supervisor:state_changed': (oldState: EngineState, newState: EngineState, reason: string) => void;
  'supervisor:killswitch_activated': (reasons: string[]) => void;
  'supervisor:killswitch_deactivated': () => void;
  'supervisor:status_heartbeat': (state: SupervisorState) => void;
}

/**
 * EngineSupervisor - Central watchdog for 24/7 runtime resilience
 */
export class EngineSupervisor extends EventEmitter {
  private config: SupervisorConfig;
  private logger: Logger;
  private tickInterval: NodeJS.Timeout | null = null;
  private statusHeartbeatInterval: NodeJS.Timeout | null = null;

  // Desired vs actual state
  private desiredState: EngineState = 'stopped';
  private actualState: EngineState = 'stopped';
  private tradingMode: TradingMode | null = null;

  // Heartbeat timestamps
  private lastEngineHeartbeatAt: number = 0;
  private lastMarketDataAt: number = 0;
  private lastStatusBroadcastAt: number = 0;

  // Kill switch state
  private killSwitchActive: boolean = false;
  private killSwitchReasons: string[] = [];
  private killSwitchSince: number | null = null;

  // Restart tracking
  private restartCount: number = 0;
  private lastRestartReason: RestartReason | null = null;
  private lastRestartAt: number | null = null;
  private restartHistory: Array<{ timestamp: number; reason: RestartReason }> = [];
  private isRestarting: boolean = false;

  // Callbacks for recovery actions
  private restartEngineCallback: ((reason: RestartReason) => Promise<boolean>) | null = null;
  private reconnectExchangeCallback: (() => Promise<boolean>) | null = null;

  constructor(config: Partial<SupervisorConfig> = {}, logger: Logger) {
    super();
    this.config = { ...DEFAULT_SUPERVISOR_CONFIG, ...config };
    this.logger = logger;

    // Initialize timestamps to now to avoid immediate false positives
    const now = Date.now();
    this.lastEngineHeartbeatAt = now;
    this.lastMarketDataAt = now;
    this.lastStatusBroadcastAt = now;

    this.logger.info('EngineSupervisor initialized', {
      config: this.config,
    });
  }

  /**
   * Start the supervisor watchdog loop
   */
  public start(): void {
    if (this.tickInterval) {
      this.logger.warn('Supervisor already running');
      return;
    }

    this.logger.info('Starting EngineSupervisor watchdog');

    // Main tick loop
    this.tickInterval = setInterval(() => {
      this.tick();
    }, this.config.tickIntervalMs);

    // Status heartbeat broadcast
    this.statusHeartbeatInterval = setInterval(() => {
      this.broadcastStatusHeartbeat();
    }, this.config.statusHeartbeatMs);

    // Initial status broadcast
    this.broadcastStatusHeartbeat();
  }

  /**
   * Stop the supervisor watchdog
   */
  public stop(): void {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    if (this.statusHeartbeatInterval) {
      clearInterval(this.statusHeartbeatInterval);
      this.statusHeartbeatInterval = null;
    }
    this.logger.info('EngineSupervisor stopped');
  }

  /**
   * Register the engine restart callback
   */
  public setRestartEngineCallback(callback: (reason: RestartReason) => Promise<boolean>): void {
    this.restartEngineCallback = callback;
  }

  /**
   * Register the exchange reconnect callback
   */
  public setReconnectExchangeCallback(callback: () => Promise<boolean>): void {
    this.reconnectExchangeCallback = callback;
  }

  /**
   * Main tick - called every tickIntervalMs
   * Checks health and triggers recovery when needed
   */
  public tick(): void {
    const now = Date.now();
    this.emit('supervisor:tick');

    // Update Prometheus gauges
    const engineStateValue = this.getEngineStateValue();
    engineStateGauge.set(engineStateValue);

    if (this.lastMarketDataAt > 0) {
      marketDataAgeGauge.set((now - this.lastMarketDataAt) / 1000);
    }
    if (this.lastEngineHeartbeatAt > 0) {
      engineHeartbeatAgeGauge.set((now - this.lastEngineHeartbeatAt) / 1000);
    }

    // Skip health checks if we're currently restarting
    if (this.isRestarting) {
      return;
    }

    // Skip checks if engine is intentionally stopped
    if (this.desiredState === 'stopped') {
      return;
    }

    // Check if engine should be running but isn't responding
    if (this.desiredState === 'running' && !this.killSwitchActive) {
      this.checkEngineHealth(now);
      this.checkMarketDataHealth(now);
    }

    // Even when kill switch is active, check market data health
    // (we want to stay connected to market data for visibility)
    if (this.killSwitchActive) {
      this.checkMarketDataHealth(now);
    }
  }

  /**
   * Check engine heartbeat health
   */
  private checkEngineHealth(now: number): void {
    const elapsed = now - this.lastEngineHeartbeatAt;

    if (elapsed > this.config.engineHeartbeatStaleMs) {
      this.logger.warn('Engine heartbeat stale', {
        elapsedMs: elapsed,
        thresholdMs: this.config.engineHeartbeatStaleMs,
      });

      this.emit('supervisor:engine_stale', 'engine_heartbeat_stale', elapsed);
      supervisorRecoveryCounter.inc({ type: 'engine_stale' });

      this.triggerRestart('engine_heartbeat_stale');
    }
  }

  /**
   * Check market data freshness
   */
  private checkMarketDataHealth(now: number): void {
    const elapsed = now - this.lastMarketDataAt;

    if (elapsed > this.config.marketDataStaleMs) {
      this.logger.warn('Market data stale', {
        elapsedMs: elapsed,
        thresholdMs: this.config.marketDataStaleMs,
      });

      this.emit('supervisor:marketdata_stale', elapsed);
      supervisorRecoveryCounter.inc({ type: 'marketdata_stale' });

      // Try to reconnect exchange WS first
      this.triggerExchangeReconnect();
    }
  }

  /**
   * Trigger engine restart with rate limiting
   */
  private async triggerRestart(reason: RestartReason): Promise<void> {
    const now = Date.now();

    // Check cooldown
    if (this.lastRestartAt && (now - this.lastRestartAt) < this.config.restartCooldownMs) {
      const remainingCooldown = this.config.restartCooldownMs - (now - this.lastRestartAt);
      this.logger.warn('Restart blocked by cooldown', {
        reason,
        remainingCooldownMs: remainingCooldown,
      });
      this.emit('supervisor:restart_blocked', `Cooldown active: ${remainingCooldown}ms remaining`);
      return;
    }

    // Check consecutive restart limit
    const recentRestarts = this.restartHistory.filter(
      r => (now - r.timestamp) < this.config.restartWindowMs
    );

    if (recentRestarts.length >= this.config.maxConsecutiveRestarts) {
      this.logger.error('Max consecutive restarts reached', {
        count: recentRestarts.length,
        max: this.config.maxConsecutiveRestarts,
        windowMs: this.config.restartWindowMs,
      });
      this.emit('supervisor:recovery_failed', 'Max consecutive restarts exceeded');
      supervisorRecoveryCounter.inc({ type: 'max_restarts_exceeded' });
      return;
    }

    // Check if restart callback is registered
    if (!this.restartEngineCallback) {
      this.logger.error('No restart callback registered');
      this.emit('supervisor:recovery_failed', 'No restart callback registered');
      return;
    }

    // Perform restart
    this.isRestarting = true;
    this.logger.info('Triggering engine restart', { reason });
    this.emit('supervisor:restart_triggered', reason);
    supervisorRestartCounter.inc({ reason });

    try {
      const success = await this.restartEngineCallback(reason);

      this.restartCount++;
      this.lastRestartReason = reason;
      this.lastRestartAt = now;
      this.restartHistory.push({ timestamp: now, reason });

      // Trim old history
      this.restartHistory = this.restartHistory.filter(
        r => (now - r.timestamp) < this.config.restartWindowMs * 2
      );

      if (success) {
        this.logger.info('Engine restart completed successfully', { reason });
        // Reset heartbeat timestamps after successful restart
        this.lastEngineHeartbeatAt = now;
        this.lastMarketDataAt = now;
      } else {
        this.logger.error('Engine restart failed', { reason });
      }

      this.emit('supervisor:restart_completed', success, reason);
    } catch (error) {
      this.logger.error('Engine restart threw error', {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      this.emit('supervisor:recovery_failed', `Restart error: ${error}`);
    } finally {
      this.isRestarting = false;
    }
  }

  /**
   * Trigger exchange WebSocket reconnect
   */
  private async triggerExchangeReconnect(): Promise<void> {
    if (!this.reconnectExchangeCallback) {
      this.logger.warn('No exchange reconnect callback registered');
      return;
    }

    this.logger.info('Triggering exchange reconnect');
    supervisorRecoveryCounter.inc({ type: 'exchange_reconnect' });

    try {
      const success = await this.reconnectExchangeCallback();
      if (success) {
        this.logger.info('Exchange reconnect successful');
        this.lastMarketDataAt = Date.now();
      } else {
        this.logger.warn('Exchange reconnect failed, will retry');
      }
    } catch (error) {
      this.logger.error('Exchange reconnect threw error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Broadcast status heartbeat for UI consumption
   */
  private broadcastStatusHeartbeat(): void {
    this.lastStatusBroadcastAt = Date.now();
    const state = this.getState();
    this.emit('supervisor:status_heartbeat', state);
  }

  // ============ State Update Methods ============

  /**
   * Update engine heartbeat timestamp (called by trading engine)
   */
  public recordEngineHeartbeat(): void {
    this.lastEngineHeartbeatAt = Date.now();
  }

  /**
   * Update market data timestamp (called on ticker/candle receipt)
   */
  public recordMarketData(): void {
    this.lastMarketDataAt = Date.now();
  }

  /**
   * Set desired engine state
   */
  public setDesiredState(state: EngineState, mode?: TradingMode): void {
    const oldState = this.desiredState;
    this.desiredState = state;
    if (mode !== undefined) {
      this.tradingMode = mode;
    }

    if (oldState !== state) {
      this.logger.info('Desired engine state changed', {
        from: oldState,
        to: state,
        mode: this.tradingMode,
      });
    }
  }

  /**
   * Set actual engine state
   */
  public setActualState(state: EngineState, reason?: string): void {
    const oldState = this.actualState;
    this.actualState = state;

    if (oldState !== state) {
      this.logger.info('Engine state changed', {
        from: oldState,
        to: state,
        reason: reason || 'unknown',
      });
      this.emit('supervisor:state_changed', oldState, state, reason || 'unknown');
    }
  }

  /**
   * Activate kill switch - halts trading but NOT runtime
   */
  public activateKillSwitch(reasons: string[]): void {
    if (this.killSwitchActive) {
      // Add new reasons to existing
      this.killSwitchReasons = [...new Set([...this.killSwitchReasons, ...reasons])];
      return;
    }

    this.killSwitchActive = true;
    this.killSwitchReasons = reasons;
    this.killSwitchSince = Date.now();

    this.logger.warn('Kill switch activated', { reasons });
    this.setActualState('halted', `kill_switch: ${reasons.join(', ')}`);
    this.emit('supervisor:killswitch_activated', reasons);
  }

  /**
   * Deactivate kill switch - allows trading to resume
   */
  public deactivateKillSwitch(): void {
    if (!this.killSwitchActive) {
      return;
    }

    this.killSwitchActive = false;
    this.killSwitchReasons = [];
    this.killSwitchSince = null;

    this.logger.info('Kill switch deactivated');
    
    // If desired state was running, restore it
    if (this.desiredState === 'running') {
      this.setActualState('running', 'kill_switch_deactivated');
    }
    
    this.emit('supervisor:killswitch_deactivated');
  }

  /**
   * Check if kill switch is active
   */
  public isKillSwitchActive(): boolean {
    return this.killSwitchActive;
  }

  // ============ Getters ============

  /**
   * Get current supervisor state for status endpoints
   */
  public getState(): SupervisorState {
    return {
      runtimeAlive: true,
      engineState: this.actualState,
      engineDesiredState: this.desiredState,
      tradingMode: this.tradingMode,
      killSwitch: {
        active: this.killSwitchActive,
        reasons: this.killSwitchReasons,
        since: this.killSwitchSince,
      },
      lastMarketDataAt: this.lastMarketDataAt,
      lastEngineHeartbeatAt: this.lastEngineHeartbeatAt,
      lastStatusBroadcastAt: this.lastStatusBroadcastAt,
      restartCount: this.restartCount,
      lastRestartReason: this.lastRestartReason,
      lastRestartAt: this.lastRestartAt,
      consecutiveRestarts: this.getConsecutiveRestarts(),
      restartHistory: this.restartHistory.slice(-10), // Last 10 restarts
    };
  }

  /**
   * Get number of consecutive restarts in the restart window
   */
  private getConsecutiveRestarts(): number {
    const now = Date.now();
    return this.restartHistory.filter(
      r => (now - r.timestamp) < this.config.restartWindowMs
    ).length;
  }

  /**
   * Convert engine state to numeric value for Prometheus
   */
  private getEngineStateValue(): number {
    switch (this.actualState) {
      case 'stopped': return 0;
      case 'running': return 1;
      case 'paused': return 2;
      case 'halted': return 3;
      default: return 0;
    }
  }

  /**
   * Get configuration
   */
  public getConfig(): SupervisorConfig {
    return { ...this.config };
  }

  /**
   * Update configuration at runtime
   */
  public updateConfig(updates: Partial<SupervisorConfig>): void {
    this.config = { ...this.config, ...updates };
    this.logger.info('Supervisor config updated', { config: this.config });
  }

  /**
   * Reset restart tracking (for manual recovery)
   */
  public resetRestartTracking(): void {
    this.restartHistory = [];
    this.logger.info('Restart tracking reset');
  }
}
