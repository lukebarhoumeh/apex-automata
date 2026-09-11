/**
 * Session-scoped per-strategy trade stats — Frontend Lead contract #3.
 *
 * `GET /api/strategies` exposes each plugin's `stats.signalsGenerated`, which
 * the dashboard cards were rendering as "trades" — so a strategy that fired
 * four signals and never got filled showed "4 trades" next to a session with
 * zero closed positions. `signalsGenerated` stays (it is a real, useful
 * counter — of SIGNALS) and this module adds the honest trade fields next to
 * it, computed from the session's closed trades only:
 *
 *   closedTrades   positions opened AND closed in this engine session
 *   pnlToday       realized USD on trades that exited on the current UTC day
 *   winRate        wins / closedTrades, `null` until the first close
 *
 * Served at `GET /api/analytics/strategies` and mirrored as `sessionStats`
 * on each `/api/strategies` entry. Pure: takes plain trade records and
 * strategy descriptors, no engine or Supabase access.
 */

import type { ExecutionMode } from '../runtime/session-context';

/** The slice of `TradeRecord` (trading/trade-analytics.ts) this module reads. */
export interface StrategyTradeLike {
  strategy?: string | null;
  realizedPnl?: number | null;
  fees?: number | null;
  outcome?: 'win' | 'loss' | 'breakeven' | null;
  exitTime?: Date | number | string | null;
}

/** The slice of a registered strategy plugin this module reads. */
export interface StrategyDescriptorLike {
  id: string;
  name?: string | null;
  enabled?: boolean | null;
  /** Plugin `getStats().signalsGenerated` — a SIGNAL counter, mirrored verbatim. */
  signalsGenerated?: number | null;
}

/** Bucket for trades whose position carried no strategy tag. */
export const UNKNOWN_STRATEGY_ID = 'unknown';

export interface StrategySessionStats {
  strategyId: string;
  name: string | null;
  /** Registry enabled flag; `null` when the strategy is not registered (only seen on trades). */
  enabled: boolean | null;
  /** Positions opened and closed within this session. */
  closedTrades: number;
  /** Positions opened in this session and still open. */
  openTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** wins / closedTrades; `null` when there are no closed trades (render as "—", not 0%). */
  winRate: number | null;
  /** Realized USD across all closed trades in the session (fees already netted by the tracker). */
  realizedPnlUsd: number;
  /** Realized USD across closed trades that exited on `riskDay` (UTC). */
  pnlToday: number;
  closedTradesToday: number;
  /** realizedPnlUsd / closedTrades; `null` when there are no closed trades. */
  avgTradeUsd: number | null;
  feesUsd: number;
  /** Epoch ms of the most recent exit in the session; `null` when none. */
  lastTradeAt: number | null;
  /**
   * Mirrored plugin counter. Counts signals the strategy emitted this session —
   * NOT trades. Kept so callers migrating off `/api/strategies.stats` see the
   * same number side by side with `closedTrades`.
   */
  signalsGenerated: number | null;
}

export interface StrategySessionStatsTotals {
  closedTrades: number;
  openTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  realizedPnlUsd: number;
  pnlToday: number;
  feesUsd: number;
}

export interface StrategySessionStatsReport {
  /** Active `trading_sessions.session_id`; `null` when no engine session is open. */
  sessionId: string | null;
  /** Epoch ms; mirrors `/api/status.sessionStartedAt`. */
  sessionStartedAt: number | null;
  executionMode: ExecutionMode | null;
  engineRunning: boolean;
  /** UTC calendar day (`YYYY-MM-DD`) that `pnlToday` / `closedTradesToday` are measured on. */
  riskDay: string;
  generatedAt: number;
  strategies: StrategySessionStats[];
  totals: StrategySessionStatsTotals;
  notes: string[];
}

export const STRATEGY_SESSION_STATS_NOTES: readonly string[] = [
  'closedTrades counts positions opened AND closed in this engine session; positions hydrated from a prior session are excluded.',
  'winRate and avgTradeUsd are null until the first closed trade — render "—", not 0%.',
  'pnlToday is realized USD on closed trades whose exit falls on riskDay (UTC); it differs from realizedPnlUsd when the session spans midnight UTC.',
  'signalsGenerated is the plugin signal counter mirrored from /api/strategies.stats — it is NOT a trade count.',
];

