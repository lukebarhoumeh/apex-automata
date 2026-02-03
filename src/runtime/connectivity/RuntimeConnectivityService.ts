/**
 * Runtime Connectivity Service
 * 
 * Single source of truth for connection status.
 * Combines WS state + heartbeats + REST probes to produce accurate connectivity state.
 * 
 * This replaces the buggy "wsConnected || backendHealthy" logic.
 */

import {
  RuntimeConnectivity,
  ConnectivityTimestamps,
  EngineStatus,
  ConnectivityListener,
  HEARTBEAT_STALE_MS,
  REST_PROBE_FAIL_MS,
  TICK_INTERVAL_MS,
} from './types';

export class RuntimeConnectivityService {
  private timestamps: ConnectivityTimestamps = {
    lastHeartbeatAt: null,
    lastRestOkAt: null,
    lastRestFailAt: null,
    lastWsOpenAt: null,
    lastWsCloseAt: null,
    lastStatusAt: null,
  };

  private wsOpen = false;
  private engineStatus: EngineStatus | null = null;
  private listeners = new Set<ConnectivityListener>();
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private currentState: RuntimeConnectivity = { 
    state: 'DISCONNECTED', 
    since: Date.now(),
    reason: 'Initial state',
  };

  constructor() {
    this.startTicking();
  }

  // ============ State Computation ============

  private computeState(now: number): RuntimeConnectivity {
    // 1) If WS is closed → DISCONNECTED immediately
    if (!this.wsOpen) {
      return {
        state: 'DISCONNECTED',
        since: this.timestamps.lastWsCloseAt || now,
        reason: 'WebSocket closed',
      };
    }

    // 2) Check for heartbeat staleness
    const lastHeartbeat = this.timestamps.lastHeartbeatAt;
    if (!lastHeartbeat) {
      // WS open but never received a heartbeat - waiting for first heartbeat
      // Treat as connected briefly, but this should quickly become STALE if no heartbeat
      const wsOpenDuration = now - (this.timestamps.lastWsOpenAt || now);
      if (wsOpenDuration > HEARTBEAT_STALE_MS) {
        return {
          state: 'STALE',
          since: (this.timestamps.lastWsOpenAt || now) + HEARTBEAT_STALE_MS,
          lastHeartbeatAt: 0,
          ageMs: wsOpenDuration,
        };
      }
      // Still within grace period after WS open
    } else {
      const heartbeatAge = now - lastHeartbeat;
      if (heartbeatAge > HEARTBEAT_STALE_MS) {
        // 3) STALE - WS open but no heartbeat
        // Check if REST has also failed → BACKEND_DOWN
        const lastRestFail = this.timestamps.lastRestFailAt;
        const lastRestOk = this.timestamps.lastRestOkAt;
        
        if (lastRestFail && (!lastRestOk || lastRestFail > lastRestOk)) {
          const restFailDuration = now - lastRestFail;
          if (restFailDuration < REST_PROBE_FAIL_MS) {
            // REST recently failed, check if it's been failing long enough
            const timeSinceLastRestOk = lastRestOk ? now - lastRestOk : Infinity;
            if (timeSinceLastRestOk > REST_PROBE_FAIL_MS) {
              return {
                state: 'BACKEND_DOWN',
                since: lastRestOk ? lastRestOk + REST_PROBE_FAIL_MS : now,
                reason: 'REST and WS both unresponsive',
              };
            }
          }
        }

        return {
          state: 'STALE',
          since: lastHeartbeat + HEARTBEAT_STALE_MS,
          lastHeartbeatAt: lastHeartbeat,
          ageMs: heartbeatAge,
        };
      }
    }

    // 4) WS open + heartbeat fresh - check engine status
    if (this.engineStatus) {
      if (!this.engineStatus.engineRunning) {
        // Engine not running
        if (this.engineStatus.tradingState === 'HALTED') {
          return {
            state: 'ENGINE_HALTED',
            since: this.timestamps.lastStatusAt || now,
            reasonCode: this.engineStatus.haltReasonCode || 
                       this.engineStatus.killSwitch?.reasons?.[0] ||
                       (this.engineStatus.dailyStopHit ? 'daily_stop' : undefined),
          };
        }
        return {
          state: 'ENGINE_STOPPED',
          since: this.timestamps.lastStatusAt || now,
          engineRunning: false,
        };
      }
      
      // Engine running but in HALTED state (can happen if halted but still "running" process)
      if (this.engineStatus.tradingState === 'HALTED') {
        return {
          state: 'ENGINE_HALTED',
          since: this.timestamps.lastStatusAt || now,
          reasonCode: this.engineStatus.haltReasonCode || 
                     this.engineStatus.killSwitch?.reasons?.[0] ||
                     (this.engineStatus.dailyStopHit ? 'daily_stop' : undefined),
        };
      }
    }

    // 5) All good - CONNECTED
    return {
      state: 'CONNECTED',
      since: this.timestamps.lastHeartbeatAt || this.timestamps.lastWsOpenAt || now,
    };
  }

