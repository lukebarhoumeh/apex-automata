/**
 * Graduated PAPER kill ladder L1–L6 (Risk desk SoT 2026-09-22).
 *
 * Pure, synchronous state machine: no I/O, no timers, no logger, no clock.
 * `RiskEngine` owns the wiring (closed-trade hook, 5s tick, `risk_events`
 * persistence, kill-switch latch) and passes `now` explicitly so every
 * transition is deterministic under test.
 *
 * Rungs (thresholds come from `guardrails.paper_kill_ladder`):
 *
 *   L1  portfolio consec >= 3 OR dailyR <= -1.0 -> position multiplier cap 0.5
 *   L2  portfolio consec >= 5 OR dailyR <= -2.0 -> cap 0.25
 *   L3  >= 4 consecutive losses in ONE strategy -> that strategy frozen for the session
 *   L4  watched strategy stopped out N times in a watched entry regime
 *       -> that (strategy, regime) paused for `pause_hours`
 *   L5  sleeve_halt -> prep only (sleeves are not wired); disabled stub
 *   L6  dailyR <= -4 OR (consec >= 12 AND dailyR <= -2) -> hard kill, reported with
 *       the existing structured halt codes (`daily_stop` / `consecutive_losses`)
 *
 * L1–L5 are "soft": they never latch the kill switch. Their reason codes are
 * distinct from `RiskHaltReasonCode` on purpose so a `risk_events` row written
 * by a rung can never be restored as a halt (see `RiskStateMachine.loadPersistedState`).
 *
 * Streak semantics mirror `RiskEngine.handleClosedPosition`: a closed trade with
 * realized P&L < 0 extends a streak, anything else (win or breakeven) resets it.
 * Size caps ratchet L1 -> L2 within a risk day and only come off via
 * `resetForNewRiskDay()` / `reset()`; strategy freezes are session-scoped
 * (`reset()` only); regime pauses expire on their own.
 */

import type { PaperKillLadderConfig } from '../../config/loadGuardrails';
import type { MarketRegime } from '../../strategies/regime-detector';
import type { RiskHaltReasonCode } from '../risk-state';

/** Reason codes of the soft rungs (L1–L5). Never a `RiskHaltReasonCode`. */
export type LadderSoftReasonCode =
  | 'size_down_consec'
  | 'size_down_daily_r'
  | 'strategy_freeze'
  | 'regime_pause'
  | 'sleeve_halt';

/** Every soft reason code, for `risk_events` filtering (restore + sweep). */
export const LADDER_SOFT_REASON_CODES: readonly LadderSoftReasonCode[] = [
  'size_down_consec',
  'size_down_daily_r',
  'strategy_freeze',
  'regime_pause',
  'sleeve_halt',
];

/** True when `value` is a soft ladder code (an audit row, not a halt). */
export function isLadderSoftReasonCode(value: unknown): value is LadderSoftReasonCode {
  return typeof value === 'string' && (LADDER_SOFT_REASON_CODES as readonly string[]).includes(value);
}

/** Structured codes the L6 hard kill latches the kill switch with. */
export type LadderHardKillReasonCode = Extract<RiskHaltReasonCode, 'daily_stop' | 'consecutive_losses'>;

export type LadderLevel = 1 | 2 | 3 | 4 | 5 | 6;
/** 0 = no size cap, 1 = L1 cap, 2 = L2 cap. */
export type LadderSizeLevel = 0 | 1 | 2;

/**
 * Exit tags that count as a stop-out for L4 when the trade lost money.
 * `PositionMonitor` stamps these via the exit order's `metadata.tag`.
 */
export const STOP_OUT_EXIT_REASONS: readonly string[] = ['stop_loss', 'trailing_stop'];

/** A rung escalation. One `risk_events` row is written per transition. */
export interface LadderTransition {
  level: LadderLevel;
  reasonCode: LadderSoftReasonCode;
  reasonText: string;
  /** Epoch ms of the transition. */
  at: number;
  /** L1/L2: the new position-multiplier cap. */
  positionMultiplier?: number;
  /** L3/L4: the strategy affected. */
  strategy?: string;
  /** L4: the entry regime affected. */
  regime?: MarketRegime;
  /** L4: pause expiry (epoch ms). */
  until?: number;
  /** Threshold / observed values for the audit row. */
  context: Record<string, number | string | boolean | undefined>;
}

/** The L6 decision. `RiskEngine.triggerKillSwitch` latches it. */
export interface LadderHardKill {
  level: 6;
  reasonCode: LadderHardKillReasonCode;
  reasonText: string;
  context: {
    ladderLevel: 6;
    dailyPnlR: number;
    thresholdR: number;
    consecutiveLosses: number;
    consecutiveLossesThreshold?: number;
  };
}

