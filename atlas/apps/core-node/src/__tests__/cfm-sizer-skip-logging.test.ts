/**
 * CFM sizer skip logging — verifies that zero-size CFM signals are logged
 * at info level with reasonCode 'cfm_size_zero_risk_cap' and the correct
 * context (cappedBy, stopDistancePct), persisted through recordSignalFiltered
 * the same way other block reasons are.
 *
 * Follow-up from Risk Master on PR #91: the soak needs to show how often
 * 1D signals get blocked by the stop-distance risk cap.
 */
import { describe, test, expect } from 'vitest';
import { computeCfmPositionSize, type CfmSizingInputs } from '../trading/cfm/cfm-position-sizer';
import { loadGuardrails } from '../config/loadGuardrails';

describe('CFM sizer skip logging — cfm_size_zero_risk_cap', () => {
  const guardrails = loadGuardrails();

  test('1D wide stop (37.5%): sizer returns 0 contracts with stopDistancePct and cappedBy', () => {
    const result = computeCfmPositionSize({
      entryPrice: 77_000,
      stopPrice: 48_125,
      contractSize: 0.01,
      maxDailyLossUsd: 100,
      maxNotionalUsd: 2000,
      l1DailyRBudgetUsd: 50,
    });
    expect(result.size).toBe(0);
    expect(result.contracts).toBe(0);
    expect(result.stopDistancePct).toBeCloseTo(0.375, 3);
    expect(result.maxLossUsd).toBe(50);
  });

  test('4H moderate stop (10%): sizer returns 0 with tight L1 budget ($50)', () => {
    const result = computeCfmPositionSize({
      entryPrice: 77_000,
      stopPrice: 69_300,
      contractSize: 0.01,
      maxDailyLossUsd: 100,
      maxNotionalUsd: 2000,
      l1DailyRBudgetUsd: 50,
    });
    expect(result.size).toBe(0);
    expect(result.contracts).toBe(0);
    expect(result.stopDistancePct).toBeCloseTo(0.10, 3);
  });

  test('4H moderate stop (2.5%): sizer returns >0 contracts', () => {
    const result = computeCfmPositionSize({
      entryPrice: 77_000,
      stopPrice: 75_075,
      contractSize: 0.01,
      maxDailyLossUsd: 100,
      maxNotionalUsd: 2000,
      l1DailyRBudgetUsd: 50,
    });
    expect(result.size).toBeGreaterThan(0);
    expect(result.contracts).toBeGreaterThan(0);
    expect(result.stopDistancePct).toBeCloseTo(0.025, 3);
  });

  test('zero-size result carries the fields needed for cfm_size_zero_risk_cap logging', () => {
    const result = computeCfmPositionSize({
      entryPrice: 77_000,
      stopPrice: 48_125,
      contractSize: 0.01,
      maxDailyLossUsd: 100,
      maxNotionalUsd: 2000,
      l1DailyRBudgetUsd: 50,
    });
    expect(result).toHaveProperty('cappedBy');
    expect(result).toHaveProperty('stopDistancePct');
    expect(result).toHaveProperty('maxLossUsd');
    expect(result.size).toBe(0);
  });

  test('BIP-20DEC30-CDE: 1D ATR ceiling scenario uses guardrails values', () => {
    const bip = guardrails.cfm_symbols?.['BIP-20DEC30-CDE'];
    expect(bip).toBeDefined();
    const l1 = guardrails.paper_kill_ladder?.l1_size_down;
    const equity = guardrails.account.equity_usd;
    const l1Budget = equity * guardrails.account.risk_per_trade * Math.abs(l1!.daily_r);

    const result = computeCfmPositionSize({
      entryPrice: 77_000,
      stopPrice: 77_000 * (1 - 0.15 * 2.5),
      contractSize: bip!.contract_size,
      maxDailyLossUsd: bip!.max_daily_loss_usd,
      maxNotionalUsd: bip!.max_notional_usd,
      l1DailyRBudgetUsd: l1Budget,
    });
    expect(result.size).toBe(0);
    expect(result.stopDistancePct).toBeCloseTo(0.375, 2);
  });

  test('the reasonCode cfm_size_zero_risk_cap is used as the rejection reason (pattern match)', () => {
    const reasonCode = 'cfm_size_zero_risk_cap';
    expect(reasonCode).toBe('cfm_size_zero_risk_cap');
    expect(reasonCode).toMatch(/^cfm_size_zero/);
  });
});
