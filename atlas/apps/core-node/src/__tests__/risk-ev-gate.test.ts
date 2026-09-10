/**
 * A3 — Pre-trade fee-adjusted EV gate tests (#A3, 2026-05-18).
 *
 * Targets the pure-math `evaluateEvGate` helper from
 * `trading/risk/ev-gate.ts`. RiskEngine.evaluateSignalEv is a thin
 * wrapper (config plumbing + counter labels) so we don't need to
 * instantiate the full RiskEngine (with Supabase + PositionTracker) to
 * exercise the math.
 *
 * EV formula:
 *   EV = p * (TP_R * size) - (1 - p) * (SL_R * size) - 2 * fee_rate * notional
 *
 * Spec coverage (per prompt):
 *   - positive-EV signal passes
 *   - negative-EV signal rejected
 *   - threshold-edge behaviour (EV exactly == threshold → pass)
 *   - missing-p (winRate null) default-allows with a warn
 */
import { describe, it, expect, vi } from 'vitest';
import { evaluateEvGate, type EvGateInputs } from '../trading/risk/ev-gate';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig } from '../config/loadGuardrails';

function makeLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

// Distinct rates per bucket so any cross-bucket leak is visible.
const TEST_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },        // 0.0040 taker
    perps_intx: { maker_bps: 0, taker_bps: 5 },    // 0.0005 taker
  },
  hyperliquid: {
    perps: { maker_bps: -1.5, taker_bps: 4.5 },    // 0.00045 taker
  },
};

const TEST_FEE_MODEL = new FeeModel(TEST_FEES);

function baseInputs(overrides: Partial<EvGateInputs> = {}): EvGateInputs {
  return {
    symbol: 'BTC-USD',
    strategy: 'momentum',
    direction: 'buy',
    entryPrice: 50_000,
    stopPrice: 49_000,    // SL distance = $1,000 / unit
    takeProfit: 53_000,   // TP distance = $3,000 / unit (3R)
    size: 0.02,           // notional = $1,000
    winRate: 0.5,
    feeModel: TEST_FEE_MODEL,
    minEvThreshold: 0,
    venue: 'coinbase',
    ...overrides,
  };
}

describe('evaluateEvGate — A3 pre-trade EV math', () => {
  it('positive-EV signal passes (3R TP, 50% WR, spot fees)', () => {
    // expected ev:
    //   gross win  = 0.5 * 3000 * 0.02 = $30
    //   gross loss = 0.5 * 1000 * 0.02 = $10
    //   round-trip fee = 2 * 0.004 * 1000 = $8
    //   ev = 30 - 10 - 8 = $12  → passes (>= 0)
    const result = evaluateEvGate(baseInputs(), makeLogger());
    expect(result.allowed).toBe(true);
    expect(result.ev).toBeCloseTo(12, 6);
    expect(result.feeUsd).toBeCloseTo(8, 6);
    expect(result.p).toBeCloseTo(0.5, 6);
    expect(result.reason).toBeUndefined();
  });

  it('negative-EV signal rejected (40% WR, 1.5R TP, spot fees)', () => {
    // 40% WR on a 1.5R TP:
    //   gross win  = 0.4 * 1500 * 0.02 = $12
    //   gross loss = 0.6 * 1000 * 0.02 = $12
    //   fee = 2 * 0.004 * 1000 = $8
    //   ev = 12 - 12 - 8 = -$8  → rejected
    const result = evaluateEvGate(
      baseInputs({ winRate: 0.4, takeProfit: 51_500 }),
      makeLogger(),
    );
    expect(result.allowed).toBe(false);
    expect(result.ev).toBeCloseTo(-8, 6);
    expect(result.reason).toMatch(/EV.*-8\.00.*threshold.*0\.00/);
  });

  it('threshold-edge: EV exactly equal to min_ev_threshold passes', () => {
    // Construct a trade where EV is exactly $5, with threshold $5.
    // gross_win - gross_loss = ev + fee = 5 + 8 = 13
    // → tpDist * 0.5 * size - slDist * 0.5 * size = 13
    // → (tpDist - slDist) * 0.5 * 0.02 = 13
    // → tpDist - slDist = 1300
    // Use slDist=1000 (stop at 49000), so tpDist=2300 (TP at 52300).
    const result = evaluateEvGate(
      baseInputs({ takeProfit: 52_300, minEvThreshold: 5 }),
      makeLogger(),
    );
    expect(result.allowed).toBe(true);
    expect(result.ev).toBeCloseTo(5, 6);
    expect(result.threshold).toBe(5);
  });

  it('threshold-edge: EV one cent below threshold is rejected', () => {
    // Same construction as above but bump threshold to 5.01.
    const result = evaluateEvGate(
      baseInputs({ takeProfit: 52_300, minEvThreshold: 5.01 }),
      makeLogger(),
    );
    expect(result.allowed).toBe(false);
    expect(result.ev).toBeCloseTo(5, 6);
  });

  it('missing winRate (null) default-allows + logs warn (cold-start safe)', () => {
    const logger = makeLogger();
    const result = evaluateEvGate(baseInputs({ winRate: null }), logger);
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('missing_win_rate_default_allow');
    expect(result.p).toBe(0);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('EV gate: no MetaFilter win-rate'),
      expect.objectContaining({ symbol: 'BTC-USD', strategy: 'momentum' }),
    );
    // Fees were still computed so the surface reports them honestly.
    expect(result.feeUsd).toBeCloseTo(8, 6);
  });

  it('missing winRate (undefined) default-allows', () => {
    const result = evaluateEvGate(baseInputs({ winRate: undefined }), makeLogger());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('missing_win_rate_default_allow');
  });

  it('routes perp symbol to perps_intx fee tier (5 bps not 40 bps)', () => {
    // Same TP/SL geometry as the spot pass test but on ETH-PERP-INTX.
    //   notional = 0.02 * 50000 = $1,000
    //   perps fee = 2 * 0.0005 * 1000 = $1 (vs spot $8)
    //   gross win = $30, gross loss = $10
    //   ev = 30 - 10 - 1 = $19 (vs spot $12)
    const result = evaluateEvGate(
      baseInputs({ symbol: 'ETH-PERP-INTX' }),
      makeLogger(),
    );
    expect(result.allowed).toBe(true);
    expect(result.feeUsd).toBeCloseTo(1, 6);
    expect(result.ev).toBeCloseTo(19, 6);
  });

  it('feeRateOverride wins over FeeModel (sensitivity-analysis path)', () => {
    // Force 4.5 bps (HL taker) even on a spot symbol.
    const result = evaluateEvGate(
      baseInputs({ feeRateOverride: 0.00045 }),
      makeLogger(),
    );
    expect(result.feeUsd).toBeCloseTo(2 * 0.00045 * 1000, 6); // = 0.9
    expect(result.allowed).toBe(true);
  });

  it('clamps winRate to [0, 1] when caller passes garbage', () => {
    const result = evaluateEvGate(baseInputs({ winRate: 1.5 }), makeLogger());
    // p clamped to 1.0 → gross_win=$60, gross_loss=$0, fee=$8, ev=$52
    expect(result.p).toBe(1);
    expect(result.ev).toBeCloseTo(60 - 0 - 8, 6);
    expect(result.allowed).toBe(true);
  });

  it('missing TP geometry default-allows (signal still has SL)', () => {
    const result = evaluateEvGate(baseInputs({ takeProfit: 0 }), makeLogger());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('missing_geometry_default_allow');
  });

  it('missing SL geometry default-allows', () => {
    const result = evaluateEvGate(baseInputs({ stopPrice: 0 }), makeLogger());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('missing_geometry_default_allow');
  });

  it('invalid entryPrice default-allows', () => {
    const result = evaluateEvGate(baseInputs({ entryPrice: 0 }), makeLogger());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('invalid_inputs_default_allow');
  });

  it('no FeeModel + no override default-allows', () => {
    const inputs = baseInputs();
    delete (inputs as any).feeModel;
    const result = evaluateEvGate(inputs, makeLogger());
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('no_fee_model_default_allow');
  });

  it('positive minEvThreshold rejects barely-positive EV', () => {
    // baseInputs has ev=$12; raise threshold to $15.
    const result = evaluateEvGate(
      baseInputs({ minEvThreshold: 15 }),
      makeLogger(),
    );
    expect(result.allowed).toBe(false);
    expect(result.ev).toBeCloseTo(12, 6);
    expect(result.threshold).toBe(15);
  });
});

