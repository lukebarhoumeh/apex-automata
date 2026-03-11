/**
 * Pure Risk Evaluation Function
 * 
 * This is the single source of truth for all risk decisions.
 * The evaluation is MODE-AGNOSTIC: same inputs → same outputs.
 * 
 * The only allowed mode-specific behavior is through explicit override flags,
 * which default to FALSE (parity behavior).
 */

import {
  RiskEvaluationSnapshot,
  RiskThresholds,
  PaperOverrideFlags,
  RiskDecision,
  GuardrailCheckResult,
  RiskEvaluationResult,
  DEFAULT_PAPER_OVERRIDES,
} from './types';

/**
 * Evaluate all risk guardrails against a snapshot
 * 
 * This is a PURE FUNCTION: no side effects, no mode-specific behavior
 * except through explicit override flags.
 * 
 * @param snapshot - The current risk snapshot
 * @param thresholds - Risk thresholds configuration
 * @param overrides - Paper mode override flags (optional, defaults to parity)
 * @returns Complete evaluation result with decision and check details
 */
export function evaluateRisk(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds,
  overrides: PaperOverrideFlags = DEFAULT_PAPER_OVERRIDES
): RiskEvaluationResult {
  const checks: GuardrailCheckResult[] = [];
  const appliedOverrides: string[] = [];
  const isPaper = snapshot.executionMode === 'paper';

  // ============ Trading Halt Guardrails (Block All + Halt) ============

  // 1. Daily Stop (R-based)
  checks.push(checkDailyStopR(snapshot, thresholds));

  // 2. Daily Stop (USD-based, fallback)
  checks.push(checkDailyStopUsd(snapshot, thresholds));

  // 3. Weekly Stop
  checks.push(checkWeeklyStop(snapshot, thresholds));

  // 4. Max Drawdown
  checks.push(checkMaxDrawdown(snapshot, thresholds));

  // 5. Consecutive Losses
  checks.push(checkConsecutiveLosses(snapshot, thresholds));

  // 6. Error Rate (with optional paper override)
  const errorRateCheck = checkErrorRate(snapshot, thresholds);
  if (isPaper && overrides.disableErrorRateLimit && !errorRateCheck.passed) {
    appliedOverrides.push('disableErrorRateLimit');
    errorRateCheck.passed = true;
    errorRateCheck.reason = `OVERRIDE: Error rate check disabled in paper mode`;
  }
  checks.push(errorRateCheck);

  // 7. Latency (with optional paper override)
  const latencyCheck = checkLatency(snapshot, thresholds);
  if (isPaper && overrides.disableLatencyLimit && !latencyCheck.passed) {
    appliedOverrides.push('disableLatencyLimit');
    latencyCheck.passed = true;
    latencyCheck.reason = `OVERRIDE: Latency check disabled in paper mode`;
  }
  checks.push(latencyCheck);

  // 8. Market Data Staleness (with optional paper override)
  const dataGapCheck = checkDataGap(snapshot, thresholds);
  if (isPaper && overrides.disableDataGapLimit && !dataGapCheck.passed) {
    appliedOverrides.push('disableDataGapLimit');
    dataGapCheck.passed = true;
    dataGapCheck.reason = `OVERRIDE: Data gap check disabled in paper mode`;
  }
  checks.push(dataGapCheck);

  // ============ Entry Block Guardrails (Block Entry Only) ============

  // 9. Max Total Exposure
  checks.push(checkMaxExposure(snapshot, thresholds));

  // 10. Max Open Positions
  checks.push(checkMaxOpenPositions(snapshot, thresholds));

  // 11. Max Open Orders
  checks.push(checkMaxOpenOrders(snapshot, thresholds));

  // 12. Per-Symbol Loss Limits
  const symbolChecks = checkPerSymbolLossLimits(snapshot, thresholds);
  checks.push(...symbolChecks);

  // ============ Determine Final Decision ============

  const failedChecks = checks.filter(c => !c.passed);
  
  if (failedChecks.length === 0) {
    return {
      decision: { type: 'ALLOW' },
      checks,
      evaluatedAt: Date.now(),
      snapshot,
      paperOverridesApplied: appliedOverrides,
    };
  }

  // Check for halt conditions first (most severe)
  const haltCheck = failedChecks.find(c => c.haltsTrading);
  if (haltCheck) {
    return {
      decision: {
        type: 'HALT_TRADING',
        reasonCode: haltCheck.name,
        reasonText: haltCheck.reason || `${haltCheck.name} limit exceeded`,
        daily: haltCheck.daily,
      },
      checks,
      evaluatedAt: Date.now(),
      snapshot,
      paperOverridesApplied: appliedOverrides,
    };
  }

  // Otherwise, block entry
  return {
    decision: {
      type: 'BLOCK_ENTRY',
      reasons: failedChecks.map(c => c.reason || c.name),
    },
    checks,
    evaluatedAt: Date.now(),
    snapshot,
    paperOverridesApplied: appliedOverrides,
  };
}

