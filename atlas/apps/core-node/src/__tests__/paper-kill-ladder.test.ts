/**
 * Graduated paper kill ladder L1–L6 — pure state-machine tests
 * (Risk desk SoT 2026-09-22).
 *
 * Pins every rung transition on the desk thresholds:
 *   L1 consec>=3 OR dailyR<=-1.0 -> cap 0.5 (size_down_consec / size_down_daily_r)
 *   L2 consec>=5 OR dailyR<=-2.0 -> cap 0.25
 *   L3 >=4 consecutive losses in ONE strategy -> strategy_freeze (session)
 *   L4 trend_follow x weak_trend/choppy, 2 losing stop-outs -> regime_pause N hours
 *   L5 sleeve_halt stub (disabled by default; never fires)
 *   L6 dailyR<=-4 OR (consec>=12 AND dailyR<=-2) -> hard kill with the existing
 *      structured codes (daily_stop / consecutive_losses), never `unknown`
 * plus: per-strategy vs portfolio streaks, ratchet semantics, resets
 * (CLEAR vs risk-day rollover), the entry gate and the size cap.
 */
import { describe, test, expect } from 'vitest';
import {
  PaperKillLadder,
  LADDER_SOFT_REASON_CODES,
  STOP_OUT_EXIT_REASONS,
  isLadderSoftReasonCode,
  type LadderTransition,
} from '../trading/risk/paper-kill-ladder';
import { resolvePaperKillLadderConfig, GuardrailsSchema, type PaperKillLadderConfig } from '../config/loadGuardrails';

const T0 = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** Desk SoT block, exactly as shipped in atlas/config/guardrails.yaml. */
function deskConfig(overrides: Record<string, unknown> = {}): PaperKillLadderConfig {
  const parsed = GuardrailsSchema.shape.paper_kill_ladder.parse({
    enabled: true,
    l1_size_down: { enabled: true, consecutive_losses: 3, daily_r: -1.0, position_multiplier: 0.5 },
    l2_size_down: { enabled: true, consecutive_losses: 5, daily_r: -2.0, position_multiplier: 0.25 },
    l3_strategy_freeze: { enabled: true, consecutive_losses: 4 },
    l4_regime_pause: { enabled: true, strategies: ['trend_follow'], regimes: ['weak_trend', 'choppy'], stop_outs: 2, pause_hours: 4 },
    l5_sleeve_halt: { enabled: false },
    l6_hard_kill: { enabled: true, daily_r: -4.0, consecutive_losses: 12, consecutive_losses_daily_r: -2.0 },
    ...overrides,
  });
  return parsed as PaperKillLadderConfig;
}

function ladder(overrides: Record<string, unknown> = {}): PaperKillLadder {
  return new PaperKillLadder(deskConfig(overrides));
}

function loss(strategy: string, extra: Partial<Parameters<PaperKillLadder['recordClosedTrade']>[0]> = {}) {
  return { strategy, symbol: 'ETH-USD', realizedPnl: -12.5, now: T0, ...extra };
}

function win(strategy: string) {
  return { strategy, symbol: 'ETH-USD', realizedPnl: 20, now: T0 };
}

const codes = (ts: LadderTransition[]) => ts.map((t) => `${t.level}:${t.reasonCode}`);

