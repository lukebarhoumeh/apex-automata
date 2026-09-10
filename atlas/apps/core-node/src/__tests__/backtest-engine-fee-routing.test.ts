/**
 * BacktestEngine per-symbol fee routing tests (#11, 2026-05-18).
 *
 * Targets the pre-F4 blocker identified in B4 audit
 * (`docs/research/2026-05-18_b4-fee-model-audit.md` §"Structural latent
 * defect" — "Recommended fix shape" Option B). Before this fix, the engine
 * applied `BacktestConfig.commission: number` flat to every fill regardless
 * of symbol, so a mixed `--products BTC-USD ETH-PERP-INTX` run silently
 * charged the spot taker rate to perp legs — reproducing the exact bug
 * commit 402e757 fixed in the live paper path (PaperTradingSimulator).
 *
 * The fix:
 *   - `BacktestConfig.commission` is now optional; `feeModel: FeeModel` is
 *     the new preferred path.
 *   - When `commission` is set, every fill uses that flat rate (CLI
 *     `--commission 0.00045` sensitivity-analysis path).
 *   - When `commission` is unset, every fill resolves through
 *     `feeModel.getFeeRate(venue, marketForSymbol(symbol), 'taker')`.
 *
 * Notes:
 *   - These tests live under `src/__tests__/` to match the rest of the
 *     backtest suite (`backtest-engine-realism.test.ts`,
 *     `backtest-trade-outcomes.test.ts`) and because vitest.config.ts
 *     restricts test discovery to that folder.
 */
import { describe, it, expect, vi } from 'vitest';
import { BacktestEngine, BacktestConfig } from '../backtesting/backtest-engine';
import { FeeModel } from '../core/fee-model';
import { marketForSymbol } from '../core/symbol-utils';
import type { FeesConfig } from '../config/loadGuardrails';
import { OHLCV } from '../indicators/technical';

function makeLogger() {
  return {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as any;
}

function buildSyntheticCandles(count: number, seed = 42): OHLCV[] {
  // Deterministic LCG — same pattern as backtest-engine-realism.test.ts
  // so trade counts are stable across runs.
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return (state >>> 8) / 0x01000000;
  };

  const candles: OHLCV[] = [];
  let price = 30_000;
  for (let i = 0; i < count; i++) {
    const drift = (next() - 0.5) * 200;
    const open = price;
    const close = price + drift;
    const high = Math.max(open, close) + next() * 100;
    const low = Math.min(open, close) - next() * 100;
    candles.push({
      time: 1_700_000_000_000 + i * 60_000,
      open,
      high,
      low,
      close,
      volume: 100 + next() * 50,
    });
    price = close;
  }
  return candles;
}

// Distinct, easy-to-verify per-bucket rates. Spot ≠ perp so any cross-bucket
// leak shows up immediately as a ~8× fee error on the affected legs.
const TEST_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: {
    perps: { maker_bps: -1.5, taker_bps: 4.5 },
  },
};

const SPOT_TAKER_RATE = TEST_FEES.coinbase.spot.taker_bps / 10_000;       // 0.004
const PERPS_TAKER_RATE = TEST_FEES.coinbase.perps_intx.taker_bps / 10_000; // 0.0005

/**
 * Build a fee-routing BacktestConfig WITHOUT a flat commission. The
 * engine will route per-fill via the supplied FeeModel.
 */
function feeRoutingConfig(
  products: string[],
  overrides: Partial<BacktestConfig> = {},
): BacktestConfig {
  const initialCapital = 10_000;
  return {
    startDate: new Date('2024-01-01'),
    endDate: new Date('2024-01-02'),
    initialCapital,
    feeModel: new FeeModel(TEST_FEES),
    venue: 'coinbase',
    slippage: 0.0005,
    products,
    signals: {
      breakout: { enabled: true, parameters: {} },
      vwapMeanReversion: { enabled: true, parameters: {} },
      momentum: { enabled: true, parameters: {} },
      trendFollow: { enabled: true, parameters: {} },
    },
    risk: {
      maxPositionSize: 3_000,
      maxTotalExposure: 30_000,
      stopLossPercent: 0.02,
      takeProfitPercent: 0.04,
    },
    account: {
      equityUsd: initialCapital,
      riskPerTrade: 0.005,
      maxPositionExposurePct: 0.30,
      minNotionalBuffer: 1.1,
    },
    disabledStrategies: ['vwap_mr', 'breakout'],
    perSymbolOverrides: {},
    realism: {
      nextBarFill: true,
      entrySlippageBps: 5,
      stopOvershootBarRangePct: 0.20,
      stopOvershootMinBps: 5,
      sizeDecimals: 6,
    },
    // These tests assert the fee CHARGED per fill, not entry admission. With
    // the TASK_017 EV gate enforced (default), a 40 bps spot taker rate
    // rejects every entry on this synthetic series (correctly — it is
    // negative-EV at p0 = 0.40), leaving nothing to assert on. The gate has
    // its own coverage in backtest-integrity-task017.test.ts.
    evGate: { mode: 'off' },
    ...overrides,
  };
}

describe('marketForSymbol (shared util)', () => {
  it('classifies spot symbols as spot', () => {
    expect(marketForSymbol('BTC-USD')).toBe('spot');
    expect(marketForSymbol('ETH-USD')).toBe('spot');
    expect(marketForSymbol('SOL-USD')).toBe('spot');
  });

  it('classifies *-PERP-* symbols as perps', () => {
    expect(marketForSymbol('ETH-PERP-INTX')).toBe('perps');
    expect(marketForSymbol('BTC-PERP-INTX')).toBe('perps');
  });

  it('treats unknown-pattern symbols as spot (safe default)', () => {
    expect(marketForSymbol('LINK-USDC')).toBe('spot');
    expect(marketForSymbol('XYZ')).toBe('spot');
  });
});

