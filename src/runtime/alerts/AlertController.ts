/**
 * Alert Controller
 * 
 * Sprint 1.6: Event-driven, deduped alert system for trading state transitions.
 * Shows toasts and modals for critical events like kill switch, disconnection, errors.
 */

import { toast } from '@/hooks/use-toast';
import type { RuntimeConnectivity } from '@/runtime/connectivity/types';
import type { RiskEventPayload } from '@/runtime/ws/types';
import type { TradingUiState } from '@/runtime/state/tradingState';

// ============ Alert Types ============

export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertDefinition {
  key: string;
  title: string;
  message: string;
  severity: AlertSeverity;
  showModal: boolean;
}

// ============ Dedupe State ============

interface DedupeEntry {
  key: string;
  timestamp: number;
}

// Dedupe window: 60 seconds
const DEDUPE_WINDOW_MS = 60_000;

// ============ Alert Controller Class ============

export class AlertController {
  private lastAlerts: Map<string, DedupeEntry> = new Map();
  private previousTradingState: TradingUiState | null = null;
  private previousConnectivity: RuntimeConnectivity | null = null;
  private modalCallback: ((alert: AlertDefinition) => void) | null = null;

  constructor() {
    // Cleanup old dedupe entries periodically
    setInterval(() => this.cleanupDedupeEntries(), 30_000);
  }

  // ============ Register Modal Callback ============

  onModal(callback: (alert: AlertDefinition) => void) {
    this.modalCallback = callback;
  }

  // ============ Generate Dedupe Keys ============

  private getTimeBucket(): number {
    return Math.floor(Date.now() / DEDUPE_WINDOW_MS);
  }

  private makeDedupeKey(type: string, details?: string): string {
    const bucket = this.getTimeBucket();
    return `${type}:${details || 'none'}:${bucket}`;
  }

  // ============ Check Dedupe ============

  private shouldAlert(key: string): boolean {
    const now = Date.now();
    const entry = this.lastAlerts.get(key);
    
    if (entry && now - entry.timestamp < DEDUPE_WINDOW_MS) {
      return false;
    }
    
    this.lastAlerts.set(key, { key, timestamp: now });
    return true;
  }

  private cleanupDedupeEntries() {
    const now = Date.now();
    for (const [key, entry] of this.lastAlerts.entries()) {
      if (now - entry.timestamp > DEDUPE_WINDOW_MS * 2) {
        this.lastAlerts.delete(key);
      }
    }
  }

  // ============ Show Alert ============

  private showAlert(alert: AlertDefinition) {
    const dedupeKey = this.makeDedupeKey(alert.key);
    
    if (!this.shouldAlert(dedupeKey)) {
      console.log('[AlertController] Deduped alert:', alert.key);
      return;
    }

    // Always show toast
    toast({
      title: alert.title,
      description: alert.message,
      variant: alert.severity === 'critical' ? 'destructive' : 'default',
      duration: alert.severity === 'critical' ? 10000 : 5000,
    });

    // Show modal for critical events
    if (alert.showModal && this.modalCallback) {
      this.modalCallback(alert);
    }

    console.log(`[AlertController] Alert shown: ${alert.key} - ${alert.title}`);
  }

  // ============ Handle Trading State Transitions ============