describe('config resolution', () => {
  test('absent block resolves to a disabled ladder with the desk defaults', () => {
    const cfg = resolvePaperKillLadderConfig({});
    expect(cfg.enabled).toBe(false);
    expect(cfg.l1_size_down).toMatchObject({ consecutive_losses: 3, daily_r: -1, position_multiplier: 0.5 });
    expect(cfg.l2_size_down).toMatchObject({ consecutive_losses: 5, daily_r: -2, position_multiplier: 0.25 });
    expect(cfg.l3_strategy_freeze).toMatchObject({ enabled: true, consecutive_losses: 4 });
    expect(cfg.l4_regime_pause).toMatchObject({ strategies: ['trend_follow'], regimes: ['weak_trend', 'choppy'], stop_outs: 2 });
    expect(cfg.l5_sleeve_halt).toEqual({ enabled: false });
    expect(cfg.l6_hard_kill).toMatchObject({ enabled: true, daily_r: -4, consecutive_losses: 12, consecutive_losses_daily_r: -2 });
  });

  test('a present block is returned verbatim', () => {
    const cfg = deskConfig({ enabled: true });
    expect(resolvePaperKillLadderConfig({ paper_kill_ladder: cfg })).toBe(cfg);
  });

  test.each([
    ['L2 consec below L1', { l2_size_down: { consecutive_losses: 2, daily_r: -2, position_multiplier: 0.25 } }],
    ['L2 daily_r above L1', { l2_size_down: { consecutive_losses: 5, daily_r: -0.5, position_multiplier: 0.25 } }],
    ['L2 cap above L1', { l2_size_down: { consecutive_losses: 5, daily_r: -2, position_multiplier: 0.75 } }],
    ['L6 daily_r above L2', { l6_hard_kill: { daily_r: -1.5 } }],
    ['L6 consec below L2', { l6_hard_kill: { consecutive_losses: 4 } }],
    ['positive daily_r', { l1_size_down: { consecutive_losses: 3, daily_r: 1, position_multiplier: 0.5 } }],
    ['cap above 1', { l1_size_down: { consecutive_losses: 3, daily_r: -1, position_multiplier: 1.5 } }],
  ])('rejects a non-monotonic ladder: %s', (_name, overrides) => {
    expect(() => deskConfig(overrides)).toThrow();
  });

  test('soft reason codes are disjoint from the halt codes and recognised by the guard', () => {
    expect(LADDER_SOFT_REASON_CODES).toEqual(['size_down_consec', 'size_down_daily_r', 'strategy_freeze', 'regime_pause', 'sleeve_halt']);
    for (const code of LADDER_SOFT_REASON_CODES) expect(isLadderSoftReasonCode(code)).toBe(true);
    for (const halt of ['daily_stop', 'consecutive_losses', 'manual_killswitch', 'data_gap', 'unknown', 'kill_switch']) {
      expect(isLadderSoftReasonCode(halt)).toBe(false);
    }
    expect(isLadderSoftReasonCode(undefined)).toBe(false);
  });
});

