/**
 * Phase 1 — CFM primary paper venue tests.
 *
 * Covers:
 *   1. CFM fee model: cost-plus (% + $/ct exchange floor), round-trip cost
 *   2. Fee-aware EV gate: perContractFeeUsd raises the cost bar for CFM
 *   3. Per-timeframe ATR bounds: resolveAtrBounds picks override for 4H/1D
 *   4. Market context logger: row shape, basis computation
 *   5. CFM bar timeframes: guardrails carry the strategy→timeframe map
 *
 * CDE fee schedule (effective 2026-08-17):
 *   nano BTC/ETH: $0.10/ct/side Professional Electronic (all-in, no clearing fee)
 *   Source: Fee_Schedule_as_of_08172026.pdf
 *
 * Fee math example (1 nano BTC round trip @ $77,000):
 *   Notional: 0.01 BTC × $77,000 = $770
 *   Entry (maker, post_only): 9.5 bps × $770 = $0.7315 + $0.10 exchange = $0.8315
 *   Exit (taker):             10 bps  × $770 = $0.77   + $0.10 exchange = $0.87
 *   Round trip fees: $1.7015 (22.1 bps effective)
 */
import { describe, test, expect, vi } from 'vitest';
import { FeeModel, contractsForSize } from '../core/fee-model';
import { loadGuardrails } from '../config/loadGuardrails';
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
import type { FeesConfig } from '../config/loadGuardrails';

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
// 1. CFM fee model — cost-plus (% + exchange floor)
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — CFM fee model (no separate clearing fee)', () => {
  const fm = new FeeModel(FEES_CFM);

  test('exchange floor is $0.10/ct/side (CDE all-in, no clearing fee)', () => {
    expect(fm.getExchangeFeePerContractUsd('coinbase', 'cfm')).toBe(0.1);
    expect(fm.isCostPlus('coinbase', 'cfm')).toBe(true);
    expect(fm.getExchangeFeePerContractUsd('coinbase', 'spot')).toBe(0);
  });

  test('computeFillFeeUsd returns 2-leg breakdown: commission + exchange', () => {
    const fee = fm.computeFillFeeUsd({
      exchange: 'coinbase',
      market: 'cfm',
      side: 'taker',
      notionalUsd: '770',
      contracts: 1,
    });
    expect(fee.commissionUsd).toBe('0.77000000');
    expect(fee.exchangeFeeUsd).toBe('0.10000000');
    expect(fee.totalUsd).toBe('0.87000000');
  });

  test('1 nano BTC round trip @ $77,000 = $1.7015 total fees', () => {
    const entryFee = fm.computeFillFeeUsd({
      exchange: 'coinbase', market: 'cfm', side: 'maker',
      notionalUsd: 770, contracts: 1,
    });
    const exitFee = fm.computeFillFeeUsd({
      exchange: 'coinbase', market: 'cfm', side: 'taker',
      notionalUsd: 770, contracts: 1,
    });
    const roundTrip = Number(entryFee.totalUsd) + Number(exitFee.totalUsd);
    // entry: 9.5bps×770=0.7315 + 0.10 = 0.8315
    // exit: 10bps×770=0.77 + 0.10 = 0.87
    expect(roundTrip).toBeCloseTo(1.7015, 4);
    // Effective bps: 1.7015 / 770 * 10000 ≈ 22.1 bps
    expect((roundTrip / 770) * 10_000).toBeCloseTo(22.1, 0);
  });

  test('canonical guardrails carry the CDE fee book (no clearing fee field)', () => {
    const g = loadGuardrails();
    expect(g.fees.coinbase.cfm_nano).toEqual({
      maker_bps: 9.5,
      taker_bps: 10,
      exchange_fee_per_contract_usd: 0.1,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 2. CFM round-trip cost calculator
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — CFM round-trip cost calculator', () => {
  const fm = new FeeModel(FEES_CFM);

  test('1 nano BTC @ $77,000 with 3 bps slippage', () => {
    const cost = computeCfmRoundTripCost(fm, 0.01, 77_000, 0.01, 3);
    expect(cost.contracts).toBe(1);
    expect(cost.entryFeeUsd).toBeCloseTo(0.8315, 4);
    expect(cost.exitFeeUsd).toBeCloseTo(0.87, 4);
    expect(cost.slippageUsd).toBeCloseTo(0.462, 3);
    expect(cost.totalUsd).toBeCloseTo(2.1635, 3);
  });

  test('computePerContractRoundTripFeeUsd = 2 × $0.10 = $0.20', () => {
    expect(computePerContractRoundTripFeeUsd(fm)).toBeCloseTo(0.2, 10);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 3. Fee-aware EV gate — perContractFeeUsd
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — fee-aware EV gate for CFM', () => {
  const fm = new FeeModel(FEES_CFM);

  function makeInputs(overrides: Partial<EvGateInputs> = {}): EvGateInputs {
    return {
      symbol: 'BIP-20DEC30-CDE',
      strategy: 'trend_follow',
      direction: 'buy',
      entryPrice: 77_000,
      stopPrice: 75_075,
      takeProfit: 88_550,
      size: 0.01,
      winRate: 0.40,
      sampleSize: 50,
      feeModel: fm,
      venue: 'coinbase',
      entryLiquidity: 'maker',
      minEvThreshold: 0,
      ...overrides,
    };
  }

  test('perContractFeeUsd increases feeUsd and can flip a marginal signal to reject', () => {
    const perContractFee = computePerContractRoundTripFeeUsd(fm);
    const contracts = Number(contractsForSize(0.01, 0.01));

    const withoutPerContract = evaluateEvGate(makeInputs({ perContractFeeUsd: 0 }));
    const withPerContract = evaluateEvGate(makeInputs({
      perContractFeeUsd: perContractFee * contracts,
    }));

    expect(withPerContract.feeUsd).toBeGreaterThan(withoutPerContract.feeUsd);
    expect(withPerContract.feeUsd - withoutPerContract.feeUsd).toBeCloseTo(0.2, 2);
  });

  test('perContractFeeUsd = 0 behaves identically to legacy (no per-contract fees)', () => {
    const legacy = evaluateEvGate(makeInputs());
    const explicit = evaluateEvGate(makeInputs({ perContractFeeUsd: 0 }));
    expect(legacy.ev).toBe(explicit.ev);
    expect(legacy.feeUsd).toBe(explicit.feeUsd);
  });

  test('high per-contract fees reject a trade that was marginally positive', () => {
    const marginal = evaluateEvGate(makeInputs({
      minEvThreshold: 0,
      winRate: 0.35,
      sampleSize: 100,
    }));
    const highFee = evaluateEvGate(makeInputs({
      minEvThreshold: 0,
      winRate: 0.35,
      sampleSize: 100,
      perContractFeeUsd: 50,
    }));
    expect(highFee.ev).toBeLessThan(marginal.ev);
    expect(highFee.allowed).toBe(false);
  });
});

// ────────────────────────────────────────────────────────────────────────
// 4. Per-timeframe ATR volatility bounds (data-driven)
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — per-timeframe ATR volatility bounds', () => {
  const filters = {
    atr_volatility_min: 0.005,
    atr_volatility_max: 0.05,
    atr_volatility_by_timeframe: {
      '240': { atr_volatility_min: 0.008, atr_volatility_max: 0.04 },
      '1440': { atr_volatility_min: 0.025, atr_volatility_max: 0.15 },
    },
  };

  test('resolveAtrBounds returns global defaults for 15m (no override)', () => {
    const bounds = resolveAtrBounds(filters, 15);
    expect(bounds.atrMin).toBe(0.005);
    expect(bounds.atrMax).toBe(0.05);
  });

  test('resolveAtrBounds returns data-driven 4H override for barMinutes=240', () => {
    const bounds = resolveAtrBounds(filters, 240);
    expect(bounds.atrMin).toBe(0.008);
    expect(bounds.atrMax).toBe(0.04);
  });

  test('resolveAtrBounds returns data-driven 1D override for barMinutes=1440', () => {
    const bounds = resolveAtrBounds(filters, 1440);
    expect(bounds.atrMin).toBe(0.025);
    expect(bounds.atrMax).toBe(0.15);
  });

  test('resolveAtrBounds falls back to global when no timeframe map', () => {
    const noMap = { atr_volatility_min: 0.005, atr_volatility_max: 0.05 };
    expect(resolveAtrBounds(noMap, 240)).toEqual({ atrMin: 0.005, atrMax: 0.05 });
  });

  test('4H floor (0.8%) is above 15m floor (0.5%) — longer TF, higher ATR%, higher floor', () => {
    const f4h = resolveAtrBounds(filters, 240);
    const f15m = resolveAtrBounds(filters, 15);
    expect(f4h.atrMin).toBeGreaterThan(f15m.atrMin);
  });

  test('1D floor (2.5%) is above 4H floor (0.8%) — structural ATR% scaling', () => {
    const f1d = resolveAtrBounds(filters, 1440);
    const f4h = resolveAtrBounds(filters, 240);
    expect(f1d.atrMin).toBeGreaterThan(f4h.atrMin);
  });

  test('4H ATR% = 1.2% passes the 4H bounds but may fail the 15m bounds on a low-vol day', () => {
    const pass4h = evaluateAtrVolatilityFilter({
      metadata: { indicators: { atr: 924 } },
      price: 77_000,
      atrMin: 0.008,
      atrMax: 0.04,
    });
    expect(pass4h.outcome).toBe('pass');
    // atrPct = 924/77000 ≈ 1.2%
  });

  test('4H ATR% = 0.6% is below the 4H floor and rejected', () => {
    const fail = evaluateAtrVolatilityFilter({
      metadata: { indicators: { atr: 462 } },
      price: 77_000,
      atrMin: 0.008,
      atrMax: 0.04,
    });
    expect(fail.outcome).toBe('atr_below_min');
    // atrPct = 462/77000 ≈ 0.6% < 0.8%
  });

  test('canonical guardrails carry data-driven per-timeframe ATR bounds', () => {
    const g = loadGuardrails();
    expect(g.filters.atr_volatility_by_timeframe).toBeDefined();
    expect(g.filters.atr_volatility_by_timeframe?.['240']).toEqual({
      atr_volatility_min: 0.008,
      atr_volatility_max: 0.04,
    });
    expect(g.filters.atr_volatility_by_timeframe?.['1440']).toEqual({
      atr_volatility_min: 0.025,
      atr_volatility_max: 0.15,
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// 5. Market context logger
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — market context logger', () => {
  function makeMockWriter(): MarketContextWriter & { rows: MarketContextBarRow[] } {
    const rows: MarketContextBarRow[] = [];
    return { rows, write: vi.fn(async (row) => { rows.push(row); }) };
  }

  function makeLogger() {
    return { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  test('logClosedBar writes a correct row with basis computation', async () => {
    const writer = makeMockWriter();
    const logger = new MarketContextLogger({
      symbols: ['BIP-20DEC30-CDE'],
      venue: 'coinbase-cfm',
      sessionId: 'test-session-id',
      executionMode: 'paper',
      writer,
      logger: makeLogger(),
    });

    await logger.logClosedBar({
      symbol: 'BIP-20DEC30-CDE',
      timeframe: 240,
      barTimestamp: Date.UTC(2026, 9, 19, 4, 0, 0),
      spotPrice: 77_000,
      futuresPrice: 77_077,
      fundingRate: 0.0001,
    });

    expect(writer.rows).toHaveLength(1);
    const row = writer.rows[0];
    expect(row.symbol).toBe('BIP-20DEC30-CDE');
    expect(row.venue).toBe('coinbase-cfm');
    expect(row.timeframe).toBe(240);
    expect(row.execution_mode).toBe('paper');
    expect(row.session_id).toBe('test-session-id');
    // basis_bps = (77077 - 77000) / 77000 * 10000 = 10.0 bps
    expect(Number(row.basis_bps)).toBeCloseTo(10.0, 1);
  });

  test('logClosedBar handles null prices gracefully', async () => {
    const writer = makeMockWriter();
    const logger = new MarketContextLogger({
      symbols: ['BIP-20DEC30-CDE'],
      venue: 'coinbase-cfm',
      sessionId: null,
      executionMode: 'paper',
      writer,
      logger: makeLogger(),
    });

    await logger.logClosedBar({
      symbol: 'BIP-20DEC30-CDE',
      timeframe: 1440,
      barTimestamp: Date.UTC(2026, 9, 19, 0, 0, 0),
      spotPrice: null,
      futuresPrice: null,
      fundingRate: null,
    });

    const row = writer.rows[0];
    expect(row.basis_bps).toBeNull();
    expect(row.spot_price).toBeNull();
    expect(row.session_id).toBeNull();
  });

  test('logClosedBar catches writer errors without throwing', async () => {
    const mockLogger = makeLogger();
    const failWriter: MarketContextWriter = {
      write: vi.fn(async () => { throw new Error('DB down'); }),
    };
    const logger = new MarketContextLogger({
      symbols: ['BIP-20DEC30-CDE'],
      venue: 'coinbase-cfm',
      sessionId: null,
      executionMode: 'paper',
      writer: failWriter,
      logger: mockLogger,
    });

    await expect(logger.logClosedBar({
      symbol: 'BIP-20DEC30-CDE',
      timeframe: 240,
      barTimestamp: Date.now(),
      spotPrice: 77_000,
      futuresPrice: 77_050,
      fundingRate: null,
    })).resolves.not.toThrow();

    expect(mockLogger.error).toHaveBeenCalledWith(
      'market_context_bars write failed',
      expect.objectContaining({ error: 'DB down' }),
    );
  });
});

// ────────────────────────────────────────────────────────────────────────
// 6. CFM bar timeframes + contract specs
// ────────────────────────────────────────────────────────────────────────

describe('Phase 1 — CFM bar timeframes and contract specs', () => {
  test('cfm_bar_timeframes maps strategies to bar durations', () => {
    const g = loadGuardrails();
    expect(g.cfm_bar_timeframes?.trend_follow).toBe(240);
    expect(g.cfm_bar_timeframes?.donchian_daily_s3).toBe(1440);
  });

  test('ETP-20DEC30-CDE tick size matches CDE spec: $0.50/ETH = $0.05/ct', () => {
    const g = loadGuardrails();
    const etp = g.cfm_symbols?.['ETP-20DEC30-CDE'];
    expect(etp).toBeDefined();
    expect(etp!.contract_size).toBe(0.1);
    expect(etp!.price_increment_usd).toBe(0.50);
    expect(etp!.spot_proxy).toBe('ETH-USD');
  });

  test('BIP-20DEC30-CDE spec: $5/BTC = $0.05/ct, 0.01 BTC/ct', () => {
    const g = loadGuardrails();
    const bip = g.cfm_symbols?.['BIP-20DEC30-CDE'];
    expect(bip!.contract_size).toBe(0.01);
    expect(bip!.price_increment_usd).toBe(5);
    expect(bip!.spot_proxy).toBe('BTC-USD');
  });

  test('CFM symbols have trend_follow overrides with the desk-pinned stop/TP ATR', () => {
    const g = loadGuardrails();
    for (const sym of ['BIP-20DEC30-CDE', 'ETP-20DEC30-CDE']) {
      const cfg = g.cfm_symbols?.[sym];
      expect(cfg?.strategy_overrides?.trend_follow?.stopAtr).toBe(2.5);
      expect(cfg?.strategy_overrides?.trend_follow?.takeProfitAtr).toBe(6.0);
    }
  });
});
