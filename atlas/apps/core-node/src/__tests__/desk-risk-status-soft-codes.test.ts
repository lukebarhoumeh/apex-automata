/**
 * Guard: the `public.desk_risk_status` view hard-codes the L1–L5 soft ladder
 * codes in its open-halt predicate (`event_type NOT IN (...)`). That list must
 * stay equal to `LADDER_SOFT_REASON_CODES` (src/trading/risk/paper-kill-ladder.ts),
 * and the rest of the predicate must keep mirroring paper-boot-guard.ts
 * `isOpenHaltRiskEvent()`; otherwise the desk view and the boot guard disagree
 * on "would a paper start be refused".
 *
 * Reads the migration SQL from the repo (no database). The view is taken from
 * the NEWEST migration file that (re)creates it, so a later migration that
 * redefines the view is what gets checked. Review finding 13
 * (docs/research/2026-09-30_pr82-round2-review-findings.md).
 */
import fs from 'fs';
import path from 'path';
import { describe, test, expect } from 'vitest';
import { LADDER_SOFT_REASON_CODES } from '../trading/risk/paper-kill-ladder';
import { isOpenHaltRiskEvent } from '../trading/risk/paper-boot-guard';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'supabase', 'migrations');
/** The migration that defines the view as of PR #82 (applied 2026-09-29). */
const V2_MIGRATION = '20260929010733_desk_status_views_v2.sql';
const CREATE_VIEW_RE = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+public\.desk_risk_status\b/i;

function stripSqlLineComments(sql: string): string {
  return sql
    .split('\n')
    .map((line) => {
      const idx = line.indexOf('--');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

function latestDeskRiskStatusMigration(): { file: string; viewSql: string } {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let found: { file: string; viewSql: string } | null = null;
  for (const file of files) {
    const sql = stripSqlLineComments(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    const match = CREATE_VIEW_RE.exec(sql);
    if (!match) continue;
    const start = match.index;
    const end = sql.indexOf(';', start);
    found = { file, viewSql: sql.slice(start, end === -1 ? undefined : end) };
  }
  if (!found) throw new Error(`no migration in ${MIGRATIONS_DIR} creates public.desk_risk_status`);
  return found;
}

function extractSoftCodes(viewSql: string): string[] {
  const matches = [...viewSql.matchAll(/\bevent_type\s+NOT\s+IN\s*\(([^)]*)\)/gi)];
  expect(matches).toHaveLength(1);
  return matches[0][1]
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const lit = /^'([^']*)'$/.exec(s);
      if (!lit) throw new Error(`non-literal entry in desk_risk_status NOT IN list: ${s}`);
      return lit[1];
    });
}

describe('desk_risk_status view mirrors the paper kill ladder soft codes', () => {
  const { file, viewSql } = latestDeskRiskStatusMigration();

  test('the view is defined by the v2 migration or a later one', () => {
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, V2_MIGRATION))).toBe(true);
    expect(file >= V2_MIGRATION).toBe(true);
  });

  test('event_type NOT IN (...) equals LADDER_SOFT_REASON_CODES (same order)', () => {
    expect(extractSoftCodes(viewSql)).toEqual([...LADDER_SOFT_REASON_CODES]);
  });

  test('the remaining open-halt predicates mirror isOpenHaltRiskEvent()', () => {
    const compact = viewSql.replace(/\s+/g, ' ');
    expect(compact).toMatch(/\be\.cleared_at IS NULL\b/i);
    expect(compact).toMatch(/\be\.active IS DISTINCT FROM false\b/i);
    expect(compact).toMatch(/COALESCE\(e\.details ->> 'eventType', ''\) <> 'resume'/i);
  });

  test('the production boot-guard predicate agrees with the SQL list', () => {
    for (const code of extractSoftCodes(viewSql)) {
      expect(isOpenHaltRiskEvent({ event_type: code })).toBe(false);
    }
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop' })).toBe(true);
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop', cleared_at: '2026-09-29T00:00:00Z' })).toBe(false);
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop', active: false })).toBe(false);
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop', details: { eventType: 'resume' } })).toBe(false);
  });
});