describe('L1 / L2 size-down rungs (portfolio streak OR dailyR)', () => {
  test('nothing armed: cap 1, no transitions, no hard kill', () => {
    const l = ladder();
    const out = l.evaluate({ consecutiveLosses: 2, dailyR: -0.99, now: T0 });
    expect(out.transitions).toEqual([]);
    expect(out.hardKill).toBeNull();
    expect(l.getSizeLevel()).toBe(0);
    expect(l.getPositionMultiplierCap()).toBe(1);
  });

  test('consec >= 3 arms L1 with size_down_consec and cap 0.5', () => {
    const l = ladder();
    const out = l.evaluate({ consecutiveLosses: 3, dailyR: 0.4, now: T0 });
    expect(codes(out.transitions)).toEqual(['1:size_down_consec']);
    expect(out.transitions[0]).toMatchObject({
      positionMultiplier: 0.5,
      at: T0,
      context: { ladderLevel: 1, consecutiveLosses: 3, consecutiveLossesThreshold: 3, positionMultiplier: 0.5 },
    });
    expect(out.hardKill).toBeNull();
    expect(l.getPositionMultiplierCap()).toBe(0.5);
    expect(l.capPositionMultiplier(1)).toBe(0.5);
    expect(l.capPositionMultiplier(0.3)).toBe(0.3);
  });

  test('dailyR <= -1.0 arms L1 with size_down_daily_r even with zero streak', () => {
    const l = ladder();
    const out = l.evaluate({ consecutiveLosses: 0, dailyR: -1.0, now: T0 });
    expect(codes(out.transitions)).toEqual(['1:size_down_daily_r']);
    expect(out.transitions[0].context).toMatchObject({ dailyPnlR: -1, dailyRThreshold: -1 });
    expect(l.getStatus(T0)).toMatchObject({ sizeLevel: 1, sizeReasonCode: 'size_down_daily_r', positionMultiplierCap: 0.5 });
  });

  test('consec >= 5 escalates to L2 (cap 0.25); the L1 -> L2 path emits one transition per rung', () => {
    const l = ladder();
    expect(codes(l.evaluate({ consecutiveLosses: 3, dailyR: 0, now: T0 }).transitions)).toEqual(['1:size_down_consec']);
    expect(codes(l.evaluate({ consecutiveLosses: 4, dailyR: 0, now: T0 }).transitions)).toEqual([]);
    expect(codes(l.evaluate({ consecutiveLosses: 5, dailyR: 0, now: T0 }).transitions)).toEqual(['2:size_down_consec']);
    expect(l.getPositionMultiplierCap()).toBe(0.25);
    expect(l.capPositionMultiplier(1)).toBe(0.25);
    expect(l.capPositionMultiplier(0.5)).toBe(0.25);
  });

  test('dailyR <= -2.0 jumps straight to L2 from a clean state', () => {
    const l = ladder();
    const out = l.evaluate({ consecutiveLosses: 1, dailyR: -2.3, now: T0 });
    expect(codes(out.transitions)).toEqual(['2:size_down_daily_r']);
    expect(out.transitions[0].positionMultiplier).toBe(0.25);
  });

  test('consec is preferred as the reason when both conditions hold', () => {
    const out = ladder().evaluate({ consecutiveLosses: 5, dailyR: -2.5, now: T0 });
    expect(codes(out.transitions)).toEqual(['2:size_down_consec']);
  });

  test('caps ratchet: recovery within the day does not lift the cap, and re-arming is silent', () => {
    const l = ladder();
    l.evaluate({ consecutiveLosses: 3, dailyR: -1.2, now: T0 });
    // A win resets the streak and P&L recovers above -1R: still L1.
    expect(l.evaluate({ consecutiveLosses: 0, dailyR: 0.5, now: T0 + 1 }).transitions).toEqual([]);
    expect(l.getSizeLevel()).toBe(1);
    expect(l.getPositionMultiplierCap()).toBe(0.5);
    // Crossing -1R again is not a new transition (no flapping rows).
    expect(l.evaluate({ consecutiveLosses: 3, dailyR: -1.1, now: T0 + 2 }).transitions).toEqual([]);
  });

  test('a disabled rung is skipped (L1 off -> the first size-down is L2)', () => {
    const l = ladder({ l1_size_down: { enabled: false, consecutive_losses: 3, daily_r: -1, position_multiplier: 0.5 } });
    expect(l.evaluate({ consecutiveLosses: 4, dailyR: -1.5, now: T0 }).transitions).toEqual([]);
    expect(l.getPositionMultiplierCap()).toBe(1);
    expect(codes(l.evaluate({ consecutiveLosses: 5, dailyR: -1.5, now: T0 }).transitions)).toEqual(['2:size_down_consec']);
  });

  test('non-finite inputs are treated as 0 (never arm a rung by accident)', () => {
    const l = ladder();
    expect(l.evaluate({ consecutiveLosses: Number.NaN, dailyR: Number.NaN, now: T0 }).transitions).toEqual([]);
    expect(l.capPositionMultiplier(Number.NaN)).toBe(1);
    expect(l.capPositionMultiplier(0)).toBe(1);
  });
});

