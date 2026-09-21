/**
 * Card SH-QMAKER-CFM-PAPER-v0, blocker 3 — maker/taker fee_side attribution per fill.
 *
 * Kill bar under test: "unlogged fee_side → VOID". The persistence layer must
 *   1. resolve every liquidity spelling the runtime sees into `maker | taker`;
 *   2. keep an unknown side UNKNOWN (`maker: null`, `fee_side: null`) instead of
 *      the legacy `liquidity === 'M'` boolean that wrote every unknown as taker;
 *   3. carry provenance (`fee_side_source`);
 *   4. still land the row on a schema that predates migration 20260921180000
 *      (fee_side columns stripped + retried once, remembered per table).
 *
 * No Supabase, no network: the writer is injected.
 */
import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resolveFeeSide, resolveFeeSideSource, feeSideToMakerFlag } from '../trading/fee-side';
import { buildFillRow, resolveFillFeeSide, FILL_FEE_SIDE_COLUMNS } from '../persistence/fill-row';
import { writeWithOptionalColumns, stripColumns, isOptionalColumnMissingError } from '../persistence/optional-columns';
import { SessionColumnSupport, writeWithSessionStamp } from '../persistence/session-stamp';

const USER_ID = '00000000-0000-4000-8000-000000000001';

describe('resolveFeeSide — every spelling, one vocabulary', () => {
  it('maps legacy Coinbase, Advanced Trade and adapter spellings', () => {
    expect(resolveFeeSide('M')).toBe('maker');
    expect(resolveFeeSide('T')).toBe('taker');
    expect(resolveFeeSide('MAKER')).toBe('maker');
    expect(resolveFeeSide('TAKER')).toBe('taker');
    expect(resolveFeeSide('maker')).toBe('maker');
    expect(resolveFeeSide(' taker ')).toBe('taker');
  });

  it('returns null for anything that does not unambiguously name a side', () => {
    expect(resolveFeeSide('UNKNOWN_LIQUIDITY_INDICATOR')).toBeNull();
    expect(resolveFeeSide('')).toBeNull();
    expect(resolveFeeSide(undefined)).toBeNull();
    expect(resolveFeeSide(null)).toBeNull();
    expect(resolveFeeSide(1)).toBeNull();
    expect(resolveFeeSide('X')).toBeNull();
  });

  it('feeSideToMakerFlag is tri-state', () => {
    expect(feeSideToMakerFlag('maker')).toBe(true);
    expect(feeSideToMakerFlag('taker')).toBe(false);
    expect(feeSideToMakerFlag(null)).toBeNull();
  });

  it('resolveFeeSideSource only admits the three known provenances', () => {
    expect(resolveFeeSideSource('exchange')).toBe('exchange');
    expect(resolveFeeSideSource('Simulated')).toBe('simulated');
    expect(resolveFeeSideSource('inferred')).toBe('inferred');
    expect(resolveFeeSideSource('guess')).toBeNull();
    expect(resolveFeeSideSource(undefined)).toBeNull();
  });
});

describe('resolveFillFeeSide — explicit fee_side wins, legacy liquidity is exchange-reported', () => {
  it('paper simulator fill: explicit fee_side + simulated provenance', () => {
    expect(resolveFillFeeSide({ liquidity: 'M', fee_side: 'maker', fee_side_source: 'simulated' })).toEqual({
      feeSide: 'maker',
      source: 'simulated',
    });
  });

  it('explicit fee_side overrides a contradictory legacy flag', () => {
    expect(resolveFillFeeSide({ liquidity: 'M', fee_side: 'taker', fee_side_source: 'simulated' })).toEqual({
      feeSide: 'taker',
      source: 'simulated',
    });
  });

  it('legacy Coinbase fill (liquidity only) is attributed to the exchange', () => {
    expect(resolveFillFeeSide({ liquidity: 'T' })).toEqual({ feeSide: 'taker', source: 'exchange' });
    expect(resolveFillFeeSide({ liquidity: 'M' })).toEqual({ feeSide: 'maker', source: 'exchange' });
  });

  it('unknown side → null side AND null source (no provenance for nothing)', () => {
    expect(resolveFillFeeSide({})).toEqual({ feeSide: null, source: null });
    expect(resolveFillFeeSide({ liquidity: 'UNKNOWN_LIQUIDITY_INDICATOR', fee_side_source: 'exchange' })).toEqual({
      feeSide: null,
      source: null,
    });
  });
});

describe('buildFillRow — tri-state maker + explicit columns', () => {
  const order = { id: randomUUID(), exchangeOrderId: 'paper-abc' };
  const base = { price: '77715', size: '0.1', fee: '8.7715', created_at: '2026-09-21T17:00:00.000Z', trade_id: 7 };

  it('simulated maker fill', () => {
    const row = buildFillRow({ userId: USER_ID, order, fill: { ...base, liquidity: 'M', fee_side: 'maker', fee_side_source: 'simulated' } });
    expect(row.maker).toBe(true);
    expect(row.fee_side).toBe('maker');
    expect(row.fee_side_source).toBe('simulated');
  });

  it('simulated taker fill (a crossing limit is a taker — the card VOIDs it, so it must be visible)', () => {
    const row = buildFillRow({ userId: USER_ID, order, fill: { ...base, liquidity: 'T', fee_side: 'taker', fee_side_source: 'simulated' } });
    expect(row.maker).toBe(false);
    expect(row.fee_side).toBe('taker');
  });

  it('unlogged side → maker null, fee_side null, fee_side_source null', () => {
    const row = buildFillRow({ userId: USER_ID, order, fill: { ...base } });
    expect(row.maker).toBeNull();
    expect(row.fee_side).toBeNull();
    expect(row.fee_side_source).toBeNull();
  });

  it('FILL_FEE_SIDE_COLUMNS names exactly the two migration-pending columns', () => {
    expect([...FILL_FEE_SIDE_COLUMNS]).toEqual(['fee_side', 'fee_side_source']);
  });
});

