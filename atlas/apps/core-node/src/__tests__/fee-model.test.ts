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
