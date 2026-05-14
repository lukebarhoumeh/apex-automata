/**
 * PaperTradingSimulator fee-routing regression tests.
 *
 * Anchors the B5 fix from SPRINT-PLAN-FINAL.md §1.4: paper trades on
 * `*-PERP-INTX` symbols were charged Coinbase spot taker (~40 bps) instead
 * of the configured perps_intx taker (~5 bps). The simulator now resolves
 * fees per-symbol through FeeModel.
 *
 * If you find yourself loosening any of the assertions here, stop. Every
 * prior paper EV measurement on a perp symbol is biased by ~55 bps RT;
 * loosening these tests re-introduces that bias.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PaperTradingSimulator, PaperTradingConfig } from '../trading/paper-trading-simulator';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig } from '../config/loadGuardrails';
import { Logger } from '../core/logger';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Mirror of the production guardrails.yaml -> fees block. If yaml drifts,
// update this fixture too (or better: import a loader once shared).
const TEST_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: {
    perps: { maker_bps: -1.5, taker_bps: 4.5 },
  },
};

function buildSim(overrides: Partial<PaperTradingConfig> = {}): PaperTradingSimulator {
  const fm = new FeeModel(TEST_FEES);
  const config: PaperTradingConfig = {
    initialBalances: new Map<string, number>([
      ['USD', 100_000],
      ['BTC', 0],
      ['ETH', 0],
      ['SOL', 0],
    ]),
    feeModel: fm,
    venue: 'coinbase',
    slippage: 0,        // remove slippage so fee math is exactly verifiable
    latencyMs: 0,       // no latency in tests
    depthAware: false,  // remove book-depth slippage
    ...overrides,
  };
  return new PaperTradingSimulator(config, mockLogger);
}

describe('PaperTradingSimulator — fee routing (B5)', () => {
  describe('with FeeModel + venue', () => {
    it('charges Coinbase SPOT taker for spot symbols (BTC-USD)', async () => {
      const sim = buildSim();
      sim.updateMarketPrice('BTC-USD', 80_000);

      const resp = await sim.placeOrder({
        product_id: 'BTC-USD',
        side: 'buy',
        type: 'market',
        size: '0.02', // notional = 0.02 * 80_000 = 1600
      });

      // 40 bps taker => 1600 * 0.0040 = 6.40
      expect(parseFloat(resp.fill_fees)).toBeCloseTo(6.4, 4);
    });

    it('charges Coinbase PERPS_INTX taker for perp symbols (ETH-PERP-INTX)', async () => {
      // This is THE regression test for B5. Today's paper run charged
      // ~$10.50 round-trip on ~$1613 notional ETH-PERP-INTX trades; with
      // the per-symbol routing it should be ~$1.61 round-trip.
      const sim = buildSim();
      sim.updateMarketPrice('ETH-PERP-INTX', 2_253.51);

      const resp = await sim.placeOrder({
        product_id: 'ETH-PERP-INTX',
        side: 'buy',
        type: 'market',
        size: '0.71561',  // notional ≈ 1612.95 (matches today's trade)
      });

      // 5 bps taker => 1612.95 * 0.0005 ≈ 0.806 per side, ≈ 1.61 RT
      const fee = parseFloat(resp.fill_fees);
      expect(fee).toBeGreaterThan(0.78);
      expect(fee).toBeLessThan(0.82);

      // And explicitly NOT the legacy spot-tier mis-pricing.
      const spotEquivalent = 1612.95 * 0.004;
      expect(fee).toBeLessThan(spotEquivalent / 5); // ≥ 5x cheaper than spot rate
    });

    it('charges different rates for paired spot+perp trades on the same asset', async () => {
      // Today's trade pairs (7 + 8) showed ETH-USD and ETH-PERP-INTX
      // executing at the same price/size/time. Pre-fix they paid the same
      // ~$10.50; post-fix the perp side must pay materially less.
      const sim = buildSim();
      sim.updateMarketPrice('ETH-USD', 2_253.51);
      sim.updateMarketPrice('ETH-PERP-INTX', 2_253.51);

      const spotResp = await sim.placeOrder({
        product_id: 'ETH-USD',
        side: 'buy',
        type: 'market',
        size: '0.71561',
      });
      const perpResp = await sim.placeOrder({
        product_id: 'ETH-PERP-INTX',
        side: 'buy',
        type: 'market',
        size: '0.71561',
      });

      const spotFee = parseFloat(spotResp.fill_fees);
      const perpFee = parseFloat(perpResp.fill_fees);

      // Spot 40 bps vs Perps 5 bps = 8x ratio (exactly).
      expect(spotFee / perpFee).toBeCloseTo(40 / 5, 1);
    });

    it('rejects unknown markets with a clear error (Coinbase has no spot HL etc.)', () => {
      // Hyperliquid has no spot bucket in the fixture; if some future caller
      // passes venue='hyperliquid' and trades a spot-shaped symbol, we want
      // to fail loudly not silently re-use the wrong tier.
      const sim = buildSim({ venue: 'hyperliquid' });
      sim.updateMarketPrice('BTC-USD', 80_000);

      // This is a buy on a 'spot' symbol but venue routes to hyperliquid;
      // FeeModel throws because hyperliquid has no spot bucket.
      return expect(
        sim.placeOrder({
          product_id: 'BTC-USD',
          side: 'buy',
          type: 'market',
          size: '0.02',
        }),
      ).rejects.toThrow(/no fee configuration/i);
    });
  });

  describe('legacy fallback (no FeeModel)', () => {
    it('preserves backwards-compat for callers passing flat makerFee/takerFee', async () => {
      const sim = buildSim({
        feeModel: undefined,
        makerFee: 0.001,  // 10 bps maker
        takerFee: 0.002,  // 20 bps taker
      });
      sim.updateMarketPrice('BTC-USD', 80_000);

      const resp = await sim.placeOrder({
        product_id: 'BTC-USD',
        side: 'buy',
        type: 'market',
        size: '0.02', // notional = 1600
      });
      // 20 bps taker * 1600 = 3.20
      expect(parseFloat(resp.fill_fees)).toBeCloseTo(3.2, 4);
    });

    it('throws if neither FeeModel nor flat rates are provided', () => {
      expect(() =>
        new PaperTradingSimulator(
          {
            initialBalances: new Map([['USD', 1000]]),
            slippage: 0,
            latencyMs: 0,
          } as unknown as PaperTradingConfig,
          mockLogger,
        ),
      ).toThrow(/feeModel.*or.*makerFee.*takerFee/i);
    });
  });

  describe('round-trip fee math anchors', () => {
    // Numerical anchors so a future refactor can't silently re-introduce the bug.
    it('ETH-PERP-INTX RT fee at $1613 notional is ~$1.61 (vs ~$12.90 if spot mis-routed)', () => {
      const fm = new FeeModel(TEST_FEES);
      const notional = 1613;
      const perpsRt = notional * fm.getFeeRate('coinbase', 'perps', 'taker') * 2;
      const spotRt = notional * fm.getFeeRate('coinbase', 'spot', 'taker') * 2;
      expect(perpsRt).toBeCloseTo(1.613, 3);
      expect(spotRt).toBeCloseTo(12.904, 3);
      // 8x difference — anything smaller means routing is broken.
      expect(spotRt / perpsRt).toBeCloseTo(8, 1);
    });
  });
});