export interface LadderClosedTradeInput {
  /** Entry strategy (`Position.strategy`); trades without one only feed the portfolio rungs. */
  strategy?: string;
  symbol: string;
  realizedPnl: number;
  /** `Position.exitReason` (exit order tag). */
  exitReason?: string;
  /** Regime stamped at entry (`Position.metadata.regime`). */
  regime?: string;
  now: number;
}

export interface LadderEvaluationInput {
  /** PORTFOLIO losing streak (`RiskEngine.metrics.consecutiveLosses`). */
  consecutiveLosses: number;
  /** Day P&L in R (realized + unrealized), negative when losing. */
  dailyR: number;
  now: number;
}

export interface LadderEvaluation {
  transitions: LadderTransition[];
  /** Non-null while an L6 condition holds; the caller de-duplicates against its own latch. */
  hardKill: LadderHardKill | null;
}

export type LadderEntryDecision =
  | { allowed: true; positionMultiplierCap: number; sizeLevel: LadderSizeLevel }
  | {
      allowed: false;
      level: 3 | 4;
      reasonCode: 'strategy_freeze' | 'regime_pause';
      reason: string;
      strategy: string;
      regime?: MarketRegime;
      until?: number;
    };

export interface LadderFrozenStrategy {
  strategy: string;
  since: number;
  consecutiveLosses: number;
}

export interface LadderRegimePause {
  strategy: string;
  regime: MarketRegime;
  since: number;
  until: number;
  stopOuts: number;
}

export interface PaperKillLadderStatus {
  enabled: true;
  /** Highest rung currently in force (0 = none). L6 is reported by the kill switch itself. */
  highestActiveLevel: 0 | 1 | 2 | 3 | 4 | 5;
  sizeLevel: LadderSizeLevel;
  positionMultiplierCap: number;
  sizeReasonCode: 'size_down_consec' | 'size_down_daily_r' | null;
  sizeSince: number | null;
  perStrategyConsecutiveLosses: Record<string, number>;
  frozenStrategies: LadderFrozenStrategy[];
  regimePauses: LadderRegimePause[];
  sleeveHalts: Array<{ sleeve: string; since: number; reason: string }>;
  thresholds: {
    l1: { consecutiveLosses: number; dailyR: number; positionMultiplier: number; enabled: boolean };
    l2: { consecutiveLosses: number; dailyR: number; positionMultiplier: number; enabled: boolean };
    l3: { consecutiveLosses: number; enabled: boolean };
    l4: { strategies: string[]; regimes: MarketRegime[]; stopOuts: number; pauseHours: number; enabled: boolean };
    l5: { enabled: boolean };
    l6: { dailyR: number; consecutiveLosses: number; consecutiveLossesDailyR: number; enabled: boolean };
  };
}

const HOUR_MS = 60 * 60 * 1000;

function pairKey(strategy: string, regime: string): string {
  return `${strategy}|${regime}`;
}

function fmtR(r: number): string {
  return `${r.toFixed(2)}R`;
}

/**
 * Graduated paper kill ladder. Construct one per paper `RiskEngine`; live
 * sessions never build it.
 */
export class PaperKillLadder {
  private readonly config: PaperKillLadderConfig;

  private sizeLevel: LadderSizeLevel = 0;
  private sizeReasonCode: 'size_down_consec' | 'size_down_daily_r' | null = null;
  private sizeSince: number | null = null;

  private readonly perStrategyConsecutiveLosses = new Map<string, number>();
  private readonly frozenStrategies = new Map<string, LadderFrozenStrategy>();
  private readonly regimeStopOuts = new Map<string, number>();
  private readonly regimePauses = new Map<string, LadderRegimePause>();
  private readonly sleeveHalts = new Map<string, { sleeve: string; since: number; reason: string }>();

  constructor(config: PaperKillLadderConfig) {
    this.config = config;
  }

  // ============ Inputs ============

