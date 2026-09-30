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
import type { ExecutionMode } from '../runtime/session-context';
import type { PaperHardStopSnapshot } from '../runtime/paper-hard-stop';
import type { PnlSnapshot } from './pnl-snapshot';
import type { RestampOpenPositionsResult, RestampOutcome } from '../persistence/position-session-restamp';
import type { ReconcileClassification } from '../persistence/session-reconcile';
import type { PositionCloseWriteFailures } from '../persistence/position-write-sequencer';
import type { OrderLinkCounts } from '../persistence/order-position-link';

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

/**
 * Persistence health (round 3, task G) — the start-up / write-path facts the
 * soak desk used to have only in logs, on `/api/status` and every WS
 * `StatusUpdate`. Read-only diagnostics, mode-agnostic: a live session carries
 * the same block with the same semantics; nothing reads it back into a gate.
 */

/** The last start's hydrated-position restamp (`persistence/position-session-restamp.ts`). */
export interface StatusPersistenceHydrateRestamp {
  outcome: RestampOutcome;
  hydrated: number;
  restamped: number;
  alreadyCurrent: number;
  /** Open rows of the OTHER execution_mode found among the hydrated set — never restamped. */
  foreign: number;
  /** Symbols of the rows the UPDATE actually moved. */
  symbols: string[];
  /** Distinct prior `session_id`s those rows carried (`null` = unstamped). */
  fromSessionIds: Array<string | null>;
  /** `"<code>: <message>"` when the restamp failed, else `null`. */
  error: string | null;
}

/** The last observational session reconcile (`persistence/session-reconcile.ts`). */
export interface StatusPersistenceReconcile {
  /** Epoch ms the reconcile ran. */
  at: number;
  modeScoped: boolean;
  dbOpenCount: number;
  engineOpenCount: number;
  /** Symbols open in the DB for this mode with no engine counterpart (phantom / failed close). */
  inDbNotEngine: string[];
  /** Symbols the engine holds open with no DB row (missed open write). */
  inEngineNotDb: string[];
  /** Open rows stamped with ANOTHER execution_mode — not drift. */
  foreignModeOpen: number;
  foreignModeSymbols: string[];
  note: string;
}

export interface StatusPersistenceBlock {
  sessionId: string | null;
  executionMode: ExecutionMode | null;
  /** `null` until the start's restamp ran (or when nothing was hydrated and no result exists). */
  hydrateRestamp: StatusPersistenceHydrateRestamp | null;
  /** `null` until the start's observational reconcile ran (or with `STARTUP_RECONCILE=false`). */
  reconcile: StatusPersistenceReconcile | null;
  /** Terminal close-write failures since process start (`PositionWriteSequencer.closeWriteFailures()`). */
  closeWriteFailures: PositionCloseWriteFailures;
  /** `orders.position_id` link counters since process start (`OrderPositionLinker.linkCounts()`). */
  orderLinks: OrderLinkCounts;
}

export interface PersistenceBlockInputs {
  sessionId: string | null;
  executionMode: ExecutionMode | null;
  hydrateRestamp: RestampOpenPositionsResult | null;
  /** The classification plus the epoch ms it ran at. */
  reconcile: (ReconcileClassification & { at: number }) | null;
  closeWriteFailures: PositionCloseWriteFailures;
  orderLinks: OrderLinkCounts;
}

/**
 * Project the persistence facts onto the wire shape. Pure; the caller supplies
 * the last restamp / reconcile results and the two counters.
 */
