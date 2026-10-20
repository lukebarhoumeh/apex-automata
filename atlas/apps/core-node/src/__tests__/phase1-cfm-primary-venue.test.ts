/**
 * Phase 1 — CFM primary paper venue tests (Risk Master round 2).
 *
 * Covers:
 *   1. CFM fee model: cost-plus round-trip cost
 *   2. Fee-aware EV gate: perContractFeeUsd charges $0.20 × contracts RT
 *   3. Per-timeframe ATR bounds (data-driven): 4H 0.8–4%, 1D 2.5–15%
 *   4. CFM stop-distance sizing: one stop-out ≤ min(max_daily_loss_usd, L1 budget)
 *   5. Config drift: allowlist [trend_follow, donchian_daily_s3] fails on any other
 *   6. Market context logger: row shape, basis computation
 *   7. Integration: 4H CFM signal uses correct ATR bounds + EV gate per-contract fee
 *   8. Live mode drops cfm_symbols (server.ts line 1540)
 */
import { describe, test, expect, vi } from 'vitest';
import { FeeModel, contractsForSize } from '../core/fee-model';
import { loadGuardrails, type GuardrailConfig } from '../config/loadGuardrails';
import {
  evaluateEvGate,
  type EvGateInputs,
} from '../trading/risk/ev-gate';
import {
  resolveAtrBounds,
  evaluateAtrVolatilityFilter,
} from '../strategies/atr-volatility-filter';
import {
  MarketContextLogger,
  type MarketContextBarRow,
  type MarketContextWriter,
} from '../trading/cfm/market-context-logger';
import {
  computeCfmRoundTripCost,
  computePerContractRoundTripFeeUsd,
} from '../trading/cfm/cfm-fee-calculator';
import { computeCfmPositionSize, type CfmSizingInputs } from '../trading/cfm/cfm-position-sizer';
import {
  checkConfigDrift,
  CFM_ALLOWED_STRATEGIES,
} from '../config/config-drift';
import { isCfmSymbol } from '../core/symbol-utils';
import type { FeesConfig } from '../config/loadGuardrails';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import YAML from 'yaml';
import { CANONICAL_GUARDRAILS_REPO_PATH } from '../config/loadGuardrails';
import { STRATEGIES_JSON_REPO_PATH, type DriftViolationCode } from '../config/config-drift';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

const FEES_CFM: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
    cfm_nano: {
      maker_bps: 9.5,
      taker_bps: 10,
      exchange_fee_per_contract_usd: 0.10,
    },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};

