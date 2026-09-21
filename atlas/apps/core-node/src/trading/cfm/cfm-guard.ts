/**
 * CfmGuard — venue risk guard for Coinbase Financial Markets / CDE nano
 * futures paper symbols (card SH-QMAKER-CFM-PAPER-v0, blocker 5).
 *
 * Two Charter / venue constraints, one component:
 *
 *   1. Inventory ≤ 2× (Charter leverage cap, `guardrails.cfm.max_leverage`).
 *      - pre-trade: an entry whose resulting `*-CDE` gross notional would push
 *        `gross / equity` above the cap is refused (`CFM_LEVERAGE_CAP`);
 *      - post-trade: `tick()` re-measures; a breach (marks moved, equity fell)
 *        emits `cfm:leverage_breach` — the wiring latches the kill switch with
 *        reason `leverage_breach` — and `cfm:flatten_required` so inventory is
 *        brought back inside the cap ("inv breach without flatten → VOID").
 *   2. Fri 17:00–18:00 ET break (`trading/cfm/cde-hours.ts`).
 *      - `entry_blocked` / `flatten` / `break` phases refuse new `*-CDE` entries
 *        (`CDE_HOURS_GAP`); reduce-only exits are always allowed;
 *      - the first tick inside `flatten` (or `break`, if we got there with
 *        inventory) emits `cfm:flatten_required` once per weekly episode.
 *
 * The guard OBSERVES (positions, equity) and DECIDES; it never places orders.
 * `TradingEngine.flattenSymbols` / `RiskEngine.activateKillSwitch` are wired
 * to its events by the API layer, and `RiskEngine.registerPreTradeGate`
 * consults `preTradeGate()` for governed symbols. Everything is venue-scoped
 * to the configured `*-CDE` symbols — spot / INTX are untouched.
 */

import { EventEmitter } from 'events';
import { Logger } from '../../core/logger';
import { isCfmSymbol } from '../../core/symbol-utils';
import { cdeBreakStatus, CdeBreakLeads, CdeBreakPhase, CdeBreakStatus } from './cde-hours';
import type { PreTradeGate, PreTradeGateContext, PreTradeGateDecision } from '../risk/pre-trade-gate';

/** Reject codes this guard produces. */
export const CFM_LEVERAGE_CAP = 'CFM_LEVERAGE_CAP';
export const CDE_HOURS_GAP = 'CDE_HOURS_GAP';

/** Why a flatten is being demanded. */
export type CfmFlattenReason = 'cde_hours_gap' | 'leverage_breach';

export interface CfmGuardPositionView {
  symbol: string;
  side: 'long' | 'short' | 'flat';
  size: number;
  marketPrice: number;
}

/** Read-only sources the guard measures against (engine-provided). */
export interface CfmGuardSources {
  getOpenPositions(): CfmGuardPositionView[];
  /** Session equity in USD (paper: `account.equity_usd` + P&L). */
  getEquityUsd(): number;
}

export interface CfmGuardConfig {
  /** `*-CDE` symbols this guard governs (`Object.keys(guardrails.cfm_symbols)`). */
  symbols: string[];
  /** Charter cap (`guardrails.cfm.max_leverage`, ≤ 2). */
  maxLeverage: number;
  hoursGap: CdeBreakLeads;
  logger: Logger;
  now?: () => number;
}

export interface CfmLeverageSnapshot {
  grossNotionalUsd: number;
  equityUsd: number;
  /** `grossNotionalUsd / equityUsd`; `Infinity` when equity ≤ 0 with inventory. */
  leverage: number;
  maxLeverage: number;
  breached: boolean;
}

export interface CfmFlattenRequiredEvent {
  reason: CfmFlattenReason;
  symbols: string[];
  phase: CdeBreakPhase;
  leverage: CfmLeverageSnapshot;
  at: number;
}

export interface CfmTickResult {
  phase: CdeBreakPhase;
  breakStatus: CdeBreakStatus;
  leverage: CfmLeverageSnapshot;
  /** Governed symbols with open inventory at tick time. */
  openSymbols: string[];
  flattenRequired: CfmFlattenRequiredEvent | null;
  leverageBreachEmitted: boolean;
}

export class CfmGuard extends EventEmitter {
  private readonly symbols: Set<string>;
  private readonly maxLeverage: number;
  private readonly hoursGap: CdeBreakLeads;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly sources: CfmGuardSources;

  private timer: NodeJS.Timeout | null = null;
  /** Weekly break episode for which the hours-gap flatten has already been demanded. */
  private flattenedEpisode: string | null = null;
  /** True while a leverage breach is latched (cleared once back inside the cap). */
  private leverageBreachLatched = false;

