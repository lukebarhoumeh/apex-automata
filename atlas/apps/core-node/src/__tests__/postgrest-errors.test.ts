/**
 * Classifiers behind the schema-tolerant persistence paths. The
 * execution_mode fallback (risk-engine / risk-state) depends on telling
 * "execution_mode is missing" apart from any other missing column, and on
 * recognising 42P10 as "the uniqueness key moved".
 */
import { describe, test, expect } from 'vitest';
import {
  isMissingColumnError,
  isMissingTableError,
  isOnConflictTargetError,
} from '../core/postgrest-errors';
import { ExecutionModeScope } from '../trading/risk/execution-mode-scope';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any;

describe('postgrest-errors', () => {
  test('isMissingColumnError: Postgres 42703 and PostgREST PGRST204 both count', () => {
    expect(isMissingColumnError({ code: '42703', message: 'column risk_metrics.execution_mode does not exist' })).toBe(true);
    expect(isMissingColumnError({ code: 'PGRST204', message: "Could not find the 'execution_mode' column of 'risk_metrics' in the schema cache" })).toBe(true);
    expect(isMissingColumnError({ message: 'column "active" of relation "risk_events" does not exist' })).toBe(true);
    expect(isMissingColumnError({ code: '500', message: 'boom' })).toBe(false);
    expect(isMissingColumnError(null)).toBe(false);
    expect(isMissingColumnError(undefined)).toBe(false);
  });

  test('isMissingColumnError with a column name only matches that column', () => {
    const activeMissing = { code: 'PGRST204', message: "Could not find the 'active' column of 'risk_events' in the schema cache" };
    const modeMissing = { code: '42703', message: 'column risk_events.execution_mode does not exist' };
    expect(isMissingColumnError(activeMissing, 'execution_mode')).toBe(false);
    expect(isMissingColumnError(activeMissing, 'active')).toBe(true);
    expect(isMissingColumnError(modeMissing, 'execution_mode')).toBe(true);
    expect(isMissingColumnError(modeMissing, 'active')).toBe(false);
  });

  test('isMissingTableError', () => {
    expect(isMissingTableError({ code: 'PGRST205' })).toBe(true);
    expect(isMissingTableError({ code: '42P01' })).toBe(true);
    expect(isMissingTableError({ code: '42703' })).toBe(false);
    expect(isMissingTableError(null)).toBe(false);
  });

  test('isOnConflictTargetError recognises 42P10 by code or message', () => {
    expect(isOnConflictTargetError({ code: '42P10', message: '' })).toBe(true);
    expect(isOnConflictTargetError({ message: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' })).toBe(true);
    expect(isOnConflictTargetError({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false);
    expect(isOnConflictTargetError(null)).toBe(false);
  });
});

describe('ExecutionModeScope', () => {
  test('normalises the mode and starts with every table mode-aware', () => {
    const scope = new ExecutionModeScope('live', logger);
    expect(scope.mode).toBe('live');
    expect(scope.isLegacy('risk_metrics')).toBe(false);
    expect(scope.isLegacy('risk_events')).toBe(false);
  });

  test('noteSchemaError latches only on execution_mode / ON CONFLICT schema errors', () => {
    const scope = new ExecutionModeScope('paper', logger);
    expect(scope.noteSchemaError('risk_metrics', { code: '500', message: 'boom' }, 'upsert')).toBe(false);
    expect(scope.isLegacy('risk_metrics')).toBe(false);
    // An unrelated missing column (risk_events.active) must NOT latch the mode fallback.
    expect(scope.noteSchemaError('risk_events', { code: 'PGRST204', message: "Could not find the 'active' column of 'risk_events' in the schema cache" }, 'update')).toBe(false);
    expect(scope.isLegacy('risk_events')).toBe(false);

    expect(scope.noteSchemaError('risk_metrics', { code: '42703', message: 'column risk_metrics.execution_mode does not exist' }, 'select')).toBe(true);
    expect(scope.isLegacy('risk_metrics')).toBe(true);
    expect(scope.isLegacy('daily_equity')).toBe(false); // per table
    expect(scope.noteSchemaError('daily_equity', { code: '42P10', message: 'no unique or exclusion constraint matching the ON CONFLICT specification' }, 'upsert')).toBe(true);
    expect(scope.isLegacy('daily_equity')).toBe(true);
  });

  test('noteLegacyConflictError un-latches on 42P10 only', () => {
    const scope = new ExecutionModeScope('paper', logger);
    scope.noteSchemaError('risk_metrics', { code: '42703', message: 'column risk_metrics.execution_mode does not exist' }, 'select');
    expect(scope.noteLegacyConflictError('risk_metrics', { code: '500', message: 'boom' }, 'upsert')).toBe(false);
    expect(scope.isLegacy('risk_metrics')).toBe(true);
    expect(scope.noteLegacyConflictError('risk_metrics', { code: '42P10', message: '' }, 'upsert')).toBe(true);
    expect(scope.isLegacy('risk_metrics')).toBe(false);
  });

  test('query(): scoped → legacy → scoped-once-more, never loops', async () => {
    const scope = new ExecutionModeScope('live', logger);
    const calls: string[] = [];
    const missing = { code: '42703', message: 'column risk_metrics.execution_mode does not exist' };
    const conflict = { code: '42P10', message: 'no unique or exclusion constraint matching the ON CONFLICT specification' };

    // 1. scoped fails with schema error → legacy succeeds
    let r = await scope.query('risk_metrics', 'upsert',
      async () => { calls.push('scoped'); return { error: missing }; },
      async () => { calls.push('legacy'); return { error: null }; });
    expect(r.error).toBeNull();
    expect(calls).toEqual(['scoped', 'legacy']);
    expect(scope.isLegacy('risk_metrics')).toBe(true);

    // 2. latched: legacy directly
    calls.length = 0;
    r = await scope.query('risk_metrics', 'upsert',
      async () => { calls.push('scoped'); return { error: null }; },
      async () => { calls.push('legacy'); return { error: null }; });
    expect(calls).toEqual(['legacy']);

    // 3. latched + legacy 42P10 → scoped retry, un-latched
    calls.length = 0;
    r = await scope.query('risk_metrics', 'upsert',
      async () => { calls.push('scoped'); return { error: null }; },
      async () => { calls.push('legacy'); return { error: conflict }; });
    expect(r.error).toBeNull();
    expect(calls).toEqual(['legacy', 'scoped']);
    expect(scope.isLegacy('risk_metrics')).toBe(false);

    // 4. broken schema: both fail → bounded at 3 attempts, final error surfaced
    calls.length = 0;
    r = await scope.query('risk_metrics', 'upsert',
      async () => { calls.push('scoped'); return { error: conflict }; },
      async () => { calls.push('legacy'); return { error: conflict }; });
    expect(calls).toEqual(['scoped', 'legacy', 'scoped']);
    expect(r.error).toEqual(conflict);

    // 5. non-schema error on the scoped path is returned untouched, no fallback
    calls.length = 0;
    const boom = { code: '500', message: 'boom' };
    r = await scope.query('risk_metrics', 'upsert',
      async () => { calls.push('scoped'); return { error: boom }; },
      async () => { calls.push('legacy'); return { error: null }; });
    expect(calls).toEqual(['scoped']);
    expect(r.error).toEqual(boom);
  });
});
