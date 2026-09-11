/**
 * Session-scoped per-strategy trade stats — FE PR1 contract #3 (Dashboard cards).
 *
 * `GET /api/strategies` exposes each plugin's `stats.signalsGenerated`, which
 * the dashboard cards were rendering as "trades" — so a strategy that fired
 * four signals and never got filled showed "4 trades" next to a session with
 * zero closed positions. That counter is left alone (and deliberately NOT
 * mirrored here); this module computes the honest trade fields from the
 * session's closed trades only:
 *
 *   strategyId     plugin id (`trend_follow`, `momentum`, `breakout`, `vwap_mr`, …)
 *   closedTrades   positions opened AND closed in this engine session
 *   pnlToday       realized USD on trades that exited on the current UTC day
 *   winRate        wins / closedTrades — `0` when there are no closed trades
 *
 * Shelved / killed strategy ids are listed with zeros so the cards can render
 * every strategy. Served at `GET /api/analytics/strategies` and mirrored as
 * `sessionStats` on each `/api/strategies` entry. Pure: takes plain trade
 * records and strategy descriptors, no engine or Supabase access.
 */

import { toIsoOrNull, type ExecutionMode } from '../runtime/session-context';

/** The slice of `TradeRecord` (trading/trade-analytics.ts) this module reads. */
export interface StrategyTradeLike {
  strategy?: string | null;
  realizedPnl?: number | null;
  fees?: number | null;
  outcome?: 'win' | 'loss' | 'breakeven' | null;
  exitTime?: Date | number | string | null;
}

/** A strategy the report must list (registered plugin or shelved builtin). */
export interface StrategyDescriptorLike {
  id: string;
  name?: string | null;
  /** Registry enabled flag; shelved (unregistered) strategies are `false`. */
  enabled?: boolean | null;
  /** True when the id is in guardrails `disabled_strategies`. */
  disabledByGuardrails?: boolean | null;
}

/** Bucket for trades whose position carried no strategy tag. */
export const UNKNOWN_STRATEGY_ID = 'unknown';

export interface StrategySessionStats {
  /** Plugin id. */
  strategyId: string;
  /** Positions opened and closed within this session. Never `signalsGenerated`. */
  closedTrades: number;
  /** Realized USD across closed trades that exited on `riskDay` (UTC). `0` with no closed trades. */
  pnlToday: number;
  /** wins / closedTrades; `0` with no closed trades. */
  winRate: number;
  // ── optional extras (not required by the FE contract) ──
  name: string | null;
  /** Registry enabled flag; `false` for shelved strategies; `null` when only seen on trades. */
  enabled: boolean | null;
  disabledByGuardrails: boolean;
  /** Positions opened in this session and still open. */
  openTrades: number;
  /** Signals that became positions this session (= openTrades + closedTrades). */
  signalsTaken: number;
  wins: number;
  losses: number;
  breakeven: number;
  /** Realized USD across all closed trades in the session (fees already netted by the tracker). */
  realizedPnl: number;
  closedTradesToday: number;
  /** realizedPnl / closedTrades; `0` with no closed trades. */
  avgTrade: number;
  fees: number;
  /** ISO-8601 UTC of the most recent exit in the session; `null` when none. */
  lastTradeAt: string | null;
}

export interface StrategySessionStatsTotals {
  closedTrades: number;
  openTrades: number;
  signalsTaken: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  realizedPnl: number;
  pnlToday: number;
  fees: number;
}

export interface StrategySessionStatsReport {
  /** Active `trading_sessions.session_id`; `null` when no engine session is open. */
  sessionId: string | null;
  /** ISO-8601 UTC; mirrors `/api/status.sessionStartedAt`. */
  sessionStartedAt: string | null;
  executionMode: ExecutionMode | null;
  engineRunning: boolean;
  /** UTC calendar day (`YYYY-MM-DD`) that `pnlToday` / `closedTradesToday` are measured on. */
  riskDay: string;
  /** ISO-8601 UTC. */
  generatedAt: string;
  strategies: StrategySessionStats[];
  totals: StrategySessionStatsTotals;
  notes: string[];
}