describe('BacktestEngine — per-symbol fee routing (#11)', () => {
  it('throws if neither feeModel nor commission is configured', () => {
    const broken = feeRoutingConfig(['BTC-USD']);
    // Delete the feeModel so neither path is configured.
    delete (broken as any).feeModel;
    expect(() => new BacktestEngine(broken, makeLogger())).toThrowError(
      /feeModel.*commission|commission.*feeModel/i,
    );
  });

  it('spot-only run charges coinbase.spot.taker_bps on every fill', async () => {
    const engine = new BacktestEngine(feeRoutingConfig(['BTC-USD']), makeLogger());
    const candles = buildSyntheticCandles(180);
    await engine.loadHistoricalData(async () => candles);
    const result = await engine.run();

    expect(result.metrics.totalTrades).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect(trade.product).toBe('BTC-USD');
      const expectedEntry = trade.size * trade.entryPrice * SPOT_TAKER_RATE;
      expect(trade.entryFee).toBeCloseTo(expectedEntry, 8);
      if (trade.exitFee !== undefined && trade.exitPrice !== undefined) {
        const expectedExit = trade.size * trade.exitPrice * SPOT_TAKER_RATE;
        expect(trade.exitFee).toBeCloseTo(expectedExit, 8);
      }
    }
  });

  it('perps-only run charges coinbase.perps_intx.taker_bps on every fill', async () => {
    const engine = new BacktestEngine(
      feeRoutingConfig(['ETH-PERP-INTX']),
      makeLogger(),
    );
    const candles = buildSyntheticCandles(180);
    await engine.loadHistoricalData(async () => candles);
    const result = await engine.run();

    expect(result.metrics.totalTrades).toBeGreaterThan(0);
    for (const trade of result.trades) {
      expect(trade.product).toBe('ETH-PERP-INTX');
      const expectedEntry = trade.size * trade.entryPrice * PERPS_TAKER_RATE;
      expect(trade.entryFee).toBeCloseTo(expectedEntry, 8);
      if (trade.exitFee !== undefined && trade.exitPrice !== undefined) {
        const expectedExit = trade.size * trade.exitPrice * PERPS_TAKER_RATE;
        expect(trade.exitFee).toBeCloseTo(expectedExit, 8);
      }
    }
  });

  it('mixed spot+perps run charges correct rate per symbol (the #11 bug fix)', async () => {
    const engine = new BacktestEngine(
      feeRoutingConfig(['BTC-USD', 'ETH-PERP-INTX']),
      makeLogger(),
    );
    const candles = buildSyntheticCandles(180);
    await engine.loadHistoricalData(async () => candles);
    const result = await engine.run();

    const spotTrades = result.trades.filter(t => t.product === 'BTC-USD');
    const perpTrades = result.trades.filter(t => t.product === 'ETH-PERP-INTX');
    expect(spotTrades.length).toBeGreaterThan(0);
    expect(perpTrades.length).toBeGreaterThan(0);

    // Spot legs must hit the 40 bps tier.
    for (const trade of spotTrades) {
      const expectedEntry = trade.size * trade.entryPrice * SPOT_TAKER_RATE;
      expect(trade.entryFee).toBeCloseTo(expectedEntry, 8);
      if (trade.exitFee !== undefined && trade.exitPrice !== undefined) {
        const expectedExit = trade.size * trade.exitPrice * SPOT_TAKER_RATE;
        expect(trade.exitFee).toBeCloseTo(expectedExit, 8);
      }
    }
    // Perp legs must hit the 5 bps tier — NOT the 40 bps spot tier (the
    // pre-fix bug). Cross-check: perp entryFee should be 8× smaller than
    // if it had been incorrectly charged spot.
    for (const trade of perpTrades) {
      const expectedEntry = trade.size * trade.entryPrice * PERPS_TAKER_RATE;
      expect(trade.entryFee).toBeCloseTo(expectedEntry, 8);
      const wrongSpotFee = trade.size * trade.entryPrice * SPOT_TAKER_RATE;
      // Sanity: the right (perp) fee is 8× smaller than the wrong (spot)
      // fee on the same notional. If routing regresses this gap collapses.
      expect(trade.entryFee).toBeLessThan(wrongSpotFee / 7);
    }
  });

  it('--commission override applies flat to every fill, regardless of symbol', async () => {
    const flatRate = 0.00045; // 4.5 bps — simulate HL taker on CB candles
    const cfg = feeRoutingConfig(['BTC-USD', 'ETH-PERP-INTX'], {
      commission: flatRate,
    });
    const engine = new BacktestEngine(cfg, makeLogger());
    const candles = buildSyntheticCandles(180);
    await engine.loadHistoricalData(async () => candles);
    const result = await engine.run();

    expect(result.metrics.totalTrades).toBeGreaterThan(0);
    const spotTrades = result.trades.filter(t => t.product === 'BTC-USD');
    const perpTrades = result.trades.filter(t => t.product === 'ETH-PERP-INTX');
    expect(spotTrades.length).toBeGreaterThan(0);
    expect(perpTrades.length).toBeGreaterThan(0);

    // Both spot AND perp legs must use the same flat 4.5 bps — the override
    // wins over FeeModel per-symbol routing.
    for (const trade of result.trades) {
      const expectedEntry = trade.size * trade.entryPrice * flatRate;
      expect(trade.entryFee).toBeCloseTo(expectedEntry, 8);
      if (trade.exitFee !== undefined && trade.exitPrice !== undefined) {
        const expectedExit = trade.size * trade.exitPrice * flatRate;
        expect(trade.exitFee).toBeCloseTo(expectedExit, 8);
      }
    }
  });
});
