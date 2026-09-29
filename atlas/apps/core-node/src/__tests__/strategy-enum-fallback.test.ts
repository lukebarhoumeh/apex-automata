/**
 * `strategy_name` enum write fallback (persistence/strategy-enum-fallback.ts).
 *
 * The runtime is deployed independently of Supabase migrations. Since
 * `donchian_daily_s3` joined `STRATEGY_NAME_ENUM_VALUES` (migration
 * 20260929120000, staged), a runtime that normalises the id onto itself would
 * fail every orders / positions / signals write for it with
 *
 *     22P02  invalid input value for enum strategy_name: "donchian_daily_s3"
 *
 * on a database that has not applied the migration yet — for positions that
 * includes the CLOSE write. Pins:
 *   - a 22P02 naming the enum value retries ONCE with `strategy = system`,
 *     warns ONCE per process (per value) and remembers the value as missing so
 *     later writes go straight to `system`;
 *   - the memory expires (re-probe) so applying the migration under a running
 *     process is picked up — and the first accepted write is logged;
 *   - a row already tagged `system` never pays the round-trip;
 *   - any other error (RLS, unrelated 22P02 such as a bad uuid, an enum error
 *     for a different value) is surfaced untouched, never masked.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_STRATEGY_ENUM_REPROBE_MS,
  STRATEGY_ENUM_MIGRATION_HINT,
  StrategyEnumValueSupport,
  isStrategyEnumValueError,
  writeWithStrategyEnumFallback,
} from '../persistence/strategy-enum-fallback';
import { STRATEGY_NAME_FALLBACK } from '../persistence/strategy-name';

const ENUM_MISSING_DONCHIAN = {
  code: '22P02',
  message: 'invalid input value for enum strategy_name: "donchian_daily_s3"',
};
const ENUM_MISSING_QUALIFIED = {
  code: '22P02',
  message: 'invalid input value for enum public.strategy_name: "donchian_daily_s3"',
};
const ENUM_MISSING_OTHER_VALUE = {
  code: '22P02',
  message: 'invalid input value for enum strategy_name: "obi_scalper_v2"',
};
const BAD_UUID = { code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' };
const OTHER_ENUM = { code: '22P02', message: 'invalid input value for enum position_side: "flat"' };
const RLS_DENIED = { code: '42501', message: 'new row violates row-level security policy' };

const makeLogger = () => ({ warn: vi.fn(), info: vi.fn() });

describe('isStrategyEnumValueError', () => {
  it('recognises the Postgres 22P02 for strategy_name, schema-qualified or not', () => {
    expect(isStrategyEnumValueError(ENUM_MISSING_DONCHIAN)).toBe(true);
    expect(isStrategyEnumValueError(ENUM_MISSING_QUALIFIED)).toBe(true);
    expect(isStrategyEnumValueError(ENUM_MISSING_DONCHIAN, 'donchian_daily_s3')).toBe(true);
    expect(isStrategyEnumValueError(ENUM_MISSING_QUALIFIED, 'donchian_daily_s3')).toBe(true);
  });

  it('matches on the message when the code is absent (PostgREST proxies vary)', () => {
    expect(isStrategyEnumValueError({ message: ENUM_MISSING_DONCHIAN.message }, 'donchian_daily_s3')).toBe(true);
  });

  it('does not match a 22P02 for anything but the strategy_name enum', () => {
    expect(isStrategyEnumValueError(BAD_UUID)).toBe(false);
    expect(isStrategyEnumValueError(OTHER_ENUM)).toBe(false);
    expect(isStrategyEnumValueError(RLS_DENIED)).toBe(false);
    expect(isStrategyEnumValueError(null)).toBe(false);
    expect(isStrategyEnumValueError(undefined)).toBe(false);
  });

  it('when a value is given, the message must name that exact value', () => {
    expect(isStrategyEnumValueError(ENUM_MISSING_OTHER_VALUE, 'donchian_daily_s3')).toBe(false);
    expect(isStrategyEnumValueError(ENUM_MISSING_DONCHIAN, 'donchian_daily_s')).toBe(false);
    expect(isStrategyEnumValueError(ENUM_MISSING_DONCHIAN, 'system')).toBe(false);
  });
});

describe('StrategyEnumValueSupport', () => {
  it('sends a value until it is marked missing, then re-probes after the window', () => {
    let now = 1_000;
    const support = new StrategyEnumValueSupport({ reprobeMs: 500, now: () => now });
    expect(support.getState('donchian_daily_s3')).toBe('unknown');
    expect(support.shouldSend('donchian_daily_s3')).toBe(true);

    support.markMissing('donchian_daily_s3');
    expect(support.getState('donchian_daily_s3')).toBe('missing');
    expect(support.shouldSend('donchian_daily_s3')).toBe(false);
    expect(support.shouldSend('trend_follow')).toBe(true);

    now = 1_499;
    expect(support.shouldSend('donchian_daily_s3')).toBe(false);
    now = 1_500;
    expect(support.shouldSend('donchian_daily_s3')).toBe(true);

    support.markPresent('donchian_daily_s3');
    expect(support.getState('donchian_daily_s3')).toBe('present');
    expect(support.shouldSend('donchian_daily_s3')).toBe(true);
    expect(support.snapshot()).toEqual({ donchian_daily_s3: 'present' });
  });

  it('defaults to the same 5-minute re-probe window as the session-stamp memory', () => {
    expect(DEFAULT_STRATEGY_ENUM_REPROBE_MS).toBe(5 * 60_000);
  });
});

describe('writeWithStrategyEnumFallback', () => {
  const row = { id: 'sig-1', symbol: 'BTC-USD', strategy: 'donchian_daily_s3', side: 'long' };

  it('writes the row as-is when the enum accepts the value and marks it present', async () => {
    const support = new StrategyEnumValueSupport();
    const write = vi.fn().mockResolvedValue({ error: null });
    const logger = makeLogger();
    const result = await writeWithStrategyEnumFallback({ table: 'signals', row, support, write, logger });
    expect(result).toEqual({ error: null, strategy: 'donchian_daily_s3', fellBack: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(row);
    expect(support.getState('donchian_daily_s3')).toBe('present');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('on 22P02 for the value: retries once as system, warns once, remembers the value as missing', async () => {
    const support = new StrategyEnumValueSupport();
    const write = vi.fn().mockResolvedValueOnce({ error: ENUM_MISSING_DONCHIAN }).mockResolvedValueOnce({ error: null });
    const logger = makeLogger();
    const result = await writeWithStrategyEnumFallback({ table: 'signals', row, support, write, logger });

    expect(result).toEqual({ error: null, strategy: STRATEGY_NAME_FALLBACK, fellBack: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenNthCalledWith(1, row);
    expect(write).toHaveBeenNthCalledWith(2, { ...row, strategy: 'system' });
    expect(row.strategy).toBe('donchian_daily_s3'); // input untouched
    expect(support.getState('donchian_daily_s3')).toBe('missing');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.warn.mock.calls[0];
    expect(message).toContain('signals');
    expect(message).toContain('donchian_daily_s3');
    expect(message).toContain(STRATEGY_ENUM_MIGRATION_HINT);
    expect(meta).toMatchObject({ table: 'signals', strategy: 'donchian_daily_s3', fallback: 'system', code: '22P02' });
  });

  it('later writes for a missing value go straight to system without the failing round-trip or a second warn', async () => {
    const support = new StrategyEnumValueSupport();
    const logger = makeLogger();
    const first = vi.fn().mockResolvedValueOnce({ error: ENUM_MISSING_DONCHIAN }).mockResolvedValueOnce({ error: null });
    await writeWithStrategyEnumFallback({ table: 'orders', row, support, write: first, logger });

    const second = vi.fn().mockResolvedValue({ error: null });
    const result = await writeWithStrategyEnumFallback({ table: 'positions', row: { ...row, id: 'pos-1' }, support, write: second, logger });
    expect(result).toEqual({ error: null, strategy: 'system', fellBack: true });
    expect(second).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledWith({ ...row, id: 'pos-1', strategy: 'system' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('re-probes after the window; an accepted write flips the value to present and is logged once', async () => {
    let now = 0;
    const support = new StrategyEnumValueSupport({ reprobeMs: 1_000, now: () => now });
    const logger = makeLogger();
    const write = vi
      .fn()
      .mockResolvedValueOnce({ error: ENUM_MISSING_DONCHIAN }) // t=0 probe
      .mockResolvedValueOnce({ error: null }) // t=0 fallback
      .mockResolvedValueOnce({ error: ENUM_MISSING_DONCHIAN }) // t=1000 re-probe, still missing
      .mockResolvedValueOnce({ error: null }) // t=1000 fallback
      .mockResolvedValueOnce({ error: null }); // t=2000 re-probe, migration applied

    await writeWithStrategyEnumFallback({ table: 'signals', row, support, write, logger });
    now = 1_000;
    const again = await writeWithStrategyEnumFallback({ table: 'signals', row, support, write, logger });
    expect(again).toEqual({ error: null, strategy: 'system', fellBack: true });
    expect(logger.warn).toHaveBeenCalledTimes(1); // the re-probe miss does not warn again

    now = 2_000;
    const accepted = await writeWithStrategyEnumFallback({ table: 'signals', row, support, write, logger });
    expect(accepted).toEqual({ error: null, strategy: 'donchian_daily_s3', fellBack: false });
    expect(support.getState('donchian_daily_s3')).toBe('present');
    expect(write).toHaveBeenCalledTimes(5);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toContain('donchian_daily_s3');
  });

  it('a row already tagged system is written once, never retried', async () => {
    const support = new StrategyEnumValueSupport();
    const write = vi.fn().mockResolvedValue({ error: RLS_DENIED });
    const result = await writeWithStrategyEnumFallback({ table: 'orders', row: { ...row, strategy: 'system' }, support, write });
    expect(result).toEqual({ error: RLS_DENIED, strategy: 'system', fellBack: false });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a row without a strategy key is passed through untouched', async () => {
    const support = new StrategyEnumValueSupport();
    const write = vi.fn().mockResolvedValue({ error: null });
    const bare = { id: 'f-1', symbol: 'ETH-USD' };
    const result = await writeWithStrategyEnumFallback({ table: 'fills', row: bare, support, write });
    expect(result).toEqual({ error: null, strategy: 'system', fellBack: false });
    expect(write).toHaveBeenCalledWith(bare);
  });

  it('surfaces unrelated errors untouched: RLS, a bad uuid 22P02, another enum, another enum value', async () => {
    for (const error of [RLS_DENIED, BAD_UUID, OTHER_ENUM, ENUM_MISSING_OTHER_VALUE]) {
      const support = new StrategyEnumValueSupport();
      const write = vi.fn().mockResolvedValue({ error });
      const logger = makeLogger();
      const result = await writeWithStrategyEnumFallback({ table: 'signals', row, support, write, logger });
      expect(result).toEqual({ error, strategy: 'donchian_daily_s3', fellBack: false });
      expect(write).toHaveBeenCalledTimes(1);
      expect(support.getState('donchian_daily_s3')).toBe('unknown');
      expect(logger.warn).not.toHaveBeenCalled();
    }
  });

  it('the fallback write error is returned when even the system shape fails', async () => {
    const support = new StrategyEnumValueSupport();
    const write = vi.fn().mockResolvedValueOnce({ error: ENUM_MISSING_DONCHIAN }).mockResolvedValueOnce({ error: RLS_DENIED });
    const result = await writeWithStrategyEnumFallback({ table: 'positions', row, support, write, logger: makeLogger() });
    expect(result).toEqual({ error: RLS_DENIED, strategy: 'system', fellBack: true });
  });

  it('works without a logger', async () => {
    const support = new StrategyEnumValueSupport();
    const write = vi.fn().mockResolvedValueOnce({ error: ENUM_MISSING_DONCHIAN }).mockResolvedValueOnce({ error: null });
    await expect(writeWithStrategyEnumFallback({ table: 'orders', row, support, write })).resolves.toEqual({
      error: null,
      strategy: 'system',
      fellBack: true,
    });
  });
});
