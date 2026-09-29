/**
 * Finding 7 (docs/research/2026-09-28_paper-persistence-verification.md §2):
 * `syncPositionToSupabase` wrote `strategy: position.strategy || 'breakout'`
 * raw. A context-less position was labelled with a KILLED strategy and any
 * string outside the `strategy_name` enum would fail every write for that
 * position with 22P02 — including the close, leaving the row open forever.
 *
 * Pins for the shared mapping (`persistence/strategy-name.ts`), used by both
 * the orders path (`normalizeStrategy`) and the positions path:
 *   - enum values pass through, case-insensitively;
 *   - the legacy display name VWAPMeanReversion → vwap_mr;
 *   - empty / non-string → `system`, flagged `empty` (not an audit event);
 *   - unknown ids → `system`, flagged `unknown` (worth an audit log line);
 *   - `donchian_daily_s3` IS an enum value since migration
 *     20260929120000_add_donchian_daily_s3_to_strategy_name_enum.sql (staged
 *     2026-09-29) and survives normalisation; a database that has not applied
 *     the migration yet is handled at write time by
 *     persistence/strategy-enum-fallback.ts (22P02 → `system`, warned once);
 *   - the fallback is never a real strategy, in particular never `breakout`.
 */
import { describe, expect, it } from 'vitest';
import {
  resolvePositionStrategy,
  resolveStrategyName,
  STRATEGY_NAME_ENUM_VALUES,
  STRATEGY_NAME_FALLBACK,
} from '../persistence/strategy-name';

describe('resolveStrategyName — strategy_name enum normalisation', () => {
  it('passes every enum value through unchanged', () => {
    for (const value of STRATEGY_NAME_ENUM_VALUES) {
      expect(resolveStrategyName(value)).toEqual({ value, empty: false, unknown: false, received: value });
    }
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(resolveStrategyName('Trend_Follow').value).toBe('trend_follow');
    expect(resolveStrategyName('  momentum  ').value).toBe('momentum');
    expect(resolveStrategyName('SYSTEM').value).toBe('system');
  });

  it('maps the legacy display name VWAPMeanReversion onto vwap_mr (orders-path parity)', () => {
    const resolved = resolveStrategyName('VWAPMeanReversion');
    expect(resolved.value).toBe('vwap_mr');
    expect(resolved.unknown).toBe(false);
  });

  it('empty / non-string input defaults to system and is flagged empty, not unknown', () => {
    for (const received of [undefined, null, '', '   ', 42, {}, [], true]) {
      const resolved = resolveStrategyName(received);
      expect(resolved.value).toBe('system');
      expect(resolved.empty).toBe(true);
      expect(resolved.unknown).toBe(false);
      expect(resolved.received).toBe(received);
    }
  });

  it('an unknown strategy id normalises to system and is flagged unknown (auditable)', () => {
    const resolved = resolveStrategyName('this_is_a_made_up_strategy');
    expect(resolved).toEqual({ value: 'system', empty: false, unknown: true, received: 'this_is_a_made_up_strategy' });
  });

  it('donchian_daily_s3 is an enum value (migration 20260929120000) and survives normalisation', () => {
    const resolved = resolveStrategyName('donchian_daily_s3');
    expect(resolved).toEqual({ value: 'donchian_daily_s3', empty: false, unknown: false, received: 'donchian_daily_s3' });
    // Guard: the list and the ALTER TYPE migration move together. A database
    // that has not applied the migration yet is covered by the 22P02 write
    // fallback (strategy-enum-fallback.test.ts), never by dropping the id here.
    expect(STRATEGY_NAME_ENUM_VALUES).toContain('donchian_daily_s3');
    expect(STRATEGY_NAME_ENUM_VALUES[STRATEGY_NAME_ENUM_VALUES.length - 1]).toBe('donchian_daily_s3');
  });

  it('the fallback is the neutral system tag — never a killed or real strategy', () => {
    expect(STRATEGY_NAME_FALLBACK).toBe('system');
    for (const garbage of ['xyz', undefined, null, 'breakout_v2', 'Donchian', {}]) {
      const { value } = resolveStrategyName(garbage);
      expect(value).not.toBe('breakout');
      expect(value).not.toBe('vwap_mr');
      expect(value).not.toBe('momentum');
      expect(value).not.toBe('trend_follow');
    }
  });

  it('a legacy-tagged breakout row still normalises to breakout (pass-through, not the fallback)', () => {
    expect(resolveStrategyName('breakout')).toMatchObject({ value: 'breakout', unknown: false });
  });
});

describe('resolvePositionStrategy — positions.strategy for a tracker Position', () => {
  it('a context-less position (no strategy) is labelled system, never breakout', () => {
    expect(resolvePositionStrategy({}).value).toBe('system');
    expect(resolvePositionStrategy({ strategy: undefined }).value).toBe('system');
    expect(resolvePositionStrategy(null).value).toBe('system');
    expect(resolvePositionStrategy(undefined).value).toBe('system');
  });

  it('a trend_follow position keeps its label', () => {
    expect(resolvePositionStrategy({ strategy: 'trend_follow' })).toMatchObject({ value: 'trend_follow', unknown: false, empty: false });
  });

  it('a donchian_daily_s3 position keeps its label (enum value since 20260929120000)', () => {
    expect(resolvePositionStrategy({ strategy: 'donchian_daily_s3' })).toMatchObject({ value: 'donchian_daily_s3', unknown: false, empty: false });
  });

  it('an unknown label on a position becomes system and is flagged for the audit log', () => {
    expect(resolvePositionStrategy({ strategy: 'Trend Following (display name)' })).toMatchObject({ value: 'system', unknown: true });
    expect(resolvePositionStrategy({ strategy: 'donchian_daily_s4' })).toMatchObject({ value: 'system', unknown: true });
  });
});
