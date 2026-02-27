/**
 * MetaFilter - Rule-Based Trade Quality Filter
 * 
 * HFT-grade meta-labeling lite that filters signals based on:
 * - Cold streak detection (consecutive losses per strategy)
 * - Signal strength percentile (only high-conviction trades)
 * - Cross-strategy confirmation (volume, MTF alignment)
 * - Time-of-day filtering (avoid low liquidity periods)
 * - Historical performance tracking per strategy
 * 
 * All filter decisions are logged for future ML training data.
 */

import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { Signal } from './signal-processor';
import { Counter, Gauge, Histogram } from 'prom-client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Prometheus metrics
const metaFilterReceivedCounter = new Counter({
  name: 'atlas_metafilter_signals_received_total',
  help: 'Total signals received by meta filter',
  labelNames: ['symbol', 'strategy'],
});

const metaFilterPassedCounter = new Counter({
  name: 'atlas_metafilter_signals_passed_total',
  help: 'Total signals that passed meta filter',
  labelNames: ['symbol', 'strategy'],
});

const metaFilterBlockedCounter = new Counter({
  name: 'atlas_metafilter_signals_blocked_total',
  help: 'Total signals blocked by meta filter',
  labelNames: ['symbol', 'strategy', 'rule'],
});

const metaFilterScoreHistogram = new Histogram({
  name: 'atlas_metafilter_score',
  help: 'Meta filter quality score distribution',
  labelNames: ['symbol', 'strategy'],
  buckets: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0],
});

const strategyWinRateGauge = new Gauge({
  name: 'atlas_strategy_win_rate',
  help: 'Rolling win rate per strategy',
  labelNames: ['strategy'],
});

const strategyConsecutiveLossesGauge = new Gauge({
  name: 'atlas_strategy_consecutive_losses',
  help: 'Current consecutive losses per strategy',
  labelNames: ['strategy'],
});

const coldStreakActiveGauge = new Gauge({
  name: 'atlas_cold_streak_active',
  help: 'Whether cold streak filter is blocking strategy (0/1)',
  labelNames: ['strategy'],
});

// Trade outcome for learning
export interface TradeOutcome {
  signalId: string;
  strategy: string;
  symbol: string;
  direction: 'buy' | 'sell';
  signalStrength: number;
  entryTime: Date;
  exitTime?: Date;
  pnl?: number;
  outcome?: 'win' | 'loss' | 'breakeven';
  
  // Context at time of signal
  volumeRatio?: number;
  atr?: number;
  regime?: string;
  hourOfDay: number;
  dayOfWeek: number;
  
  // Filter decisions made
  metaScore?: number;
  filtersPassed: string[];
  filtersBlocked: string[];
}

// Historical strategy performance
export interface StrategyPerformance {
  strategy: string;
  totalTrades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number;
  avgWinPnl: number;
  avgLossPnl: number;
  profitFactor: number;
  consecutiveLosses: number;
  consecutiveWins: number;
  maxConsecutiveLosses: number;
  recentStrengths: number[];     // Strengths of recent winning trades
  avgWinningStrength: number;
  strengthPercentile25: number;  // 25th percentile of winning strengths
  strengthPercentile50: number;  // 50th percentile
  lastTradeTime: Date | null;
  hourlyPerformance: Map<number, { wins: number; losses: number }>;
}

// Filter decision log entry (for ML training)
export interface FilterDecisionLog {
  id: string;
  timestamp: Date;
  signalId: string;
  symbol: string;
  strategy: string;
  direction: 'buy' | 'sell';
  signalStrength: number;
  
  // Context
  volumeRatio?: number;
  regime?: string;
  hourOfDay: number;
  dayOfWeek: number;
  
  // Filter results
  passed: boolean;
  metaScore: number;
  rulesEvaluated: {
    rule: string;
    passed: boolean;
    reason: string;
    weight: number;
  }[];
  
  // For later labeling
  outcome?: 'win' | 'loss' | 'breakeven';
  pnl?: number;
}

export interface MetaFilterConfig {
  enabled: boolean;
  
