/**
 * Guard: the `public.desk_risk_status` view hard-codes the L1–L5 soft ladder
 * codes in its open-halt predicate (`event_type NOT IN (...)`). That list must
 * stay equal (as a set) to `LADDER_SOFT_REASON_CODES`
 * (src/trading/risk/paper-kill-ladder.ts), and the rest of the predicate must
 * keep mirroring paper-boot-guard.ts `isOpenHaltRiskEvent()`; otherwise the
 * desk view and the boot guard disagree on "would a paper start be refused".
 *
 * Reads the migration SQL from the repo (no database). Every view DDL
 * statement that targets desk_risk_status (CREATE [OR REPLACE] / DROP /
 * ALTER ... RENAME TO | SET SCHEMA, schema-qualified or not, quoted or not) is
 * collected across all migrations in apply order. The LAST one must be a
 * CREATE, and that CREATE is the definition checked, so a later migration that
 * redefines the view is what gets checked, and a later drop / rename fails
 * loudly instead of the guard silently re-checking a stale definition.
 * Review finding 13 (docs/research/2026-09-30_pr82-round2-review-findings.md).
 */
import fs from 'fs';
import path from 'path';
import { describe, test, expect } from 'vitest';
import { LADDER_SOFT_REASON_CODES } from '../trading/risk/paper-kill-ladder';
import { isOpenHaltRiskEvent } from '../trading/risk/paper-boot-guard';

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', '..', '..', '..', 'supabase', 'migrations');
/** The migration that defines the view as of PR #82 (applied 2026-09-29). */
const V2_MIGRATION = '20260929010733_desk_status_views_v2.sql';

/** `desk_risk_status`, optionally `public.`-qualified, either part optionally double-quoted. */
const VIEW_NAME = String.raw`(?:"?public"?\s*\.\s*)?"?desk_risk_status"?(?![\w$"])`;
const NAME_ONLY_RE = new RegExp(String.raw`^${VIEW_NAME}$`, 'i');
const CREATE_RE = new RegExp(
  String.raw`\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMP|TEMPORARY|RECURSIVE|MATERIALIZED)\s+)*VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?${VIEW_NAME}`,
  'gi',
);
const DROP_RE = /\bDROP\s+(?:MATERIALIZED\s+)?VIEW\s+(?:IF\s+EXISTS\s+)?([^;]*)/gi;
const ALTER_FROM_RE = new RegExp(
  String.raw`\bALTER\s+(?:TABLE|(?:MATERIALIZED\s+)?VIEW)\s+(?:IF\s+EXISTS\s+)?${VIEW_NAME}\s+(?:RENAME\s+TO|SET\s+SCHEMA)\b`,
  'gi',
);
const ALTER_TO_RE = new RegExp(
  String.raw`\bALTER\s+(?:TABLE|(?:MATERIALIZED\s+)?VIEW)\s+[^;]*?\bRENAME\s+TO\s+"?desk_risk_status"?(?![\w$"])`,
  'gi',
);

type ViewDdlKind = 'create' | 'drop' | 'alter';
interface ViewDdl {
  file: string;
  index: number;
  kind: ViewDdlKind;
  sql: string;
}
interface MigrationSource {
  file: string;
  sql: string;
}

/** Strips `--` and `/* *\/` comments, leaving single-quoted literals intact. */
function stripSqlComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
        else if (sql[j] === "'") break;
        else j += 1;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      out += ' ';
      i = close === -1 ? sql.length : close + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** Same length as `sql`, with the contents of single-quoted literals blanked (quotes kept). */
function maskStringLiterals(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    if (sql[i] !== "'") {
      out += sql[i];
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < sql.length) {
      if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
      else if (sql[j] === "'") break;
      else j += 1;
    }
    out += "'" + ' '.repeat(Math.max(0, Math.min(j, sql.length) - i - 1)) + (j < sql.length ? "'" : '');
    i = j + 1;
  }
  return out;
}

