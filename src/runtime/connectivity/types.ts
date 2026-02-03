/**
 * Runtime Connectivity Types
 * 
 * Defines the single source of truth for connection status.
 * The UI should ONLY use these states to determine "connected" status.
 */

// ============ Connectivity State Machine ============

export type RuntimeConnectivity =
  | { state: 'CONNECTED'; since: number }
  | { state: 'STALE'; since: number; lastHeartbeatAt: number; ageMs: number }
  | { state: 'DISCONNECTED'; since: number; reason?: string }
  | { state: 'BACKEND_DOWN'; since: number; reason?: string }
  | { state: 'ENGINE_STOPPED'; since: number; engineRunning: false }
  | { state: 'ENGINE_HALTED'; since: number; reasonCode?: string };

export type ConnectivityState = RuntimeConnectivity['state'];

// ============ Thresholds / Constants ============

/** Expected heartbeat interval from backend (status/pnl:snapshot) */
export const HEARTBEAT_INTERVAL_MS = 5000;

/** If no heartbeat in this time, mark as STALE */
export const HEARTBEAT_STALE_MS = 10000;

/** REST probe interval for fallback reachability check */
export const REST_PROBE_INTERVAL_MS = 5000;

/** If REST fails for this long, mark BACKEND_DOWN */
export const REST_PROBE_FAIL_MS = 12000;

/** Tick interval for recomputing state */
export const TICK_INTERVAL_MS = 1000;

// ============ Engine State (from backend status) ============

export interface EngineStatus {
  engineRunning: boolean;
  mode: 'paper' | 'live' | null;
  paused: boolean;
  tradingState?: 'RUNNING' | 'PAUSED' | 'HALTED';
  haltReasonCode?: string;
  dailyStopHit?: boolean;
  killSwitch?: {
    active: boolean;
    reasons: string[];
  };
}

// ============ Internal Timestamps ============

export interface ConnectivityTimestamps {
  lastHeartbeatAt: number | null;
  lastRestOkAt: number | null;
  lastRestFailAt: number | null;
  lastWsOpenAt: number | null;
  lastWsCloseAt: number | null;
  lastStatusAt: number | null;
}

// ============ Listener Types ============

export type ConnectivityListener = (connectivity: RuntimeConnectivity) => void;