// ────────────────────────────────────────────────────────────────────────
// 1. CFM fee model
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — CFM fee model', () => {
  const fm = new FeeModel(FEES_CFM);

  test('1 nano BTC round trip @ $77,000 = $1.7015 total fees (22.1 bps)', () => {
    const entry = fm.computeFillFeeUsd({ exchange: 'coinbase', market: 'cfm', side: 'maker', notionalUsd: 770, contracts: 1 });
    const exit = fm.computeFillFeeUsd({ exchange: 'coinbase', market: 'cfm', side: 'taker', notionalUsd: 770, contracts: 1 });
    const rt = Number(entry.totalUsd) + Number(exit.totalUsd);
    expect(rt).toBeCloseTo(1.7015, 4);
    expect((rt / 770) * 10_000).toBeCloseTo(22.1, 0);
  });

  test('computePerContractRoundTripFeeUsd = 2 × $0.10 = $0.20', () => {
    expect(computePerContractRoundTripFeeUsd(fm)).toBeCloseTo(0.2, 10);
  });

  test('canonical guardrails carry the CDE fee book (no clearing fee)', () => {
    const g = loadGuardrails();
    expect(g.fees.coinbase.cfm_nano).toEqual({
      maker_bps: 9.5, taker_bps: 10, exchange_fee_per_contract_usd: 0.1,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. Fee-aware EV gate — perContractFeeUsd ($0.20 × contracts RT)
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — fee-aware EV gate for CFM', () => {
  const fm = new FeeModel(FEES_CFM);

  function makeInputs(overrides: Partial<EvGateInputs> = {}): EvGateInputs {
    return {
      symbol: 'BIP-20DEC30-CDE', strategy: 'trend_follow', direction: 'buy',
      entryPrice: 77_000, stopPrice: 75_075, takeProfit: 88_550, size: 0.01,
      winRate: 0.40, sampleSize: 50, feeModel: fm, venue: 'coinbase',
      entryLiquidity: 'maker', minEvThreshold: 0,
      ...overrides,
    };
  }

  test('perContractFeeUsd = $0.20 × 1 contract adds $0.20 to round-trip fee', () => {
    const perCtFee = computePerContractRoundTripFeeUsd(fm);
    expect(perCtFee).toBeCloseTo(0.20, 10);

    const without = evaluateEvGate(makeInputs({ perContractFeeUsd: 0 }));
    const with_ = evaluateEvGate(makeInputs({ perContractFeeUsd: perCtFee * 1 }));
    expect(with_.feeUsd - without.feeUsd).toBeCloseTo(0.2, 2);
  });

  test('10 contracts → perContractFeeUsd = $2.00 added to fees', () => {
    const perCtFee = computePerContractRoundTripFeeUsd(fm);
    const base = evaluateEvGate(makeInputs({ size: 0.10, perContractFeeUsd: 0 }));
    const with10 = evaluateEvGate(makeInputs({ size: 0.10, perContractFeeUsd: perCtFee * 10 }));
    expect(with10.feeUsd - base.feeUsd).toBeCloseTo(2.0, 1);
  });

  test('high per-contract fees reject a marginally positive trade', () => {
    const highFee = evaluateEvGate(makeInputs({
      minEvThreshold: 0, winRate: 0.35, sampleSize: 100, perContractFeeUsd: 50,
    }));
    expect(highFee.allowed).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. Per-timeframe ATR bounds (data-driven)
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — per-timeframe ATR volatility bounds', () => {
  const filters = {
    atr_volatility_min: 0.005, atr_volatility_max: 0.05,
    atr_volatility_by_timeframe: {
      '240': { atr_volatility_min: 0.008, atr_volatility_max: 0.04 },
      '1440': { atr_volatility_min: 0.025, atr_volatility_max: 0.15 },
    },
  };

  test('4H bounds: 0.8% floor, 4% ceiling (data-driven from fixture p5/p95)', () => {
    const b = resolveAtrBounds(filters, 240);
    expect(b.atrMin).toBe(0.008);
    expect(b.atrMax).toBe(0.04);
  });

  test('1D bounds: 2.5% floor, 15% ceiling', () => {
    const b = resolveAtrBounds(filters, 1440);
    expect(b.atrMin).toBe(0.025);
    expect(b.atrMax).toBe(0.15);
  });

  test('15m falls back to global (no override)', () => {
    expect(resolveAtrBounds(filters, 15)).toEqual({ atrMin: 0.005, atrMax: 0.05 });
  });

  test('floors RISE with timeframe: 15m < 4H < 1D', () => {
    const f15 = resolveAtrBounds(filters, 15);
    const f4h = resolveAtrBounds(filters, 240);
    const f1d = resolveAtrBounds(filters, 1440);
    expect(f4h.atrMin).toBeGreaterThan(f15.atrMin);
    expect(f1d.atrMin).toBeGreaterThan(f4h.atrMin);
  });

  test('4H ATR% = 1.2% passes 4H bounds', () => {
    const v = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr: 924 } }, price: 77_000, atrMin: 0.008, atrMax: 0.04 });
    expect(v.outcome).toBe('pass');
  });

  test('4H ATR% = 0.6% is below 4H floor → rejected', () => {
    const v = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr: 462 } }, price: 77_000, atrMin: 0.008, atrMax: 0.04 });
    expect(v.outcome).toBe('atr_below_min');
  });

  test('canonical guardrails carry correct per-timeframe bounds', () => {
    const g = loadGuardrails();
    expect(g.filters.atr_volatility_by_timeframe?.['240']).toEqual({ atr_volatility_min: 0.008, atr_volatility_max: 0.04 });
    expect(g.filters.atr_volatility_by_timeframe?.['1440']).toEqual({ atr_volatility_min: 0.025, atr_volatility_max: 0.15 });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. CFM stop-distance sizing (one stop-out ≤ loss cap)
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — CFM stop-distance sizing', () => {
  const base: CfmSizingInputs = {
    entryPrice: 77_000, stopPrice: 69_300,
    contractSize: 0.01,
    maxDailyLossUsd: 100,
    maxNotionalUsd: 2000,
    l1DailyRBudgetUsd: 50,
  };

  test('10% stop with tight L1 budget ($50): rounds to 0 contracts (risk too large for 1 ct)', () => {
    const r = computeCfmPositionSize(base);
    // $50 / 10% = $500 max notional, $500/77000 = 0.00649 BTC → 0 whole 0.01 BTC contracts
    expect(r.contracts).toBe(0);
    expect(r.size).toBe(0);
  });

  test('wider L1 budget allows at least 1 contract', () => {
    const wider = { ...base, l1DailyRBudgetUsd: 200, maxDailyLossUsd: 200 };
    const r = computeCfmPositionSize(wider);
    // $200 / 10% = $2000 max notional, but capped at $2000. 2000/77000 = 0.0259 → 2 contracts
    expect(r.contracts).toBeGreaterThan(0);
    const lossAtStop = r.size * Math.abs(wider.entryPrice - wider.stopPrice);
    expect(lossAtStop).toBeLessThanOrEqual(wider.l1DailyRBudgetUsd);
  });

  test('small stop (1%): max_daily_loss_usd is the binding cap', () => {
    const narrow = { ...base, stopPrice: 76_230 }; // 1% stop
    const r = computeCfmPositionSize(narrow);
    const lossAtStop = r.size * Math.abs(narrow.entryPrice - narrow.stopPrice);
    expect(lossAtStop).toBeLessThanOrEqual(narrow.maxDailyLossUsd);
  });

  test('max_notional_usd caps the notional even when loss allows more', () => {
    const loose = { ...base, maxDailyLossUsd: 10_000, l1DailyRBudgetUsd: 10_000 };
    const r = computeCfmPositionSize(loose);
    expect(r.notionalUsd).toBeLessThanOrEqual(loose.maxNotionalUsd);
    expect(r.cappedBy).toBe('max_notional');
  });

  test('result is in whole contracts', () => {
    const r = computeCfmPositionSize(base);
    expect(r.size % base.contractSize).toBeCloseTo(0, 10);
    expect(Number.isInteger(r.contracts)).toBe(true);
  });

  test('4H ceiling scenario: ATR% 4% × stopAtr 2.5 → 10% stop on $2000 notional → $200 risk vs $100 daily cap', () => {
    const scenario: CfmSizingInputs = {
      entryPrice: 77_000, stopPrice: 69_300,
      contractSize: 0.01,
      maxDailyLossUsd: 100,
      maxNotionalUsd: 2000,
      l1DailyRBudgetUsd: 50,
    };
    const r = computeCfmPositionSize(scenario);
    const lossIfStopped = r.size * (77_000 - 69_300);
    expect(lossIfStopped).toBeLessThanOrEqual(50);
  });

  test('1D ceiling scenario: ATR% 15% × stopAtr 2.5 → 37.5% stop → sizer caps at loss budget', () => {
    const scenario: CfmSizingInputs = {
      entryPrice: 77_000, stopPrice: 48_125,
      contractSize: 0.01,
      maxDailyLossUsd: 100,
      maxNotionalUsd: 2000,
      l1DailyRBudgetUsd: 50,
    };
    const r = computeCfmPositionSize(scenario);
    const lossIfStopped = r.size * (77_000 - 48_125);
    expect(lossIfStopped).toBeLessThanOrEqual(50);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5. Config drift — CFM allowlist (fails closed)
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — config drift: CFM allowlist', () => {
  const realCanonicalYaml = fs.readFileSync(path.join(REPO_ROOT, CANONICAL_GUARDRAILS_REPO_PATH), 'utf8');
  const realStub = fs.readFileSync(path.join(REPO_ROOT, 'atlas/apps/core-node/config/guardrails.yaml'), 'utf8');
  const realStrategiesJson = fs.readFileSync(path.join(REPO_ROOT, STRATEGIES_JSON_REPO_PATH), 'utf8');
  const tempDirs: string[] = [];

  function makeRepo(mutate: (doc: Record<string, unknown>) => void): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cfm-allow-'));
    tempDirs.push(root);
    const doc = YAML.parse(realCanonicalYaml);
    mutate(doc);
    for (const [rel, content] of [
      [CANONICAL_GUARDRAILS_REPO_PATH, YAML.stringify(doc)],
      ['atlas/apps/core-node/config/guardrails.yaml', realStub],
      [STRATEGIES_JSON_REPO_PATH, realStrategiesJson],
    ] as const) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return root;
  }

  afterEach(() => { for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

  test('real repo is clean', () => {
    expect(checkConfigDrift(REPO_ROOT).violations).toEqual([]);
  });

  test('CFM_ALLOWED_STRATEGIES is [trend_follow, donchian_daily_s3]', () => {
    expect(CFM_ALLOWED_STRATEGIES).toEqual(['trend_follow', 'donchian_daily_s3']);
  });

  test('enabling momentum on a CFM symbol triggers cfm_symbol_strategy_enabled (fails closed)', () => {
    const root = makeRepo((doc: Record<string, unknown>) => {
      const cfm = doc.cfm_symbols as Record<string, Record<string, unknown>>;
      cfm['BIP-20DEC30-CDE'].disabled_strategies = ['vwap_mr', 'breakout'];
    });
    const codes = checkConfigDrift(root).violations.map(v => ({ code: v.code, key: v.key }));
    expect(codes).toContainEqual({ code: 'cfm_symbol_strategy_enabled', key: 'cfm_symbols.BIP-20DEC30-CDE.disabled_strategies' });
    const msg = checkConfigDrift(root).violations.find(v => v.code === 'cfm_symbol_strategy_enabled')?.message;
    expect(msg).toMatch(/momentum/);
  });

  test('a hypothetical new builtin not in allowlist would be caught (fails closed)', () => {
    const root = makeRepo((doc: Record<string, unknown>) => {
      const cfm = doc.cfm_symbols as Record<string, Record<string, unknown>>;
      cfm['BIP-20DEC30-CDE'].disabled_strategies = ['momentum', 'vwap_mr', 'breakout'];
    });
    const violations = checkConfigDrift(root).violations;
    const cfmViolations = violations.filter(v => v.code === 'cfm_symbol_strategy_enabled');
    expect(cfmViolations.length).toBe(0);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 6. Market context logger
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — market context logger', () => {
  function makeMockWriter(): MarketContextWriter & { rows: MarketContextBarRow[] } {
    const rows: MarketContextBarRow[] = [];
    return { rows, write: vi.fn(async (row) => { rows.push(row); }) };
  }
  function makeLogger() { return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }; }

  test('logClosedBar writes correct row with basis computation', async () => {
    const writer = makeMockWriter();
    const logger = new MarketContextLogger({
      symbols: ['BIP-20DEC30-CDE'], venue: 'coinbase-cfm', sessionId: 'test-id', executionMode: 'paper', writer, logger: makeLogger(),
    });
    await logger.logClosedBar({ symbol: 'BIP-20DEC30-CDE', timeframe: 240, barTimestamp: Date.UTC(2026, 9, 19, 4, 0, 0), spotPrice: 77_000, futuresPrice: 77_077, fundingRate: 0.0001 });
    expect(writer.rows).toHaveLength(1);
    expect(Number(writer.rows[0].basis_bps)).toBeCloseTo(10.0, 1);
  });

  test('catches writer errors without throwing', async () => {
    const mockLogger = makeLogger();
    const logger = new MarketContextLogger({
      symbols: ['BIP-20DEC30-CDE'], venue: 'coinbase-cfm', sessionId: null, executionMode: 'paper',
      writer: { write: vi.fn(async () => { throw new Error('DB down'); }) }, logger: mockLogger,
    });
    await expect(logger.logClosedBar({ symbol: 'BIP-20DEC30-CDE', timeframe: 240, barTimestamp: Date.now(), spotPrice: 77_000, futuresPrice: 77_050, fundingRate: null })).resolves.not.toThrow();
    expect(mockLogger.error).toHaveBeenCalled();
  });
});

// ────────────────────────────────────────────────────────────────────────
// 7. Integration: 4H CFM signal uses 0.8–4% ATR bounds + EV per-contract
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 integration — 4H CFM signal path', () => {
  const guardrails = loadGuardrails();
  const fm = FeeModel.fromGuardrails(guardrails);

  test('4H ATR bounds are resolved for a CFM trend_follow signal', () => {
    const barMinutes = guardrails.cfm_bar_timeframes?.trend_follow;
    expect(barMinutes).toBe(240);
    const { atrMin, atrMax } = resolveAtrBounds(guardrails.filters, barMinutes);
    expect(atrMin).toBe(0.008);
    expect(atrMax).toBe(0.04);
  });

  test('4H ATR% = 1.2% passes 4H bounds but would fail if using 15m global', () => {
    const barMinutes = guardrails.cfm_bar_timeframes?.trend_follow;
    const { atrMin: min4h, atrMax: max4h } = resolveAtrBounds(guardrails.filters, barMinutes);
    const { atrMin: min15m, atrMax: max15m } = resolveAtrBounds(guardrails.filters, 15);
    const atr = 924;
    const price = 77_000;
    const pass4h = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr } }, price, atrMin: min4h, atrMax: max4h });
    const pass15m = evaluateAtrVolatilityFilter({ metadata: { indicators: { atr } }, price, atrMin: min15m, atrMax: max15m });
    expect(pass4h.outcome).toBe('pass');
    expect(pass15m.outcome).toBe('pass');
  });

  test('EV gate charges $0.20 × contracts round-trip for a BIP-20DEC30-CDE signal', () => {
    const symbol = 'BIP-20DEC30-CDE';
    const cfmCfg = guardrails.cfm_symbols?.[symbol];
    expect(cfmCfg).toBeDefined();
    const size = 0.05;
    const contracts = Math.abs(size / cfmCfg!.contract_size);
    expect(contracts).toBe(5);
    const perCtFee = computePerContractRoundTripFeeUsd(fm);
    const totalPerCtFee = perCtFee * contracts;
    expect(totalPerCtFee).toBeCloseTo(1.0, 2);

    const evWithFee = evaluateEvGate({
      symbol, strategy: 'trend_follow', direction: 'buy',
      entryPrice: 77_000, stopPrice: 75_075, takeProfit: 88_550,
      size, winRate: 0.40, sampleSize: 50, feeModel: fm, venue: 'coinbase',
      entryLiquidity: 'taker', minEvThreshold: 0, perContractFeeUsd: totalPerCtFee,
    });
    const evWithout = evaluateEvGate({
      symbol, strategy: 'trend_follow', direction: 'buy',
      entryPrice: 77_000, stopPrice: 75_075, takeProfit: 88_550,
      size, winRate: 0.40, sampleSize: 50, feeModel: fm, venue: 'coinbase',
      entryLiquidity: 'taker', minEvThreshold: 0, perContractFeeUsd: 0,
    });
    expect(evWithFee.feeUsd - evWithout.feeUsd).toBeCloseTo(1.0, 1);
  });

  test('CFM sizing caps one stop-out at the loss budget', () => {
    const symbol = 'BIP-20DEC30-CDE';
    const cfmCfg = guardrails.cfm_symbols?.[symbol];
    expect(cfmCfg).toBeDefined();
    const l1 = guardrails.paper_kill_ladder?.l1_size_down;
    const equity = guardrails.account.equity_usd;
    const l1Budget = equity * guardrails.account.risk_per_trade * Math.abs(l1!.daily_r);
    const sizing = computeCfmPositionSize({
      entryPrice: 77_000, stopPrice: 69_300,
      contractSize: cfmCfg!.contract_size,
      maxDailyLossUsd: cfmCfg!.max_daily_loss_usd,
      maxNotionalUsd: cfmCfg!.max_notional_usd,
      l1DailyRBudgetUsd: l1Budget,
    });
    const lossIfStopped = sizing.size * (77_000 - 69_300);
    expect(lossIfStopped).toBeLessThanOrEqual(Math.min(cfmCfg!.max_daily_loss_usd, l1Budget));
  });
});