  private recomputeAndNotify() {
    const now = Date.now();
    const newState = this.computeState(now);
    
    // Only notify if state actually changed
    if (newState.state !== this.currentState.state) {
      this.currentState = newState;
      this.notifyListeners();
    } else {
      // Update dynamic fields (like ageMs) without notification
      this.currentState = newState;
    }
  }

  private notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener(this.currentState);
      } catch (error) {
        console.error('[Connectivity] Listener error:', error);
      }
    }
  }

  private startTicking() {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => {
      this.recomputeAndNotify();
    }, TICK_INTERVAL_MS);
  }

  // ============ Public API ============

  getState(): RuntimeConnectivity {
    return this.currentState;
  }

  getTimestamps(): ConnectivityTimestamps {
    return { ...this.timestamps };
  }

  getEngineStatus(): EngineStatus | null {
    return this.engineStatus;
  }

  subscribe(listener: ConnectivityListener): () => void {
    this.listeners.add(listener);
    // Immediately notify with current state
    listener(this.currentState);
    return () => this.listeners.delete(listener);
  }

  // ============ Ingest Methods ============

  /**
   * Called when WS connection opens
   */
  ingestWsOpen() {
    const now = Date.now();
    this.wsOpen = true;
    this.timestamps.lastWsOpenAt = now;
    this.recomputeAndNotify();
  }

  /**
   * Called when WS connection closes
   */
  ingestWsClose(reason?: string) {
    const now = Date.now();
    this.wsOpen = false;
    this.timestamps.lastWsCloseAt = now;
    this.currentState = {
      state: 'DISCONNECTED',
      since: now,
      reason,
    };
    this.notifyListeners();
  }

  /**
   * Called when receiving heartbeat-like events (status, pnl:snapshot, runtime:heartbeat)
   */
  ingestHeartbeat(ts?: number) {
    const now = ts || Date.now();
    this.timestamps.lastHeartbeatAt = now;
    this.recomputeAndNotify();
  }

  /**
   * Called when receiving a status event with engine info
   */
  ingestStatus(status: EngineStatus, ts?: number) {
    const now = ts || Date.now();
    this.engineStatus = status;
    this.timestamps.lastStatusAt = now;
    this.timestamps.lastHeartbeatAt = now; // status counts as heartbeat
    this.recomputeAndNotify();
  }

  /**
   * Called when REST health check succeeds
   */
  ingestRestOk(ts?: number) {
    const now = ts || Date.now();
    this.timestamps.lastRestOkAt = now;
    this.recomputeAndNotify();
  }

  /**
   * Called when REST health check fails
   */
  ingestRestFail(ts?: number) {
    const now = ts || Date.now();
    this.timestamps.lastRestFailAt = now;
    this.recomputeAndNotify();
  }

  // ============ Cleanup ============

  destroy() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.listeners.clear();
  }
}

// ============ Singleton ============

let instance: RuntimeConnectivityService | null = null;

export function getConnectivityService(): RuntimeConnectivityService {
  if (!instance) {
    instance = new RuntimeConnectivityService();
  }
  return instance;
}

export function resetConnectivityService() {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}