describe('L3 strategy freeze (per-strategy streak, session-scoped)', () => {
  test('4 consecutive losses in one strategy freeze that strategy only', () => {
    const l = ladder();
    for (let i = 0; i < 3; i++) expect(l.recordClosedTrade(loss('trend_follow'))).toEqual([]);
    const out = l.recordClosedTrade(loss('trend_follow', { symbol: 'BTC-USD' }));
    expect(codes(out)).toEqual(['3:strategy_freeze']);
    expect(out[0]).toMatchObject({
      strategy: 'trend_follow',
      context: { ladderLevel: 3, strategy: 'trend_follow', symbol: 'BTC-USD', consecutiveLosses: 4, threshold: 4 },
    });
    expect(l.isStrategyFrozen('trend_follow')).toBe(true);
    expect(l.isStrategyFrozen('momentum')).toBe(false);
    expect(l.checkEntry({ strategy: 'trend_follow', now: T0 })).toMatchObject({ allowed: false, level: 3, reasonCode: 'strategy_freeze' });
    expect(l.checkEntry({ strategy: 'momentum', now: T0 })).toMatchObject({ allowed: true, positionMultiplierCap: 1 });
  });

  test('streaks are per strategy: interleaved losses across strategies do not freeze either', () => {
    const l = ladder();
    for (let i = 0; i < 3; i++) {
      expect(l.recordClosedTrade(loss('trend_follow'))).toEqual([]);
      expect(l.recordClosedTrade(loss('momentum'))).toEqual([]);
    }
    expect(l.getStatus(T0).perStrategyConsecutiveLosses).toEqual({ trend_follow: 3, momentum: 3 });
    expect(l.getStatus(T0).frozenStrategies).toEqual([]);
  });

  test('a win (or breakeven) resets that strategy streak', () => {
    const l = ladder();
    for (let i = 0; i < 3; i++) l.recordClosedTrade(loss('trend_follow'));
    l.recordClosedTrade(win('trend_follow'));
    expect(l.getStatus(T0).perStrategyConsecutiveLosses.trend_follow).toBe(0);
    for (let i = 0; i < 3; i++) expect(l.recordClosedTrade(loss('trend_follow'))).toEqual([]);
    l.recordClosedTrade({ strategy: 'trend_follow', symbol: 'ETH-USD', realizedPnl: 0, now: T0 });
    expect(l.isStrategyFrozen('trend_follow')).toBe(false);
  });

  test('freeze fires once and survives a risk-day rollover, but not a session CLEAR', () => {
    const l = ladder();
    for (let i = 0; i < 4; i++) l.recordClosedTrade(loss('trend_follow'));
    expect(l.recordClosedTrade(loss('trend_follow'))).toEqual([]);
    l.resetForNewRiskDay();
    expect(l.isStrategyFrozen('trend_follow')).toBe(true);
    expect(l.getStatus(T0).perStrategyConsecutiveLosses).toEqual({});
    l.reset();
    expect(l.isStrategyFrozen('trend_follow')).toBe(false);
  });

  test('trades without a strategy only feed the portfolio rungs', () => {
    const l = ladder();
    for (let i = 0; i < 6; i++) expect(l.recordClosedTrade({ symbol: 'ETH-USD', realizedPnl: -5, now: T0 })).toEqual([]);
    expect(l.getStatus(T0).frozenStrategies).toEqual([]);
  });

  test('L3 can be switched off independently', () => {
    const l = ladder({ l3_strategy_freeze: { enabled: false, consecutive_losses: 4 } });
    for (let i = 0; i < 6; i++) expect(l.recordClosedTrade(loss('trend_follow'))).toEqual([]);
    expect(l.isStrategyFrozen('trend_follow')).toBe(false);
  });
});