  constructor(config: CfmGuardConfig, sources: CfmGuardSources) {
    super();
    const bad = config.symbols.filter((s) => !isCfmSymbol(s));
    if (bad.length > 0) {
      throw new Error(`CfmGuard governs *-CDE symbols only; got ${bad.join(', ')}`);
    }
    if (!Number.isFinite(config.maxLeverage) || config.maxLeverage <= 0) {
      throw new Error(`CfmGuard: maxLeverage must be > 0, got ${config.maxLeverage}`);
    }
    this.symbols = new Set(config.symbols);
    this.maxLeverage = config.maxLeverage;
    this.hoursGap = config.hoursGap;
    this.logger = config.logger;
    this.now = config.now ?? (() => Date.now());
    this.sources = sources;
  }

  /** Symbols under this guard. */
  public getSymbols(): string[] {
    return [...this.symbols];
  }

  /** True when `symbol` is one of the governed `*-CDE` products. */
  public isGoverned(symbol: string): boolean {
    return this.symbols.has(symbol);
  }

  /** Current break phase / timings at `now`. */
  public breakStatus(at: number = this.now()): CdeBreakStatus {
    return cdeBreakStatus(new Date(at), this.hoursGap);
  }

  /** Gross `*-CDE` notional, equity and leverage right now. */
  public leverageSnapshot(): CfmLeverageSnapshot {
    const grossNotionalUsd = this.grossNotionalUsd();
    const equityUsd = this.sources.getEquityUsd();
    return this.snapshotFor(grossNotionalUsd, equityUsd);
  }

  /**
   * Pre-trade decision for an order on a governed symbol. Reduce-only exits
   * are always allowed (the break and the cap both want inventory DOWN).
   *
   * @param input.symbol Product.
   * @param input.isReduceOnly True when the order only reduces existing inventory.
   * @param input.newAbsNotional Absolute position notional (USD) AFTER the order.
   * @param input.currentAbsNotional Absolute position notional (USD) BEFORE the order.
   */
  public evaluateEntry(input: {
    symbol: string;
    isReduceOnly: boolean;
    newAbsNotional: number;
    currentAbsNotional: number;
  }): PreTradeGateDecision {
    if (!this.isGoverned(input.symbol)) return { allowed: true };
    if (input.isReduceOnly) return { allowed: true };

    const status = this.breakStatus();
    if (status.phase !== 'open') {
      const minutes = Math.ceil(status.msToBreakStart / 60_000);
      return {
        allowed: false,
        code: CDE_HOURS_GAP,
        reason:
          status.phase === 'break'
            ? `CDE weekly break (Fri 17:00–18:00 ET) — venue closed, no *-CDE orders (ET ${fmtEt(status)})`
            : `CDE weekly break in ${minutes} min — new *-CDE entries blocked during '${status.phase}' (ET ${fmtEt(status)})`,
      };
    }

    const gross = this.grossNotionalUsd();
    const equity = this.sources.getEquityUsd();
    const projectedGross = Math.max(0, gross - input.currentAbsNotional + input.newAbsNotional);
    const projected = this.snapshotFor(projectedGross, equity);
    if (projected.breached) {
      return {
        allowed: false,
        code: CFM_LEVERAGE_CAP,
        reason:
          `Charter leverage cap: *-CDE gross notional $${projectedGross.toFixed(2)} after this order = ` +
          `${formatLeverage(projected.leverage)}× of equity $${equity.toFixed(2)} (cap ${this.maxLeverage}×)`,
      };
    }
    return { allowed: true };
  }

  /** `RiskEngine.registerPreTradeGate`-shaped view of `evaluateEntry` (null = not my symbol). */
  public preTradeGate(): PreTradeGate {
    return (ctx: PreTradeGateContext) => {
      if (!this.isGoverned(ctx.symbol)) return null;
      return this.evaluateEntry({
        symbol: ctx.symbol,
        isReduceOnly: ctx.isReduceOnly,
        newAbsNotional: ctx.newAbsNotional,
        currentAbsNotional: ctx.currentAbsNotional,
      });
    };
  }

