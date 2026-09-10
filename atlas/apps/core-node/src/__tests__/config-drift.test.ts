/**
 * Single-source guardrails — drift check + loader tests.
 *
 * Pins the 2026-09-10 desk decisions:
 *
 *   1. `loadGuardrails()` reads ONLY `atlas/config/guardrails.yaml`
 *      (resolved from the module's own location) and throws if a caller
 *      points it at any other root.
 *   2. `checkConfigDrift()` is green on the real repo, and red for each
 *      class of drift it exists to catch: a second editable guardrails
 *      YAML, a `strategies.json` that disagrees with `disabled_strategies`
 *      or smuggles parameters, and any desk pin moving.
 *
 * Fixture repos are built in a temp dir from the real canonical YAML so the
 * negative cases mutate exactly one thing each.
 */
import { describe, test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import {
  checkConfigDrift,
  findGuardrailsFiles,
  formatViolations,
  isPointerStub,
  STRATEGIES_JSON_REPO_PATH,
  type DriftViolation,
  type DriftViolationCode,
} from '../config/config-drift';
import {
  loadGuardrails,
  resolveCanonicalGuardrailsPath,
  CANONICAL_GUARDRAILS_REPO_PATH,
} from '../config/loadGuardrails';

// src/__tests__ -> src -> core-node -> apps -> atlas -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const CANONICAL_ABS = path.join(REPO_ROOT, CANONICAL_GUARDRAILS_REPO_PATH);
const STUB_REPO_PATH = 'atlas/apps/core-node/config/guardrails.yaml';

const realCanonicalYaml = fs.readFileSync(CANONICAL_ABS, 'utf8');
const realStub = fs.readFileSync(path.join(REPO_ROOT, STUB_REPO_PATH), 'utf8');
const realStrategiesJson = fs.readFileSync(path.join(REPO_ROOT, STRATEGIES_JSON_REPO_PATH), 'utf8');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface FixtureOptions {
  /** Mutate the parsed canonical YAML before it is written. */
  mutateCanonical?: (doc: Record<string, any>) => void;
  /** Omit the canonical file entirely. */
  omitCanonical?: boolean;
  /** Content for the core-node stub; `null` omits the file. Defaults to the real stub. */
  stub?: string | null;
  /** Content for strategies.json; `null` omits the file. Defaults to the real file. */
  strategiesJson?: string | null;
  /** Additional files: repo-relative path -> content. */
  extraFiles?: Record<string, string>;
}

function writeFile(root: string, rel: string, content: string) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function makeRepo(opts: FixtureOptions = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-drift-'));
  tempDirs.push(root);

  if (!opts.omitCanonical) {
    const doc = YAML.parse(realCanonicalYaml);
    opts.mutateCanonical?.(doc);
    writeFile(root, CANONICAL_GUARDRAILS_REPO_PATH, YAML.stringify(doc));
  }
  const stub = opts.stub === undefined ? realStub : opts.stub;
  if (stub !== null) writeFile(root, STUB_REPO_PATH, stub);

  const strategies = opts.strategiesJson === undefined ? realStrategiesJson : opts.strategiesJson;
  if (strategies !== null) writeFile(root, STRATEGIES_JSON_REPO_PATH, strategies);

  for (const [rel, content] of Object.entries(opts.extraFiles ?? {})) {
    writeFile(root, rel, content);
  }
  return root;
}

function codes(violations: DriftViolation[]): DriftViolationCode[] {
  return violations.map((v) => v.code);
}

function withStrategies(mutate: (strategies: Record<string, any>) => void): string {
  const doc = JSON.parse(realStrategiesJson);
  mutate(doc.strategies);
  return JSON.stringify(doc, null, 2);
}

/** The pre-2026-09-10 second copy: a real, divergent config. */
const LEGACY_SECOND_COPY = `
account:
  equity_usd: 50000
  risk_per_trade: 0.01
  max_open_positions: 5
  max_account_leverage: 3.0
  min_notional_buffer: 1.1
filters:
  atr_volatility_min: 0.0005
  atr_volatility_max: 0.05
`;

describe('loadGuardrails() single source', () => {
  test('resolves the canonical path from the module location, not cwd', () => {
    const resolved = resolveCanonicalGuardrailsPath();
    expect(resolved.split(path.sep).join('/')).toMatch(/\/atlas\/config\/guardrails\.yaml$/);
    expect(fs.realpathSync.native(resolved)).toBe(fs.realpathSync.native(CANONICAL_ABS));
  });

  test('loads with no argument', () => {
    const g = loadGuardrails();
    expect(g.account.equity_usd).toBeGreaterThan(0);
    expect(g.disabled_strategies).toEqual(expect.arrayContaining(['vwap_mr', 'breakout']));
  });

  test('accepts an atlasRoot that resolves to the canonical file', () => {
    const atlasRoot = path.join(REPO_ROOT, 'atlas');
    expect(loadGuardrails(atlasRoot)).toEqual(loadGuardrails());
    // Unnormalised spelling of the same directory is still the same file.
    expect(loadGuardrails(path.join(atlasRoot, 'apps', '..'))).toEqual(loadGuardrails());
  });

  test('refuses any other root instead of reading a second copy', () => {
    const decoyRoot = makeRepo({
      extraFiles: { 'decoy/config/guardrails.yaml': LEGACY_SECOND_COPY },
    });
    const atlasRoot = path.join(decoyRoot, 'decoy');
    expect(() => loadGuardrails(atlasRoot)).toThrow(/refusing to read .*decoy.*guardrails\.yaml/);
    expect(() => loadGuardrails(atlasRoot)).toThrow(CANONICAL_GUARDRAILS_REPO_PATH);
  });

  test('refuses the legacy core-node root specifically', () => {
    // The old call-site bug: deriving atlasRoot from a --config path under
    // atlas/apps/core-node/ silently loaded the divergent copy that lived there.
    expect(() => loadGuardrails(path.join(REPO_ROOT, 'atlas', 'apps', 'core-node'))).toThrow(/refusing to read/);
  });

  test('refuses a non-existent root with the same error (not ENOENT)', () => {
    expect(() => loadGuardrails(path.join(os.tmpdir(), 'definitely-not-atlas'))).toThrow(/refusing to read/);
  });
});

describe('checkConfigDrift() on the real repository', () => {
  test('is clean', () => {
    const result = checkConfigDrift(REPO_ROOT);
    expect(formatViolations(result.violations)).toBe('');
    expect(result.violations).toEqual([]);
    expect(result.checked).toEqual(
      expect.arrayContaining([CANONICAL_GUARDRAILS_REPO_PATH, STUB_REPO_PATH, STRATEGIES_JSON_REPO_PATH])
    );
  });

  test('the only guardrails files in the tree are the canonical one and the stub', () => {
    const rel = findGuardrailsFiles(REPO_ROOT).map((p) => path.relative(REPO_ROOT, p).split(path.sep).join('/'));
    expect(rel).toEqual([STUB_REPO_PATH, CANONICAL_GUARDRAILS_REPO_PATH].sort());
  });

  test('the core-node copy is a DO_NOT_EDIT pointer stub with no runtime keys', () => {
    const parsed = YAML.parse(realStub);
    expect(isPointerStub(parsed)).toBe(true);
    expect(parsed).toEqual({ DO_NOT_EDIT: true, canonical: CANONICAL_GUARDRAILS_REPO_PATH });
  });

  test('strategies.json mirrors disabled_strategies and carries no parameters', () => {
    const { strategies } = JSON.parse(realStrategiesJson);
    expect(strategies).toEqual({
      momentum: { enabled: true },
      trend_follow: { enabled: true },
      vwap_mr: { enabled: false },
      breakout: { enabled: false },
    });
  });
});

describe('checkConfigDrift() fixtures', () => {
  test('a stub-only second copy is fine; deleting it is fine too', () => {
    expect(checkConfigDrift(makeRepo()).violations).toEqual([]);
    expect(checkConfigDrift(makeRepo({ stub: null })).violations).toEqual([]);
  });

  test('flags the legacy editable second copy', () => {
    const { violations } = checkConfigDrift(makeRepo({ stub: LEGACY_SECOND_COPY }));
    expect(codes(violations)).toEqual(['second_editable_guardrails']);
    expect(violations[0].file).toBe(STUB_REPO_PATH);
    expect(violations[0].message).toMatch(/account, filters/);
  });

  test('flags a stub that grows a runtime key', () => {
    const { violations } = checkConfigDrift(
      makeRepo({ stub: `DO_NOT_EDIT: true\ncanonical: x\nstrategy:\n  trade_cooldown_min: 5\n` })
    );
    expect(codes(violations)).toEqual(['second_editable_guardrails']);
  });

  test('flags a copy that forgot DO_NOT_EDIT', () => {
    const { violations } = checkConfigDrift(makeRepo({ stub: `canonical: atlas/config/guardrails.yaml\n` }));
    expect(codes(violations)).toEqual(['second_editable_guardrails']);
  });

  test('flags a stray guardrails.yml anywhere else in the tree (skips node_modules/dist/var)', () => {
    const repo = makeRepo({
      extraFiles: {
        'deploy/k8s/guardrails.yml': LEGACY_SECOND_COPY,
        'node_modules/some-pkg/guardrails.yaml': LEGACY_SECOND_COPY,
        'atlas/apps/core-node/dist/guardrails.yaml': LEGACY_SECOND_COPY,
        'atlas/var/tmp/guardrails.yaml': LEGACY_SECOND_COPY,
      },
    });
    const { violations } = checkConfigDrift(repo);
    expect(codes(violations)).toEqual(['second_editable_guardrails']);
    expect(violations[0].file).toBe('deploy/k8s/guardrails.yml');
  });

  test('flags a second copy that is not even parseable YAML', () => {
    const { violations } = checkConfigDrift(makeRepo({ stub: 'account: [unclosed' }));
    expect(codes(violations)).toEqual(['second_editable_guardrails']);
    expect(violations[0].message).toMatch(/not a parseable DO_NOT_EDIT stub/);
  });

  test('reports a missing canonical file and still scans for second copies', () => {
    const { violations } = checkConfigDrift(makeRepo({ omitCanonical: true, stub: LEGACY_SECOND_COPY }));
    expect(codes(violations)).toEqual(['canonical_missing', 'second_editable_guardrails']);
  });

  test('reports a canonical file that fails schema validation', () => {
    const { violations } = checkConfigDrift(
      makeRepo({
        mutateCanonical: (doc) => {
          delete doc.fees;
        },
      })
    );
    expect(codes(violations)).toEqual(['canonical_invalid']);
    expect(violations[0].message).toMatch(/fees/);
  });

  describe('strategies.json', () => {
    test('absent file is allowed', () => {
      expect(checkConfigDrift(makeRepo({ strategiesJson: null })).violations).toEqual([]);
    });

    test('claiming enabled=true for a disabled strategy is a conflict', () => {
      const { violations } = checkConfigDrift(
        makeRepo({
          strategiesJson: withStrategies((s) => {
            s.vwap_mr.enabled = true;
            s.breakout.enabled = true;
          }),
        })
      );
      expect(codes(violations)).toEqual(['strategies_json_enabled_conflict', 'strategies_json_enabled_conflict']);
      expect(violations.map((v) => v.key)).toEqual(['strategies.vwap_mr.enabled', 'strategies.breakout.enabled']);
    });

    test('claiming enabled=false for an active strategy is also a conflict', () => {
      const { violations } = checkConfigDrift(
        makeRepo({ strategiesJson: withStrategies((s) => { s.momentum.enabled = false; }) })
      );
      expect(codes(violations)).toEqual(['strategies_json_enabled_conflict']);
      expect(violations[0].message).toMatch(/does not disable it/);
    });

    test('a missing built-in strategy (trend_follow) is flagged', () => {
      const { violations } = checkConfigDrift(
        makeRepo({ strategiesJson: withStrategies((s) => { delete s.trend_follow; }) })
      );
      expect(codes(violations)).toEqual(['strategies_json_missing_strategy']);
      expect(violations[0].key).toBe('strategies.trend_follow');
      expect(violations[0].message).toMatch(/enabled=true/);
    });

    test('parameter keys are flagged — parameters live only in guardrails', () => {
      const { violations } = checkConfigDrift(
        makeRepo({
          strategiesJson: withStrategies((s) => {
            s.momentum.takeProfitAtr = 4.0;
            s.momentum.rsiPeriod = 14;
          }),
        })
      );
      expect(codes(violations)).toEqual(['strategies_json_has_params']);
      expect(violations[0].message).toMatch(/takeProfitAtr, rsiPeriod/);
    });

    test('tracks disabled_strategies from the canonical file, not a hardcoded list', () => {
      // Disable momentum in guardrails; the mirror must follow.
      const { violations } = checkConfigDrift(
        makeRepo({
          mutateCanonical: (doc) => { doc.disabled_strategies.push('momentum'); },
        })
      );
      expect(codes(violations)).toEqual(['strategies_json_enabled_conflict']);
      expect(violations[0].key).toBe('strategies.momentum.enabled');
    });

    test('invalid JSON is reported once', () => {
      const { violations } = checkConfigDrift(makeRepo({ strategiesJson: '{ nope' }));
      expect(codes(violations)).toEqual(['strategies_json_invalid']);
    });
  });

  describe('desk pins', () => {
    const pinCase = (name: string, mutate: (doc: Record<string, any>) => void, expectedKeys: string[], expectedCodes?: DriftViolationCode[]) =>
      test(name, () => {
        const { violations } = checkConfigDrift(makeRepo({ mutateCanonical: mutate }));
        expect(violations.map((v) => v.key)).toEqual(expectedKeys);
        if (expectedCodes) expect(codes(violations)).toEqual(expectedCodes);
        else expect(new Set(codes(violations))).toEqual(new Set(['pin_mismatch']));
      });

    pinCase(
      'filters.atr_volatility_min must stay 0.005',
      (doc) => { doc.filters.atr_volatility_min = 0.0005; },
      ['filters.atr_volatility_min']
    );

    pinCase(
      'strategy.trade_cooldown_min back to 5 trips both the pin and the fee-churn floor',
      (doc) => { doc.strategy.trade_cooldown_min = 5; },
      ['strategy.trade_cooldown_min', 'strategy.trade_cooldown_min'],
      ['pin_mismatch', 'pin_floor_breached']
    );

    pinCase(
      'strategy.trade_cooldown_min raised above 15 is a pin change (but not a floor breach)',
      (doc) => { doc.strategy.trade_cooldown_min = 20; },
      ['strategy.trade_cooldown_min'],
      ['pin_mismatch']
    );

    pinCase(
      'momentum.requireMacdConfirm must stay true',
      (doc) => { doc.momentum.requireMacdConfirm = false; },
      ['momentum.requireMacdConfirm']
    );

    pinCase(
      'global momentum.takeProfitAtr must stay 5.0',
      (doc) => { doc.momentum.takeProfitAtr = 4.0; },
      ['momentum.takeProfitAtr']
    );

    pinCase(
      'spot per-symbol momentum takeProfitAtr override must stay 5.0',
      (doc) => { doc.per_symbol['ETH-USD'].strategy_overrides.momentum.takeProfitAtr = 6.0; },
      ['per_symbol.ETH-USD.strategy_overrides.momentum.takeProfitAtr']
    );

    pinCase(
      'perps momentum takeProfitAtr overrides must stay 6.0',
      (doc) => {
        doc.perps_symbols['ETH-PERP-INTX'].strategy_overrides.momentum.takeProfitAtr = 5.0;
        delete doc.perps_symbols['BTC-PERP-INTX'].strategy_overrides.momentum.takeProfitAtr;
      },
      [
        'perps_symbols.ETH-PERP-INTX.strategy_overrides.momentum.takeProfitAtr',
        'perps_symbols.BTC-PERP-INTX.strategy_overrides.momentum.takeProfitAtr',
      ]
    );

    pinCase(
      'risk.min_ev_threshold must stay 0 until the 30-paper-day review',
      (doc) => { doc.risk.min_ev_threshold = 1; },
      ['risk.min_ev_threshold']
    );

    pinCase(
      'trend_follow 2.5 / 6.0 must be carried by every symbol block (spot)',
      (doc) => { delete doc.per_symbol['BTC-USD'].strategy_overrides.trend_follow; },
      [
        'per_symbol.BTC-USD.strategy_overrides.trend_follow.stopAtr',
        'per_symbol.BTC-USD.strategy_overrides.trend_follow.takeProfitAtr',
      ]
    );

    pinCase(
      'trend_follow takeProfitAtr drift on a perp or HL symbol is caught',
      (doc) => {
        doc.perps_symbols['BTC-PERP-INTX'].strategy_overrides.trend_follow.takeProfitAtr = 5.0;
        doc.hyperliquid_symbols['ETH-USD'].strategy_overrides.trend_follow.stopAtr = 2.0;
      },
      [
        'perps_symbols.BTC-PERP-INTX.strategy_overrides.trend_follow.takeProfitAtr',
        'hyperliquid_symbols.ETH-USD.strategy_overrides.trend_follow.stopAtr',
      ]
    );

    pinCase(
      'a newly added symbol without a trend_follow override is caught',
      (doc) => {
        doc.per_symbol['DOGE-USD'] = { max_notional_usd: 1000, max_daily_loss_usd: 100 };
      },
      [
        'per_symbol.DOGE-USD.strategy_overrides.trend_follow.stopAtr',
        'per_symbol.DOGE-USD.strategy_overrides.trend_follow.takeProfitAtr',
      ]
    );

    pinCase(
      'global disabled_strategies must keep vwap_mr and breakout (extras allowed); the strategies.json mirror follows',
      (doc) => { doc.disabled_strategies = ['vwap_mr', 'something_else']; },
      ['strategies.breakout.enabled', 'disabled_strategies'],
      ['strategies_json_enabled_conflict', 'pin_list_missing_entry']
    );

    pinCase(
      'perps symbols must keep momentum disabled',
      (doc) => {
        delete doc.perps_symbols['ETH-PERP-INTX'].disabled_strategies;
        doc.perps_symbols['BTC-PERP-INTX'].disabled_strategies = [];
      },
      ['perps_symbols.ETH-PERP-INTX.disabled_strategies', 'perps_symbols.BTC-PERP-INTX.disabled_strategies'],
      ['pin_list_missing_entry', 'pin_list_missing_entry']
    );
  });

  test('formatViolations renders code, file, key and message', () => {
    const { violations } = checkConfigDrift(makeRepo({ mutateCanonical: (doc) => { doc.risk.min_ev_threshold = 2; } }));
    expect(formatViolations(violations)).toMatch(
      /^\[pin_mismatch\] atlas\/config\/guardrails\.yaml :: risk\.min_ev_threshold\n {4}risk\.min_ev_threshold is 2; desk pin is 0$/
    );
  });
});
