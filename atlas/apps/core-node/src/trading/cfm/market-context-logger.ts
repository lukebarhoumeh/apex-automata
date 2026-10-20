/**
 * MarketContextLogger — writes one `market_context_bars` row per closed bar
 * for CFM paper symbols. Captures basis (futures − spot), funding rate, and
 * price context so post-trade analysis can correlate fills with market state.
 *
 * Phase 1 (2026-10-19): paper-only, CFM venue. The logger is constructed by
 * the API layer when CFM symbols are configured and a paper session is active.
 * It observes the candle pipeline and emits a row when a bar closes.
 *
 * The actual DB write is stubbed behind an interface so tests and paper mode
 * can run without a live Supabase connection.
 */

import { Logger } from '../../core/logger';

export interface MarketContextBarRow {
  symbol: string;
  venue: string;
  timeframe: number;
  bar_ts: string;
  funding_rate: string | null;
  spot_price: string | null;
  futures_price: string | null;
  basis_bps: string | null;
  session_id: string | null;
  execution_mode: string;
}

export interface MarketContextWriter {
  write(row: MarketContextBarRow): Promise<void>;
}

export interface MarketContextLoggerConfig {
  symbols: string[];
  venue: string;
  sessionId: string | null;
  executionMode: string;
  writer: MarketContextWriter;
  logger: Logger;
}

export class MarketContextLogger {
  private readonly config: MarketContextLoggerConfig;
  private readonly logger: Logger;

  constructor(config: MarketContextLoggerConfig) {
    this.config = config;
    this.logger = config.logger;
  }

  /**
   * Log a closed bar's market context. Called by the candle pipeline when a
   * bar closes for a CFM symbol.
   */
  async logClosedBar(params: {
    symbol: string;
    timeframe: number;
    barTimestamp: number;
    spotPrice: number | null;
    futuresPrice: number | null;
    fundingRate: number | null;
  }): Promise<void> {
    const { symbol, timeframe, barTimestamp, spotPrice, futuresPrice, fundingRate } = params;

    let basisBps: string | null = null;
    if (spotPrice && futuresPrice && spotPrice > 0) {
      const basis = ((futuresPrice - spotPrice) / spotPrice) * 10_000;
      basisBps = basis.toFixed(4);
    }

    const row: MarketContextBarRow = {
      symbol,
      venue: this.config.venue,
      timeframe,
      bar_ts: new Date(barTimestamp).toISOString(),
      funding_rate: fundingRate !== null ? fundingRate.toFixed(8) : null,
      spot_price: spotPrice !== null ? spotPrice.toFixed(8) : null,
      futures_price: futuresPrice !== null ? futuresPrice.toFixed(8) : null,
      basis_bps: basisBps,
      session_id: this.config.sessionId,
      execution_mode: this.config.executionMode,
    };

    try {
      await this.config.writer.write(row);
      this.logger.debug('market_context_bars row written', {
        symbol,
        timeframe,
        bar_ts: row.bar_ts,
        basis_bps: basisBps,
      });
    } catch (error) {
      this.logger.error('market_context_bars write failed', {
        symbol,
        timeframe,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  getSymbols(): string[] {
    return [...this.config.symbols];
  }
}