// ----------------------------------------------------------------------------
// Schema tolerance: fee_side columns missing on the deployed schema.
// ----------------------------------------------------------------------------

function pgrst204(column: string) {
  return { code: 'PGRST204', message: `Could not find the '${column}' column of 'fills' in the schema cache` };
}

describe('writeWithOptionalColumns — fee_side fallback', () => {
  const row = { user_id: USER_ID, order_id: 'o1', trade_id: 't1', maker: true, fee_side: 'maker', fee_side_source: 'simulated' };

  it('sends the full row when the schema has the columns', async () => {
    const support = new SessionColumnSupport();
    const write = vi.fn(async () => ({ error: null }));
    const result = await writeWithOptionalColumns({ table: 'fills', row, columns: FILL_FEE_SIDE_COLUMNS, support, write });
    expect(result).toEqual({ error: null, withOptional: true, fellBack: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).toHaveProperty('fee_side', 'maker');
    expect(support.getState('fills')).toBe('present');
  });

  it('strips fee_side/fee_side_source and retries once on PGRST204 for one of them; remembers the table', async () => {
    const support = new SessionColumnSupport({ reprobeMs: 60_000, now: () => 1_000 });
    const logger = { warn: vi.fn() };
    const write = vi
      .fn()
      .mockResolvedValueOnce({ error: pgrst204('fee_side') })
      .mockResolvedValue({ error: null });

    const result = await writeWithOptionalColumns({
      table: 'fills',
      row,
      columns: FILL_FEE_SIDE_COLUMNS,
      support,
      write,
      logger,
      migrationHint: '20260921180000',
    });

    expect(result).toEqual({ error: null, withOptional: false, fellBack: true });
    expect(write).toHaveBeenCalledTimes(2);
    const retried = write.mock.calls[1][0] as Record<string, unknown>;
    expect(retried).not.toHaveProperty('fee_side');
    expect(retried).not.toHaveProperty('fee_side_source');
    expect(retried).toHaveProperty('maker', true); // tri-state maker still lands pre-migration
    expect(support.getState('fills')).toBe('missing');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/20260921180000/);

    // Next write inside the re-probe window skips straight to the legacy shape (one call, no warn).
    write.mockClear();
    const second = await writeWithOptionalColumns({ table: 'fills', row, columns: FILL_FEE_SIDE_COLUMNS, support, write, logger });
    expect(second).toEqual({ error: null, withOptional: false, fellBack: false });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0]).not.toHaveProperty('fee_side');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT mask an unrelated missing column as "migration pending"', async () => {
    const support = new SessionColumnSupport();
    const write = vi.fn(async () => ({ error: pgrst204('slippage_bps') }));
    const result = await writeWithOptionalColumns({ table: 'fills', row, columns: FILL_FEE_SIDE_COLUMNS, support, write });
    expect(result.error).toEqual(pgrst204('slippage_bps'));
    expect(result.fellBack).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(support.getState('fills')).toBe('unknown');
  });

  it('helpers: stripColumns leaves the source untouched; isOptionalColumnMissingError is column-scoped', () => {
    const stripped = stripColumns(row, FILL_FEE_SIDE_COLUMNS);
    expect(stripped).toEqual({ user_id: USER_ID, order_id: 'o1', trade_id: 't1', maker: true });
    expect(row).toHaveProperty('fee_side');
    expect(isOptionalColumnMissingError(pgrst204('fee_side_source'), FILL_FEE_SIDE_COLUMNS)).toBe(true);
    expect(isOptionalColumnMissingError({ code: '42703', message: 'column fills.fee_side does not exist' }, FILL_FEE_SIDE_COLUMNS)).toBe(true);
    expect(isOptionalColumnMissingError(pgrst204('session_id'), FILL_FEE_SIDE_COLUMNS)).toBe(false);
    expect(isOptionalColumnMissingError(null, FILL_FEE_SIDE_COLUMNS)).toBe(false);
  });

  it('composes under the session-stamp writer exactly as server.ts wires it: both fallbacks fire independently', async () => {
    // Schema has NEITHER the session columns NOR the fee_side columns.
    const sessionSupport = new SessionColumnSupport();
    const feeSupport = new SessionColumnSupport();
    const upsert = vi.fn(async (shape: Record<string, unknown>) => {
      if ('session_id' in shape) return { error: pgrst204('session_id') };
      if ('fee_side' in shape) return { error: pgrst204('fee_side') };
      return { error: null };
    });

    const result = await writeWithSessionStamp({
      table: 'fills',
      row,
      stamp: { sessionId: 'sess_1', executionMode: 'paper' },
      support: sessionSupport,
      write: async (payload) => {
        const { error } = await writeWithOptionalColumns({
          table: 'fills',
          row: payload,
          columns: FILL_FEE_SIDE_COLUMNS,
          support: feeSupport,
          write: upsert,
        });
        return { error };
      },
    });

    expect(result.error).toBeNull();
    expect(result.fellBack).toBe(true);
    const landed = upsert.mock.calls.at(-1)![0];
    expect(landed).not.toHaveProperty('session_id');
    expect(landed).not.toHaveProperty('fee_side');
    expect(landed).toHaveProperty('maker', true);
    expect(sessionSupport.getState('fills')).toBe('missing');
    expect(feeSupport.getState('fills')).toBe('missing');
  });
});