describe('L4 regime pause (strategy x entry regime stop-outs)', () => {
  const tfStopOut = (regime: string, exitReason = 'stop_loss', now = T0) =>
    loss('trend_follow', { regime, exitReason, now });

  test('two losing stop-outs of trend_follow in weak_trend pause that pair for pause_hours', () => {
    const l = ladder();
    expect(l.recordClosedTrade(tfStopOut('weak_trend'))).toEqual([]);
    const out = l.recordClosedTrade(tfStopOut('weak_trend', 'stop_loss', T0 + 1000));
    expect(codes(out)).toEqual(['4:regime_pause']);
    expect(out[0]).toMatchObject({
      strategy: 'trend_follow',
      regime: 'weak_trend',
      until: T0 + 1000 + 4 * HOUR,
      context: { ladderLevel: 4, stopOuts: 2, threshold: 2, pauseHours: 4, exitReason: 'stop_loss' },
    });

    expect(l.isRegimePaused('trend_follow', 'weak_trend', T0 + 2000)).toBe(true);
    expect(l.isRegimePaused('trend_follow', 'choppy', T0 + 2000)).toBe(false);
    expect(l.isRegimePaused('trend_follow', 'strong_trend', T0 + 2000)).toBe(false);
    expect(l.isRegimePaused('momentum', 'weak_trend', T0 + 2000)).toBe(false);

    const blocked = l.checkEntry({ strategy: 'trend_follow', regime: 'weak_trend', now: T0 + 2000 });
    expect(blocked).toMatchObject({ allowed: false, level: 4, reasonCode: 'regime_pause', regime: 'weak_trend', until: T0 + 1000 + 4 * HOUR });
    expect(l.checkEntry({ strategy: 'trend_follow', regime: 'strong_trend', now: T0 + 2000 })).toMatchObject({ allowed: true });
    // No stamped regime on the signal -> the pause cannot apply.
    expect(l.checkEntry({ strategy: 'trend_follow', now: T0 + 2000 })).toMatchObject({ allowed: true });
  });

  test('the pause expires on its own and expired pauses are handed back for audit clearing', () => {
    const l = ladder();
    l.recordClosedTrade(tfStopOut('choppy'));
    l.recordClosedTrade(tfStopOut('choppy', 'trailing_stop'));
    const until = T0 + 4 * HOUR;
    expect(l.isRegimePaused('trend_follow', 'choppy', until - 1)).toBe(true);
    expect(l.isRegimePaused('trend_follow', 'choppy', until)).toBe(false);
    expect(l.getStatus(until).regimePauses).toEqual([]);
    expect(l.takeExpiredRegimePauses(until - 1)).toEqual([]);
    expect(l.takeExpiredRegimePauses(until)).toMatchObject([{ strategy: 'trend_follow', regime: 'choppy', until }]);
    expect(l.takeExpiredRegimePauses(until)).toEqual([]);
    expect(l.checkEntry({ strategy: 'trend_follow', regime: 'choppy', now: until })).toMatchObject({ allowed: true });
  });

  test('stop-outs are counted per (strategy, regime) and the counter resets when the pause fires', () => {
    const l = ladder();
    expect(l.recordClosedTrade(tfStopOut('weak_trend'))).toEqual([]);
    expect(l.recordClosedTrade(tfStopOut('choppy'))).toEqual([]);
    expect(codes(l.recordClosedTrade(tfStopOut('weak_trend')))).toEqual(['4:regime_pause']);
    // A third weak_trend stop-out while paused neither re-fires nor extends
    // (this 4th straight trend_follow loss does trip L3 — a different rung).
    expect(codes(l.recordClosedTrade(tfStopOut('weak_trend')))).toEqual(['3:strategy_freeze']);
    expect(l.getStatus(T0).regimePauses).toHaveLength(1);
  });

  test('only watched strategies, watched regimes, losing stop-out exits count', () => {
    const l = ladder();
    // Wrong strategy.
    l.recordClosedTrade(loss('momentum', { regime: 'weak_trend', exitReason: 'stop_loss' }));
    l.recordClosedTrade(loss('momentum', { regime: 'weak_trend', exitReason: 'stop_loss' }));
    // Unwatched regime.
    l.recordClosedTrade(tfStopOut('strong_trend'));
    l.recordClosedTrade(tfStopOut('strong_trend'));
    // Losing but not a stop-out exit (signal exit / time stop).
    l.recordClosedTrade(tfStopOut('weak_trend', 'signal_exit'));
    l.recordClosedTrade(tfStopOut('weak_trend', 'time_stop'));
    // Stop tag but profitable (trailing stop locked in gains).
    l.recordClosedTrade({ strategy: 'trend_follow', symbol: 'ETH-USD', realizedPnl: 8, regime: 'weak_trend', exitReason: 'trailing_stop', now: T0 });
    // No regime stamped at entry.
    l.recordClosedTrade(loss('trend_follow', { exitReason: 'stop_loss' }));
    expect(l.getStatus(T0).regimePauses).toEqual([]);
    expect(STOP_OUT_EXIT_REASONS).toEqual(['stop_loss', 'trailing_stop']);
  });

  test('L4 can be switched off independently', () => {
    const l = ladder({ l4_regime_pause: { enabled: false } });
    l.recordClosedTrade(tfStopOut('weak_trend'));
    expect(l.recordClosedTrade(tfStopOut('weak_trend'))).toEqual([]);
    expect(l.isRegimePaused('trend_follow', 'weak_trend', T0)).toBe(false);
  });
});