// ============ Individual Guardrail Check Functions ============

function checkDailyStopR(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.dailyPnlR > thresholds.dailyStopR;
  return {
    name: 'daily_stop',
    passed,
    currentValue: snapshot.dailyPnlR,
    thresholdValue: thresholds.dailyStopR,
    reason: passed
      ? undefined
      : `Daily P&L ${snapshot.dailyPnlR.toFixed(2)}R <= threshold ${thresholds.dailyStopR}R`,
    haltsTrading: true,
    daily: true,
  };
}

function checkDailyStopUsd(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  // Note: thresholds.dailyStopUsd should be positive, dailyPnlUsd negative when losing
  const passed = snapshot.dailyPnlUsd > -thresholds.dailyStopUsd;
  return {
    name: 'daily_stop_usd',
    passed,
    currentValue: snapshot.dailyPnlUsd,
    thresholdValue: -thresholds.dailyStopUsd,
    reason: passed
      ? undefined
      : `Daily P&L $${snapshot.dailyPnlUsd.toFixed(2)} <= threshold -$${thresholds.dailyStopUsd.toFixed(2)}`,
    haltsTrading: true,
    daily: true,
  };
}

function checkWeeklyStop(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.weeklyPnlUsd > -thresholds.weeklyStopUsd;
  return {
    name: 'weekly_stop',
    passed,
    currentValue: snapshot.weeklyPnlUsd,
    thresholdValue: -thresholds.weeklyStopUsd,
    reason: passed
      ? undefined
      : `Weekly P&L $${snapshot.weeklyPnlUsd.toFixed(2)} <= threshold -$${thresholds.weeklyStopUsd.toFixed(2)}`,
    haltsTrading: true,
    daily: false, // Weekly halts don't auto-clear on daily rollover
  };
}

function checkMaxDrawdown(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.maxDrawdownPct < thresholds.maxDrawdownPct;
  return {
    name: 'max_drawdown',
    passed,
    currentValue: snapshot.maxDrawdownPct,
    thresholdValue: thresholds.maxDrawdownPct,
    reason: passed
      ? undefined
      : `Drawdown ${(snapshot.maxDrawdownPct * 100).toFixed(2)}% >= limit ${(thresholds.maxDrawdownPct * 100).toFixed(2)}%`,
    haltsTrading: true,
    daily: false,
  };
}

function checkConsecutiveLosses(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.consecutiveLosses < thresholds.maxConsecutiveLosses;
  return {
    name: 'consecutive_losses',
    passed,
    currentValue: snapshot.consecutiveLosses,
    thresholdValue: thresholds.maxConsecutiveLosses,
    reason: passed
      ? undefined
      : `Consecutive losses ${snapshot.consecutiveLosses} >= limit ${thresholds.maxConsecutiveLosses}`,
    haltsTrading: true,
    daily: false,
  };
}

function checkErrorRate(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.errorRatePct < thresholds.maxErrorRatePct;
  return {
    name: 'error_rate',
    passed,
    currentValue: snapshot.errorRatePct,
    thresholdValue: thresholds.maxErrorRatePct,
    reason: passed
      ? undefined
      : `Error rate ${snapshot.errorRatePct.toFixed(2)}% >= limit ${thresholds.maxErrorRatePct}%`,
    haltsTrading: true,
    daily: false,
  };
}