export function buildPersistenceBlock(inputs: PersistenceBlockInputs): StatusPersistenceBlock {
  const { hydrateRestamp, reconcile } = inputs;
  return {
    sessionId: inputs.sessionId,
    executionMode: inputs.executionMode,
    hydrateRestamp: hydrateRestamp
      ? {
          outcome: hydrateRestamp.outcome,
          hydrated: hydrateRestamp.hydrated,
          restamped: hydrateRestamp.restamped,
          alreadyCurrent: hydrateRestamp.alreadyCurrent,
          foreign: hydrateRestamp.foreign,
          symbols: hydrateRestamp.rows.map((row) => row.symbol),
          fromSessionIds: [...new Set(hydrateRestamp.rows.map((row) => row.fromSessionId ?? null))],
          error: hydrateRestamp.error
            ? `${hydrateRestamp.error.code ? `${hydrateRestamp.error.code}: ` : ''}${hydrateRestamp.error.message}`
            : null,
        }
      : null,
    reconcile: reconcile
      ? {
          at: reconcile.at,
          modeScoped: reconcile.modeScoped,
          dbOpenCount: reconcile.dbOpenCount,
          engineOpenCount: reconcile.engineOpenCount,
          inDbNotEngine: [...reconcile.inDbNotEngine],
          inEngineNotDb: [...reconcile.inEngineNotDb],
          foreignModeOpen: reconcile.foreignModeOpen,
          foreignModeSymbols: [...reconcile.foreignModeSymbols],
          note: reconcile.note,
        }
      : null,
    closeWriteFailures: {
      count: inputs.closeWriteFailures.count,
      last: inputs.closeWriteFailures.last ? { ...inputs.closeWriteFailures.last } : null,
    },
    orderLinks: { ...inputs.orderLinks },
  };
}

export interface StatusPayloadInputs {
  runtime: StatusRuntimeStateLike;
  supervisor: StatusSupervisorStateLike;
  engine: StatusEngineLike;
  /** Canonical snapshot while running, `null` otherwise (see pnl-snapshot.ts). */
  pnl: PnlSnapshot | null;
  /** Live only (TASK_011); `null` in paper / when stopped. */
  liveAccount: Record<string, unknown> | null;
  /**
   * Paper-only engine-side 22:30 CT self-stop backstop (handoff P5). The
   * scheduler's snapshot while a paper session is running; `null` when no
   * scheduler exists (stopped, or a live session). Optional for callers that
   * predate the field.
   */
  paperHardStop?: PaperHardStopSnapshot | null;
  /**
   * Persistence health (round 3, task G) while the engine runs; ignored (the
   * key is `null`) when it does not. Optional for callers that predate the field.
   */
  persistence?: StatusPersistenceBlock | null;
  now?: number;
}

export interface StatusSessionBlock {
  id: string | null;
  /** Epoch ms. */
  startedAt: number | null;
  mode: ExecutionMode | null;
  /** `trading_sessions.initial_equity`; the paper capital the session opened with. */
  initialEquityUsd: number | null;
}

export interface StatusPayload {
  engineRunning: boolean;
  mode: ExecutionMode | null;
  /** Active `trading_sessions.session_id`; `null` when no session is open. ALWAYS present. */
  sessionId: string | null;
  /** Epoch ms the session opened; `null` when no session is open. ALWAYS present. */
  sessionStartedAt: number | null;
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
  /**
   * Paper-only hard-stop backstop state: `{ enabled, nextFireAtIso, nextFireAtMs,
   * timezone, localTime, reason }` while a paper session is running, `null`
   * otherwise (and ALWAYS `null` for live). ALWAYS present as a key.
   */
  paperHardStop: PaperHardStopSnapshot | null;
  /**
   * Persistence health: `{ sessionId, executionMode, hydrateRestamp, reconcile,
   * closeWriteFailures, orderLinks }` while the engine runs, `null` otherwise.
   * ALWAYS present as a key.
   */
  persistence: StatusPersistenceBlock | null;
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
  'paperHardStop',
  'persistence',
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

  return {
    engineRunning: engine.running,
    mode: engine.running ? engine.mode : null,
    sessionId: runtime.sessionId,
    sessionStartedAt: runtime.sessionStartedAt,
    session: {
      id: runtime.sessionId,
      startedAt: runtime.sessionStartedAt,
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
    // Paper only: never surface (or arm) a hard stop for a live session.
    paperHardStop: engine.running && engine.mode === 'paper' ? (inputs.paperHardStop ?? null) : null,
    // Read-only persistence diagnostics; null whenever no engine is running.
    persistence: engine.running ? (inputs.persistence ?? null) : null,
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
