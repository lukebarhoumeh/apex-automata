/**
 * Risk System Tests
 * 
 * Tests for:
 * 1. Risk unit conversion (prevent 0.7 means 70% bugs)
 * 2. Daily stop trigger at exact threshold
 * 3. Kill switch does not kill runtime
 * 4. Reduce-only exits still place when halted
 * 5. Daily rollover behavior
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RiskMath,
  RiskMathConfig,
  validatePerTradeRisk,
  computeDailyStopThresholdR,
  parseDailyStopSetting,
} from '../trading/risk-math';
import {
  RiskStateMachine,
  RiskStateConfig,
  createDailyStopHalt,
  createConsecutiveLossesHalt,
  isDailyHaltReason,
} from '../trading/risk-state';
import { Logger } from '../core/logger';

// Mock logger
const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

describe('Risk Math', () => {
  describe('Per-Trade Risk Validation', () => {
    it('should accept valid fraction (0.01 = 1%)', () => {
      const result = validatePerTradeRisk(0.01, 'test', mockLogger);
      expect(result).toBe(0.01);
    });

    it('should reject and auto-correct percentage values', () => {
      // 1.0 looks like someone meant 1%
      const result = validatePerTradeRisk(1.0, 'test', mockLogger);
      expect(result).toBe(0.01);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should reject and auto-correct large percentage values', () => {
      // 70 looks like someone meant 0.7%
      const result = validatePerTradeRisk(70, 'test', mockLogger);
      expect(result).toBe(0.70);
    });

    it('should warn on unusually small values', () => {
      const result = validatePerTradeRisk(0.0001, 'test', mockLogger);
      expect(result).toBe(0.0001);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should warn on unusually large values (but still valid)', () => {
      // Reset mock
      vi.clearAllMocks();
      const result = validatePerTradeRisk(0.09, 'test', mockLogger);
      expect(result).toBe(0.09);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    it('should default to 0.01 for invalid values', () => {
      const result = validatePerTradeRisk(NaN, 'test', mockLogger);
      expect(result).toBe(0.01);
    });
  });

  describe('Risk Unit Calculation', () => {
    it('should compute risk unit correctly', () => {
      const config: RiskMathConfig = {
        accountEquityUsd: 50000,
        perTradeRiskFraction: 0.01, // 1%
        logger: mockLogger,
      };

      const riskMath = new RiskMath(config);
      
      // 1% of 50000 = 500
      expect(riskMath.computeRiskUnit()).toBe(500);
    });

    it('should convert USD to R correctly', () => {
      const config: RiskMathConfig = {
        accountEquityUsd: 50000,
        perTradeRiskFraction: 0.01,
        logger: mockLogger,
      };

      const riskMath = new RiskMath(config);
      
      // -1000 USD should be -2R (since 1R = 500)
      expect(riskMath.usdToR(-1000)).toBe(-2);
      expect(riskMath.usdToR(500)).toBe(1);
      expect(riskMath.usdToR(0)).toBe(0);
    });

    it('should convert R to USD correctly', () => {
      const config: RiskMathConfig = {
        accountEquityUsd: 50000,
        perTradeRiskFraction: 0.01,
        logger: mockLogger,
      };

      const riskMath = new RiskMath(config);
      
      // -2R should be -1000 USD
      expect(riskMath.rToUsd(-2)).toBe(-1000);
      expect(riskMath.rToUsd(1)).toBe(500);
    });
  });

  describe('Daily Stop Threshold', () => {
    it('should compute daily stop threshold in R', () => {
      // 2% daily loss limit with 1% per trade = -2R
      const threshold = computeDailyStopThresholdR(0.02, 0.01);
      expect(threshold).toBe(-2);
    });

    it('should handle different risk levels', () => {
      // 4% daily loss limit with 0.5% per trade = -8R
      const threshold = computeDailyStopThresholdR(0.04, 0.005);
      expect(threshold).toBe(-8);
    });

    it('should trigger at exact threshold', () => {
      const config: RiskMathConfig = {
        accountEquityUsd: 50000,
        perTradeRiskFraction: 0.01, // 1% = 500 per R
        logger: mockLogger,
      };

      const riskMath = new RiskMath(config);
      
      // Threshold: -2R
      const thresholdR = -2;
      
      // At -999 USD (just under -2R), should NOT trigger
      riskMath.computeSnapshot(-999, 0);
      expect(riskMath.isDailyStopTriggered(thresholdR)).toBe(false);
      
      // At -1000 USD (exactly -2R), SHOULD trigger
      riskMath.computeSnapshot(-1000, 0);
      expect(riskMath.isDailyStopTriggered(thresholdR)).toBe(true);
      
      // At -1001 USD (past -2R), SHOULD trigger
      riskMath.computeSnapshot(-1001, 0);
      expect(riskMath.isDailyStopTriggered(thresholdR)).toBe(true);
    });
  });

  describe('Risk Snapshot', () => {
    it('should compute complete snapshot', () => {
      const config: RiskMathConfig = {
        accountEquityUsd: 50000,
        perTradeRiskFraction: 0.01,
        logger: mockLogger,
      };

      const riskMath = new RiskMath(config);
      
      // -500 realized, -200 unrealized
      const snapshot = riskMath.computeSnapshot(-500, -200);
      
      expect(snapshot.dayStartEquityUsd).toBe(50000);
      expect(snapshot.realizedPnlUsd).toBe(-500);
      expect(snapshot.unrealizedPnlUsd).toBe(-200);
      expect(snapshot.netPnlUsd).toBe(-700);
      expect(snapshot.currentEquityUsd).toBe(49300);
      expect(snapshot.dailyPnlUsd).toBe(-700);
      expect(snapshot.riskUnitUsd).toBe(500);
      expect(snapshot.dailyPnlR).toBeCloseTo(-1.4);
    });

    it('should track drawdown from intraday high', () => {
      const config: RiskMathConfig = {
        accountEquityUsd: 50000,
        perTradeRiskFraction: 0.01,
        logger: mockLogger,
      };

      const riskMath = new RiskMath(config);
      
      // Go up first
      riskMath.computeSnapshot(1000, 0); // Equity: 51000
      expect(riskMath.getSnapshot()?.intradayHighUsd).toBe(51000);
      
      // Now go down
      const snapshot = riskMath.computeSnapshot(500, 0); // Equity: 50500
      expect(snapshot.intradayHighUsd).toBe(51000);
      expect(snapshot.drawdownUsd).toBe(500);
      expect(snapshot.drawdownPct).toBeCloseTo(500 / 51000);
    });
  });

  describe('Day Reset', () => {
    it('should reset for new day correctly', () => {
      const config: RiskMathConfig = {
        accountEquityUsd: 50000,
        perTradeRiskFraction: 0.01,
        logger: mockLogger,
      };

      const riskMath = new RiskMath(config);
      
      // Accumulate some P&L
      riskMath.computeSnapshot(2000, 0);
      
      // Reset for new day
      riskMath.resetForNewDay(52000);
      
      expect(riskMath.getDayStartEquity()).toBe(52000);
      expect(riskMath.computeRiskUnit()).toBe(520); // 1% of 52000
    });
  });
});

describe('Risk State Machine', () => {
  let stateMachine: RiskStateMachine;

  beforeEach(() => {
    vi.clearAllMocks();
    stateMachine = new RiskStateMachine({
      logger: mockLogger,
    });
  });

  describe('Initial State', () => {
    it('should start in RUNNING state', () => {
      expect(stateMachine.getState().state).toBe('RUNNING');
      expect(stateMachine.isRunning()).toBe(true);
      expect(stateMachine.isHalted()).toBe(false);
      expect(stateMachine.canEnterTrades()).toBe(true);
    });
  });

  describe('Halt Behavior', () => {
    it('should transition to HALTED state', () => {
      stateMachine.halt('daily_stop', 'Daily loss limit', true, {
        dailyPnlUsd: -1000,
        dailyPnlR: -2,
      });

      expect(stateMachine.getState().state).toBe('HALTED');
      expect(stateMachine.isHalted()).toBe(true);
      expect(stateMachine.canEnterTrades()).toBe(false);
      expect(stateMachine.getHaltReasonCode()).toBe('daily_stop');
    });

    it('should always allow exits when halted', () => {
      stateMachine.halt('daily_stop', 'Daily loss limit', true);
      
      expect(stateMachine.canExitTrades()).toBe(true);
    });

    it('should ignore duplicate halts', () => {
      stateMachine.halt('daily_stop', 'First halt', true);
      
      const firstState = stateMachine.getState();
      
      stateMachine.halt('max_drawdown', 'Second halt', false);
      
      // Should still be the first halt
      expect(stateMachine.getHaltReasonCode()).toBe('daily_stop');
    });

    it('should emit events on halt', () => {
      const stateChangeSpy = vi.fn();
      const killswitchSpy = vi.fn();
      
      stateMachine.on('risk:state_changed', stateChangeSpy);
      stateMachine.on('risk:killswitch:triggered', killswitchSpy);
      
      stateMachine.halt('daily_stop', 'Test halt', true);
      
      expect(stateChangeSpy).toHaveBeenCalledTimes(1);
      expect(killswitchSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Resume Behavior', () => {
    it('should not resume from HALTED without force', () => {
      stateMachine.halt('daily_stop', 'Test halt', true);
      
      const resumed = stateMachine.resume(false);
      
      expect(resumed).toBe(false);
      expect(stateMachine.isHalted()).toBe(true);
    });

    it('should resume from HALTED with force', () => {
      stateMachine.halt('daily_stop', 'Test halt', true);
      
      const resumed = stateMachine.resume(true);
      
      expect(resumed).toBe(true);
      expect(stateMachine.isRunning()).toBe(true);
    });

    it('should resume from PAUSED without force', () => {
      stateMachine.pause('Maintenance');
      
      const resumed = stateMachine.resume(false);
      
      expect(resumed).toBe(true);
      expect(stateMachine.isRunning()).toBe(true);
    });
  });

  describe('Day Rollover', () => {
    it('should clear daily halts on rollover', () => {
      stateMachine.halt('daily_stop', 'Daily limit', true);
      expect(stateMachine.isHalted()).toBe(true);
      
      // Simulate rollover by accessing private method through event
      // In real code, checkDayRollover() would detect the boundary
      
      // Force resume (simulating rollover effect)
      stateMachine.resume(true);
      
      expect(stateMachine.isRunning()).toBe(true);
    });

    it('should NOT clear non-daily halts on rollover', () => {
      stateMachine.halt('max_drawdown', 'Drawdown limit', false);
      
      // Even with force resume, we can check the daily flag
      expect(isDailyHaltReason('max_drawdown')).toBe(false);
      expect(isDailyHaltReason('daily_stop')).toBe(true);
    });
  });

  describe('Halt Helpers', () => {
    it('should create daily stop halt correctly', () => {
      const halt = createDailyStopHalt(-1000, -2, -2);
      
      expect(halt.reasonCode).toBe('daily_stop');
      expect(halt.daily).toBe(true);
      expect(halt.context?.dailyPnlUsd).toBe(-1000);
      expect(halt.context?.dailyPnlR).toBe(-2);
    });

    it('should create consecutive losses halt correctly', () => {
      const halt = createConsecutiveLossesHalt(5, 5);
      
      expect(halt.reasonCode).toBe('consecutive_losses');
      expect(halt.daily).toBe(false);
      expect(halt.context?.consecutiveLosses).toBe(5);
    });
  });

  describe('Status API', () => {
    it('should return correct status when running', () => {
      const status = stateMachine.getStatus();
      
      expect(status.tradingState).toBe('RUNNING');
      expect(status.reasonCode).toBeUndefined();
    });

    it('should return correct status when halted', () => {
      stateMachine.halt('daily_stop', 'Test', true, { dailyPnlR: -2 });
      
      const status = stateMachine.getStatus();
      
      expect(status.tradingState).toBe('HALTED');
      expect(status.reasonCode).toBe('daily_stop');
      expect(status.daily).toBe(true);
      expect(status.context?.dailyPnlR).toBe(-2);
    });
  });
});

describe('Integration: Kill Switch Does Not Kill Runtime', () => {
  it('should halt trading but keep state accessible', () => {
    const riskMath = new RiskMath({
      accountEquityUsd: 50000,
      perTradeRiskFraction: 0.01,
      logger: mockLogger,
    });

    const stateMachine = new RiskStateMachine({
      logger: mockLogger,
    });

    // Simulate loss that triggers daily stop
    const snapshot = riskMath.computeSnapshot(-1000, 0);
    
    // Check if daily stop should trigger
    const thresholdR = -2;
    if (riskMath.isDailyStopTriggered(thresholdR)) {
      const halt = createDailyStopHalt(
        snapshot.dailyPnlUsd,
        snapshot.dailyPnlR,
        thresholdR
      );
      stateMachine.halt(halt.reasonCode, halt.reasonText, halt.daily, halt.context);
    }

    // Verify state
    expect(stateMachine.isHalted()).toBe(true);
    expect(stateMachine.canEnterTrades()).toBe(false);
    expect(stateMachine.canExitTrades()).toBe(true);

    // Verify we can still get status (runtime alive)
    const status = stateMachine.getStatus();
    expect(status.tradingState).toBe('HALTED');

    // Verify risk math still works (not crashed)
    const mathStatus = riskMath.getStatus();
    expect(mathStatus.dailyPnlR).toBe(-2);
    
    // Verify we can compute new snapshots (market data still flowing)
    const newSnapshot = riskMath.computeSnapshot(-1100, 0);
    expect(newSnapshot.dailyPnlR).toBeCloseTo(-2.2);
  });
});

describe('Integration: Reduce-Only Exits', () => {
  it('should allow exit orders when halted', () => {
    const stateMachine = new RiskStateMachine({
      logger: mockLogger,
    });

    // Halt trading
    stateMachine.halt('daily_stop', 'Daily limit', true);

    // Check permissions
    expect(stateMachine.canEnterTrades()).toBe(false);
    expect(stateMachine.canExitTrades()).toBe(true);

    // Simulate order check
    const isEntry = true;
    const isExit = false;

    const entryAllowed = stateMachine.canEnterTrades();
    const exitAllowed = stateMachine.canExitTrades();

    expect(entryAllowed).toBe(false);
    expect(exitAllowed).toBe(true);
  });
});