function checkLatency(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.avgLatencyMs < thresholds.maxLatencyMs;
  return {
    name: 'latency',
    passed,
    currentValue: snapshot.avgLatencyMs,
    thresholdValue: thresholds.maxLatencyMs,
    reason: passed
      ? undefined
      : `Average latency ${snapshot.avgLatencyMs.toFixed(0)}ms >= limit ${thresholds.maxLatencyMs}ms`,
    haltsTrading: true,
    daily: false,
  };
}

function checkDataGap(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.marketDataStaleMs < thresholds.maxMarketDataStaleMs;
  return {
    name: 'data_gap',
    passed,
    currentValue: snapshot.marketDataStaleMs,
    thresholdValue: thresholds.maxMarketDataStaleMs,
    reason: passed
      ? undefined
      : `Market data stale ${snapshot.marketDataStaleMs}ms >= limit ${thresholds.maxMarketDataStaleMs}ms`,
    haltsTrading: true,
    daily: false,
  };
}

function checkMaxExposure(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.exposureUsd <= thresholds.maxExposureUsd;
  return {
    name: 'max_exposure',
    passed,
    currentValue: snapshot.exposureUsd,
    thresholdValue: thresholds.maxExposureUsd,
    reason: passed
      ? undefined
      : `Exposure $${snapshot.exposureUsd.toFixed(2)} > limit $${thresholds.maxExposureUsd.toFixed(2)}`,
    haltsTrading: false, // Just block entry, don't halt
    daily: false,
  };
}

function checkMaxOpenPositions(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.openPositionsCount < thresholds.maxOpenPositions;
  return {
    name: 'max_open_positions',
    passed,
    currentValue: snapshot.openPositionsCount,
    thresholdValue: thresholds.maxOpenPositions,
    reason: passed
      ? undefined
      : `Open positions ${snapshot.openPositionsCount} >= limit ${thresholds.maxOpenPositions}`,
    haltsTrading: false,
    daily: false,
  };
}

function checkMaxOpenOrders(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult {
  const passed = snapshot.openOrdersCount < thresholds.maxOpenOrders;
  return {
    name: 'max_open_orders',
    passed,
    currentValue: snapshot.openOrdersCount,
    thresholdValue: thresholds.maxOpenOrders,
    reason: passed
      ? undefined
      : `Open orders ${snapshot.openOrdersCount} >= limit ${thresholds.maxOpenOrders}`,
    haltsTrading: false,
    daily: false,
  };
}

function checkPerSymbolLossLimits(
  snapshot: RiskEvaluationSnapshot,
  thresholds: RiskThresholds
): GuardrailCheckResult[] {
  const results: GuardrailCheckResult[] = [];

  for (const [symbol, lossUsd] of Object.entries(snapshot.dailyLossPerSymbolUsd)) {
    const limit = thresholds.maxDailyLossPerSymbolUsd[symbol];
    if (limit === undefined) continue;

    const passed = lossUsd < limit;
    results.push({
      name: `symbol_loss_${symbol}`,
      passed,
      currentValue: lossUsd,
      thresholdValue: limit,
      reason: passed
        ? undefined
        : `${symbol} daily loss $${lossUsd.toFixed(2)} >= limit $${limit.toFixed(2)}`,
      haltsTrading: false, // Symbol block, not full halt
      daily: true,
    });
  }

  return results;
}

// ============ Pre-Trade Order Check ============

/**
 * Check if a specific order can be placed
 * 
 * This is for pre-trade gating on individual orders.
 */
export function checkOrderAllowed(
  orderNotionalUsd: number,
  resultingPositionNotionalUsd: number,
  resultingExposureUsd: number,
  isReduceOnly: boolean,
  thresholds: RiskThresholds
): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Reduce-only orders are always allowed (exits must work)
  if (isReduceOnly) {
    return { allowed: true, reasons: [] };
  }

  // Check order notional bounds
  if (orderNotionalUsd < thresholds.minOrderNotionalUsd) {
    reasons.push(`Order notional $${orderNotionalUsd.toFixed(2)} < min $${thresholds.minOrderNotionalUsd.toFixed(2)}`);
  }

  if (orderNotionalUsd > thresholds.maxOrderNotionalUsd) {
    reasons.push(`Order notional $${orderNotionalUsd.toFixed(2)} > max $${thresholds.maxOrderNotionalUsd.toFixed(2)}`);
  }

  // Check resulting position notional
  if (resultingPositionNotionalUsd > thresholds.maxPositionNotionalUsd) {
    reasons.push(`Position notional $${resultingPositionNotionalUsd.toFixed(2)} > max $${thresholds.maxPositionNotionalUsd.toFixed(2)}`);
  }

  // Check resulting total exposure
  if (resultingExposureUsd > thresholds.maxExposureUsd) {
    reasons.push(`Total exposure $${resultingExposureUsd.toFixed(2)} > max $${thresholds.maxExposureUsd.toFixed(2)}`);
  }

  return {
    allowed: reasons.length === 0,
    reasons,
  };
}