function toEpochMs(value: Date | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** UTC calendar day for `pnlToday` (matches `riskDay` on the PnL snapshot). */
export function utcRiskDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function normalizeStrategyId(strategy: string | null | undefined): string {
  const trimmed = typeof strategy === 'string' ? strategy.trim() : '';
  return trimmed.length > 0 ? trimmed : UNKNOWN_STRATEGY_ID;
}

interface Bucket {
  closed: StrategyTradeLike[];
  open: number;
}

/**
 * Build the per-strategy session report.
 *
 * @param input.closedTrades Closed trades of the session (`TradeAnalytics.getRecentTrades(Infinity)`).
 * @param input.openTrades Open trades of the session (`TradeAnalytics.getOpenTrades()`).
 * @param input.strategies Registered plugins; every one appears in the output even with zero trades.
 * @param input.session Active session identity from the API runtime state.
 * @param input.engineRunning Whether the engine is running (report is empty-but-honest otherwise).
 * @param input.now Clock for `riskDay` / `generatedAt` (injectable for tests).
 */
export function buildStrategySessionStats(input: {
  closedTrades: readonly StrategyTradeLike[];
  openTrades?: readonly StrategyTradeLike[];
  strategies: readonly StrategyDescriptorLike[];
  session: { sessionId: string | null; sessionStartedAt: number | null; executionMode: ExecutionMode | null };
  engineRunning: boolean;
  now?: number;
}): StrategySessionStatsReport {
  const now = input.now ?? Date.now();
  const riskDay = utcRiskDay(now);

  const buckets = new Map<string, Bucket>();
  const bucketFor = (strategy: string | null | undefined): Bucket => {
    const id = normalizeStrategyId(strategy);
    let bucket = buckets.get(id);
    if (!bucket) {
      bucket = { closed: [], open: 0 };
      buckets.set(id, bucket);
    }
    return bucket;
  };

  for (const trade of input.closedTrades) bucketFor(trade.strategy).closed.push(trade);
  for (const trade of input.openTrades ?? []) bucketFor(trade.strategy).open += 1;

  // Registered strategies first (registry order), then any strategy that only
  // appears on trades (e.g. a plugin unregistered mid-session, or 'unknown').
  const registered = new Map<string, StrategyDescriptorLike>();
  for (const descriptor of input.strategies) registered.set(descriptor.id, descriptor);
  const orderedIds = [
    ...registered.keys(),
    ...[...buckets.keys()].filter((id) => !registered.has(id)).sort(),
  ];

  const strategies: StrategySessionStats[] = orderedIds.map((strategyId) => {
    const descriptor = registered.get(strategyId);
    const bucket = buckets.get(strategyId) ?? { closed: [], open: 0 };

    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let realizedPnlUsd = 0;
    let feesUsd = 0;
    let pnlToday = 0;
    let closedTradesToday = 0;
    let lastTradeAt: number | null = null;

    for (const trade of bucket.closed) {
      const pnl = finiteOrZero(trade.realizedPnl);
      realizedPnlUsd += pnl;
      feesUsd += finiteOrZero(trade.fees);
      if (trade.outcome === 'win') wins += 1;
      else if (trade.outcome === 'loss') losses += 1;
      else breakeven += 1;

      const exitedAt = toEpochMs(trade.exitTime);
      if (exitedAt !== null) {
        if (lastTradeAt === null || exitedAt > lastTradeAt) lastTradeAt = exitedAt;
        if (utcRiskDay(exitedAt) === riskDay) {
          pnlToday += pnl;
          closedTradesToday += 1;
        }
      }
    }

    const closedTrades = bucket.closed.length;
    return {
      strategyId,
      name: descriptor?.name ?? null,
      enabled: descriptor ? Boolean(descriptor.enabled) : null,
      closedTrades,
      openTrades: bucket.open,
      wins,
      losses,
      breakeven,
      winRate: closedTrades > 0 ? wins / closedTrades : null,
      realizedPnlUsd,
      pnlToday,
      closedTradesToday,
      avgTradeUsd: closedTrades > 0 ? realizedPnlUsd / closedTrades : null,
      feesUsd,
      lastTradeAt,
      signalsGenerated:
        typeof descriptor?.signalsGenerated === 'number' && Number.isFinite(descriptor.signalsGenerated)
          ? descriptor.signalsGenerated
          : null,
    };
  });

  const totals = strategies.reduce<StrategySessionStatsTotals>(
    (acc, s) => ({
      closedTrades: acc.closedTrades + s.closedTrades,
      openTrades: acc.openTrades + s.openTrades,
      wins: acc.wins + s.wins,
      losses: acc.losses + s.losses,
      breakeven: acc.breakeven + s.breakeven,
      winRate: null,
      realizedPnlUsd: acc.realizedPnlUsd + s.realizedPnlUsd,
      pnlToday: acc.pnlToday + s.pnlToday,
      feesUsd: acc.feesUsd + s.feesUsd,
    }),
    { closedTrades: 0, openTrades: 0, wins: 0, losses: 0, breakeven: 0, winRate: null, realizedPnlUsd: 0, pnlToday: 0, feesUsd: 0 },
  );
  totals.winRate = totals.closedTrades > 0 ? totals.wins / totals.closedTrades : null;

  return {
    sessionId: input.session.sessionId,
    sessionStartedAt: input.session.sessionStartedAt,
    executionMode: input.session.executionMode,
    engineRunning: input.engineRunning,
    riskDay,
    generatedAt: now,
    strategies,
    totals,
    notes: [...STRATEGY_SESSION_STATS_NOTES],
  };
}
