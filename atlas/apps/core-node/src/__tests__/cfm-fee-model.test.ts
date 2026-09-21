/**
 * Tier-A Eng infra — card SH-QMAKER-CFM-PAPER-v0, blocker 4:
 * CFM FeeModel bucket + `*-CDE` product classification.
 *
 * Cite locks pinned here (never mix books):
 *   - `CFM-NANO-H1-v0.2` + `CFM-NANO-COSTPLUS-ADV1` — futures maker 9.5 / taker
 *     10 bps PLUS a $0.10/contract/side exchange floor, STACKED not blended.
 *     DRAFT working model, not v1.0.
 *   - `PAPER-FeeModel-SPOT-25-40` — paper spot book stays 25/40; it is neither
 *     the live Intro tier (`SPOT-INTRO-50-90`) nor ever averaged into CFM.
 *
 * Numerical anchor: Luke 10-ct BIP limit-long preview @ 77715 (notional
 * $7,771.50) → cost-plus taker 10 bps = $7.7715 + 10 × $0.10 = $1.00 →
 * $8.7715, vs UI $8.96 (delta ~$0.19, directionally cost-plus, NOT the
 * exchange-only ~2.5 bps). Fee sheet §Call (working).
 */
import { describe, test, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { FeeModel, contractsForSize } from '../core/fee-model';
import { isCfmSymbol, marketForSymbol } from '../core/symbol-utils';
import {
  loadGuardrails,
  resolveCfmConfig,
  CFM_CHARTER_MAX_LEVERAGE,
  GuardrailsSchema,
  CANONICAL_GUARDRAILS_REPO_PATH,
  type FeesConfig,
} from '../config/loadGuardrails';
import { checkConfigDrift, STRATEGIES_JSON_REPO_PATH, type DriftViolationCode } from '../config/config-drift';
import { resolveRoutedExchange, ROUTED_EXCHANGE_COINBASE_CFM } from '../exchanges/signal-route';
import { capabilitiesForVenue, venueForSymbol, isShortingAllowed } from '../trading/execution/venue-capabilities';

const BIP = 'BIP-20DEC30-CDE';

const FEES_WITH_CFM: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
    cfm_nano: { maker_bps: 9.5, taker_bps: 10, exchange_fee_per_contract_usd: 0.1 },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};

const FEES_WITHOUT_CFM: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};

describe('symbol classification — *-CDE is its own market bucket', () => {
  test('marketForSymbol routes CDE futures to `cfm`, INTX to `perps`, everything else to `spot`', () => {
    expect(marketForSymbol(BIP)).toBe('cfm');
    expect(marketForSymbol('ETP-20DEC30-CDE')).toBe('cfm');
    expect(marketForSymbol('BIT-25SEP26-CDE')).toBe('cfm');
    expect(marketForSymbol('BTC-PERP-INTX')).toBe('perps');
    expect(marketForSymbol('BTC-USD')).toBe('spot');
    expect(marketForSymbol('SOL-USD')).toBe('spot');
  });

  test('isCfmSymbol is suffix-based and case-insensitive', () => {
    expect(isCfmSymbol(BIP)).toBe(true);
    expect(isCfmSymbol('bip-20dec30-cde')).toBe(true);
    expect(isCfmSymbol('BTC-PERP-INTX')).toBe(false);
    expect(isCfmSymbol('CDE-USD')).toBe(false);
  });

  test('router venue id for *-CDE is coinbase-cfm; spot and INTX ids are unchanged', () => {
    expect(resolveRoutedExchange(BIP)).toBe(ROUTED_EXCHANGE_COINBASE_CFM);
    expect(resolveRoutedExchange(BIP)).toBe('coinbase-cfm');
    expect(resolveRoutedExchange('ETH-USD')).toBe('coinbase');
    expect(resolveRoutedExchange('ETH-PERP-INTX')).toBe('coinbase-perps');
  });

  test('venue capabilities: futures can short (subject to allow_short); spot still cannot', () => {
    expect(venueForSymbol(BIP)).toBe('cfm');
    expect(capabilitiesForVenue('cfm')).toEqual({ shorting: true });
    expect(isShortingAllowed(true, 'cfm')).toBe(true);
    expect(isShortingAllowed(false, 'cfm')).toBe(false);
    expect(isShortingAllowed(true, 'spot')).toBe(false);
  });
});

