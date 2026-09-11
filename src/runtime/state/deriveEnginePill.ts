/**
 * Engine pill (TopBar) — one honest label/tone from runtime status + connectivity.
 *
 * TASK_016 U3: the pill used to read `${mode ?? "paper"} · running` and stayed
 * green after a kill. It now defers to deriveTradingUiState (kill switch and
 * transport outrank "running") and never invents a mode.
 */

import type { RuntimeConnectivity } from '@/runtime/connectivity/types';
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