// ============ Snapshot Builder Helper ============

/**
 * Build thresholds from guardrails config
 */
export function buildThresholdsFromGuardrails(
  guardrails: {
    risk: {
      daily_loss_limit: number;
      weekly_loss_limit: number;
      max_drawdown_limit: number;
      max_position_exposure_pct: number;
    };
    account: {
      equity_usd: number;
      risk_per_trade: number;
      max_open_positions: number;
      max_account_leverage: number;
      min_notional_buffer: number;
    };
    circuit_breakers: {
      max_consecutive_losses: number;
      data_gap_sec: number;
    };
    per_symbol?: Record<string, { max_notional_usd: number; max_daily_loss_usd: number }>;
    perps_symbols?: Record<string, { max_notional_usd: number; max_daily_loss_usd: number }>;
  }
): RiskThresholds {
  const equity = guardrails.account.equity_usd;
  const perTradeRisk = guardrails.account.risk_per_trade;
  
  // Compute daily stop in R
  const dailyStopR = -(Math.abs(guardrails.risk.daily_loss_limit) / perTradeRisk);
  const dailyStopUsd = Math.abs(guardrails.risk.daily_loss_limit) * equity;
  const weeklyStopUsd = Math.abs(guardrails.risk.weekly_loss_limit) * equity;
  
  // Per-symbol limits
  const maxExposurePerSymbolUsd: Record<string, number> = {};
  const maxDailyLossPerSymbolUsd: Record<string, number> = {};
  
  if (guardrails.per_symbol) {
    for (const [symbol, limits] of Object.entries(guardrails.per_symbol)) {
      maxExposurePerSymbolUsd[symbol] = limits.max_notional_usd;
      maxDailyLossPerSymbolUsd[symbol] = limits.max_daily_loss_usd;
    }
  }

  // Merge perps symbol limits (same structure, different symbols)
  if (guardrails.perps_symbols) {
    for (const [symbol, limits] of Object.entries(guardrails.perps_symbols)) {
      maxExposurePerSymbolUsd[symbol] = limits.max_notional_usd;
      maxDailyLossPerSymbolUsd[symbol] = limits.max_daily_loss_usd;
    }
  }

  return {
    dailyStopR,
    dailyStopUsd,
    weeklyStopUsd,
    maxDrawdownPct: Math.abs(guardrails.risk.max_drawdown_limit),
    maxExposureUsd: equity * guardrails.account.max_account_leverage,
    maxExposurePerSymbolUsd,
    maxDailyLossPerSymbolUsd,
    maxPositionNotionalUsd: equity * guardrails.risk.max_position_exposure_pct,
    minOrderNotionalUsd: equity * perTradeRisk * guardrails.account.min_notional_buffer,
    maxOrderNotionalUsd: equity * guardrails.risk.max_position_exposure_pct,
    maxOpenPositions: guardrails.account.max_open_positions,
    maxOpenOrders: guardrails.account.max_open_positions,
    maxConsecutiveLosses: guardrails.circuit_breakers.max_consecutive_losses,
    maxErrorRatePct: 20, // 20% error rate limit (same for paper and live)
    maxLatencyMs: guardrails.circuit_breakers.data_gap_sec * 1000,
    maxMarketDataStaleMs: guardrails.circuit_breakers.data_gap_sec * 1000,
  };
}
