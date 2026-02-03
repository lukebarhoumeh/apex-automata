/**
 * Risk Parity Test Harness
 * 
 * Ensures paper and live modes produce identical risk decisions
 * given the same inputs. This prevents future regressions.
 */

import { describe, it, expect } from 'vitest';
import {
  evaluateRisk,
  checkOrderAllowed,
  buildThresholdsFromGuardrails,
} from '../trading/risk/evaluate-risk';
import {
  RiskEvaluationSnapshot,
  RiskThresholds,
  PaperOverrideFlags,
  DEFAULT_PAPER_OVERRIDES,
} from '../trading/risk/types';

// ============ Test Fixtures ============

function createBaseSnapshot(mode: 'paper' | 'live'): RiskEvaluationSnapshot {
  return {
    ts: Date.now(),
    sessionId: 'test-session',
    executionMode: mode,
    dayStartEquityUsd: 50000,
    realizedPnlUsd: 0,
    unrealizedPnlUsd: 0,
    dailyPnlUsd: 0,
    dailyPnlR: 0,
    riskUnitUsd: 500, // 1% of 50000
    maxDrawdownPct: 0,
    weeklyPnlUsd: 0,
    exposureUsd: 0,
    exposureBySymbolUsd: {},
    openPositionsCount: 0,
    openOrdersCount: 0,
    consecutiveLosses: 0,
    errorRatePct: 0,
    avgLatencyMs: 100,
    marketDataStaleMs: 0,
    dailyLossPerSymbolUsd: {},
  };
}

function createBaseThresholds(): RiskThresholds {
  return {
    dailyStopR: -2.0, // -2R
    dailyStopUsd: 1000, // $1000 (2% of 50000)
    weeklyStopUsd: 2000, // $2000 (4% of 50000)
    maxDrawdownPct: 0.05, // 5%
    maxExposureUsd: 50000, // 100% of equity
    maxExposurePerSymbolUsd: { 'BTC-USD': 25000 },
    maxDailyLossPerSymbolUsd: { 'BTC-USD': 500 },
    maxPositionNotionalUsd: 10000, // 20% of equity
    minOrderNotionalUsd: 50,
    maxOrderNotionalUsd: 10000,
    maxOpenPositions: 5,
    maxOpenOrders: 10,
    maxConsecutiveLosses: 5,
    maxErrorRatePct: 20,
    maxLatencyMs: 5000,
    maxMarketDataStaleMs: 30000,
  };
}

// ============ Parity Tests ============