  /**
   * Periodic evaluation. Emits at most one `cfm:flatten_required` per weekly
   * break episode and one `cfm:leverage_breach` per breach episode; both are
   * idempotent to call as often as you like (tick every ≤ 60 s).
   */
  public tick(): CfmTickResult {
    const at = this.now();
    const breakStatus = this.breakStatus(at);
    const leverage = this.leverageSnapshot();
    const openSymbols = this.openGovernedSymbols();

    let flattenRequired: CfmFlattenRequiredEvent | null = null;
    let leverageBreachEmitted = false;

    // Leverage: latch on first breach, release once back inside the cap.
    if (leverage.breached) {
      if (!this.leverageBreachLatched) {
        this.leverageBreachLatched = true;
        leverageBreachEmitted = true;
        this.logger.error('CFM Charter leverage cap BREACHED — kill + flatten *-CDE inventory', {
          ...leverage,
          symbols: openSymbols,
        });
        this.emit('cfm:leverage_breach', leverage);
        if (openSymbols.length > 0) {
          flattenRequired = { reason: 'leverage_breach', symbols: openSymbols, phase: breakStatus.phase, leverage, at };
        }
      }
    } else if (this.leverageBreachLatched) {
      this.leverageBreachLatched = false;
      this.logger.warn('CFM leverage back inside the Charter cap (kill switch stays latched until operator resume)', leverage);
    }

    // Hours gap: once per episode, when we reach `flatten` (or `break`) with inventory.
    if ((breakStatus.phase === 'flatten' || breakStatus.phase === 'break') && breakStatus.episodeKey) {
      if (this.flattenedEpisode !== breakStatus.episodeKey) {
        this.flattenedEpisode = breakStatus.episodeKey;
        this.logger.warn('CDE weekly break approaching — flattening *-CDE inventory and cancelling resting *-CDE orders', {
          phase: breakStatus.phase,
          et: breakStatus.et,
          msToBreakStart: breakStatus.msToBreakStart,
          symbols: openSymbols,
        });
        flattenRequired = flattenRequired ?? {
          reason: 'cde_hours_gap',
          symbols: openSymbols.length > 0 ? openSymbols : this.getSymbols(),
          phase: breakStatus.phase,
          leverage,
          at,
        };
      }
    } else if (breakStatus.phase === 'open' && this.flattenedEpisode !== null) {
      this.flattenedEpisode = null;
    }

    if (flattenRequired) {
      this.emit('cfm:flatten_required', flattenRequired);
    }

    return { phase: breakStatus.phase, breakStatus, leverage, openSymbols, flattenRequired, leverageBreachEmitted };
  }

  /** Start ticking every `intervalMs` (default 15 s). Idempotent. */
  public start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.tick();
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        this.logger.error('CfmGuard tick failed', { error: error instanceof Error ? error.message : String(error) });
      }
    }, intervalMs);
    this.logger.info('CfmGuard started', {
      symbols: this.getSymbols(),
      maxLeverage: this.maxLeverage,
      hoursGap: this.hoursGap,
      intervalMs,
    });
  }

  /** Stop ticking. */
  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Status view for `/api/status`. */
  public getStatus(): {
    symbols: string[];
    maxLeverage: number;
    breakPhase: CdeBreakPhase;
    msToBreakStart: number;
    leverage: CfmLeverageSnapshot;
    leverageBreachLatched: boolean;
    flattenedEpisode: string | null;
  } {
    const status = this.breakStatus();
    return {
      symbols: this.getSymbols(),
      maxLeverage: this.maxLeverage,
      breakPhase: status.phase,
      msToBreakStart: status.msToBreakStart,
      leverage: this.leverageSnapshot(),
      leverageBreachLatched: this.leverageBreachLatched,
      flattenedEpisode: this.flattenedEpisode,
    };
  }

  // ------------------------------------------------------------- internals

  private grossNotionalUsd(): number {
    let gross = 0;
    for (const position of this.sources.getOpenPositions()) {
      if (!this.isGoverned(position.symbol) || position.side === 'flat') continue;
      const notional = Math.abs(position.size * position.marketPrice);
      if (Number.isFinite(notional)) gross += notional;
    }
    return gross;
  }

  private openGovernedSymbols(): string[] {
    const out = new Set<string>();
    for (const position of this.sources.getOpenPositions()) {
      if (this.isGoverned(position.symbol) && position.side !== 'flat' && Math.abs(position.size) > 0) {
        out.add(position.symbol);
      }
    }
    return [...out];
  }

  private snapshotFor(grossNotionalUsd: number, equityUsd: number): CfmLeverageSnapshot {
    const leverage = grossNotionalUsd === 0 ? 0 : equityUsd > 0 ? grossNotionalUsd / equityUsd : Number.POSITIVE_INFINITY;
    return {
      grossNotionalUsd,
      equityUsd,
      leverage,
      maxLeverage: this.maxLeverage,
      breached: leverage > this.maxLeverage,
    };
  }
}

function fmtEt(status: CdeBreakStatus): string {
  const { et } = status;
  return `${et.date} ${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')}`;
}

function formatLeverage(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '∞';
}