  /**
   * Feed one closed trade. Drives the per-strategy streak (L3) and the
   * (strategy, regime) stop-out counter (L4). The portfolio streak is owned by
   * the caller and arrives via {@link evaluate}.
   *
   * @returns L3/L4 transitions that fired on this close (usually empty).
   */
  public recordClosedTrade(input: LadderClosedTradeInput): LadderTransition[] {
    const transitions: LadderTransition[] = [];
    const strategy = typeof input.strategy === 'string' && input.strategy.length > 0 ? input.strategy : null;
    const lost = Number.isFinite(input.realizedPnl) && input.realizedPnl < 0;

    if (strategy) {
      const streak = lost ? (this.perStrategyConsecutiveLosses.get(strategy) ?? 0) + 1 : 0;
      this.perStrategyConsecutiveLosses.set(strategy, streak);

      const l3 = this.config.l3_strategy_freeze;
      if (l3.enabled && lost && streak >= l3.consecutive_losses && !this.frozenStrategies.has(strategy)) {
        this.frozenStrategies.set(strategy, { strategy, since: input.now, consecutiveLosses: streak });
        transitions.push({
          level: 3,
          reasonCode: 'strategy_freeze',
          reasonText: `Strategy ${strategy} frozen for the session: ${streak} consecutive losses (limit ${l3.consecutive_losses})`,
          at: input.now,
          strategy,
          context: {
            ladderLevel: 3,
            strategy,
            symbol: input.symbol,
            consecutiveLosses: streak,
            threshold: l3.consecutive_losses,
          },
        });
      }

      const l4Transition = this.recordStopOut(strategy, input, lost);
      if (l4Transition) transitions.push(l4Transition);
    }

    return transitions;
  }

  private recordStopOut(strategy: string, input: LadderClosedTradeInput, lost: boolean): LadderTransition | null {
    const l4 = this.config.l4_regime_pause;
    if (!l4.enabled || !lost) return null;
    if (!l4.strategies.includes(strategy)) return null;
    const regime = input.regime;
    if (typeof regime !== 'string' || !(l4.regimes as readonly string[]).includes(regime)) return null;
    if (typeof input.exitReason !== 'string' || !STOP_OUT_EXIT_REASONS.includes(input.exitReason)) return null;

    const key = pairKey(strategy, regime);
    const stopOuts = (this.regimeStopOuts.get(key) ?? 0) + 1;
    this.regimeStopOuts.set(key, stopOuts);

    if (stopOuts < l4.stop_outs) return null;
    if (this.isRegimePaused(strategy, regime, input.now)) return null;

    const until = input.now + l4.pause_hours * HOUR_MS;
    this.regimePauses.set(key, {
      strategy,
      regime: regime as MarketRegime,
      since: input.now,
      until,
      stopOuts,
    });
    this.regimeStopOuts.set(key, 0);

    return {
      level: 4,
      reasonCode: 'regime_pause',
      reasonText:
        `Strategy ${strategy} paused in ${regime} for ${l4.pause_hours}h: ` +
        `${stopOuts} stop-outs in regime (limit ${l4.stop_outs})`,
      at: input.now,
      strategy,
      regime: regime as MarketRegime,
      until,
      context: {
        ladderLevel: 4,
        strategy,
        regime,
        symbol: input.symbol,
        exitReason: input.exitReason,
        stopOuts,
        threshold: l4.stop_outs,
        pauseHours: l4.pause_hours,
        until,
      },
    };
  }

  /**
   * L5 prep: record a sleeve breach reported by a future sleeve monitor.
   * Sleeves are not wired today, so nothing in the runtime calls this; the
   * rung is inert while `l5_sleeve_halt.enabled` is false.
   *
   * @returns The `sleeve_halt` transition, or `null` when the rung is disabled
   *   or the sleeve is already halted.
   */
  public recordSleeveBreach(sleeve: string, reason: string, now: number): LadderTransition | null {
    if (!this.config.l5_sleeve_halt.enabled) return null;
    if (this.sleeveHalts.has(sleeve)) return null;
    this.sleeveHalts.set(sleeve, { sleeve, since: now, reason });
    return {
      level: 5,
      reasonCode: 'sleeve_halt',
      reasonText: `Sleeve ${sleeve} halted: ${reason}`,
      at: now,
      context: { ladderLevel: 5, sleeve, reason },
    };
  }