describe('Risk Parity: Paper vs Live', () => {
  const thresholds = createBaseThresholds();

  describe('Same Inputs → Same Outputs', () => {
    it('ALLOW: both modes allow trading when all checks pass', () => {
      const paperSnapshot = createBaseSnapshot('paper');
      const liveSnapshot = createBaseSnapshot('live');

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('ALLOW');
      expect(liveResult.decision.type).toBe('ALLOW');
      expect(paperResult.decision).toEqual(liveResult.decision);
    });

    it('HALT: daily stop triggers at same threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), dailyPnlR: -2.0 };
      const liveSnapshot = { ...createBaseSnapshot('live'), dailyPnlR: -2.0 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('HALT_TRADING');
      expect(liveResult.decision.type).toBe('HALT_TRADING');
      expect(paperResult.decision).toEqual(liveResult.decision);
    });

    it('ALLOW: just above daily stop threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), dailyPnlR: -1.99 };
      const liveSnapshot = { ...createBaseSnapshot('live'), dailyPnlR: -1.99 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('ALLOW');
      expect(liveResult.decision.type).toBe('ALLOW');
    });

    it('HALT: max drawdown triggers at same threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), maxDrawdownPct: 0.05 };
      const liveSnapshot = { ...createBaseSnapshot('live'), maxDrawdownPct: 0.05 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('HALT_TRADING');
      expect(liveResult.decision.type).toBe('HALT_TRADING');
      if (paperResult.decision.type === 'HALT_TRADING' && liveResult.decision.type === 'HALT_TRADING') {
        expect(paperResult.decision.reasonCode).toBe('max_drawdown');
        expect(liveResult.decision.reasonCode).toBe('max_drawdown');
      }
    });

    it('BLOCK_ENTRY: exposure limit triggers at same threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), exposureUsd: 50001 };
      const liveSnapshot = { ...createBaseSnapshot('live'), exposureUsd: 50001 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('BLOCK_ENTRY');
      expect(liveResult.decision.type).toBe('BLOCK_ENTRY');
    });

    it('HALT: consecutive losses triggers at same threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), consecutiveLosses: 5 };
      const liveSnapshot = { ...createBaseSnapshot('live'), consecutiveLosses: 5 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('HALT_TRADING');
      expect(liveResult.decision.type).toBe('HALT_TRADING');
      if (paperResult.decision.type === 'HALT_TRADING' && liveResult.decision.type === 'HALT_TRADING') {
        expect(paperResult.decision.reasonCode).toBe('consecutive_losses');
        expect(liveResult.decision.reasonCode).toBe('consecutive_losses');
      }
    });

    it('HALT: error rate triggers at same threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), errorRatePct: 20 };
      const liveSnapshot = { ...createBaseSnapshot('live'), errorRatePct: 20 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('HALT_TRADING');
      expect(liveResult.decision.type).toBe('HALT_TRADING');
    });

    it('HALT: latency triggers at same threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), avgLatencyMs: 5000 };
      const liveSnapshot = { ...createBaseSnapshot('live'), avgLatencyMs: 5000 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('HALT_TRADING');
      expect(liveResult.decision.type).toBe('HALT_TRADING');
    });

    it('HALT: data gap triggers at same threshold', () => {
      const paperSnapshot = { ...createBaseSnapshot('paper'), marketDataStaleMs: 30000 };
      const liveSnapshot = { ...createBaseSnapshot('live'), marketDataStaleMs: 30000 };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('HALT_TRADING');
      expect(liveResult.decision.type).toBe('HALT_TRADING');
    });

    it('BLOCK_ENTRY: per-symbol loss limit triggers at same threshold', () => {
      const paperSnapshot = {
        ...createBaseSnapshot('paper'),
        dailyLossPerSymbolUsd: { 'BTC-USD': 500 },
      };
      const liveSnapshot = {
        ...createBaseSnapshot('live'),
        dailyLossPerSymbolUsd: { 'BTC-USD': 500 },
      };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe('BLOCK_ENTRY');
      expect(liveResult.decision.type).toBe('BLOCK_ENTRY');
    });
  });

  describe('Explicit Paper Overrides', () => {
    it('error rate override only affects paper mode', () => {
      const snapshot = { ...createBaseSnapshot('paper'), errorRatePct: 25 };
      const overrides: PaperOverrideFlags = {
        ...DEFAULT_PAPER_OVERRIDES,
        disableErrorRateLimit: true,
      };

      const paperResult = evaluateRisk(snapshot, thresholds, overrides);
      
      expect(paperResult.decision.type).toBe('ALLOW');
      expect(paperResult.paperOverridesApplied).toContain('disableErrorRateLimit');

      // Live should still halt even with overrides
      const liveSnapshot = { ...createBaseSnapshot('live'), errorRatePct: 25 };
      const liveResult = evaluateRisk(liveSnapshot, thresholds, overrides);
      expect(liveResult.decision.type).toBe('HALT_TRADING');
      expect(liveResult.paperOverridesApplied).not.toContain('disableErrorRateLimit');
    });

    it('latency override only affects paper mode', () => {
      const snapshot = { ...createBaseSnapshot('paper'), avgLatencyMs: 6000 };
      const overrides: PaperOverrideFlags = {
        ...DEFAULT_PAPER_OVERRIDES,
        disableLatencyLimit: true,
      };

      const paperResult = evaluateRisk(snapshot, thresholds, overrides);
      
      expect(paperResult.decision.type).toBe('ALLOW');
      expect(paperResult.paperOverridesApplied).toContain('disableLatencyLimit');
    });

    it('data gap override only affects paper mode', () => {
      const snapshot = { ...createBaseSnapshot('paper'), marketDataStaleMs: 35000 };
      const overrides: PaperOverrideFlags = {
        ...DEFAULT_PAPER_OVERRIDES,
        disableDataGapLimit: true,
      };

      const paperResult = evaluateRisk(snapshot, thresholds, overrides);
      
      expect(paperResult.decision.type).toBe('ALLOW');
      expect(paperResult.paperOverridesApplied).toContain('disableDataGapLimit');
    });

    it('default overrides produce parity (no overrides applied)', () => {
      const snapshot = { ...createBaseSnapshot('paper'), errorRatePct: 25 };
      const result = evaluateRisk(snapshot, thresholds, DEFAULT_PAPER_OVERRIDES);

      expect(result.decision.type).toBe('HALT_TRADING');
      expect(result.paperOverridesApplied).toHaveLength(0);
    });
  });
});