  // Cold streak rules
  coldStreakEnabled: boolean;
  coldStreakThreshold: number;       // Consecutive losses to trigger (default: 3)
  coldStreakCooldownMs: number;      // Time to wait before re-enabling (default: 30 min)
  coldStreakRecoveryWins: number;    // Wins needed to reset (default: 1)
  
  // Signal strength rules
  strengthFilterEnabled: boolean;
  minStrengthPercentile: number;     // Only take signals above this percentile (default: 0.25)
  minAbsoluteStrength: number;       // Minimum absolute strength (default: 0.3)
  
  // Volume confirmation rules
  volumeConfirmEnabled: boolean;
  minVolumeRatio: number;            // Min ratio vs 20-period avg (default: 1.2)
  volumeRatioBonus: number;          // Bonus score for high volume (default: 0.1)
  
  // Time-of-day rules
  timeFilterEnabled: boolean;
  lowLiquidityHours: number[];       // UTC hours to avoid (e.g., [4, 5, 6] = 4-7 AM UTC)
  preferredHours: number[];          // UTC hours with bonus (e.g., [14, 15, 16] = US open)
  lowLiquidityPenalty: number;       // Score penalty for bad hours (default: 0.3)
  preferredHoursBonus: number;       // Score bonus for good hours (default: 0.1)
  
  // Cross-strategy confirmation
  crossConfirmEnabled: boolean;
  requireMTFConfirm: boolean;        // Require MTF alignment for trend trades
  
  // Quality score threshold
  minQualityScore: number;           // Min score to pass (default: 0.5)
  
  // Logging
  logDecisions: boolean;             // Log all decisions to DB
  logToSupabase: boolean;            // Persist to Supabase
}

const DEFAULT_CONFIG: MetaFilterConfig = {
  enabled: true,
  
  coldStreakEnabled: true,
  coldStreakThreshold: 10,  // AGGRESSIVE: Higher threshold
  coldStreakCooldownMs: 5 * 60 * 1000, // AGGRESSIVE: Only 5 min cooldown
  coldStreakRecoveryWins: 1,

  strengthFilterEnabled: false,  // AGGRESSIVE: Disabled
  minStrengthPercentile: 0.0,
  minAbsoluteStrength: 0.0,

  volumeConfirmEnabled: false,  // AGGRESSIVE: Disabled
  minVolumeRatio: 0.1,
  volumeRatioBonus: 0.1,
  
  timeFilterEnabled: true,
  lowLiquidityHours: [4, 5, 6, 7],     // 4-8 AM UTC (low Asian/pre-London)
  preferredHours: [13, 14, 15, 16, 17], // 1-6 PM UTC (US market hours)
  lowLiquidityPenalty: 0.3,
  preferredHoursBonus: 0.1,
  
  crossConfirmEnabled: true,
  requireMTFConfirm: false,
  
  minQualityScore: 0.5,
  
  logDecisions: true,
  logToSupabase: false,
};

export interface MetaFilterResult {
  allowed: boolean;
  qualityScore: number;
  reason: string;
  rulesEvaluated: {
    rule: string;
    passed: boolean;
    reason: string;
    weight: number;
    contribution: number;
  }[];
  adjustedStrength: number;
  coldStreakActive: boolean;
  strategyPerformance: StrategyPerformance | null;
}

export class MetaFilter extends EventEmitter {
  private config: MetaFilterConfig;
  private logger: Logger;
  private supabase: SupabaseClient | null = null;
  
  // Strategy performance tracking
  private strategyPerformance: Map<string, StrategyPerformance> = new Map();
  
  // Cold streak tracking
  private coldStreakStart: Map<string, number> = new Map();  // strategy -> timestamp
  
  // Recent trades for analysis
  private recentOutcomes: TradeOutcome[] = [];
  private maxRecentOutcomes = 500;
  
  // Decision log buffer (for batch persistence)
  private decisionLogBuffer: FilterDecisionLog[] = [];
  private logFlushIntervalMs = 10000;
  private logFlushTimer: NodeJS.Timeout | null = null;