  /**
   * Evaluate the portfolio rungs (L1/L2 size caps, L6 hard kill) against the
   * current streak and day P&L. Called on every closed trade and on the
   * risk-metrics tick, since unrealized P&L can cross a daily-R rung between
   * closes. Size caps ratchet: only escalations produce a transition.
   */
  public evaluate(input: LadderEvaluationInput): LadderEvaluation {
    const transitions: LadderTransition[] = [];
    const consec = Number.isFinite(input.consecutiveLosses) ? input.consecutiveLosses : 0;
    const dailyR = Number.isFinite(input.dailyR) ? input.dailyR : 0;

    const { l1_size_down: l1, l2_size_down: l2 } = this.config;
    const armed = (rung: typeof l1) => rung.enabled && (consec >= rung.consecutive_losses || dailyR <= rung.daily_r);
    const target: LadderSizeLevel = armed(l2) ? 2 : armed(l1) ? 1 : 0;

    if (target > this.sizeLevel && target !== 0) {
      const rung = target === 2 ? l2 : l1;
      const byConsec = consec >= rung.consecutive_losses;
      const reasonCode = byConsec ? 'size_down_consec' : 'size_down_daily_r';
      this.sizeLevel = target;
      this.sizeReasonCode = reasonCode;
      this.sizeSince = input.now;
      transitions.push({
        level: target,
        reasonCode,
        reasonText: byConsec
          ? `L${target} size-down: ${consec} consecutive losses (limit ${rung.consecutive_losses}) -> position multiplier cap ${rung.position_multiplier}`
          : `L${target} size-down: day P&L ${fmtR(dailyR)} (limit ${fmtR(rung.daily_r)}) -> position multiplier cap ${rung.position_multiplier}`,
        at: input.now,
        positionMultiplier: rung.position_multiplier,
        context: {
          ladderLevel: target,
          consecutiveLosses: consec,
          consecutiveLossesThreshold: rung.consecutive_losses,
          dailyPnlR: dailyR,
          dailyRThreshold: rung.daily_r,
          positionMultiplier: rung.position_multiplier,
        },
      });
    }

    return { transitions, hardKill: this.evaluateHardKill(consec, dailyR) };
  }

  private evaluateHardKill(consec: number, dailyR: number): LadderHardKill | null {
    const l6 = this.config.l6_hard_kill;
    if (!l6.enabled) return null;

    if (dailyR <= l6.daily_r) {
      return {
        level: 6,
        reasonCode: 'daily_stop',
        reasonText: `L6 hard kill: day P&L ${fmtR(dailyR)} <= ${fmtR(l6.daily_r)}`,
        context: { ladderLevel: 6, dailyPnlR: dailyR, thresholdR: l6.daily_r, consecutiveLosses: consec },
      };
    }

    if (consec >= l6.consecutive_losses && dailyR <= l6.consecutive_losses_daily_r) {
      return {
        level: 6,
        reasonCode: 'consecutive_losses',
        reasonText:
          `L6 hard kill: ${consec} consecutive losses (limit ${l6.consecutive_losses}) ` +
          `with day P&L ${fmtR(dailyR)} <= ${fmtR(l6.consecutive_losses_daily_r)}`,
        context: {
          ladderLevel: 6,
          dailyPnlR: dailyR,
          thresholdR: l6.consecutive_losses_daily_r,
          consecutiveLosses: consec,
          consecutiveLossesThreshold: l6.consecutive_losses,
        },
      };
    }

    return null;
  }

  // ============ Queries ============

  /** True when L6 is enabled — the RiskEngine then lets the ladder own the paper daily/streak hard kill. */
  public isHardKillEnabled(): boolean {
    return this.config.l6_hard_kill.enabled;
  }

  /** The L6 daily-R threshold (for status payloads / halt context). */
  public getHardKillDailyR(): number {
    return this.config.l6_hard_kill.daily_r;
  }

  public getSizeLevel(): LadderSizeLevel {
    return this.sizeLevel;
  }

  /** Upper bound for the router's position multiplier (1 when no size rung is active). */
  public getPositionMultiplierCap(): number {
    if (this.sizeLevel === 2) return this.config.l2_size_down.position_multiplier;
    if (this.sizeLevel === 1) return this.config.l1_size_down.position_multiplier;
    return 1;
  }

  /** Apply the active cap: `min(multiplier, cap)`. Non-finite / non-positive input maps to the cap itself. */
  public capPositionMultiplier(multiplier: number): number {
    const cap = this.getPositionMultiplierCap();
    if (!Number.isFinite(multiplier) || multiplier <= 0) return cap;
    return Math.min(multiplier, cap);
  }

  public isStrategyFrozen(strategy: string): boolean {
    return this.frozenStrategies.has(strategy);
  }

  /** True while an L4 pause for (strategy, regime) is in force at `now`. Expired pauses read as not paused. */
  public isRegimePaused(strategy: string, regime: string | undefined, now: number): boolean {
    if (typeof regime !== 'string') return false;
    const pause = this.regimePauses.get(pairKey(strategy, regime));
    return Boolean(pause && pause.until > now);
  }

