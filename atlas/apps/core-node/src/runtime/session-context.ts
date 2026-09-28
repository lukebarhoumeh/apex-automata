/**
 * Session Context
 * 
 * Single source of truth for session identity and time base.
 * All modules that write to DB must use this context.
 */

import { v4 as uuidv4 } from 'uuid';

export type ExecutionMode = 'paper' | 'live';
export type MarketDataEnv = 'production' | 'sandbox';

/**
 * Session context - immutable once created
 */
export interface SessionContext {
  /** Unique session identifier */
  readonly sessionId: string;
  
  /** Session start time */
  readonly startedAt: Date;
  
  /** Execution mode */
  readonly mode: ExecutionMode;
  
  /** Market data environment */
  readonly marketDataEnv: MarketDataEnv;
  
  /** User ID (for multi-tenant) */
  readonly userId: string;
  
  /** Risk day timezone */
  readonly riskDayTz: string;
  
  /** Risk day rollover hour (0-23) */
  readonly riskDayRolloverHour: number;
}

/**
 * Get current risk day string (YYYY-MM-DD)
 */
export function getRiskDay(ctx: SessionContext, now: Date = new Date()): string {
  const adjusted = new Date(now);
  adjusted.setUTCHours(adjusted.getUTCHours() - ctx.riskDayRolloverHour);
  return adjusted.toISOString().split('T')[0];
}

/**
 * Format timestamp for DB writes (always UTC ISO string)
 */
export function formatTimestamp(date: Date = new Date()): string {
  return date.toISOString();
}

/**
 * Create a new session context
 */
export function createSessionContext(options: {
  mode: ExecutionMode;
  marketDataEnv?: MarketDataEnv;
  userId: string;
  riskDayTz?: string;
  riskDayRolloverHour?: number;
  sessionId?: string; // Optional: reuse existing session ID
}): SessionContext {
  return {
    sessionId: options.sessionId || uuidv4(),
    startedAt: new Date(),
    mode: options.mode,
    marketDataEnv: options.marketDataEnv || 'production',
    userId: options.userId,
    riskDayTz: options.riskDayTz || 'UTC',
    riskDayRolloverHour: options.riskDayRolloverHour ?? 0,
  };
}

/**
 * Generate deterministic UUID for idempotent writes
 * 
 * Used to ensure retry/spool replay doesn't create duplicates.
 *
 * Pure function of `parts`: the same parts always yield the same key, no matter
 * when it is called. (Pre-2026-09-28 the second group embedded `Date.now()`, so
 * two calls a millisecond apart produced different keys and a replay across a
 * clock tick could never be deduped.) Callers that legitimately repeat a write
 * with identical parts must include a version / sequence part themselves.
 */
export function generateDedupeKey(...parts: (string | number)[]): string {
  // Simple deterministic hash for deduplication
  const input = parts.join('|');
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  // Convert to hex string and pad
  const hex = Math.abs(hash).toString(16).padStart(8, '0');
  
  // Second, independent hash of the same input (djb2-style, different seed) for
  // the 4-hex group that used to carry the wall clock — keeps the UUID-like shape.
  let hash2 = 5381;
  for (let i = 0; i < input.length; i++) {
    hash2 = ((hash2 * 33) ^ input.charCodeAt(i)) | 0;
  }
  const hex2 = Math.abs(hash2).toString(16).padStart(4, '0').slice(-4);

  // Create UUID-like format for consistency
  return `${hex.slice(0, 8)}-${hex2}-4000-8000-${parts[0]?.toString().slice(0, 12) || '000000000000'}`;
}