describe('Pre-Trade Gate Parity', () => {
  const thresholds = createBaseThresholds();

  it('same order produces same allow/block in paper and live', () => {
    // This test verifies the order check logic is mode-agnostic
    const orderNotional = 5000;
    const resultingPosition = 8000;
    const resultingExposure = 30000;

    const result = checkOrderAllowed(
      orderNotional,
      resultingPosition,
      resultingExposure,
      false,
      thresholds
    );

    expect(result.allowed).toBe(true);
    expect(result.reasons).toHaveLength(0);
  });

  it('blocks order below min notional', () => {
    const result = checkOrderAllowed(40, 40, 40, false, thresholds);
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain('Order notional $40.00 < min $50.00');
  });

  it('blocks order above max notional', () => {
    const result = checkOrderAllowed(11000, 11000, 11000, false, thresholds);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Order notional'))).toBe(true);
  });

  it('blocks order that would exceed max position', () => {
    const result = checkOrderAllowed(5000, 15000, 30000, false, thresholds);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Position notional'))).toBe(true);
  });

  it('blocks order that would exceed max exposure', () => {
    const result = checkOrderAllowed(5000, 8000, 55000, false, thresholds);
    expect(result.allowed).toBe(false);
    expect(result.reasons.some(r => r.includes('Total exposure'))).toBe(true);
  });

  it('always allows reduce-only orders', () => {
    // Even with exposure over limit, reduce-only should work
    const result = checkOrderAllowed(1000, 1000, 60000, true, thresholds);
    expect(result.allowed).toBe(true);
  });
});

describe('Threshold Builder', () => {
  it('builds consistent thresholds from guardrails', () => {
    const guardrails = {
      risk: {
        daily_loss_limit: 0.02, // 2%
        weekly_loss_limit: 0.04, // 4%
        max_drawdown_limit: 0.05, // 5%
        max_position_exposure_pct: 0.2, // 20%
      },
      account: {
        equity_usd: 50000,
        risk_per_trade: 0.01, // 1%
        max_open_positions: 5,
        max_account_leverage: 1,
        min_notional_buffer: 0.5,
      },
      circuit_breakers: {
        max_consecutive_losses: 5,
        data_gap_sec: 30,
      },
      per_symbol: {
        'BTC-USD': { max_notional_usd: 25000, max_daily_loss_usd: 500 },
      },
    };

    const thresholds = buildThresholdsFromGuardrails(guardrails);

    expect(thresholds.dailyStopR).toBe(-2); // 2% / 1% = 2R
    expect(thresholds.dailyStopUsd).toBe(1000); // 2% of 50000
    expect(thresholds.weeklyStopUsd).toBe(2000); // 4% of 50000
    expect(thresholds.maxDrawdownPct).toBe(0.05);
    expect(thresholds.maxExposureUsd).toBe(50000); // 1x leverage
    expect(thresholds.maxPositionNotionalUsd).toBe(10000); // 20% of 50000
    expect(thresholds.minOrderNotionalUsd).toBe(250); // 50000 * 0.01 * 0.5
    expect(thresholds.maxConsecutiveLosses).toBe(5);
    expect(thresholds.maxLatencyMs).toBe(30000);
    expect(thresholds.maxDailyLossPerSymbolUsd['BTC-USD']).toBe(500);
  });
});