  constructor(
    config: Partial<MetaFilterConfig>,
    logger: Logger,
    supabaseUrl?: string,
    supabaseKey?: string
  ) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger;

    if (supabaseUrl && supabaseKey && this.config.logToSupabase) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
    }

    // Start log flush timer
    if (this.config.logDecisions) {
      this.logFlushTimer = setInterval(() => this.flushDecisionLogs(), this.logFlushIntervalMs);
    }
  }

  /**
   * Initialize strategy performance from historical data
   */
  public async loadHistoricalPerformance(trades: TradeOutcome[]): Promise<void> {
    this.logger.info('Loading historical performance for meta filter', { tradeCount: trades.length });

    for (const trade of trades) {
      this.recordTradeOutcome(trade, false); // Don't persist, just load
    }

    // Log loaded stats
    for (const [strategy, perf] of this.strategyPerformance) {
      this.logger.info('Loaded strategy performance', {
        strategy,
        totalTrades: perf.totalTrades,
        winRate: perf.winRate.toFixed(2),
        avgWinningStrength: perf.avgWinningStrength.toFixed(2),
      });
    }
  }

  /**
   * Filter a signal based on meta-labeling rules
   */
  public filter(
    signal: Signal,
    context: {
      volumeRatio?: number;
      atr?: number;
      regime?: string;
      mtfAlignment?: number;
    } = {}
  ): MetaFilterResult {
    metaFilterReceivedCounter.inc({ symbol: signal.symbol, strategy: signal.strategy });

    // Check if filtering is disabled
    if (!this.config.enabled) {
      return {
        allowed: true,
        qualityScore: 1.0,
        reason: 'Meta filtering disabled',
        rulesEvaluated: [],
        adjustedStrength: signal.strength,
        coldStreakActive: false,
        strategyPerformance: null,
      };
    }

    const now = new Date();
    const hourOfDay = now.getUTCHours();
    const dayOfWeek = now.getUTCDay();

    // Get strategy performance
    const perf = this.getOrCreatePerformance(signal.strategy);

    // Evaluate all rules
    const rulesEvaluated: MetaFilterResult['rulesEvaluated'] = [];
    let totalWeight = 0;
    let totalScore = 0;

    // Rule 1: Cold Streak Detection
    if (this.config.coldStreakEnabled) {
      const coldStreakResult = this.evaluateColdStreak(signal.strategy, perf);
      rulesEvaluated.push(coldStreakResult);
      totalWeight += coldStreakResult.weight;
      totalScore += coldStreakResult.contribution;

      if (!coldStreakResult.passed) {
        // Hard block for cold streak
        metaFilterBlockedCounter.inc({ symbol: signal.symbol, strategy: signal.strategy, rule: 'cold_streak' });
        this.logDecision(signal, context, false, 0, rulesEvaluated, hourOfDay, dayOfWeek);

        return {
          allowed: false,
          qualityScore: 0,
          reason: coldStreakResult.reason,
          rulesEvaluated,
          adjustedStrength: signal.strength,
          coldStreakActive: true,
          strategyPerformance: perf,
        };
      }
    }

    // Rule 2: Signal Strength Percentile
    if (this.config.strengthFilterEnabled) {
      const strengthResult = this.evaluateStrength(signal.strength, perf);
      rulesEvaluated.push(strengthResult);
      totalWeight += strengthResult.weight;
      totalScore += strengthResult.contribution;
    }

    // Rule 3: Volume Confirmation
    if (this.config.volumeConfirmEnabled && context.volumeRatio !== undefined) {
      const volumeResult = this.evaluateVolume(context.volumeRatio, signal.strategy);
      rulesEvaluated.push(volumeResult);
      totalWeight += volumeResult.weight;
      totalScore += volumeResult.contribution;
    }

    // Rule 4: Time of Day
    if (this.config.timeFilterEnabled) {
      const timeResult = this.evaluateTimeOfDay(hourOfDay);
      rulesEvaluated.push(timeResult);
      totalWeight += timeResult.weight;
      totalScore += timeResult.contribution;
    }

    // Rule 5: Cross-Strategy Confirmation (MTF)
    if (this.config.crossConfirmEnabled && context.mtfAlignment !== undefined) {
      const mtfResult = this.evaluateMTFAlignment(context.mtfAlignment, signal.strategy);
      rulesEvaluated.push(mtfResult);
      totalWeight += mtfResult.weight;
      totalScore += mtfResult.contribution;
    }

    // Rule 6: Historical Win Rate for Strategy
    const winRateResult = this.evaluateStrategyWinRate(perf);
    rulesEvaluated.push(winRateResult);
    totalWeight += winRateResult.weight;
    totalScore += winRateResult.contribution;

    // Rule 7: Hourly Performance Check
    const hourlyResult = this.evaluateHourlyPerformance(hourOfDay, perf);
    rulesEvaluated.push(hourlyResult);
    totalWeight += hourlyResult.weight;
    totalScore += hourlyResult.contribution;

    // Calculate final quality score
    const qualityScore = totalWeight > 0 ? totalScore / totalWeight : 0.5;

    // Record metric
    metaFilterScoreHistogram.observe({ symbol: signal.symbol, strategy: signal.strategy }, qualityScore);

    // Check if passes threshold
    const passed = qualityScore >= this.config.minQualityScore;

    if (passed) {
      metaFilterPassedCounter.inc({ symbol: signal.symbol, strategy: signal.strategy });
      this.emit('signal:passed', signal, qualityScore, rulesEvaluated);
    } else {
      const failedRules = rulesEvaluated.filter(r => !r.passed).map(r => r.rule).join(',');
      metaFilterBlockedCounter.inc({ 
        symbol: signal.symbol, 
        strategy: signal.strategy, 
        rule: failedRules || 'low_score' 
      });
      this.emit('signal:blocked', signal, qualityScore, rulesEvaluated);
    }

    // Log decision
    this.logDecision(signal, context, passed, qualityScore, rulesEvaluated, hourOfDay, dayOfWeek);

    const reason = passed
      ? `Quality score ${(qualityScore * 100).toFixed(0)}% passed threshold`
      : `Quality score ${(qualityScore * 100).toFixed(0)}% below ${(this.config.minQualityScore * 100).toFixed(0)}% threshold`;

    return {
      allowed: passed,
      qualityScore,
      reason,
      rulesEvaluated,
      adjustedStrength: signal.strength * qualityScore,
      coldStreakActive: this.isColdStreakActive(signal.strategy),
      strategyPerformance: perf,
    };
  }

  // ============ Rule Evaluators ============

  private evaluateColdStreak(
    strategy: string,
    perf: StrategyPerformance
  ): MetaFilterResult['rulesEvaluated'][0] {
    const isColdStreak = perf.consecutiveLosses >= this.config.coldStreakThreshold;
    const cooldownStart = this.coldStreakStart.get(strategy);
    const inCooldown = cooldownStart && (Date.now() - cooldownStart) < this.config.coldStreakCooldownMs;

    // Update cold streak tracking
    if (isColdStreak && !cooldownStart) {
      this.coldStreakStart.set(strategy, Date.now());
      coldStreakActiveGauge.set({ strategy }, 1);
      this.logger.warn('Cold streak detected', { 
        strategy, 
        consecutiveLosses: perf.consecutiveLosses,
        threshold: this.config.coldStreakThreshold,
      });
    }

    const blocked = isColdStreak || inCooldown;
    const weight = 1.0; // Hard filter - full weight

    return {
      rule: 'cold_streak',
      passed: !blocked,
      reason: blocked
        ? `Cold streak: ${perf.consecutiveLosses} consecutive losses (threshold: ${this.config.coldStreakThreshold})`
        : `No cold streak (${perf.consecutiveLosses} consecutive losses)`,
      weight,
      contribution: blocked ? 0 : weight,
    };
  }

  private evaluateStrength(
    signalStrength: number,
    perf: StrategyPerformance
  ): MetaFilterResult['rulesEvaluated'][0] {
    const weight = 0.3;

    // Check absolute minimum
    if (signalStrength < this.config.minAbsoluteStrength) {
      return {
        rule: 'strength_absolute',
        passed: false,
        reason: `Strength ${signalStrength.toFixed(2)} below minimum ${this.config.minAbsoluteStrength}`,
        weight,
        contribution: 0,
      };
    }

    // Check percentile (if we have historical data)
    if (perf.recentStrengths.length >= 10) {
      const threshold = perf.strengthPercentile25;
      if (signalStrength < threshold) {
        return {
          rule: 'strength_percentile',
          passed: false,
          reason: `Strength ${signalStrength.toFixed(2)} below 25th percentile ${threshold.toFixed(2)}`,
          weight,
          contribution: weight * 0.3, // Partial score
        };
      }

      // Score based on where strength falls in distribution
      const score = signalStrength >= perf.strengthPercentile50 ? 1.0 : 
                    signalStrength >= perf.strengthPercentile25 ? 0.7 : 0.3;
      
      return {
        rule: 'strength_percentile',
        passed: true,
        reason: `Strength ${signalStrength.toFixed(2)} at ${(score * 100).toFixed(0)}th percentile`,
        weight,
        contribution: weight * score,
      };
    }

    // No historical data - use absolute strength
    const score = Math.min(1, signalStrength / 0.8); // Full score at 0.8 strength
    return {
      rule: 'strength_absolute',
      passed: true,
      reason: `Strength ${signalStrength.toFixed(2)} (no historical data)`,
      weight,
      contribution: weight * score,
    };
  }

  private evaluateVolume(
    volumeRatio: number,
    strategy: string
  ): MetaFilterResult['rulesEvaluated'][0] {
    const weight = 0.2;

    // Breakout strategies need volume confirmation
    const needsVolume = strategy === 'breakout' || strategy === 'momentum';
    
    if (needsVolume && volumeRatio < this.config.minVolumeRatio) {
      return {
        rule: 'volume_confirm',
        passed: false,
        reason: `Volume ratio ${volumeRatio.toFixed(2)}x below ${this.config.minVolumeRatio}x for ${strategy}`,
        weight,
        contribution: weight * 0.3, // Partial penalty
      };
    }

    // Calculate score based on volume
    const volumeScore = Math.min(1, volumeRatio / 2); // Full score at 2x volume
    const bonus = volumeRatio >= 1.5 ? this.config.volumeRatioBonus : 0;

    return {
      rule: 'volume_confirm',
      passed: true,
      reason: `Volume ratio ${volumeRatio.toFixed(2)}x${volumeRatio >= 1.5 ? ' (bonus)' : ''}`,
      weight,
      contribution: weight * (volumeScore + bonus),
    };
  }

  private evaluateTimeOfDay(hourOfDay: number): MetaFilterResult['rulesEvaluated'][0] {
    const weight = 0.15;

    // Check low liquidity hours
    if (this.config.lowLiquidityHours.includes(hourOfDay)) {
      return {
        rule: 'time_of_day',
        passed: true, // Soft filter - just penalty
        reason: `Low liquidity hour (${hourOfDay}:00 UTC)`,
        weight,
        contribution: weight * (1 - this.config.lowLiquidityPenalty),
      };
    }

    // Check preferred hours
    if (this.config.preferredHours.includes(hourOfDay)) {
      return {
        rule: 'time_of_day',
        passed: true,
        reason: `Preferred trading hour (${hourOfDay}:00 UTC)`,
        weight,
        contribution: weight * (1 + this.config.preferredHoursBonus),
      };
    }

    // Neutral hours
    return {
      rule: 'time_of_day',
      passed: true,
      reason: `Neutral hour (${hourOfDay}:00 UTC)`,
      weight,
      contribution: weight,
    };
  }

  private evaluateMTFAlignment(
    mtfAlignment: number,
    strategy: string
  ): MetaFilterResult['rulesEvaluated'][0] {
    const weight = 0.2;
    const isTrendStrategy = strategy === 'breakout' || strategy === 'momentum' || strategy === 'trend';

    if (isTrendStrategy && this.config.requireMTFConfirm) {
      const aligned = Math.abs(mtfAlignment) >= 0.3;
      if (!aligned) {
        return {
          rule: 'mtf_alignment',
          passed: false,
          reason: `MTF alignment ${(mtfAlignment * 100).toFixed(0)}% insufficient for trend strategy`,
          weight,
          contribution: weight * 0.3,
        };
      }
    }

    // Score based on alignment strength
    const alignmentScore = 0.5 + Math.abs(mtfAlignment) * 0.5;

    return {
      rule: 'mtf_alignment',
      passed: true,
      reason: `MTF alignment ${(mtfAlignment * 100).toFixed(0)}%`,
      weight,
      contribution: weight * alignmentScore,
    };
  }

  private evaluateStrategyWinRate(perf: StrategyPerformance): MetaFilterResult['rulesEvaluated'][0] {
    const weight = 0.15;

    if (perf.totalTrades < 10) {
      // Not enough data
      return {
        rule: 'strategy_winrate',
        passed: true,
        reason: `Insufficient history (${perf.totalTrades} trades)`,
        weight,
        contribution: weight * 0.5, // Neutral
      };
    }

    // Update metric
    strategyWinRateGauge.set({ strategy: perf.strategy }, perf.winRate);

    // Score based on win rate
    const winRateScore = perf.winRate >= 0.5 ? 1.0 :
                         perf.winRate >= 0.4 ? 0.7 :
                         perf.winRate >= 0.3 ? 0.4 : 0.2;

    return {
      rule: 'strategy_winrate',
      passed: perf.winRate >= 0.3,
      reason: `Win rate ${(perf.winRate * 100).toFixed(0)}%`,
      weight,
      contribution: weight * winRateScore,
    };
  }

  private evaluateHourlyPerformance(
    hourOfDay: number,
    perf: StrategyPerformance
  ): MetaFilterResult['rulesEvaluated'][0] {
    const weight = 0.1;
    const hourlyStats = perf.hourlyPerformance.get(hourOfDay);

    if (!hourlyStats || (hourlyStats.wins + hourlyStats.losses) < 5) {
      // Not enough data for this hour
      return {
        rule: 'hourly_performance',
        passed: true,
        reason: `Insufficient hourly data for hour ${hourOfDay}`,
        weight,
        contribution: weight * 0.5, // Neutral
      };
    }

    const hourlyWinRate = hourlyStats.wins / (hourlyStats.wins + hourlyStats.losses);

    // Block if this hour has terrible performance
    if (hourlyWinRate < 0.25) {
      return {
        rule: 'hourly_performance',
        passed: false,
        reason: `Poor hourly performance: ${(hourlyWinRate * 100).toFixed(0)}% win rate at hour ${hourOfDay}`,
        weight,
        contribution: 0,
      };
    }

    const score = hourlyWinRate >= 0.5 ? 1.0 :
                  hourlyWinRate >= 0.4 ? 0.7 : 0.4;

    return {
      rule: 'hourly_performance',
      passed: true,
      reason: `Hour ${hourOfDay} win rate: ${(hourlyWinRate * 100).toFixed(0)}%`,
      weight,
      contribution: weight * score,
    };
  }

  // ============ Trade Outcome Recording ============

  /**
   * Record a trade outcome to update strategy performance
   */
  public recordTradeOutcome(outcome: TradeOutcome, persist = true): void {
    const perf = this.getOrCreatePerformance(outcome.strategy);

    // Update counts
    perf.totalTrades++;
    if (outcome.outcome === 'win') {
      perf.wins++;
      perf.consecutiveWins++;
      perf.consecutiveLosses = 0;

      // Record winning strength
      perf.recentStrengths.push(outcome.signalStrength);
      if (perf.recentStrengths.length > 100) {
        perf.recentStrengths.shift();
      }

      // Clear cold streak
      if (this.coldStreakStart.has(outcome.strategy)) {
        this.coldStreakStart.delete(outcome.strategy);
        coldStreakActiveGauge.set({ strategy: outcome.strategy }, 0);
        this.logger.info('Cold streak cleared', { strategy: outcome.strategy });
      }
    } else if (outcome.outcome === 'loss') {
      perf.losses++;
      perf.consecutiveLosses++;
      perf.consecutiveWins = 0;
      perf.maxConsecutiveLosses = Math.max(perf.maxConsecutiveLosses, perf.consecutiveLosses);
    } else {
      perf.breakeven++;
    }

    // Update consecutive losses metric
    strategyConsecutiveLossesGauge.set({ strategy: outcome.strategy }, perf.consecutiveLosses);

    // Update P&L averages
    if (outcome.pnl !== undefined) {
      if (outcome.outcome === 'win') {
        perf.avgWinPnl = (perf.avgWinPnl * (perf.wins - 1) + outcome.pnl) / perf.wins;
      } else if (outcome.outcome === 'loss') {
        perf.avgLossPnl = (perf.avgLossPnl * (perf.losses - 1) + Math.abs(outcome.pnl)) / perf.losses;
      }
    }

    // Update win rate and profit factor
    perf.winRate = perf.totalTrades > 0 ? perf.wins / perf.totalTrades : 0;
    perf.profitFactor = perf.avgLossPnl > 0 ? perf.avgWinPnl / perf.avgLossPnl : 0;

    // Update strength percentiles
    this.updateStrengthPercentiles(perf);

    // Update hourly performance
    const hourlyStats = perf.hourlyPerformance.get(outcome.hourOfDay) || { wins: 0, losses: 0 };
    if (outcome.outcome === 'win') {
      hourlyStats.wins++;
    } else if (outcome.outcome === 'loss') {
      hourlyStats.losses++;
    }
    perf.hourlyPerformance.set(outcome.hourOfDay, hourlyStats);

    perf.lastTradeTime = outcome.exitTime || new Date();

    // Add to recent outcomes
    this.recentOutcomes.push(outcome);
    if (this.recentOutcomes.length > this.maxRecentOutcomes) {
      this.recentOutcomes.shift();
    }

    this.emit('outcome:recorded', outcome, perf);
  }

  private updateStrengthPercentiles(perf: StrategyPerformance): void {
    const strengths = [...perf.recentStrengths].sort((a, b) => a - b);
    if (strengths.length < 4) {
      perf.avgWinningStrength = strengths.reduce((a, b) => a + b, 0) / (strengths.length || 1);
      perf.strengthPercentile25 = 0;
      perf.strengthPercentile50 = 0;
      return;
    }

    perf.avgWinningStrength = strengths.reduce((a, b) => a + b, 0) / strengths.length;
    perf.strengthPercentile25 = strengths[Math.floor(strengths.length * 0.25)];
    perf.strengthPercentile50 = strengths[Math.floor(strengths.length * 0.50)];
  }

  // ============ Decision Logging ============

  private logDecision(
    signal: Signal,
    context: any,
    passed: boolean,
    qualityScore: number,
    rulesEvaluated: MetaFilterResult['rulesEvaluated'],
    hourOfDay: number,
    dayOfWeek: number
  ): void {
    if (!this.config.logDecisions) return;

    const logEntry: FilterDecisionLog = {
      id: `mf-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date(),
      signalId: signal.id,
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      signalStrength: signal.strength,
      volumeRatio: context.volumeRatio,
      regime: context.regime,
      hourOfDay,
      dayOfWeek,
      passed,
      metaScore: qualityScore,
      rulesEvaluated: rulesEvaluated.map(r => ({
        rule: r.rule,
        passed: r.passed,
        reason: r.reason,
        weight: r.weight,
      })),
    };

    this.decisionLogBuffer.push(logEntry);
    if (this.decisionLogBuffer.length > 500) {
      this.decisionLogBuffer = this.decisionLogBuffer.slice(-500);
    }
    this.emit('decision:logged', logEntry);
  }

  private async flushDecisionLogs(): Promise<void> {
    if (this.decisionLogBuffer.length === 0) return;

    const logsToFlush = [...this.decisionLogBuffer];
    this.decisionLogBuffer = [];

    if (this.supabase && this.config.logToSupabase) {
      try {
        const { error } = await this.supabase
          .from('meta_filter_decisions')
          .insert(logsToFlush.map(log => ({
            id: log.id,
            timestamp: log.timestamp.toISOString(),
            signal_id: log.signalId,
            symbol: log.symbol,
            strategy: log.strategy,
            direction: log.direction,
            signal_strength: log.signalStrength,
            volume_ratio: log.volumeRatio,
            regime: log.regime,
            hour_of_day: log.hourOfDay,
            day_of_week: log.dayOfWeek,
            passed: log.passed,
            meta_score: log.metaScore,
            rules_evaluated: log.rulesEvaluated,
          })));

        if (error) {
          this.logger.warn('Failed to persist decision logs:', error);
        }
      } catch (err) {
        this.logger.warn('Error flushing decision logs:', err);
      }
    }
  }

  // ============ Helpers ============

  private getOrCreatePerformance(strategy: string): StrategyPerformance {
    let perf = this.strategyPerformance.get(strategy);
    if (!perf) {
      perf = {
        strategy,
        totalTrades: 0,
        wins: 0,
        losses: 0,
        breakeven: 0,
        winRate: 0,
        avgWinPnl: 0,
        avgLossPnl: 0,
        profitFactor: 0,
        consecutiveLosses: 0,
        consecutiveWins: 0,
        maxConsecutiveLosses: 0,
        recentStrengths: [],
        avgWinningStrength: 0,
        strengthPercentile25: 0,
        strengthPercentile50: 0,
        lastTradeTime: null,
        hourlyPerformance: new Map(),
      };
      this.strategyPerformance.set(strategy, perf);
    }
    return perf;
  }

  private isColdStreakActive(strategy: string): boolean {
    const cooldownStart = this.coldStreakStart.get(strategy);
    if (!cooldownStart) return false;
    return (Date.now() - cooldownStart) < this.config.coldStreakCooldownMs;
  }

  // ============ Public API ============

  /**
   * Get performance stats for all strategies
   */
  public getPerformanceStats(): Map<string, StrategyPerformance> {
    return new Map(this.strategyPerformance);
  }

  /**
   * Get performance for a specific strategy
   */
  public getStrategyPerformance(strategy: string): StrategyPerformance | undefined {
    return this.strategyPerformance.get(strategy);
  }

  /**
   * Get recent decision logs
   */
  public getRecentDecisions(limit = 50): FilterDecisionLog[] {
    return this.decisionLogBuffer.slice(-limit);
  }

  /**
   * Get filter statistics
   */
  public getStats(): {
    enabled: boolean;
    config: MetaFilterConfig;
    strategies: Record<string, any>;
    coldStreaks: Record<string, boolean>;
    decisionLogSize: number;
  } {
    const strategies: Record<string, any> = {};
    for (const [strategy, perf] of this.strategyPerformance) {
      strategies[strategy] = {
        totalTrades: perf.totalTrades,
        winRate: perf.winRate,
        consecutiveLosses: perf.consecutiveLosses,
        avgWinningStrength: perf.avgWinningStrength,
        profitFactor: perf.profitFactor,
      };
    }

    const coldStreaks: Record<string, boolean> = {};
    for (const [strategy] of this.coldStreakStart) {
      coldStreaks[strategy] = this.isColdStreakActive(strategy);
    }

    return {
      enabled: this.config.enabled,
      config: this.config,
      strategies,
      coldStreaks,
      decisionLogSize: this.decisionLogBuffer.length,
    };
  }

  /**
   * Update configuration
   */
  public updateConfig(config: Partial<MetaFilterConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Meta filter config updated', { config: this.config });
  }

  /**
   * Enable/disable the filter
   */
  public setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    this.logger.info(`Meta filter ${enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Stop the filter and flush logs
   */
  public async stop(): Promise<void> {
    if (this.logFlushTimer) {
      clearInterval(this.logFlushTimer);
      this.logFlushTimer = null;
    }
    await this.flushDecisionLogs();
  }
}

