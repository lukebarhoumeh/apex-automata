/**
 * Runtime status payload — Frontend Lead contract #4 (stable session window).
 *
 * `GET /api/status`, the periodic WS `StatusUpdate`, the on-connect
 * `StatusUpdate` and the pause/resume `StatusUpdate` broadcasts used to be four
 * hand-rolled object literals in server.ts. The UI merges every `StatusUpdate`
 * over its `/api/status` cache, so any emitter that dropped `sessionId` /
 * `sessionStartedAt` made the session window flap and triggered refetch
 * storms. This module is the one place the payload is built; every emitter
 * calls it, and the invariants are unit-tested:
 *
 *   - `sessionId` and `sessionStartedAt` keys are ALWAYS present (null when
 *     no `trading_sessions` row is open);
 *   - `pnl` is ALWAYS present: the canonical snapshot while the engine runs,
 *     `null` otherwise — never a partial object;
 *   - `pnl.sessionId === sessionId` while running.
 *
 * `GET /api/status` layers exchange-health blocks (`ws`, `rest`,
 * `exchangeHealth`, `reconciler`) on top of this core in server.ts.
 */

import type { EngineState } from '../trading/trading-engine';
import type { EngineState as SupervisorEngineState } from '../runtime/engine-supervisor';
import { toIsoOrNull, type ExecutionMode } from '../runtime/session-context';
import type { PnlSnapshot } from './pnl-snapshot';

export interface StatusKillSwitch {
  active: boolean;
  reasons: string[];
  since: number | null;
}

export interface StatusRiskBlock {
  exposureUsd: number;
  dailyPnLUsd: number;
  maxDrawdownPct: number;
  killSwitchActive: boolean;
}

/** The slice of server.ts `runtimeState` the payload reads. */
export interface StatusRuntimeStateLike {
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: StatusKillSwitch;
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: string;
  risk: StatusRiskBlock;
  warmupComplete: boolean;
  candlesBuffered: Record<string, number>;
  sessionId: string | null;
  sessionStartedAt: number | null;
  sessionMode: ExecutionMode | null;
  sessionInitialEquity: number | null;
}

/** The slice of `EngineSupervisor.getState()` the payload reads. */
export interface StatusSupervisorStateLike {
  runtimeAlive: boolean;
  engineDesiredState: SupervisorEngineState;
  lastMarketDataAt: number;
  lastEngineHeartbeatAt: number;
  restartCount: number;
  lastRestartReason: string | null;
  lastRestartAt: number | null;
  killSwitch: StatusKillSwitch;
}

export interface StatusEngineLike {
  running: boolean;
  mode: ExecutionMode | null;
  engineState: EngineState;
  activeSymbols: string[];
}

export interface StatusPayloadInputs {
  runtime: StatusRuntimeStateLike;
  supervisor: StatusSupervisorStateLike;
  engine: StatusEngineLike;
  /** Canonical snapshot while running, `null` otherwise (see pnl-snapshot.ts). */
  pnl: PnlSnapshot | null;
  /** Live only (TASK_011); `null` in paper / when stopped. */
  liveAccount: Record<string, unknown> | null;
  now?: number;
}

export interface StatusSessionBlock {
  id: string | null;
  /** ISO-8601 UTC. */
  startedAt: string | null;
  mode: ExecutionMode | null;
  /** `trading_sessions.initial_equity`; the paper capital the session opened with. */
  initialEquityUsd: number | null;
}

export interface StatusPayload {
  engineRunning: boolean;
  mode: ExecutionMode | null;
  /** Active `trading_sessions.session_id`; `null` when no session is open. ALWAYS present. */
  sessionId: string | null;
  /**
   * ISO-8601 UTC the session opened (e.g. `2026-09-11T15:02:00.000Z`); `null` when no
   * session is open. ALWAYS present and stable for the life of a session (FE PR1 #4).
   */
  sessionStartedAt: string | null;
  /** Same identity, grouped, plus the session's mode and opening equity. */
  session: StatusSessionBlock;
  paused: boolean;
  dailyStopHit: boolean;
  killSwitch: StatusKillSwitch;
  wsLatencyMs: number;
  restLatencyMs: number;
  spreadPctile: number;
  regime: string;
  risk: StatusRiskBlock;
  /** Canonical PnL / equity snapshot; `null` while the engine is not running. ALWAYS present. */
  pnl: PnlSnapshot | null;
  liveAccount: Record<string, unknown> | null;
  activeSymbols: string[];
  warmupComplete: boolean;
  candlesBuffered: Record<string, number>;
  runtimeAlive: boolean;
  engineState: EngineState;
  engineDesiredState: SupervisorEngineState;
  lastMarketDataAt: number;
  lastEngineHeartbeatAt: number;
  restartCount: number;
  lastRestartReason: string | null;
  lastRestartAt: number | null;
  timestamp: number;
}

/** Keys the UI relies on being present on every `/api/status` and `StatusUpdate` payload. */
export const STATUS_PAYLOAD_REQUIRED_KEYS = [
  'engineRunning',
  'mode',
  'sessionId',
  'sessionStartedAt',
  'session',
  'pnl',
  'engineState',
  'timestamp',
] as const satisfies readonly (keyof StatusPayload)[];

/**
 * Build the status payload shared by REST and every WS `StatusUpdate` emitter.
 *
 * @param inputs Runtime state, supervisor state, engine facts and the PnL snapshot.
 */
export function buildStatusPayload(inputs: StatusPayloadInputs): StatusPayload {
  const { runtime, supervisor, engine } = inputs;
  const now = inputs.now ?? Date.now();
  const pnl = engine.running ? inputs.pnl : null;
  const sessionStartedAt = toIsoOrNull(runtime.sessionStartedAt);

  return {
    engineRunning: engine.running,
    mode: engine.running ? engine.mode : null,
    sessionId: runtime.sessionId,
    sessionStartedAt,
    session: {
      id: runtime.sessionId,
      startedAt: sessionStartedAt,
      mode: runtime.sessionMode,
      initialEquityUsd: runtime.sessionInitialEquity,
    },
    paused: runtime.paused,
    dailyStopHit: runtime.dailyStopHit,
    // Supervisor-tripped kill switch wins so a halt is never hidden by stale runtime state.
    killSwitch: supervisor.killSwitch.active ? supervisor.killSwitch : runtime.killSwitch,
    wsLatencyMs: runtime.wsLatencyMs,
    restLatencyMs: runtime.restLatencyMs,
    spreadPctile: runtime.spreadPctile,
    regime: runtime.regime,
    risk: runtime.risk,
    pnl,
    liveAccount: engine.running && engine.mode === 'live' ? inputs.liveAccount : null,
    activeSymbols: engine.activeSymbols,
    warmupComplete: runtime.warmupComplete ?? false,
    candlesBuffered: runtime.candlesBuffered ?? {},
    runtimeAlive: supervisor.runtimeAlive,
    engineState: engine.engineState,
    engineDesiredState: supervisor.engineDesiredState,
    lastMarketDataAt: supervisor.lastMarketDataAt,
    lastEngineHeartbeatAt: supervisor.lastEngineHeartbeatAt,
    restartCount: supervisor.restartCount,
    lastRestartReason: supervisor.lastRestartReason,
    lastRestartAt: supervisor.lastRestartAt,
    timestamp: now,
  };
}