  /**
   * Remove and return every L4 pause whose expiry has passed. The RiskEngine
   * calls this on its tick so each released pause can retire its audit row.
   */
  public takeExpiredRegimePauses(now: number): LadderRegimePause[] {
    const expired: LadderRegimePause[] = [];
    for (const [key, pause] of this.regimePauses) {
      if (pause.until <= now) {
        expired.push(pause);
        this.regimePauses.delete(key);
      }
    }
    return expired;
  }

  /**
   * Router-side entry gate. Blocks a new entry when its strategy is frozen
   * (L3) or its (strategy, entry regime) is paused (L4); otherwise returns the
   * size cap the router must apply.
   */
  public checkEntry(input: { strategy: string; regime?: string; now: number }): LadderEntryDecision {
    const frozen = this.frozenStrategies.get(input.strategy);
    if (frozen) {
      return {
        allowed: false,
        level: 3,
        reasonCode: 'strategy_freeze',
        reason: `Strategy ${input.strategy} is frozen for the session (${frozen.consecutiveLosses} consecutive losses)`,
        strategy: input.strategy,
      };
    }
    if (this.isRegimePaused(input.strategy, input.regime, input.now)) {
      const pause = this.regimePauses.get(pairKey(input.strategy, input.regime as string))!;
      return {
        allowed: false,
        level: 4,
        reasonCode: 'regime_pause',
        reason: `Strategy ${input.strategy} is paused in ${pause.regime} until ${new Date(pause.until).toISOString()}`,
        strategy: input.strategy,
        regime: pause.regime,
        until: pause.until,
      };
    }
    return { allowed: true, positionMultiplierCap: this.getPositionMultiplierCap(), sizeLevel: this.sizeLevel };
  }

  public getStatus(now: number): PaperKillLadderStatus {
    const frozenStrategies = Array.from(this.frozenStrategies.values());
    const regimePauses = Array.from(this.regimePauses.values()).filter((pause) => pause.until > now);
    const sleeveHalts = Array.from(this.sleeveHalts.values());

    let highestActiveLevel: PaperKillLadderStatus['highestActiveLevel'] = this.sizeLevel;
    if (frozenStrategies.length > 0) highestActiveLevel = 3;
    if (regimePauses.length > 0) highestActiveLevel = 4;
    if (sleeveHalts.length > 0) highestActiveLevel = 5;

    const { l1_size_down: l1, l2_size_down: l2, l3_strategy_freeze: l3, l4_regime_pause: l4, l5_sleeve_halt: l5, l6_hard_kill: l6 } = this.config;
    return {
      enabled: true,
      highestActiveLevel,
      sizeLevel: this.sizeLevel,
      positionMultiplierCap: this.getPositionMultiplierCap(),
      sizeReasonCode: this.sizeReasonCode,
      sizeSince: this.sizeSince,
      perStrategyConsecutiveLosses: Object.fromEntries(this.perStrategyConsecutiveLosses),
      frozenStrategies,
      regimePauses,
      sleeveHalts,
      thresholds: {
        l1: { consecutiveLosses: l1.consecutive_losses, dailyR: l1.daily_r, positionMultiplier: l1.position_multiplier, enabled: l1.enabled },
        l2: { consecutiveLosses: l2.consecutive_losses, dailyR: l2.daily_r, positionMultiplier: l2.position_multiplier, enabled: l2.enabled },
        l3: { consecutiveLosses: l3.consecutive_losses, enabled: l3.enabled },
        l4: { strategies: [...l4.strategies], regimes: [...l4.regimes], stopOuts: l4.stop_outs, pauseHours: l4.pause_hours, enabled: l4.enabled },
        l5: { enabled: l5.enabled },
        l6: { dailyR: l6.daily_r, consecutiveLosses: l6.consecutive_losses, consecutiveLossesDailyR: l6.consecutive_losses_daily_r, enabled: l6.enabled },
      },
    };
  }

  // ============ Resets ============

  /**
   * Risk-day rollover: the daily-R rungs re-arm from zero, so the size cap and
   * the streak-derived counters come off. Session-scoped freezes and
   * time-scoped pauses are kept (a paper session spans days).
   */
  public resetForNewRiskDay(): void {
    this.sizeLevel = 0;
    this.sizeReasonCode = null;
    this.sizeSince = null;
    this.perStrategyConsecutiveLosses.clear();
    this.regimeStopOuts.clear();
  }

  /**
   * Clean session start after CLEAR (`PAPER_RESET_RISK_STATE_ON_START`) or an
   * operator RESUME TRADING: every rung is released.
   */
  public reset(): void {
    this.resetForNewRiskDay();
    this.frozenStrategies.clear();
    this.regimePauses.clear();
    this.sleeveHalts.clear();
  }
}