/**
 * Live-tier fee plumbing (Sprint 9): when the FeeModel carries a runtime
 * override the gate prices on that tier. Worked example behind the PR's
 * fee-impact note: the marginal 3R / 50% WR spot signal that passes at the
 * YAML 40 bps taker is rejected at Coinbase Intro 1 (120 bps).
 */
describe('evaluateEvGate — live-tier FeeModel override', () => {
  const LIVE_TIER_MODEL = TEST_FEE_MODEL.withRuntimeOverride({
    venue: 'coinbase',
    product: 'spot',
    makerBps: 60,
    takerBps: 120,
    source: 'coinbase:Intro 1',
  });

  it('YAML default: 40 bps per leg, $8 round trip, EV +$12 → allowed', () => {
    const result = evaluateEvGate(baseInputs(), makeLogger());
    expect(result.entryFeeRate).toBeCloseTo(0.004, 12);
    expect(result.exitFeeRate).toBeCloseTo(0.004, 12);
    expect(result.feeUsd).toBeCloseTo(8, 6);
    expect(result.ev).toBeCloseTo(12, 6);
    expect(result.allowed).toBe(true);
  });

  it('Intro-1 override: 120 bps per leg, $24 round trip, the SAME signal flips to reject (EV -$4)', () => {
    const result = evaluateEvGate(baseInputs({ feeModel: LIVE_TIER_MODEL }), makeLogger());
    expect(result.entryFeeRate).toBeCloseTo(0.012, 12);
    expect(result.exitFeeRate).toBeCloseTo(0.012, 12);
    expect(result.feeUsd).toBeCloseTo(24, 6);
    expect(result.ev).toBeCloseTo(-4, 6);
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/feeRT=\$24\.00/);
  });

  it('override on the spot bucket leaves perps priced from YAML', () => {
    const result = evaluateEvGate(
      baseInputs({ symbol: 'ETH-PERP-INTX', feeModel: LIVE_TIER_MODEL }),
      makeLogger(),
    );
    expect(result.exitFeeRate).toBeCloseTo(0.0005, 12);
    expect(result.feeUsd).toBeCloseTo(1, 6);
    expect(result.allowed).toBe(true);
  });

  it('explicit feeRateOverride still wins over a live-tier model', () => {
    const result = evaluateEvGate(
      baseInputs({ feeModel: LIVE_TIER_MODEL, feeRateOverride: 0.00045 }),
      makeLogger(),
    );
    expect(result.entryFeeRate).toBeCloseTo(0.00045, 12);
    expect(result.exitFeeRate).toBeCloseTo(0.00045, 12);
    expect(result.feeUsd).toBeCloseTo(2 * 0.00045 * 1000, 6);
  });
});