  handleTradingStateChange(
    newState: TradingUiState,
    oldState: TradingUiState | null
  ) {
    // Skip if no previous state (initial load)
    if (!oldState) {
      this.previousTradingState = newState;
      return;
    }

    // Skip if no state change
    if (newState.state === oldState.state) {
      return;
    }

    console.log(`[AlertController] State transition: ${oldState.state} → ${newState.state}`);

    // Kill switch activation
    if (newState.state === 'KILL_SWITCH' && oldState.state !== 'KILL_SWITCH') {
      const reasons = newState.reasons.length > 0 
        ? newState.reasons.join(', ')
        : newState.reasonCode || 'Unknown';
      
      this.showAlert({
        key: `killswitch:${reasons}`,
        title: '🚨 Kill Switch Triggered',
        message: `Trading halted for safety. Reason: ${reasons}. Engine halted - manual reset required to resume.`,
        severity: 'critical',
        showModal: true,
      });
    }

    // Unexpected stop (engine stopped without kill switch)
    if (newState.state === 'STOPPED_UNEXPECTED' && oldState.state === 'RUNNING') {
      this.showAlert({
        key: 'unexpected_stop',
        title: '⚠️ Engine Stopped Unexpectedly',
        message: newState.reason || 'The trading engine stopped due to an error or backend issue. Check logs for details.',
        severity: 'critical',
        showModal: true,
      });
    }

    // Engine paused
    if (newState.state === 'PAUSED' && oldState.state === 'RUNNING') {
      this.showAlert({
        key: 'paused',
        title: 'Engine Paused',
        message: newState.reason || 'New entries blocked. Existing positions remain open.',
        severity: 'info',
        showModal: false,
      });
    }

    // Engine resumed
    if (newState.state === 'RUNNING' && oldState.state === 'PAUSED') {
      this.showAlert({
        key: 'resumed',
        title: 'Engine Resumed',
        message: 'Trading activity has resumed.',
        severity: 'info',
        showModal: false,
      });
    }

    this.previousTradingState = newState;
  }

  // ============ Handle Connectivity Transitions ============

  handleConnectivityChange(
    newConnectivity: RuntimeConnectivity,
    oldConnectivity: RuntimeConnectivity | null
  ) {
    // Skip if no previous state
    if (!oldConnectivity) {
      this.previousConnectivity = newConnectivity;
      return;
    }

    // Skip if no state change
    if (newConnectivity.state === oldConnectivity.state) {
      return;
    }

    console.log(`[AlertController] Connectivity: ${oldConnectivity.state} → ${newConnectivity.state}`);

    // Disconnection
    if (
      newConnectivity.state === 'DISCONNECTED' &&
      oldConnectivity.state === 'CONNECTED'
    ) {
      this.showAlert({
        key: 'disconnected',
        title: '🔌 Connection Lost',
        message: newConnectivity.reason || 'Connection to trading backend was lost. Attempting to reconnect...',
        severity: 'warning',
        showModal: false,
      });
    }

    // Backend down
    if (newConnectivity.state === 'BACKEND_DOWN') {
      this.showAlert({
        key: 'backend_down',
        title: '🔴 Backend Unreachable',
        message: newConnectivity.reason || 'Cannot reach the trading backend. Check if the service is running.',
        severity: 'critical',
        showModal: true,
      });
    }

    // Reconnected
    if (
      newConnectivity.state === 'CONNECTED' &&
      (oldConnectivity.state === 'DISCONNECTED' || oldConnectivity.state === 'BACKEND_DOWN')
    ) {
      this.showAlert({
        key: 'reconnected',
        title: '✅ Connection Restored',
        message: 'Successfully reconnected to the trading backend.',
        severity: 'info',
        showModal: false,
      });
    }

    this.previousConnectivity = newConnectivity;
  }

  // ============ Handle Risk Events ============

  handleRiskEvent(payload: RiskEventPayload) {
    // Kill switch triggered via risk event
    if (
      payload.eventType === 'killswitch_triggered' ||
      payload.eventType === 'daily_stop'
    ) {
      const reason = (payload.details as any)?.reasonCode || payload.eventType;
      const message = (payload.details as any)?.message;
      this.showAlert({
        key: `risk:${payload.eventType}:${reason}`,
        title: '🚨 Risk Event: ' + (payload.eventType === 'daily_stop' ? 'Daily Stop Hit' : 'Kill Switch'),
        message: message || `Trading halted. Reason: ${reason}`,
        severity: 'critical',
        showModal: true,
      });
    }
  }

  // ============ Get Previous States ============

  getPreviousTradingState(): TradingUiState | null {
    return this.previousTradingState;
  }

  getPreviousConnectivity(): RuntimeConnectivity | null {
    return this.previousConnectivity;
  }
}

// ============ Singleton Instance ============

let instance: AlertController | null = null;

export function getAlertController(): AlertController {
  if (!instance) {
    instance = new AlertController();
  }
  return instance;
}