/** Every desk_risk_status view DDL statement, in apply order (file name, then position). */
function collectDeskRiskStatusDdl(migrations: MigrationSource[]): ViewDdl[] {
  const events: ViewDdl[] = [];
  const ordered = [...migrations].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  for (const { file, sql: raw } of ordered) {
    const sql = stripSqlComments(raw);
    // Match on a literal-masked copy (same offsets) so DDL-looking text inside a
    // string (e.g. a COMMENT ON body) is never taken for a statement, and a ';'
    // inside a literal never ends the statement early.
    const masked = maskStringLiterals(sql);
    const statementAt = (start: number): string => {
      const end = masked.indexOf(';', start);
      return sql.slice(start, end === -1 ? undefined : end);
    };
    const found: ViewDdl[] = [];
    for (const m of masked.matchAll(CREATE_RE)) {
      found.push({ file, index: m.index ?? 0, kind: 'create', sql: statementAt(m.index ?? 0) });
    }
    for (const m of masked.matchAll(DROP_RE)) {
      const names = m[1].replace(/\b(?:CASCADE|RESTRICT)\s*$/i, '').split(',').map((s) => s.trim());
      if (names.some((n) => NAME_ONLY_RE.test(n))) {
        found.push({ file, index: m.index ?? 0, kind: 'drop', sql: statementAt(m.index ?? 0) });
      }
    }
    for (const re of [ALTER_FROM_RE, ALTER_TO_RE]) {
      for (const m of masked.matchAll(re)) {
        found.push({ file, index: m.index ?? 0, kind: 'alter', sql: statementAt(m.index ?? 0) });
      }
    }
    found.sort((a, b) => a.index - b.index);
    events.push(...found);
  }
  return events;
}

/** The CREATE that defines the view as the migrations leave it; throws if the last DDL is not a CREATE. */
function currentDeskRiskStatusDefinition(migrations: MigrationSource[]): ViewDdl {
  const events = collectDeskRiskStatusDdl(migrations);
  const last = events[events.length - 1];
  if (!last) throw new Error('no migration creates public.desk_risk_status');
  if (last.kind !== 'create') {
    throw new Error(
      `the last desk_risk_status view DDL (${last.file}) is a ${last.kind}, not a CREATE this guard can parse: ${last.sql.trim()}`,
    );
  }
  return last;
}