describe('L5 sleeve halt (prep stub)', () => {
  test('disabled by default: a reported breach is ignored', () => {
    const l = ladder();
    expect(l.recordSleeveBreach('cfm', 'sleeve drawdown', T0)).toBeNull();
    expect(l.getStatus(T0).sleeveHalts).toEqual([]);
  });

  test('when enabled it records a single sleeve_halt per sleeve and reports it in status', () => {
    const l = ladder({ l5_sleeve_halt: { enabled: true } });
    const out = l.recordSleeveBreach('cfm', 'sleeve drawdown', T0);
    expect(out).toMatchObject({ level: 5, reasonCode: 'sleeve_halt', context: { ladderLevel: 5, sleeve: 'cfm' } });
    expect(l.recordSleeveBreach('cfm', 'again', T0)).toBeNull();
    expect(l.getStatus(T0)).toMatchObject({ highestActiveLevel: 5, sleeveHalts: [{ sleeve: 'cfm', since: T0 }] });
    l.reset();
    expect(l.getStatus(T0).sleeveHalts).toEqual([]);
  });
});

describe('L6 hard kill (portfolio streak, structured codes)', () => {
  test('dailyR <= -4 -> daily_stop with ladderLevel 6', () => {
    const out = ladder().evaluate({ consecutiveLosses: 0, dailyR: -4, now: T0 });
    expect(out.hardKill).toMatchObject({
      level: 6,
      reasonCode: 'daily_stop',
      context: { ladderLevel: 6, dailyPnlR: -4, thresholdR: -4, consecutiveLosses: 0 },
    });
    // The size rungs escalate on the same evaluation (L2 by dailyR).
    expect(codes(out.transitions)).toEqual(['2:size_down_daily_r']);
  });

  test('consec >= 12 alone is NOT a hard kill; it needs dailyR <= -2 as well', () => {
    const l = ladder();
    expect(l.evaluate({ consecutiveLosses: 12, dailyR: -1.9, now: T0 }).hardKill).toBeNull();
    expect(l.evaluate({ consecutiveLosses: 30, dailyR: 0.5, now: T0 }).hardKill).toBeNull();
    const out = l.evaluate({ consecutiveLosses: 12, dailyR: -2, now: T0 });
    expect(out.hardKill).toMatchObject({
      level: 6,
      reasonCode: 'consecutive_losses',
      context: { ladderLevel: 6, consecutiveLosses: 12, consecutiveLossesThreshold: 12, dailyPnlR: -2, thresholdR: -2 },
    });
  });

  test('dailyR <= -2 with consec 11 is only L2, not a kill', () => {
    const out = ladder().evaluate({ consecutiveLosses: 11, dailyR: -3.9, now: T0 });
    expect(out.hardKill).toBeNull();
    expect(codes(out.transitions)).toEqual(['2:size_down_consec']);
  });

  test('the hard kill code is always a structured halt code, never unknown or a soft code', () => {
    const l = ladder();
    for (const input of [
      { consecutiveLosses: 0, dailyR: -4.01 },
      { consecutiveLosses: 12, dailyR: -2.01 },
      { consecutiveLosses: 50, dailyR: -10 },
    ]) {
      const kill = l.evaluate({ ...input, now: T0 }).hardKill;
      expect(kill).not.toBeNull();
      expect(['daily_stop', 'consecutive_losses']).toContain(kill!.reasonCode);
      expect(isLadderSoftReasonCode(kill!.reasonCode)).toBe(false);
    }
  });

  test('L6 off: no hard kill from the ladder and the RiskEngine keeps its legacy stops', () => {
    const l = ladder({ l6_hard_kill: { enabled: false } });
    expect(l.isHardKillEnabled()).toBe(false);
    expect(l.evaluate({ consecutiveLosses: 20, dailyR: -9, now: T0 }).hardKill).toBeNull();
    expect(ladder().isHardKillEnabled()).toBe(true);
    expect(ladder().getHardKillDailyR()).toBe(-4);
  });
});