describe('FeeModel — CFM cost-plus bucket (CFM-NANO-COSTPLUS-ADV1)', () => {
  const fm = new FeeModel(FEES_WITH_CFM);

  test('percentage legs are 9.5 bps maker / 10 bps taker', () => {
    expect(fm.getFeeBps('coinbase', 'cfm', 'maker')).toBe(9.5);
    expect(fm.getFeeBps('coinbase', 'cfm', 'taker')).toBe(10);
    expect(fm.getFeeRate('coinbase', 'cfm', 'maker')).toBeCloseTo(0.00095, 12);
    expect(fm.getFeeRate('coinbase', 'cfm', 'taker')).toBeCloseTo(0.001, 12);
  });

  test('exchange floor is $0.10 per contract per side and marks the book cost-plus', () => {
    expect(fm.getExchangeFeePerContractUsd('coinbase', 'cfm')).toBe(0.1);
    expect(fm.isCostPlus('coinbase', 'cfm')).toBe(true);
    expect(fm.getExchangeFeePerContractUsd('coinbase', 'spot')).toBe(0);
    expect(fm.isCostPlus('coinbase', 'spot')).toBe(false);
    expect(fm.isCostPlus('coinbase', 'perps')).toBe(false);
    expect(fm.isCostPlus('hyperliquid', 'perps')).toBe(false);
  });

  test('computeFillFeeUsd stacks % + $/ct — Luke 10-ct limit-long preview reconciles to $8.7715 (taker)', () => {
    const fee = fm.computeFillFeeUsd({
      exchange: 'coinbase',
      market: 'cfm',
      side: 'taker',
      notionalUsd: '7771.50', // 10 ct × 0.01 BTC × 77715
      contracts: 10,
    });
    expect(fee.commissionUsd).toBe('7.77150000');
    expect(fee.exchangeFeeUsd).toBe('1.00000000');
    expect(fee.totalUsd).toBe('8.77150000');
    expect(fee.rate).toBeCloseTo(0.001, 12);
    expect(fee.perContractUsd).toBe(0.1);
    // Sheet: $8.77 model vs $8.96 UI — cost-plus, not the exchange-only ~$0.20 RT.
    expect(Number(fee.totalUsd)).toBeCloseTo(8.77, 2);
    expect(Number(fee.totalUsd)).toBeGreaterThan(1.0);
  });

  test('maker leg of the same fill: 9.5 bps + floor = $8.382925; floor is identical on both sides', () => {
    const maker = fm.computeFillFeeUsd({ exchange: 'coinbase', market: 'cfm', side: 'maker', notionalUsd: 7771.5, contracts: '10' });
    expect(maker.commissionUsd).toBe('7.38292500');
    expect(maker.exchangeFeeUsd).toBe('1.00000000');
    expect(maker.totalUsd).toBe('8.38292500');
  });

  test('one-way all-in on the 10-ct preview is ~11.3 bps (model) — same order as the ~11.5 bps Luke observed', () => {
    const fee = fm.computeFillFeeUsd({ exchange: 'coinbase', market: 'cfm', side: 'taker', notionalUsd: 7771.5, contracts: 10 });
    const bps = (Number(fee.totalUsd) / 7771.5) * 10_000;
    expect(bps).toBeGreaterThan(11);
    expect(bps).toBeLessThan(12);
  });

  test('the floor dominates small tickets: 1 ct @ 77715 taker = $0.78 + $0.10 (≈ 11.3 bps, not 10)', () => {
    const fee = fm.computeFillFeeUsd({ exchange: 'coinbase', market: 'cfm', side: 'taker', notionalUsd: 777.15, contracts: 1 });
    expect(fee.commissionUsd).toBe('0.77715000');
    expect(fee.exchangeFeeUsd).toBe('0.10000000');
    expect(fee.totalUsd).toBe('0.87715000');
  });

  test('non cost-plus books ignore `contracts` and report a zero exchange leg', () => {
    const spot = fm.computeFillFeeUsd({ exchange: 'coinbase', market: 'spot', side: 'taker', notionalUsd: 1600, contracts: 99 });
    expect(spot.commissionUsd).toBe('6.40000000');
    expect(spot.exchangeFeeUsd).toBe('0');
    expect(spot.totalUsd).toBe('6.40000000');
    const hl = fm.computeFillFeeUsd({ exchange: 'hyperliquid', market: 'perps', side: 'maker', notionalUsd: 1000 });
    expect(hl.totalUsd).toBe('-0.15000000'); // rebate stays signed
  });

  test('contractsForSize converts underlying size to whole contracts exactly', () => {
    expect(contractsForSize('0.10', 0.01)).toBe('10.00000000');
    expect(contractsForSize(0.05, '0.01')).toBe('5.00000000');
    expect(contractsForSize('0.3', 0.1)).toBe('3.00000000');
  });

  test('books never mix: the spot bucket is untouched by the CFM bucket', () => {
    expect(fm.getFeeBps('coinbase', 'spot', 'maker')).toBe(25);
    expect(fm.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
    expect(fm.getFeeBps('coinbase', 'perps', 'taker')).toBe(5);
    expect(fm.getFeeBps('coinbase', 'cfm', 'taker')).not.toBe(fm.getFeeBps('coinbase', 'spot', 'taker'));
  });

  test('a fees block without cfm_nano fails loudly for *-CDE pricing instead of falling back to spot', () => {
    const noCfm = new FeeModel(FEES_WITHOUT_CFM);
    expect(() => noCfm.getFeeBps('coinbase', 'cfm', 'taker')).toThrow(/no fee configuration.*market='cfm'/);
    expect(() => noCfm.computeFillFeeUsd({ exchange: 'coinbase', market: 'cfm', side: 'taker', notionalUsd: 1 })).toThrow(/guardrails\.yaml/);
    expect(() => noCfm.getFeeBps('hyperliquid', 'cfm', 'taker')).toThrow(/no fee configuration/);
  });

  test('withRuntimeOverride on the cfm bucket replaces the % legs and keeps the $/ct floor', () => {
    const live = fm.withRuntimeOverride({ venue: 'coinbase', product: 'cfm', makerBps: 8, takerBps: 9, source: 'coinbase:FUTURE Intro' });
    expect(live.getFeeBps('coinbase', 'cfm', 'maker')).toBe(8);
    expect(live.getFeeBps('coinbase', 'cfm', 'taker')).toBe(9);
    expect(live.getExchangeFeePerContractUsd('coinbase', 'cfm')).toBe(0.1);
    expect(live.hasRuntimeOverride('coinbase', 'cfm')).toBe(true);
    // Immutable: the yaml model is untouched.
    expect(fm.getFeeBps('coinbase', 'cfm', 'maker')).toBe(9.5);
    expect(fm.hasRuntimeOverride('coinbase', 'cfm')).toBe(false);
  });
});

describe('canonical guardrails.yaml — CFM bucket + paper symbols load', () => {
  test('fees.coinbase.cfm_nano is present with the cite-locked values', () => {
    const guardrails = loadGuardrails();
    expect(guardrails.fees.coinbase.cfm_nano).toEqual({
      maker_bps: 9.5,
      taker_bps: 10,
      exchange_fee_per_contract_usd: 0.1,
    });
    const fm = FeeModel.fromGuardrails(guardrails);
    expect(fm.getFeeBps('coinbase', 'cfm', 'maker')).toBe(9.5);
    expect(fm.getFeeBps('coinbase', 'cfm', 'taker')).toBe(10);
    expect(fm.isCostPlus('coinbase', 'cfm')).toBe(true);
    // and the paper spot book is still PAPER-FeeModel-SPOT-25-40
    expect(fm.getFeeBps('coinbase', 'spot', 'maker')).toBe(25);
    expect(fm.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
  });

  test('cfm venue block: Charter ≤2×, true post-only, no chase, Fri-break leads', () => {
    const guardrails = loadGuardrails();
    const cfm = resolveCfmConfig(guardrails);
    expect(cfm.max_leverage).toBe(2);
    expect(cfm.max_leverage).toBeLessThanOrEqual(CFM_CHARTER_MAX_LEVERAGE);
    expect(cfm.execution.order_type).toBe('post_only');
    expect(cfm.execution.no_chase).toBe(true);
    expect(cfm.execution.max_requotes_per_sec).toBe(4);
    expect(cfm.hours_gap.entry_block_lead_min).toBe(30);
    expect(cfm.hours_gap.flatten_lead_min).toBe(10);
  });

  test('BIP-20DEC30-CDE paper symbol carries the CDE spec, a spot proxy, and disables every strategy', () => {
    const guardrails = loadGuardrails();
    const bip = guardrails.cfm_symbols?.[BIP];
    expect(bip).toBeDefined();
    expect(bip!.contract_size).toBe(0.01);
    expect(bip!.price_increment_usd).toBe(5);
    expect(bip!.spot_proxy).toBe('BTC-USD');
    expect(Object.keys(guardrails.per_symbol ?? {})).toContain(bip!.spot_proxy);
    expect(bip!.disabled_strategies).toEqual(expect.arrayContaining(['trend_follow', 'momentum', 'vwap_mr', 'breakout']));
    // ETP is deliberately not wired (hours / tick UNVERIFIED on the ETP spec).
    expect(guardrails.cfm_symbols?.['ETP-20DEC30-CDE']).toBeUndefined();
  });

  test('resolveCfmConfig falls back to Charter defaults when the block is absent', () => {
    const cfm = resolveCfmConfig({});
    expect(cfm.max_leverage).toBe(2);
    expect(cfm.execution.order_type).toBe('post_only');
    expect(cfm.execution.no_chase).toBe(true);
    expect(cfm.hours_gap).toEqual({ entry_block_lead_min: 30, flatten_lead_min: 10 });
  });
});

describe('GuardrailsSchema — the CFM venue cannot be configured past the desk constraints', () => {
  const base = () => YAML.parse(fs.readFileSync(path.join(REPO_ROOT, CANONICAL_GUARDRAILS_REPO_PATH), 'utf8'));

  test('cfm.max_leverage above 2 is rejected at load time', () => {
    const doc = base();
    doc.cfm.max_leverage = 4.1; // the venue preview leverage
    expect(() => GuardrailsSchema.parse(doc)).toThrow(/max_leverage|less than or equal to 2/i);
  });

  test('cfm.execution.order_type accepts only post_only (no marketable_limit / market on this venue)', () => {
    for (const bad of ['marketable_limit', 'market', 'limit']) {
      const doc = base();
      doc.cfm.execution.order_type = bad;
      expect(() => GuardrailsSchema.parse(doc)).toThrow();
    }
  });

  test('cfm.execution.no_chase cannot be switched off', () => {
    const doc = base();
    doc.cfm.execution.no_chase = false;
    expect(() => GuardrailsSchema.parse(doc)).toThrow();
  });

  test('cfm_symbols keys must be *-CDE products and the flatten lead cannot exceed the entry-block lead', () => {
    const doc = base();
    doc.cfm_symbols['BTC-PERP-INTX'] = doc.cfm_symbols[BIP];
    expect(() => GuardrailsSchema.parse(doc)).toThrow(/-CDE/);

    const doc2 = base();
    doc2.cfm.hours_gap = { entry_block_lead_min: 5, flatten_lead_min: 10 };
    expect(() => GuardrailsSchema.parse(doc2)).toThrow(/flatten_lead_min/);
  });

  test('cfm_nano requires the per-contract floor (a % only entry is not the cost-plus book)', () => {
    const doc = base();
    delete doc.fees.coinbase.cfm_nano.exchange_fee_per_contract_usd;
    expect(() => GuardrailsSchema.parse(doc)).toThrow(/exchange_fee_per_contract_usd/);
  });
});

// ----------------------------------------------------------------------------
// Drift check: the fee books and the "no strategy on CFM" invariant are pinned.
// ----------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const STUB_REPO_PATH = 'atlas/apps/core-node/config/guardrails.yaml';
const realCanonicalYaml = fs.readFileSync(path.join(REPO_ROOT, CANONICAL_GUARDRAILS_REPO_PATH), 'utf8');
const realStub = fs.readFileSync(path.join(REPO_ROOT, STUB_REPO_PATH), 'utf8');
const realStrategiesJson = fs.readFileSync(path.join(REPO_ROOT, STRATEGIES_JSON_REPO_PATH), 'utf8');

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRepo(mutate: (doc: Record<string, any>) => void): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-cfm-drift-'));
  tempDirs.push(root);
  const doc = YAML.parse(realCanonicalYaml);
  mutate(doc);
  for (const [rel, content] of [
    [CANONICAL_GUARDRAILS_REPO_PATH, YAML.stringify(doc)],
    [STUB_REPO_PATH, realStub],
    [STRATEGIES_JSON_REPO_PATH, realStrategiesJson],
  ] as const) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function codesFor(root: string): Array<{ code: DriftViolationCode; key?: string }> {
  return checkConfigDrift(root).violations.map((v) => ({ code: v.code, key: v.key }));
}

describe('config drift — CFM pins', () => {
  test('real repo is clean', () => {
    expect(checkConfigDrift(REPO_ROOT).violations).toEqual([]);
  });

  test('moving the CFM book toward the spot book is a pin_mismatch (books never mix)', () => {
    const root = makeRepo((doc) => {
      doc.fees.coinbase.cfm_nano.taker_bps = 40;
    });
    expect(codesFor(root)).toContainEqual({ code: 'pin_mismatch', key: 'fees.coinbase.cfm_nano.taker_bps' });
  });

  test('moving the paper spot book toward live Intro (50/90) is a pin_mismatch', () => {
    const root = makeRepo((doc) => {
      doc.fees.coinbase.spot.maker_bps = 50;
      doc.fees.coinbase.spot.taker_bps = 90;
    });
    const codes = codesFor(root);
    expect(codes).toContainEqual({ code: 'pin_mismatch', key: 'fees.coinbase.spot.maker_bps' });
    expect(codes).toContainEqual({ code: 'pin_mismatch', key: 'fees.coinbase.spot.taker_bps' });
  });

  test('dropping the $/ct floor is a pin_mismatch', () => {
    const root = makeRepo((doc) => {
      doc.fees.coinbase.cfm_nano.exchange_fee_per_contract_usd = 0;
    });
    expect(codesFor(root)).toContainEqual({ code: 'pin_mismatch', key: 'fees.coinbase.cfm_nano.exchange_fee_per_contract_usd' });
  });

  test('lowering cfm.max_leverage below Charter is a pin_mismatch (the pin is exact, the schema caps the ceiling)', () => {
    const root = makeRepo((doc) => {
      doc.cfm.max_leverage = 1.5;
    });
    expect(codesFor(root)).toContainEqual({ code: 'pin_mismatch', key: 'cfm.max_leverage' });
  });

  test('enabling any built-in strategy on the CFM paper symbol is a violation (infra only, NOT strategy GO)', () => {
    const root = makeRepo((doc) => {
      doc.cfm_symbols[BIP].disabled_strategies = ['momentum', 'vwap_mr', 'breakout']; // trend_follow re-enabled
    });
    const codes = codesFor(root);
    expect(codes).toContainEqual({ code: 'cfm_symbol_strategy_enabled', key: `cfm_symbols.${BIP}.disabled_strategies` });
    expect(checkConfigDrift(root).violations.find((v) => v.code === 'cfm_symbol_strategy_enabled')?.message).toMatch(/trend_follow/);
  });

  test('a spot_proxy that is not a subscribed per_symbol product is a violation (no quote path)', () => {
    const root = makeRepo((doc) => {
      doc.cfm_symbols[BIP].spot_proxy = 'XRP-USD';
    });
    expect(codesFor(root)).toContainEqual({ code: 'cfm_symbol_proxy_missing', key: `cfm_symbols.${BIP}.spot_proxy` });
  });
});
