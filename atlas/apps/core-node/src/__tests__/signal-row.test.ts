/**
 * `public.signals` row mapping (persistence/signal-row.ts).
 *
 * Finding 7 follow-up (docs/research/2026-09-28_paper-persistence-verification.md
 * §2, "signals.strategy is still written raw — open item"): `syncSignalToSupabase`
 * used to write `strategy: signal.strategy` straight into the `strategy_name`
 * enum column, so a strategy id outside the enum failed the INSERT with 22P02
 * and the signal never reached the desk's funnel. Pins:
 *   - `strategy` goes through the shared `resolveStrategyName` mapping
 *     (enum pass-through, alias, `system` fallback), exactly like orders and
 *     positions;
 *   - `donchian_daily_s3` (enum value since 20260929120000) survives;
 *   - the resolution is returned so the caller can warn on an unknown id;
 *   - every other column keeps the shape the pre-extraction inline writer
 *     produced (id only when a v4 uuid, side mapping, score / confidence
 *     defaults, allowed default true, reason fallback to metadata.reason).
 */

import { describe, expect, it } from 'vitest';
import { buildSignalRow } from '../persistence/signal-row';

const USER_ID = '0a7c2d5e-1111-4222-8333-444455556666';
const SIGNAL_ID = '9f1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';
const NOW = new Date('2026-09-29T14:00:00.000Z');

const baseSignal = () => ({
  id: SIGNAL_ID,
  symbol: 'BTC-USD',
  strategy: 'trend_follow',
  timestamp: new Date('2026-09-29T13:59:58.000Z'),
  direction: 'buy',
  strength: 0.72,
  confidence: 0.61,
  metadata: { reason: 'Bullish EMA crossover (12/15) with price confirmation', regime: 'trending' },
});

describe('buildSignalRow — strategy_name normalisation', () => {
  it('a donchian_daily_s3 signal keeps its id (enum value since 20260929120000)', () => {
    const { row, strategy } = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), strategy: 'donchian_daily_s3' }, now: NOW });
    expect(row.strategy).toBe('donchian_daily_s3');
    expect(strategy).toEqual({ value: 'donchian_daily_s3', empty: false, unknown: false, received: 'donchian_daily_s3' });
  });

  it('an id the enum does not know is normalised to system and flagged unknown — never written raw', () => {
    const { row, strategy } = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), strategy: 'made_up_strategy' }, now: NOW });
    expect(row.strategy).toBe('system');
    expect(strategy).toMatchObject({ value: 'system', unknown: true, received: 'made_up_strategy' });
  });

  it('a legacy display name maps onto its enum value (orders-path parity)', () => {
    const { row, strategy } = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), strategy: 'VWAPMeanReversion' }, now: NOW });
    expect(row.strategy).toBe('vwap_mr');
    expect(strategy.unknown).toBe(false);
  });

  it('a signal without a strategy is system, flagged empty', () => {
    const { row, strategy } = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), strategy: undefined }, now: NOW });
    expect(row.strategy).toBe('system');
    expect(strategy).toMatchObject({ value: 'system', empty: true, unknown: false });
  });

  it('is case-insensitive like the other writers', () => {
    expect(buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), strategy: 'Trend_Follow' }, now: NOW }).row.strategy).toBe('trend_follow');
  });
});

describe('buildSignalRow — the pre-routing INSERT shape', () => {
  it('maps the engine signal onto the signals row exactly as the inline writer did', () => {
    const { row } = buildSignalRow({ userId: USER_ID, signal: baseSignal(), now: NOW });
    expect(row).toEqual({
      id: SIGNAL_ID,
      user_id: USER_ID,
      symbol: 'BTC-USD',
      strategy: 'trend_follow',
      decided_at: '2026-09-29T13:59:58.000Z',
      side: 'long',
      score: 0.72,
      confidence: 0.61,
      meta_prob: null,
      features: { reason: 'Bullish EMA crossover (12/15) with price confirmation', regime: 'trending' },
      allowed: true,
      reason: 'Bullish EMA crossover (12/15) with price confirmation',
      created_at: '2026-09-29T14:00:00.000Z',
    });
  });

  it('omits id unless it is a v4 uuid (Postgres generates one)', () => {
    expect(buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), id: 'sig_123' }, now: NOW }).row).not.toHaveProperty('id');
    expect(buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), id: undefined }, now: NOW }).row).not.toHaveProperty('id');
    expect(buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), id: 42 }, now: NOW }).row).not.toHaveProperty('id');
  });

  it('maps direction buy/sell onto position_side, accepts long/short, else null', () => {
    const at = (patch: Record<string, unknown>) => buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), direction: undefined, ...patch }, now: NOW }).row.side;
    expect(at({ direction: 'buy' })).toBe('long');
    expect(at({ direction: 'sell' })).toBe('short');
    expect(at({ side: 'long' })).toBe('long');
    expect(at({ side: 'short' })).toBe('short');
    expect(at({ side: 'buy' })).toBe('long');
    expect(at({ side: 'flat' })).toBeNull();
    expect(at({})).toBeNull();
  });

  it('decided_at accepts a Date, an ISO string, a number, or defaults to now', () => {
    const at = (timestamp: unknown) => buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), timestamp }, now: NOW }).row.decided_at;
    expect(at(new Date('2026-09-29T10:00:00.000Z'))).toBe('2026-09-29T10:00:00.000Z');
    expect(at('2026-09-29T11:00:00.000Z')).toBe('2026-09-29T11:00:00.000Z');
    expect(at(Date.UTC(2026, 8, 29, 12))).toBe('2026-09-29T12:00:00.000Z');
    expect(at(undefined)).toBe('2026-09-29T14:00:00.000Z');
  });

  it('score / confidence fall back on each other, then 0; meta_prob is null without a label', () => {
    const { row } = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), strength: undefined, score: 0.4, confidence: undefined }, now: NOW });
    expect(row.score).toBe(0.4);
    expect(row.confidence).toBe(0);
    expect(row.meta_prob).toBeNull();
    const labelled = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), metaLabel: 0.9 }, now: NOW }).row;
    expect(labelled.meta_prob).toBe(0.9);
  });

  it('allowed defaults to true and is only false when the signal says so; reason falls back to metadata.reason then null', () => {
    const blocked = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), allowed: false, reason: 'regime_gate: choppy' }, now: NOW }).row;
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('regime_gate: choppy');
    const bare = buildSignalRow({ userId: USER_ID, signal: { ...baseSignal(), metadata: undefined, features: { x: 1 } }, now: NOW }).row;
    expect(bare.allowed).toBe(true);
    expect(bare.reason).toBeNull();
    expect(bare.features).toEqual({ x: 1 });
  });
});