function readMigrations(): MigrationSource[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .map((file) => ({ file, sql: fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8') }));
}

function extractSoftCodes(viewSql: string): string[] {
  const matches = [...viewSql.matchAll(/\bevent_type\s+NOT\s+IN\s*\(([^)]*)\)/gi)];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one event_type NOT IN (...) list in desk_risk_status, found ${matches.length}`);
  }
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

const sorted = (xs: readonly string[]): string[] => [...xs].sort();

describe('desk_risk_status view mirrors the paper kill ladder soft codes', () => {
  const current = currentDeskRiskStatusDefinition(readMigrations());

  test('the view is defined by the v2 migration or a later one', () => {
    expect(fs.existsSync(path.join(MIGRATIONS_DIR, V2_MIGRATION))).toBe(true);
    expect(current.file >= V2_MIGRATION).toBe(true);
  });

  test('event_type NOT IN (...) equals LADDER_SOFT_REASON_CODES as a set, no duplicates on either side', () => {
    const extracted = extractSoftCodes(current.sql);
    expect(new Set(extracted).size).toBe(extracted.length);
    expect(new Set(LADDER_SOFT_REASON_CODES).size).toBe(LADDER_SOFT_REASON_CODES.length);
    expect(sorted(extracted)).toEqual(sorted(LADDER_SOFT_REASON_CODES));
  });

  test('the remaining open-halt predicates mirror isOpenHaltRiskEvent()', () => {
    const compact = current.sql.replace(/\s+/g, ' ');
    expect(compact).toMatch(/\be\.cleared_at IS NULL\b/i);
    expect(compact).toMatch(/\be\.active IS DISTINCT FROM false\b/i);
    expect(compact).toMatch(/COALESCE\(e\.details ->> 'eventType', ''\) <> 'resume'/i);
  });

  test('the production boot-guard predicate agrees with the SQL list', () => {
    for (const code of extractSoftCodes(current.sql)) {
      expect(isOpenHaltRiskEvent({ event_type: code })).toBe(false);
    }
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop' })).toBe(true);
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop', cleared_at: '2026-09-29T00:00:00Z' })).toBe(false);
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop', active: false })).toBe(false);
    expect(isOpenHaltRiskEvent({ event_type: 'daily_stop', details: { eventType: 'resume' } })).toBe(false);
  });
});

describe('desk_risk_status DDL scanner (synthetic migrations)', () => {
  const v2: MigrationSource = {
    file: V2_MIGRATION,
    sql: [
      '-- DROP VIEW IF EXISTS public.desk_risk_status;  (rollback note, a comment)',
      'DROP VIEW IF EXISTS public.desk_risk_status;',
      "CREATE VIEW public.desk_risk_status AS SELECT 1 WHERE e.event_type NOT IN ('a', 'b');",
      "COMMENT ON VIEW public.desk_risk_status IS 'not -- a comment; DROP VIEW public.desk_risk_status; it''s a string';",
    ].join('\n'),
  };
  const later = (sql: string): MigrationSource => ({ file: '20261001000000_later.sql', sql });

  test('picks the v2 CREATE; comments and string literals are not DDL', () => {
    const def = currentDeskRiskStatusDefinition([v2]);
    expect(def.file).toBe(V2_MIGRATION);
    expect(extractSoftCodes(def.sql)).toEqual(['a', 'b']);
    expect(collectDeskRiskStatusDdl([v2]).map((e) => e.kind)).toEqual(['drop', 'create']);
  });

  test.each([
    ['quoted schema + name', `CREATE OR REPLACE VIEW "public"."desk_risk_status" AS SELECT 1 WHERE event_type NOT IN ('x');`],
    ['unqualified name', `CREATE VIEW desk_risk_status AS SELECT 1 WHERE event_type NOT IN ('x');`],
    ['quoted name only', `create or replace view "desk_risk_status" as select 1 where event_type not in ('x');`],
  ])('a later CREATE (%s) becomes the checked definition', (_label, sql) => {
    const def = currentDeskRiskStatusDefinition([later(sql), v2]);
    expect(def.file).toBe('20261001000000_later.sql');
    expect(extractSoftCodes(def.sql)).toEqual(['x']);
  });

  test.each([
    ['DROP VIEW', 'DROP VIEW IF EXISTS public.desk_risk_status;'],
    ['quoted DROP in a name list', 'DROP VIEW IF EXISTS public.other_view, "public"."desk_risk_status" CASCADE;'],
    ['ALTER VIEW RENAME TO', 'ALTER VIEW public.desk_risk_status RENAME TO desk_risk_status_old;'],
    ['ALTER VIEW SET SCHEMA', 'ALTER VIEW IF EXISTS desk_risk_status SET SCHEMA archive;'],
    ['a view renamed onto the name', 'ALTER VIEW public.desk_risk_status_v3 RENAME TO desk_risk_status;'],
  ])('a later %s makes the guard fail loudly', (_label, sql) => {
    expect(() => currentDeskRiskStatusDefinition([v2, later(sql)])).toThrow(/is a (drop|alter), not a CREATE/);
  });

  test('unrelated views and other schemas are ignored', () => {
    const noise = later(
      [
        'CREATE VIEW public.desk_risk_status_v3 AS SELECT * FROM public.desk_risk_status;',
        'DROP VIEW IF EXISTS archive.desk_risk_status;',
        'ALTER VIEW public.desk_risk_status OWNER TO postgres;',
      ].join('\n'),
    );
    expect(currentDeskRiskStatusDefinition([v2, noise]).file).toBe(V2_MIGRATION);
  });

  test('a CREATE without a parseable NOT IN list fails the extraction', () => {
    const def = currentDeskRiskStatusDefinition([v2, later('CREATE VIEW public.desk_risk_status AS SELECT 1;')]);
    expect(() => extractSoftCodes(def.sql)).toThrow(/exactly one event_type NOT IN/);
  });
});
