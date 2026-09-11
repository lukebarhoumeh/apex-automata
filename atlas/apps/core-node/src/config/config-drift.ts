/**
 * Config drift check — keeps `atlas/config/guardrails.yaml` the single
 * editable source of truth.
 *
 * Fails (returns violations) when:
 *
 *   1. The canonical guardrails file is missing or does not validate against
 *      `GuardrailsSchema`.
 *   2. Any other `guardrails.yaml` / `guardrails.yml` exists in the tree that
 *      is not a `DO_NOT_EDIT` pointer stub (see
 *      `atlas/apps/core-node/config/guardrails.yaml`). A second editable copy
 *      is how limits silently diverged before 2026-09-10.
 *   3. `atlas/apps/core-node/config/strategies.json` (deprecated, not read by
 *      the runtime) claims `enabled` for a strategy that guardrails disables
 *      (or vice versa), is missing a built-in strategy, or carries parameter
 *      keys — parameters live only in guardrails.
 *   4. A desk-pinned value in the canonical file has drifted. Pins are the
 *      2026-09-10 desk approvals; changing one is a two-file change (YAML +
 *      this list) on purpose.
 *
 * Pure: no logging, no process.exit — the CLI wrapper in
 * `src/cli/check-config-drift.ts` and the vitest suite both consume the
 * returned `DriftViolation[]`.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { GuardrailsSchema, CANONICAL_GUARDRAILS_REPO_PATH, type GuardrailConfig } from './loadGuardrails';
import { getBuiltinStrategyIds } from '../strategies/plugins/builtin';

export type DriftViolationCode =
  | 'canonical_missing'
  | 'canonical_invalid'
  | 'second_editable_guardrails'
  | 'strategies_json_invalid'
  | 'strategies_json_enabled_conflict'
  | 'strategies_json_missing_strategy'
  | 'strategies_json_has_params'
  | 'pin_mismatch'
  | 'pin_floor_breached'
  | 'pin_list_missing_entry';

export interface DriftViolation {
  code: DriftViolationCode;
  /** Repo-relative file path (POSIX separators). */
  file: string;
  /** Dotted config path inside the file, when applicable. */
  key?: string;
  message: string;
}

export interface DriftCheckResult {
  violations: DriftViolation[];
  /** Repo-relative paths of every file that was inspected. */
  checked: string[];
}

/** Repo-relative path of the deprecated strategies mirror. */
export const STRATEGIES_JSON_REPO_PATH = 'atlas/apps/core-node/config/strategies.json';

/** Only keys a non-canonical guardrails stub may contain. */
const STUB_ALLOWED_KEYS = new Set(['DO_NOT_EDIT', 'canonical']);

/** Directories never descended into when scanning for stray guardrails files. */
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'var', '.pnpm', 'coverage']);

interface ScalarPin {
  key: string;
  expected: number | boolean;
}

/**
 * Exact-value desk pins (2026-09-10). `key` is a dotted path into the
 * parsed canonical YAML; symbol names contain `-` but never `.`, so a plain
 * split is safe.
 */
export const SCALAR_PINS: readonly ScalarPin[] = [
  { key: 'filters.atr_volatility_min', expected: 0.005 },
  { key: 'strategy.trade_cooldown_min', expected: 15 },
  { key: 'momentum.requireMacdConfirm', expected: true },
  { key: 'momentum.takeProfitAtr', expected: 5.0 },
  { key: 'risk.min_ev_threshold', expected: 0 },
  { key: 'perps_symbols.ETH-PERP-INTX.strategy_overrides.momentum.takeProfitAtr', expected: 6.0 },
  { key: 'perps_symbols.BTC-PERP-INTX.strategy_overrides.momentum.takeProfitAtr', expected: 6.0 },
];

/**
 * Lists that must contain every listed entry (extra entries are allowed).
 * `momentum` joined the global shelf on 2026-09-11 (E2-MOM-ISO KILL).
 */
export const LIST_PINS: ReadonlyArray<{ key: string; mustInclude: readonly string[] }> = [
  { key: 'disabled_strategies', mustInclude: ['vwap_mr', 'breakout', 'momentum'] },
  { key: 'perps_symbols.ETH-PERP-INTX.disabled_strategies', mustInclude: ['momentum'] },
  { key: 'perps_symbols.BTC-PERP-INTX.disabled_strategies', mustInclude: ['momentum'] },
];

/** trade_cooldown_min may be raised, never dropped to the fee-churn zone. */
export const TRADE_COOLDOWN_FLOOR_EXCLUSIVE = 5;

/** trend_follow stop / take-profit pin applied to every symbol block. */
export const TREND_FOLLOW_PIN = { stopAtr: 2.5, takeProfitAtr: 6.0 } as const;

