/**
 * Engine pill (TopBar) — one honest label/tone from runtime status + connectivity.
 *
 * TASK_016 U3: the pill used to read `${mode ?? "paper"} · running` and stayed
 * green after a kill. It now defers to deriveTradingUiState (kill switch and
 * transport outrank "running") and never invents a mode.
 */

import type { RuntimeConnectivity } from '@/runtime/connectivity/types';
import type { PaperHardStopStatus } from '@/runtime/ws/types';
import { deriveTradingUiState, type RuntimeStatusPayload } from './deriveTradingUiState';

export type EnginePillTone = 'up' | 'live' | 'warn' | 'down' | 'muted';

export interface EnginePill {
  label: string;
  tone: EnginePillTone;
  /** Hover text with the reason behind the state. */
  title: string;
}

export interface EnginePillStatus extends RuntimeStatusPayload {
  sessionId?: string | null;
  engineState?: string;
  /** PAPER ONLY 22:30 CT hard stop; null for live/stopped, absent on old backends. */
  paperHardStop?: PaperHardStopStatus | null;
}

// ============ Paper hard-stop chip (handoff P5) ============

export type HardStopChipTone = 'info' | 'warn';

export interface HardStopChip {
  /** e.g. "Hard stop 22:30 CT" */
  label: string;
  /** Short countdown for the chip body, e.g. "3h 12m", "<1m", "now". */
  remaining: string;
  /** e.g. "fires in 3h 12m (2026-09-30T03:30:00.000Z)" */
  detail: string;
  tone: HardStopChipTone;
  /** Hover text: timezone + local time + the ISO fire instant. */
  title: string;
}

/** Below this much time left the chip turns to `warn`. */
export const HARD_STOP_WARN_MS = 30 * 60_000;

/** Desk-facing zone abbreviations; anything else falls back to the IANA name. */
const ZONE_ABBREVIATIONS: Readonly<Record<string, string>> = {
  'America/Chicago': 'CT',
};

function formatRemaining(remainingMs: number): string {
  if (remainingMs <= 0) return 'now';
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return '<1m';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * Pure derivation of the paper hard-stop chip from `/api/status → paperHardStop`.
 * Returns null whenever there is nothing honest to show: no status yet, field
 * null (live or stopped) or absent (old backend), scheduler not armed, or an
 * unparseable fire time. `nowMs` is injected so the caller owns the clock.
 */
export function deriveHardStopChip(
  status: Pick<EnginePillStatus, 'paperHardStop'> | null | undefined,
  nowMs: number,
): HardStopChip | null {
  const hardStop = status?.paperHardStop;
  if (!hardStop || !hardStop.enabled || !hardStop.nextFireAtIso) return null;
  const fireAtMs = Date.parse(hardStop.nextFireAtIso);
  if (!Number.isFinite(fireAtMs)) return null;

  const remainingMs = fireAtMs - nowMs;
  const remaining = formatRemaining(remainingMs);
  const zone = ZONE_ABBREVIATIONS[hardStop.timezone] ?? hardStop.timezone;
  return {
    label: `Hard stop ${hardStop.localTime} ${zone}`,
    remaining,
    detail: remainingMs <= 0 ? `firing now (${hardStop.nextFireAtIso})` : `fires in ${remaining} (${hardStop.nextFireAtIso})`,
    tone: remainingMs < HARD_STOP_WARN_MS ? 'warn' : 'info',
    title: `Paper session hard stop at ${hardStop.localTime} ${hardStop.timezone} — stops the engine through the shared stop path. Next fire: ${hardStop.nextFireAtIso}`,
  };
}

export function deriveEnginePill(
  status: EnginePillStatus | null | undefined,
  connectivity: RuntimeConnectivity,
): EnginePill {
  const uiState = deriveTradingUiState(status ?? null, connectivity);
  const session = status?.sessionId ? `Session ${status.sessionId}` : 'No active session';

  switch (uiState.state) {
    case 'DISCONNECTED':
      if (!status && connectivity.state !== 'DISCONNECTED' && connectivity.state !== 'BACKEND_DOWN') {
        return { label: 'connecting…', tone: 'muted', title: 'Waiting for the first /api/status response' };
      }
      return {
        label: connectivity.state === 'BACKEND_DOWN' ? 'backend down' : 'offline',
        tone: 'down',
        title: uiState.reason ?? 'Runtime unreachable',
      };
    case 'STALE':
      return {
        label: `stale ${Math.round(uiState.ageMs / 1000)}s`,
        tone: 'warn',
        title: `No runtime heartbeat for ${Math.round(uiState.ageMs / 1000)}s — showing last known state`,
      };
    case 'KILL_SWITCH':
      return {
        label: 'halted',
        tone: 'down',
        title: `Kill switch active: ${uiState.reasons.join(', ') || uiState.reasonCode || 'manual'} — positions NOT auto-closed. ${session}`,
      };
    case 'PAUSED':
      return {
        label: `${status?.mode ?? 'unknown'} · paused`,
        tone: 'warn',
        title: `New entries halted, positions held. ${session}`,
      };
    case 'RUNNING': {
      const mode = status?.mode ?? 'unknown';
      // Belt-and-braces: TradingEngine reports its own halted state even if
      // the kill-switch flag has not propagated to runtimeState yet.
      if (status?.engineState === 'halted') {
        return { label: 'halted', tone: 'down', title: `Engine state halted. ${session}` };
      }
      return {
        label: `${mode} · running`,
        tone: mode === 'live' ? 'live' : mode === 'paper' ? 'up' : 'warn',
        title: `${mode === 'live' ? 'REAL MONEY' : mode === 'paper' ? 'Simulated capital' : 'Mode not reported by runtime'}. ${session}`,
      };
    }
    case 'STOPPED_UNEXPECTED':
    default:
      return { label: 'stopped', tone: 'muted', title: `Engine not running. ${session}` };
  }
}
