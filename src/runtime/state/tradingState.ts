/**
 * Trading UI State Types
 * 
 * Sprint 1.6: Single source of truth for trading state classification.
 * This is what the UI should use to determine what state indicator to show.
 */

// ============ Trading UI State ============

export type TradingUiState =
  | { state: 'RUNNING' }
  | { state: 'PAUSED'; reason?: string }
  | { state: 'KILL_SWITCH'; reasons: string[]; reasonCode?: string }
  | { state: 'STOPPED_UNEXPECTED'; reason?: string }
  | { state: 'DISCONNECTED'; reason?: string }
  | { state: 'STALE'; ageMs: number };

export type TradingUiStateName = TradingUiState['state'];

// ============ Helper to get state name ============

export function getTradingStateName(state: TradingUiState): TradingUiStateName {
  return state.state;
}

// ============ Display Info ============

export interface TradingStateDisplay {
  label: string;
  description: string;
  variant: 'success' | 'warning' | 'destructive' | 'muted';
  showBanner: boolean;
}

export function getTradingStateDisplay(state: TradingUiState): TradingStateDisplay {
  switch (state.state) {
    case 'RUNNING':
      return {
        label: 'RUNNING',
        description: 'Trading engine is active and processing signals',
        variant: 'success',
        showBanner: false,
      };
    case 'PAUSED':
      return {
        label: 'PAUSED',
        description: state.reason || 'New entries blocked. Existing positions remain open.',
        variant: 'warning',
        showBanner: false,
      };
    case 'KILL_SWITCH':
      return {
        label: 'HALTED (KILL SWITCH)',
        description: `Trading halted for safety. Reason: ${state.reasons.join(', ') || state.reasonCode || 'Unknown'}`,
        variant: 'destructive',
        showBanner: true,
      };
    case 'STOPPED_UNEXPECTED':
      return {
        label: 'STOPPED (ERROR)',
        description: state.reason || 'Engine stopped unexpectedly. Check backend logs.',
        variant: 'destructive',
        showBanner: true,
      };
    case 'DISCONNECTED':
      return {
        label: 'DISCONNECTED',
        description: state.reason || 'Connection to trading backend lost',
        variant: 'destructive',
        showBanner: false,
      };
    case 'STALE':
      return {
        label: `STALE (${Math.round(state.ageMs / 1000)}s)`,
        description: `No heartbeat for ${Math.round(state.ageMs / 1000)} seconds`,
        variant: 'warning',
        showBanner: false,
      };
  }
}