/** Spot momentum take-profit pin (perps carry 6.0 via SCALAR_PINS). */
export const SPOT_MOMENTUM_TAKE_PROFIT_ATR = 5.0;

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, part) => {
    if (acc === null || acc === undefined || typeof acc !== 'object') return undefined;
    return (acc as Record<string, unknown>)[part];
  }, obj);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Recursively list every `guardrails.yaml` / `.yml` under `root`, skipping
 * dependency, build and runtime directories.
 */
export function findGuardrailsFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.isFile() && /^guardrails\.ya?ml$/i.test(entry.name)) {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(root);
  return found.sort();
}

/**
 * A non-canonical guardrails file is acceptable only as a pointer stub:
 * `DO_NOT_EDIT: true` plus an optional `canonical:` path and nothing else.
 */
export function isPointerStub(parsed: unknown): boolean {
  if (!isPlainObject(parsed)) return false;
  if (parsed.DO_NOT_EDIT !== true) return false;
  return Object.keys(parsed).every((k) => STUB_ALLOWED_KEYS.has(k));
}

function checkCanonical(repoRoot: string, out: DriftViolation[], checked: string[]): GuardrailConfig | null {
  const file = CANONICAL_GUARDRAILS_REPO_PATH;
  const abs = path.join(repoRoot, file);
  checked.push(file);
  if (!fs.existsSync(abs)) {
    out.push({ code: 'canonical_missing', file, message: `Canonical guardrails file not found at ${file}` });
    return null;
  }
  try {
    const parsed = YAML.parse(fs.readFileSync(abs, 'utf8'));
    return GuardrailsSchema.parse(parsed);
  } catch (error) {
    out.push({
      code: 'canonical_invalid',
      file,
      message: `Canonical guardrails failed to parse/validate: ${(error as Error).message}`,
    });
    return null;
  }
}

function checkNoSecondEditable(repoRoot: string, out: DriftViolation[], checked: string[]): void {
  const canonicalAbs = path.resolve(repoRoot, CANONICAL_GUARDRAILS_REPO_PATH);
  for (const abs of findGuardrailsFiles(repoRoot)) {
    if (path.resolve(abs) === canonicalAbs) continue;
    const file = toPosix(path.relative(repoRoot, abs));
    checked.push(file);
    let parsed: unknown;
    try {
      parsed = YAML.parse(fs.readFileSync(abs, 'utf8'));
    } catch (error) {
      out.push({
        code: 'second_editable_guardrails',
        file,
        message: `Non-canonical guardrails file is not a parseable DO_NOT_EDIT stub: ${(error as Error).message}`,
      });
      continue;
    }
    if (!isPointerStub(parsed)) {
      const keys = isPlainObject(parsed) ? Object.keys(parsed).join(', ') : typeof parsed;
      out.push({
        code: 'second_editable_guardrails',
        file,
        message:
          `Second editable guardrails file detected (keys: ${keys}). ` +
          `Only ${CANONICAL_GUARDRAILS_REPO_PATH} may carry runtime config; ` +
          'replace this file with a `DO_NOT_EDIT: true` pointer stub or delete it.',
      });
    }
  }
}

function checkStrategiesJson(repoRoot: string, guardrails: GuardrailConfig, out: DriftViolation[], checked: string[]): void {
  const file = STRATEGIES_JSON_REPO_PATH;
  const abs = path.join(repoRoot, file);
  if (!fs.existsSync(abs)) return; // deleting the mirror is always allowed
  checked.push(file);

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    out.push({ code: 'strategies_json_invalid', file, message: `strategies.json is not valid JSON: ${(error as Error).message}` });
    return;
  }
  const strategies = isPlainObject(parsed) ? parsed.strategies : undefined;
  if (!isPlainObject(strategies)) {
    out.push({ code: 'strategies_json_invalid', file, key: 'strategies', message: 'strategies.json has no `strategies` object' });
    return;
  }

  const disabled = new Set(guardrails.disabled_strategies ?? []);
  const builtin = getBuiltinStrategyIds();

  for (const id of builtin) {
    if (!(id in strategies)) {
      out.push({
        code: 'strategies_json_missing_strategy',
        file,
        key: `strategies.${id}`,
        message: `Built-in strategy "${id}" is missing from strategies.json; add it with enabled=${!disabled.has(id)}`,
      });
    }
  }

  for (const [id, cfg] of Object.entries(strategies)) {
    const key = `strategies.${id}`;
    if (!isPlainObject(cfg)) {
      out.push({ code: 'strategies_json_invalid', file, key, message: `strategies.${id} must be an object` });
      continue;
    }
    const expectedEnabled = !disabled.has(id);
    if (cfg.enabled !== expectedEnabled) {
      out.push({
        code: 'strategies_json_enabled_conflict',
        file,
        key: `${key}.enabled`,
        message:
          `strategies.json says ${id}.enabled=${String(cfg.enabled)} but ${CANONICAL_GUARDRAILS_REPO_PATH} ` +
          `${disabled.has(id) ? 'lists it under disabled_strategies' : 'does not disable it'} (expected ${expectedEnabled})`,
      });
    }
    const extraKeys = Object.keys(cfg).filter((k) => k !== 'enabled');
    if (extraKeys.length > 0) {
      out.push({
        code: 'strategies_json_has_params',
        file,
        key,
        message:
          `strategies.json carries parameter keys for ${id} (${extraKeys.join(', ')}); ` +
          `strategy parameters live only in ${CANONICAL_GUARDRAILS_REPO_PATH}`,
      });
    }
  }
}

