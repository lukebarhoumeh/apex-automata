import { describe, test, expect } from 'vitest';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig, GuardrailConfig } from '../config/loadGuardrails';

const FIXTURE_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: {
    perps: { maker_bps: -1.5, taker_bps: 4.5 },
  },
};

describe('FeeModel', () => {
  test('getFeeBps returns Coinbase spot maker/taker from config', () => {
    const fm = new FeeModel(FIXTURE_FEES);
    expect(fm.getFeeBps('coinbase', 'spot', 'maker')).toBe(25);
    expect(fm.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
  });

  test('getFeeBps returns Coinbase perps (INTX) maker/taker from config', () => {
    const fm = new FeeModel(FIXTURE_FEES);
    expect(fm.getFeeBps('coinbase', 'perps', 'maker')).toBe(0);
    expect(fm.getFeeBps('coinbase', 'perps', 'taker')).toBe(5);
  });

  test('getFeeBps returns Hyperliquid maker rebate (negative) and taker fee', () => {
    const fm = new FeeModel(FIXTURE_FEES);
    expect(fm.getFeeBps('hyperliquid', 'perps', 'maker')).toBe(-1.5);
    expect(fm.getFeeBps('hyperliquid', 'perps', 'taker')).toBe(4.5);
  });

  test('getFeeRate converts bps to decimal (bps / 10_000)', () => {
    const fm = new FeeModel(FIXTURE_FEES);
    expect(fm.getFeeRate('coinbase', 'spot', 'taker')).toBeCloseTo(0.004, 12);
    expect(fm.getFeeRate('coinbase', 'perps', 'taker')).toBeCloseTo(0.0005, 12);
    expect(fm.getFeeRate('hyperliquid', 'perps', 'maker')).toBeCloseTo(-0.00015, 12);
  });

  test('fromGuardrails reads the nested fees block off a full GuardrailConfig', () => {
    const guardrails = { fees: FIXTURE_FEES } as unknown as GuardrailConfig;
    const fm = FeeModel.fromGuardrails(guardrails);
    expect(fm.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
  });

  test('throws clearly when exchange/market combination is unconfigured', () => {
    const fm = new FeeModel(FIXTURE_FEES);
    expect(() => fm.getFeeBps('hyperliquid', 'spot', 'taker')).toThrow(/no fee configuration/i);
    expect(() => fm.getFeeBps('binance', 'spot', 'taker')).toThrow(/exchange='binance'/);
  });

  test('error message points operators at the YAML, not the code', () => {
    const fm = new FeeModel(FIXTURE_FEES);
    expect(() => fm.getFeeBps('kraken', 'spot', 'maker')).toThrow(/guardrails\.yaml/);
  });
});

/**
 * Live-tier runtime override — Risk-lane additions on top of TASK_011's
 * `withRuntimeOverride` (bucket/rate validation and the yaml-model
 * immutability are covered in live-account-truth.test.ts). These pin what
 * the EV gate plumbing relies on: the GuardrailConfig object itself is never
 * written back to, re-applying a tier replaces rather than stacks, and the
 * override list is inspectable for logs / status.
 */
describe('FeeModel.withRuntimeOverride (risk-lane invariants)', () => {
  const INTRO_1 = {
    venue: 'coinbase' as const,
    product: 'spot' as const,
    makerBps: 60,
    takerBps: 120,
    source: 'coinbase:Intro 1',
  };

  test('fromGuardrails + override never writes back into the GuardrailConfig object', () => {
    const guardrails = { fees: JSON.parse(JSON.stringify(FIXTURE_FEES)) } as unknown as GuardrailConfig;
    const before = JSON.stringify(guardrails);

    const base = FeeModel.fromGuardrails(guardrails);
    const live = base.withRuntimeOverride(INTRO_1);

    expect(live.getFeeBps('coinbase', 'spot', 'taker')).toBe(120);
    expect(live.getFeeRate('coinbase', 'spot', 'taker')).toBeCloseTo(0.012, 12);
    expect(JSON.stringify(guardrails)).toBe(before);
    expect(guardrails.fees.coinbase.spot.taker_bps).toBe(40);
    expect(base.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
    expect(base.getRuntimeOverrides()).toEqual([]);
  });

  test('a second override for the same bucket replaces the first; other buckets accumulate', () => {
    const live = new FeeModel(FIXTURE_FEES)
      .withRuntimeOverride(INTRO_1)
      .withRuntimeOverride({ venue: 'coinbase', product: 'spot', makerBps: 40, takerBps: 60, source: 'Intro 2' })
      .withRuntimeOverride({ venue: 'coinbase', product: 'perps', makerBps: 2, takerBps: 8 });

    expect(live.getFeeBps('coinbase', 'spot', 'taker')).toBe(60);
    expect(live.getFeeBps('coinbase', 'perps', 'taker')).toBe(8);
    expect(live.getFeeBps('hyperliquid', 'perps', 'maker')).toBe(-1.5); // untouched yaml bucket
    expect(live.getRuntimeOverrides()).toHaveLength(2);
    expect(live.getRuntimeOverrides().map((o) => `${o.venue}:${o.product}:${o.takerBps}`)).toEqual([
      'coinbase:spot:60',
      'coinbase:perps:8',
    ]);
    expect(live.hasRuntimeOverride('coinbase', 'spot')).toBe(true);
    expect(live.hasRuntimeOverride('hyperliquid', 'perps')).toBe(false);
  });

  test('each override returns a distinct model; earlier models keep their own tier', () => {
    const base = new FeeModel(FIXTURE_FEES);
    const intro1 = base.withRuntimeOverride(INTRO_1);
    const intro2 = intro1.withRuntimeOverride({ ...INTRO_1, makerBps: 40, takerBps: 60 });

    expect(intro2).not.toBe(intro1);
    expect(intro1.getFeeBps('coinbase', 'spot', 'taker')).toBe(120);
    expect(intro2.getFeeBps('coinbase', 'spot', 'taker')).toBe(60);
    expect(base.getFeeBps('coinbase', 'spot', 'taker')).toBe(40);
  });

  test('accepts a negative maker rebate (Hyperliquid) as a finite rate', () => {
    const live = new FeeModel(FIXTURE_FEES).withRuntimeOverride({
      venue: 'hyperliquid', product: 'perps', makerBps: -0.5, takerBps: 3.5,
    });
    expect(live.getFeeBps('hyperliquid', 'perps', 'maker')).toBe(-0.5);
    expect(live.getFeeBps('hyperliquid', 'perps', 'taker')).toBe(3.5);
  });
});
