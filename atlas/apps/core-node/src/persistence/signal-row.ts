/**
 * `public.signals` row mapping — the pre-routing INSERT `syncSignalToSupabase`
 * writes (the router's verdict is patched on afterwards, see
 * persistence/signal-route-verdict.ts).
 *
 * Extracted from `api/server.ts` on 2026-09-29 to close the finding-7 open
 * item (docs/research/2026-09-28_paper-persistence-verification.md §2):
 * `strategy` used to be written RAW into the `strategy_name` enum column, so a
 * strategy id the enum did not know failed the INSERT with 22P02 and the
 * signal never reached the desk's funnel — the one row the whole
 * signal → gate → order audit hangs off. `strategy` now goes through the same
 * `resolveStrategyName` mapping as orders and positions (enum pass-through,
 * legacy alias, `system` fallback), and the resolution is returned so the
 * caller can warn on an unknown id. The 22P02 fallback for a value the
 * deployed enum lacks (`donchian_daily_s3` before its migration is applied)
 * is applied at write time by persistence/strategy-enum-fallback.ts.
 *
 * Every other column keeps exactly the shape the inline writer produced.
 * Pure and Supabase-free so it is unit-testable (`__tests__/signal-row.test.ts`).
 */

import { resolveStrategyName, type ResolvedStrategyName, type StrategyNameEnum } from './strategy-name';

/** The engine signal (`TradingSignal` shape, structurally typed — any field may be absent). */
export interface SignalRowInput {
  id?: unknown;
  symbol?: string;
  strategy?: unknown;
  timestamp?: unknown;
  direction?: string;
  side?: string;
  strength?: number;
  score?: number;
  confidence?: number;
  metaLabel?: number | null;
  metaProb?: number | null;
  metadata?: Record<string, unknown> | null;
  features?: Record<string, unknown> | null;
  allowed?: boolean;
  reason?: string | null;
}

/** The `signals` row as inserted (session stamp columns are added by the writer). */
export interface SignalRow {
  id?: string;
  user_id: string;
  symbol: string | undefined;
  strategy: StrategyNameEnum;
  decided_at: string;
  side: 'long' | 'short' | null;
  score: number;
  confidence: number;
  meta_prob: number | null;
  features: Record<string, unknown>;
  allowed: boolean;
  reason: string | null;
  created_at: string;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Build the `signals` INSERT row for an engine signal.
 *
 * @param params.userId `USER_ID` the runtime writes under.
 * @param params.signal The engine signal.
 * @param params.now Wall clock for `created_at` (and `decided_at` when the signal has no timestamp); defaults to `new Date()`.
 */
export function buildSignalRow(params: {
  userId: string;
  signal: SignalRowInput;
  now?: Date;
}): { row: SignalRow; strategy: ResolvedStrategyName } {
  const { userId, signal } = params;
  const now = params.now ?? new Date();

  const maybeId = typeof signal.id === 'string' && UUID_V4.test(signal.id) ? signal.id : undefined;

  const decidedAt = signal.timestamp instanceof Date
    ? signal.timestamp.toISOString()
    : new Date((signal.timestamp as string | number | undefined) ?? now.getTime()).toISOString();

  const direction = signal.direction || signal.side;
  const side: 'long' | 'short' | null = direction === 'buy'
    ? 'long'
    : direction === 'sell'
      ? 'short'
      : (signal.side === 'long' || signal.side === 'short' ? signal.side : null);

  const strategy = resolveStrategyName(signal.strategy);

  const row: SignalRow = {
    ...(maybeId ? { id: maybeId } : {}),
    user_id: userId,
    symbol: signal.symbol,
    strategy: strategy.value, // strategy_name enum, normalised like orders / positions
    decided_at: decidedAt,
    side, // position_side enum
    score: signal.strength || signal.score || 0,
    confidence: signal.confidence || signal.strength || 0,
    meta_prob: signal.metaLabel || signal.metaProb || null,
    features: signal.metadata || signal.features || {},
    allowed: signal.allowed !== false, // Default to true if signal was generated
    reason: signal.reason || (signal.metadata && (signal.metadata.reason as string | undefined)) || null,
    created_at: now.toISOString(),
  };

  return { row, strategy };
}