function checkPins(guardrails: GuardrailConfig, out: DriftViolation[]): void {
  const file = CANONICAL_GUARDRAILS_REPO_PATH;

  for (const pin of SCALAR_PINS) {
    const actual = getPath(guardrails, pin.key);
    if (actual !== pin.expected) {
      out.push({
        code: 'pin_mismatch',
        file,
        key: pin.key,
        message: `${pin.key} is ${JSON.stringify(actual)}; desk pin is ${JSON.stringify(pin.expected)}`,
      });
    }
  }

  const cooldown = guardrails.strategy.trade_cooldown_min;
  if (cooldown <= TRADE_COOLDOWN_FLOOR_EXCLUSIVE) {
    out.push({
      code: 'pin_floor_breached',
      file,
      key: 'strategy.trade_cooldown_min',
      message: `strategy.trade_cooldown_min=${cooldown} must be > ${TRADE_COOLDOWN_FLOOR_EXCLUSIVE} (fee-churn zone)`,
    });
  }

  for (const pin of LIST_PINS) {
    const actual = getPath(guardrails, pin.key);
    const list = Array.isArray(actual) ? (actual as unknown[]) : [];
    for (const entry of pin.mustInclude) {
      if (!list.includes(entry)) {
        out.push({
          code: 'pin_list_missing_entry',
          file,
          key: pin.key,
          message: `${pin.key} must include "${entry}" (currently ${JSON.stringify(actual ?? null)})`,
        });
      }
    }
  }

  const symbolBlocks: Array<[string, Record<string, { strategy_overrides?: Record<string, Record<string, unknown>> }> | undefined]> = [
    ['per_symbol', guardrails.per_symbol],
    ['perps_symbols', guardrails.perps_symbols],
    ['hyperliquid_symbols', guardrails.hyperliquid_symbols],
  ];

  for (const [block, symbols] of symbolBlocks) {
    for (const [symbol, cfg] of Object.entries(symbols ?? {})) {
      const tf = cfg.strategy_overrides?.trend_follow;
      for (const [param, expected] of Object.entries(TREND_FOLLOW_PIN)) {
        const key = `${block}.${symbol}.strategy_overrides.trend_follow.${param}`;
        const actual = tf?.[param];
        if (actual !== expected) {
          out.push({
            code: 'pin_mismatch',
            file,
            key,
            message:
              `${key} is ${JSON.stringify(actual)}; desk pin is ${expected}. ` +
              'trend_follow has no global block, so every symbol must carry the override or it falls back to the plugin default.',
          });
        }
      }

      if (block === 'per_symbol') {
        const tp = cfg.strategy_overrides?.momentum?.takeProfitAtr;
        if (tp !== undefined && tp !== SPOT_MOMENTUM_TAKE_PROFIT_ATR) {
          out.push({
            code: 'pin_mismatch',
            file,
            key: `${block}.${symbol}.strategy_overrides.momentum.takeProfitAtr`,
            message: `spot momentum takeProfitAtr on ${symbol} is ${JSON.stringify(tp)}; desk pin is ${SPOT_MOMENTUM_TAKE_PROFIT_ATR}`,
          });
        }
      }
    }
  }
}

/**
 * Run every drift check against a repository root.
 *
 * @param repoRoot Absolute path to the repo checkout (the directory that
 *   contains `atlas/`).
 * @returns Violations (empty when the config is clean) plus the list of
 *   files that were inspected.
 */
export function checkConfigDrift(repoRoot: string): DriftCheckResult {
  const violations: DriftViolation[] = [];
  const checked: string[] = [];

  const guardrails = checkCanonical(repoRoot, violations, checked);
  checkNoSecondEditable(repoRoot, violations, checked);
  if (guardrails) {
    checkStrategiesJson(repoRoot, guardrails, violations, checked);
    checkPins(guardrails, violations);
  }

  return { violations, checked };
}

/**
 * Human-readable one-line-per-violation report.
 */
export function formatViolations(violations: readonly DriftViolation[]): string {
  return violations
    .map((v) => `[${v.code}] ${v.file}${v.key ? ` :: ${v.key}` : ''}\n    ${v.message}`)
    .join('\n');
}