export const STRATEGY_SESSION_STATS_NOTES: readonly string[] = [
  'closedTrades counts positions opened AND closed in this engine session; positions hydrated from a prior session are excluded. It is never the plugin signal counter.',
  'winRate, pnlToday and avgTrade are 0 when the strategy has no closed trades this session.',
  'pnlToday is realized USD on closed trades whose exit falls on riskDay (UTC); it differs from realizedPnl when the session spans midnight UTC.',
  'Shelved strategies (guardrails disabled_strategies) are listed with zeros and disabledByGuardrails=true.',
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
 * @param input.closedTrades Closed trades of the session (`TradeAnalytics.getClosedTrades()`).
 * @param input.openTrades Open trades of the session (`TradeAnalytics.getOpenTrades()`).
 * @param input.strategies Strategies to list (registered plugins + shelved builtins); every one
 *   appears in the output even with zero trades, in the given order.
 * @param input.session Active session identity from the API runtime state (`sessionStartedAt` in epoch ms).
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

  // Listed strategies first (given order), then any strategy that only appears
  // on trades (e.g. a plugin unregistered mid-session, or 'unknown').
  const listed = new Map<string, StrategyDescriptorLike>();
  for (const descriptor of input.strategies) {
    if (!listed.has(descriptor.id)) listed.set(descriptor.id, descriptor);
  }
  const orderedIds = [
    ...listed.keys(),
    ...[...buckets.keys()].filter((id) => !listed.has(id)).sort(),
  ];

  const strategies: StrategySessionStats[] = orderedIds.map((strategyId) => {
    const descriptor = listed.get(strategyId);
    const bucket = buckets.get(strategyId) ?? { closed: [], open: 0 };

    let wins = 0;
    let losses = 0;
    let breakeven = 0;
    let realizedPnl = 0;
    let fees = 0;
    let pnlToday = 0;
    let closedTradesToday = 0;
    let lastTradeAtMs: number | null = null;

    for (const trade of bucket.closed) {
      const pnl = finiteOrZero(trade.realizedPnl);
      realizedPnl += pnl;
      fees += finiteOrZero(trade.fees);
      if (trade.outcome === 'win') wins += 1;
      else if (trade.outcome === 'loss') losses += 1;
      else breakeven += 1;

      const exitedAt = toEpochMs(trade.exitTime);
      if (exitedAt !== null) {
        if (lastTradeAtMs === null || exitedAt > lastTradeAtMs) lastTradeAtMs = exitedAt;
        if (utcRiskDay(exitedAt) === riskDay) {
          pnlToday += pnl;
          closedTradesToday += 1;
        }
      }
    }

    const closedTrades = bucket.closed.length;
    return {
      strategyId,
      closedTrades,
      pnlToday,
      winRate: closedTrades > 0 ? wins / closedTrades : 0,
      name: descriptor?.name ?? null,
      enabled: descriptor ? Boolean(descriptor.enabled) : null,
      disabledByGuardrails: Boolean(descriptor?.disabledByGuardrails),
      openTrades: bucket.open,
      signalsTaken: bucket.open + closedTrades,
      wins,
      losses,
      breakeven,
      realizedPnl,
      closedTradesToday,
      avgTrade: closedTrades > 0 ? realizedPnl / closedTrades : 0,
      fees,
      lastTradeAt: toIsoOrNull(lastTradeAtMs),
    };
  });

  const totals = strategies.reduce<StrategySessionStatsTotals>(
    (acc, s) => ({
      closedTrades: acc.closedTrades + s.closedTrades,
      openTrades: acc.openTrades + s.openTrades,
      signalsTaken: acc.signalsTaken + s.signalsTaken,
      wins: acc.wins + s.wins,
      losses: acc.losses + s.losses,
      breakeven: acc.breakeven + s.breakeven,
      winRate: 0,
      realizedPnl: acc.realizedPnl + s.realizedPnl,
      pnlToday: acc.pnlToday + s.pnlToday,
      fees: acc.fees + s.fees,
    }),
    { closedTrades: 0, openTrades: 0, signalsTaken: 0, wins: 0, losses: 0, breakeven: 0, winRate: 0, realizedPnl: 0, pnlToday: 0, fees: 0 },
  );
  totals.winRate = totals.closedTrades > 0 ? totals.wins / totals.closedTrades : 0;

  return {
    sessionId: input.session.sessionId,
    sessionStartedAt: toIsoOrNull(input.session.sessionStartedAt),
    executionMode: input.session.executionMode,
    engineRunning: input.engineRunning,
    riskDay,
    generatedAt: new Date(now).toISOString(),
    strategies,
    totals,
    notes: [...STRATEGY_SESSION_STATS_NOTES],
  };
}
