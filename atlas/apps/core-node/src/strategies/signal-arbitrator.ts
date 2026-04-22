import type { Logger } from '../core/logger';
import type { Position } from '../trading/position-tracker';
import type { Signal } from './signal-processor';

export type ArbitratorRejectionReason =
  | 'intra_window_dedup'
  | 'cross_venue_opposing_position';

export interface ArbitratorDecision {
  allow: boolean;
  reason?: ArbitratorRejectionReason;
  context?: Record<string, unknown>;
}

export interface SignalArbitratorOptions {
  /** Drop a duplicate (same strategy+symbol+side) within this many ms. Default 60_000. */
  dedupWindowMs?: number;
  /**
   * Allow opposing-direction signal ONLY IF
   *   signal.strength > reversalStrengthThreshold
   *   AND signal.metadata.reversalIntent === true
   * Default 0.9. Strategies must opt in by setting `reversalIntent: true` in
   * the signal's metadata to declare a defensible reversal thesis (typically
   * after a regime-change observation). Without the flag, opposing signals
   * are blocked regardless of strength.
   */
  reversalStrengthThreshold?: number;
}

interface DecisionRecord {
  timestamp: number;
  signalId: string;
}

/**
 * Coherence layer between signal generation and order routing.
 *
 * Two checks before letting a fresh ENTRY signal place an order:
 *  1. Intra-window dedup — if (strategy, symbol, side) fired within the
 *     dedup window, drop the later one. Real edge re-fires fast; this
 *     catches the noise, not the edge.
 *  2. Cross-venue netting — group positions by BASE asset (ETH-USD and
 *     ETH-PERP-INTX share base "ETH"). Reject any signal that would create
 *     opposing exposure on the same base, UNLESS the signal is an explicit
 *     reversal: BOTH `signal.strength > reversalStrengthThreshold` AND
 *     `signal.metadata.reversalIntent === true`. The strength threshold is
 *     necessary but not sufficient — strategies must opt in by setting the
 *     reversalIntent flag (typically tied to a regime-change observation).
 *     Without the flag, all opposing entries get blocked regardless of how
 *     confident the signal claims to be.
 *
 * Exit signals (closing existing positions) MUST be routed around this
 * arbitrator by the caller — this layer only protects ENTRY routing.
 */
export class SignalArbitrator {
  private readonly dedupWindowMs: number;
  private readonly reversalStrengthThreshold: number;
  private readonly recentDecisions: Map<string, DecisionRecord> = new Map();

  constructor(
    private readonly logger: Logger,
    options: SignalArbitratorOptions = {},
  ) {
    this.dedupWindowMs = options.dedupWindowMs ?? 60_000;
    this.reversalStrengthThreshold = options.reversalStrengthThreshold ?? 0.9;
  }

  arbitrate(signal: Signal, openPositions: Position[]): ArbitratorDecision {
    const now = Date.now();
    const dedupKey = this.dedupKey(signal);

    const recent = this.recentDecisions.get(dedupKey);
    if (recent && now - recent.timestamp < this.dedupWindowMs) {
      const decision: ArbitratorDecision = {
        allow: false,
        reason: 'intra_window_dedup',
        context: {
          previousSignalId: recent.signalId,
          ageMs: now - recent.timestamp,
          windowMs: this.dedupWindowMs,
        },
      };
      this.logRejection(signal, decision);
      return decision;
    }

    const baseAsset = extractBaseAsset(signal.symbol);
    const desiredSide: 'long' | 'short' = signal.direction === 'buy' ? 'long' : 'short';

    const opposing = openPositions.filter(
      (p) =>
        p.size > 0 &&
        (p.side === 'long' || p.side === 'short') &&
        p.side !== desiredSide &&
        extractBaseAsset(p.symbol) === baseAsset,
    );

    if (opposing.length > 0) {
      const reversalIntent = signal.metadata?.reversalIntent === true;
      const strengthOk = signal.strength > this.reversalStrengthThreshold;
      const isReversal = reversalIntent && strengthOk;
      if (!isReversal) {
        const decision: ArbitratorDecision = {
          allow: false,
          reason: 'cross_venue_opposing_position',
          context: {
            baseAsset,
            requiredStrength: this.reversalStrengthThreshold,
            actualStrength: signal.strength,
            reversalIntentSet: reversalIntent,
            opposing: opposing.map((p) => ({
              symbol: p.symbol,
              side: p.side,
              size: p.size,
            })),
          },
        };
        this.logRejection(signal, decision);
        return decision;
      }
      // Reversal allowed — note loudly so it shows up in audit
      this.logger.warn('SignalArbitrator: allowing explicit reversal', {
        signalId: signal.id,
        symbol: signal.symbol,
        strategy: signal.strategy,
        direction: signal.direction,
        strength: signal.strength,
        threshold: this.reversalStrengthThreshold,
        reversalIntent,
        baseAsset,
        opposing: opposing.map((p) => ({ symbol: p.symbol, side: p.side, size: p.size })),
      });
    }

    this.recentDecisions.set(dedupKey, { timestamp: now, signalId: signal.id });
    return { allow: true };
  }

  /** Drop dedup records older than maxAgeMs. Call periodically to bound memory. */
  cleanup(maxAgeMs: number = 5 * 60 * 1000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, record] of this.recentDecisions) {
      if (record.timestamp < cutoff) {
        this.recentDecisions.delete(key);
      }
    }
  }

  /** Reset all dedup state. For tests and engine-restart scenarios. */
  reset(): void {
    this.recentDecisions.clear();
  }

  /** Visible for tests + ops: count of currently-tracked dedup entries. */
  size(): number {
    return this.recentDecisions.size;
  }

  private dedupKey(signal: Signal): string {
    return `${signal.strategy}|${signal.symbol}|${signal.direction}`;
  }

  private logRejection(signal: Signal, decision: ArbitratorDecision): void {
    this.logger.warn(`SignalArbitrator rejected signal: ${decision.reason}`, {
      signalId: signal.id,
      symbol: signal.symbol,
      strategy: signal.strategy,
      direction: signal.direction,
      strength: signal.strength,
      ...decision.context,
    });
  }
}

/**
 * Extract base asset from a symbol. Works for all current Coinbase formats:
 *   BTC-USD          → BTC
 *   ETH-PERP-INTX    → ETH
 *   SOL-USDT         → SOL
 */
export function extractBaseAsset(symbol: string): string {
  return symbol.split('-')[0];
}