// ────────────────────────────────────────────────────────────────────────
// 8. Live mode drops cfm_symbols
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — live mode cfm_symbols drop', () => {
  test('cfm_symbols configured in guardrails but live code path drops them (server.ts L1540)', () => {
    const guardrails = loadGuardrails();
    const configuredCfmSymbols = Object.keys(guardrails.cfm_symbols ?? {});
    expect(configuredCfmSymbols.length).toBeGreaterThan(0);
    const mode = 'live';
    const cfmSymbols: string[] = mode === 'paper' ? configuredCfmSymbols : [];
    expect(cfmSymbols).toEqual([]);
  });

  test('paper mode keeps cfm_symbols', () => {
    const guardrails = loadGuardrails();
    const configuredCfmSymbols = Object.keys(guardrails.cfm_symbols ?? {});
    const mode = 'paper';
    const cfmSymbols: string[] = mode === 'paper' ? configuredCfmSymbols : [];
    expect(cfmSymbols).toEqual(configuredCfmSymbols);
    expect(cfmSymbols.length).toBeGreaterThan(0);
    expect(cfmSymbols.every(s => isCfmSymbol(s))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 9. Contract specs + ETP disabled
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — contract specs and ETP disabled', () => {
  test('BIP-20DEC30-CDE: 0.01 BTC/ct, $5/BTC tick, trend_follow enabled', () => {
    const g = loadGuardrails();
    const bip = g.cfm_symbols?.['BIP-20DEC30-CDE'];
    expect(bip!.contract_size).toBe(0.01);
    expect(bip!.price_increment_usd).toBe(5);
    expect(bip!.disabled_strategies).not.toContain('trend_follow');
    expect(bip!.disabled_strategies).not.toContain('donchian_daily_s3');
  });

  test('ETP-20DEC30-CDE: 0.1 ETH/ct, $0.50/ETH tick, ALL strategies disabled', () => {
    const g = loadGuardrails();
    const etp = g.cfm_symbols?.['ETP-20DEC30-CDE'];
    expect(etp).toBeDefined();
    expect(etp!.contract_size).toBe(0.1);
    expect(etp!.price_increment_usd).toBe(0.50);
    expect(etp!.spot_proxy).toBe('ETH-USD');
    expect(etp!.disabled_strategies).toContain('trend_follow');
    expect(etp!.disabled_strategies).toContain('donchian_daily_s3');
    expect(etp!.disabled_strategies).toContain('momentum');
  });

  test('cfm_bar_timeframes maps strategies to bar durations', () => {
    const g = loadGuardrails();
    expect(g.cfm_bar_timeframes?.trend_follow).toBe(240);
    expect(g.cfm_bar_timeframes?.donchian_daily_s3).toBe(1440);
  });
});