describe('Matrix Test: All Guardrails', () => {
  const thresholds = createBaseThresholds();
  
  interface TestCase {
    name: string;
    modify: Partial<RiskEvaluationSnapshot>;
    expectedDecision: 'ALLOW' | 'BLOCK_ENTRY' | 'HALT_TRADING';
    expectedReason?: string;
  }

  const testCases: TestCase[] = [
    // Passing cases
    { name: 'healthy state', modify: {}, expectedDecision: 'ALLOW' },
    { name: 'small loss', modify: { dailyPnlR: -0.5 }, expectedDecision: 'ALLOW' },
    { name: 'some exposure', modify: { exposureUsd: 25000 }, expectedDecision: 'ALLOW' },
    { name: 'few positions', modify: { openPositionsCount: 3 }, expectedDecision: 'ALLOW' },
    
    // Halt cases
    { name: 'daily stop at -2R', modify: { dailyPnlR: -2.0 }, expectedDecision: 'HALT_TRADING', expectedReason: 'daily_stop' },
    { name: 'daily stop at -2.5R', modify: { dailyPnlR: -2.5 }, expectedDecision: 'HALT_TRADING', expectedReason: 'daily_stop' },
    { name: 'weekly stop', modify: { weeklyPnlUsd: -2000 }, expectedDecision: 'HALT_TRADING', expectedReason: 'weekly_stop' },
    { name: 'max drawdown', modify: { maxDrawdownPct: 0.06 }, expectedDecision: 'HALT_TRADING', expectedReason: 'max_drawdown' },
    { name: 'consecutive losses', modify: { consecutiveLosses: 6 }, expectedDecision: 'HALT_TRADING', expectedReason: 'consecutive_losses' },
    { name: 'error rate', modify: { errorRatePct: 25 }, expectedDecision: 'HALT_TRADING', expectedReason: 'error_rate' },
    { name: 'latency', modify: { avgLatencyMs: 6000 }, expectedDecision: 'HALT_TRADING', expectedReason: 'latency' },
    { name: 'data gap', modify: { marketDataStaleMs: 35000 }, expectedDecision: 'HALT_TRADING', expectedReason: 'data_gap' },
    
    // Block entry cases
    { name: 'max exposure', modify: { exposureUsd: 55000 }, expectedDecision: 'BLOCK_ENTRY' },
    { name: 'max positions', modify: { openPositionsCount: 5 }, expectedDecision: 'BLOCK_ENTRY' },
    { name: 'max orders', modify: { openOrdersCount: 10 }, expectedDecision: 'BLOCK_ENTRY' },
  ];

  for (const tc of testCases) {
    it(`${tc.name}: paper and live match`, () => {
      const paperSnapshot: RiskEvaluationSnapshot = {
        ...createBaseSnapshot('paper'),
        ...tc.modify,
      };
      const liveSnapshot: RiskEvaluationSnapshot = {
        ...createBaseSnapshot('live'),
        ...tc.modify,
      };

      const paperResult = evaluateRisk(paperSnapshot, thresholds);
      const liveResult = evaluateRisk(liveSnapshot, thresholds);

      expect(paperResult.decision.type).toBe(tc.expectedDecision);
      expect(liveResult.decision.type).toBe(tc.expectedDecision);
      
      if (tc.expectedReason && paperResult.decision.type === 'HALT_TRADING') {
        expect(paperResult.decision.reasonCode).toBe(tc.expectedReason);
      }
      
      // Key assertion: paper and live produce identical decisions
      expect(paperResult.decision).toEqual(liveResult.decision);
    });
  }
});