describe('resets and status', () => {
  test('reset() (clean session start after CLEAR / operator resume) releases every rung', () => {
    const l = ladder();
    l.evaluate({ consecutiveLosses: 5, dailyR: -2.5, now: T0 });
    for (let i = 0; i < 4; i++) l.recordClosedTrade(loss('trend_follow'));
    l.recordClosedTrade(loss('trend_follow', { regime: 'weak_trend', exitReason: 'stop_loss' }));
    l.recordClosedTrade(loss('trend_follow', { regime: 'weak_trend', exitReason: 'stop_loss' }));
    expect(l.getStatus(T0)).toMatchObject({ sizeLevel: 2, highestActiveLevel: 4 });

    l.reset();

    expect(l.getStatus(T0)).toMatchObject({
      enabled: true,
      highestActiveLevel: 0,
      sizeLevel: 0,
      positionMultiplierCap: 1,
      sizeReasonCode: null,
      sizeSince: null,
      perStrategyConsecutiveLosses: {},
      frozenStrategies: [],
      regimePauses: [],
    });
    // Rungs re-arm from scratch afterwards.
    expect(codes(l.evaluate({ consecutiveLosses: 3, dailyR: 0, now: T0 }).transitions)).toEqual(['1:size_down_consec']);
  });

  test('resetForNewRiskDay() lifts the size cap and streaks but keeps freezes and timed pauses', () => {
    const l = ladder();
    l.evaluate({ consecutiveLosses: 5, dailyR: -2.5, now: T0 });
    for (let i = 0; i < 4; i++) l.recordClosedTrade(loss('trend_follow'));
    l.recordClosedTrade(loss('trend_follow', { regime: 'choppy', exitReason: 'stop_loss' }));
    l.recordClosedTrade(loss('trend_follow', { regime: 'choppy', exitReason: 'stop_loss' }));

    l.resetForNewRiskDay();

    const status = l.getStatus(T0 + 1);
    expect(status.sizeLevel).toBe(0);
    expect(status.positionMultiplierCap).toBe(1);
    expect(status.perStrategyConsecutiveLosses).toEqual({});
    expect(status.frozenStrategies).toMatchObject([{ strategy: 'trend_follow' }]);
    expect(status.regimePauses).toMatchObject([{ strategy: 'trend_follow', regime: 'choppy' }]);
    expect(status.highestActiveLevel).toBe(4);
  });

  test('status exposes the desk thresholds for the API', () => {
    expect(ladder().getStatus(T0).thresholds).toEqual({
      l1: { consecutiveLosses: 3, dailyR: -1, positionMultiplier: 0.5, enabled: true },
      l2: { consecutiveLosses: 5, dailyR: -2, positionMultiplier: 0.25, enabled: true },
      l3: { consecutiveLosses: 4, enabled: true },
      l4: { strategies: ['trend_follow'], regimes: ['weak_trend', 'choppy'], stopOuts: 2, pauseHours: 4, enabled: true },
      l5: { enabled: false },
      l6: { dailyR: -4, consecutiveLosses: 12, consecutiveLossesDailyR: -2, enabled: true },
    });
  });
});
