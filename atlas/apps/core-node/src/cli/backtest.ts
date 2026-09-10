import path from 'node:path';
import dotenv from 'dotenv';
// .env lives at the repo root; pnpm sets cwd to atlas/apps/core-node.
dotenv.config({ path: path.resolve(process.cwd(), '../../../.env') });
import yargs from 'yargs/yargs';
import { hideBin } from 'yargs/helpers';
import { createLogger } from '../core/logger';
import { BacktestRunner, BacktestRunnerConfig, FeeTierLabel } from '../backtesting/backtest-runner';
import {
  BacktestConfig,
  BacktestResult,
  EvGateMode,
  PerSymbolStrategyOverrides,
} from '../backtesting/backtest-engine';
import { isDataUnavailableError } from '../backtesting/data-loader';
import { loadGuardrails } from '../config/loadGuardrails';
import { buildPerSymbolDisabledStrategies } from '../strategies/per-symbol-disable';
import { FeeModel } from '../core/fee-model';
import type { MarketVenue } from '../trading/execution/venue-capabilities';

/**
 * Coinbase Advanced Trade spot fee tiers (maker/taker bps), TASK_017 step 7.
 *   intro1 — Intro 1 (< $1K 30d volume): 60 / 120
 *   t1k    — $1K–$10K:                   35 / 75
 *   t10k   — $10K–$50K:                  25 / 40  (guardrails.yaml default)
 * `custom:<maker>,<taker>` sets arbitrary bps.
 */
const FEE_TIERS: Record<string, { makerBps: number; takerBps: number }> = {
  intro1: { makerBps: 60, takerBps: 120 },
  t1k: { makerBps: 35, takerBps: 75 },
  t10k: { makerBps: 25, takerBps: 40 },
};

function resolveFeeTier(flag: string | undefined, guardrailsSpot: { maker_bps: number; taker_bps: number }): FeeTierLabel {
  if (!flag) {
    // Back-compat default: whatever guardrails.yaml says (25/40 = t10k today).
    // Label it by matching the known table so the report names the tier.
    const match = Object.entries(FEE_TIERS).find(
      ([, t]) => t.makerBps === guardrailsSpot.maker_bps && t.takerBps === guardrailsSpot.taker_bps,
    );
    return {
      name: `${match ? match[0] : 'custom'} (guardrails.yaml default)`,
      makerBps: guardrailsSpot.maker_bps,
      takerBps: guardrailsSpot.taker_bps,
    };
  }
  if (flag.startsWith('custom:')) {
    const [maker, taker] = flag.slice('custom:'.length).split(',').map((v) => Number(v));
    if (!Number.isFinite(maker) || !Number.isFinite(taker) || maker < 0 || taker < 0) {
      throw new Error(`--fee-tier custom:<maker>,<taker> expects two non-negative bps numbers, got "${flag}"`);
    }
    return { name: flag, makerBps: maker, takerBps: taker };
  }
  const tier = FEE_TIERS[flag];
  if (!tier) {
    throw new Error(`Unknown --fee-tier "${flag}". Use intro1|t1k|t10k|custom:<maker>,<taker>`);
  }
  return { name: flag, ...tier };
}

/** Print the CI-parsed summary. Line 1 is always the data stamp. */
function printSummary(result: BacktestResult, feeTier: FeeTierLabel): void {
  const m = result.metrics;
  console.log('');
  console.log(result.dataStamp === 'SYNTHETIC'
    ? 'DATA: SYNTHETIC — SMOKE/VOID (random-walk candles; not evidence)'
    : 'DATA: REAL');
  console.log('Backtest Results:');
  console.log('=================');
  for (const p of Object.values(result.dataProvenance)) {
    console.log(
      `Data source ${p.symbol}: ${p.source} bars=${p.candleCount}/${p.expectedCount} ` +
        `coverage=${(p.coverage * 100).toFixed(1)}% spacing=${p.inferredBarMinutes ?? 'n/a'}m` +
        (p.source === 'synthetic' ? ' [SYNTHETIC — VOID]' : ''),
    );
  }
  const spacing = Array.from(new Set(Object.values(result.dataProvenance).map((p) => p.inferredBarMinutes ?? 'n/a')));
  console.log(`Bar timeframe: ${spacing.join(', ')} min (native stored bars)`);
  console.log(`Venue: ${Object.entries(result.venueBySymbol).map(([s, v]) => `${s}=${v}`).join(', ')}`);
  if (result.fees.routing === 'flat-override') {
    console.log(`Fees: flat ${((result.fees.flatRate ?? 0) * 10_000).toFixed(2)} bps/side (--commission override; fee tier ${feeTier.name} ignored)`);
  } else {
    const per = Object.entries(result.fees.perVenue).map(([v, b]) => `${v} maker=${b.makerBps}/taker=${b.takerBps} bps`).join('; ');
    console.log(`Fees: tier=${feeTier.name} → ${per}`);
  }
  console.log(`Long/Short entries: ${m.longEntries}/${m.shortEntries} (sell-exits=${m.sellSignalExits}, short-blocked=${m.shortBlocked})`);
  console.log(`EV gate: mode=${m.evGate.mode} evaluated=${m.evGate.evaluated} rejected=${m.evGate.rejected} shadow-would-reject=${m.evGate.shadowWouldReject}`);
  console.log(`Regime gate: enabled=${result.regimeGate.enabled} minCompat=${result.regimeGate.minCompatibilityScore} minConf=${result.regimeGate.minRegimeConfidence}`);
  console.log(`Total Return: ${m.returnPercent.toFixed(2)}%`);
  console.log(`Sharpe Ratio: ${m.sharpeRatio.toFixed(2)}`);
  console.log(`Win Rate: ${(m.winRate * 100).toFixed(2)}%`);
  console.log(`Profit Factor: ${m.profitFactor.toFixed(2)}`);
  console.log(`Max Drawdown: ${(m.maxDrawdownPercent * 100).toFixed(2)}%`);
  console.log(`Total Trades: ${m.totalTrades}`);
  console.log(`Total Fees: $${m.totalFees.toFixed(2)}`);
  console.log(`Average Hold Time: ${m.averageHoldTime.toFixed(1)} minutes`);
  console.log(`Final Capital: $${m.finalCapital.toFixed(2)}`);
}

async function main() {
  // Single source of truth for fees — backtest must match paper/live or
  // comparisons are meaningless. Per #11 (2026-05-18), we pass the
  // FeeModel into BacktestConfig so per-fill fees route by symbol
  // (spot vs perps_intx) instead of one flat decimal applied uniformly.
  // CLI `--commission` is kept as an explicit sensitivity-analysis
  // override (e.g. simulate HL 4.5 bps on Coinbase candles).
  const atlasRoot = path.resolve(process.cwd(), '../..');
  const guardrails = loadGuardrails(atlasRoot);

  const argv = await yargs(hideBin(process.argv))
    .scriptName('atlas-backtest')
    .usage('$0 [options]')
    .option('start-date', {
      type: 'string',
      describe: 'Start date (YYYY-MM-DD)',
      demandOption: true,
    })
    .option('end-date', {
      type: 'string',
      describe: 'End date (YYYY-MM-DD)',
      demandOption: true,
    })
    .option('products', {
      type: 'array',
      describe: 'Products to backtest (e.g., BTC-USD ETH-USD)',
      default: ['BTC-USD'],
    })
    .option('initial-capital', {
      type: 'number',
      describe: 'Initial capital',
      default: 10000,
    })
    .option('results-path', {
      type: 'string',
      describe: 'Path to save results',
      default: path.resolve(process.cwd(), '../../var/backtest_results'),
    })
    .option('strategy', {
      type: 'string',
      describe: 'Strategy to test (breakout, vwap, momentum, trend_follow, all). disabled_strategies in guardrails.yaml override this.',
      default: 'all',
    })
    .option('commission', {
      type: 'number',
      describe:
        'OPTIONAL flat commission override (decimal, e.g. 0.00045 = 4.5 bps). ' +
        'When set, every fill is charged this rate regardless of symbol — ' +
        'use this to simulate Hyperliquid fees on Coinbase candles or for ' +
        'sensitivity analysis. When omitted, fees are resolved per-symbol ' +
        'via FeeModel (coinbase.spot.taker_bps for spot, ' +
        'coinbase.perps_intx.taker_bps for *-PERP-INTX).',
    })
    .option('slippage', {
      type: 'number',
      describe:
        'Entry/exit slippage as a decimal rate (0.0005 = 5 bps). Maps onto ' +
        'realism.entrySlippageBps; when omitted guardrails.yaml backtest.entry_slippage_bps applies.',
    })
    .option('allow-synthetic', {
      type: 'boolean',
      describe:
        'SMOKE ONLY. Permit random-walk synthetic candles when no real data exists. ' +
        'Default false → exit 1 with DATA_UNAVAILABLE. Any synthetic run is stamped ' +
        '"DATA: SYNTHETIC" and is VOID as evidence.',
      default: false,
    })
    .option('fixture-dir', {
      type: 'string',
      describe:
        'Load candles from <dir>/<SYMBOL>.json fixtures instead of Supabase (offline/CI). ' +
        'Fixtures are the only source when set — a missing fixture is DATA_UNAVAILABLE.',
    })
    .option('min-coverage', {
      type: 'number',
      describe: 'Minimum bars-loaded / bars-expected ratio per symbol before DATA_UNAVAILABLE (0 disables).',
      default: 0.5,
    })
    .option('venue', {
      type: 'string',
      choices: ['spot', 'perps'],
      describe:
        'Force every product onto one venue class (fee bucket + shorting capability). ' +
        'Default: inferred per symbol (XXX-PERP-INTX → perps, else spot). Spot is long-only.',
    })
    .option('fee-tier', {
      type: 'string',
      describe:
        'Coinbase spot fee tier: intro1 (60/120 bps) | t1k (35/75) | t10k (25/40) | custom:<maker>,<taker>. ' +
        'Default: guardrails.yaml fees (t10k today). Ignored when --commission is set.',
    })
    .option('ev-gate', {
      type: 'string',
      choices: ['enforce', 'shadow', 'off'],
      default: 'enforce',
      describe:
        'Fee-adjusted EV gate: enforce (reject negative-EV entries, live parity) | ' +
        'shadow (allow but count would-be rejects) | off.',
    })
    .option('regime-gates', {
      type: 'string',
      choices: ['on', 'off'],
      default: 'on',
      describe: 'Regime/strategy compatibility filter (RegimeFilter). Default on.',
    })
    .option('optimize', {
      type: 'boolean',
      describe: 'Run parameter optimization',
      default: false,
    })
    .help()
    .parse();

  const logger = createLogger(path.join(process.cwd(), '../../var/logs/backtest.jsonl'));

  // NOTE: `guardrails` is loaded at the top of main() and passed into
  // BacktestConfig below. Both backtest-engine (disabled_strategies,
  // per-symbol overrides, account sizing) and the fee resolution path
  // read from the same source of truth so backtest behaviour can't
  // drift from paper/live.

  const fixtureDir = argv.fixtureDir ? path.resolve(process.cwd(), String(argv.fixtureDir)) : undefined;
  const SUPABASE_URL = process.env.SUPABASE_URL || '';
  const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
  if (!fixtureDir && (!SUPABASE_URL || !SUPABASE_SERVICE_KEY)) {
    console.error(
      'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY — backtest reads candles from public.bars. ' +
        'Pass --fixture-dir <dir> to run offline on committed fixtures.',
    );
    process.exit(1);
  }

  // Fee tier → FeeModel. The tier only rewrites the coinbase.spot bucket;
  // perps buckets stay as configured in guardrails.yaml.
  const feeTier = resolveFeeTier(argv.feeTier ? String(argv.feeTier) : undefined, guardrails.fees.coinbase.spot);
  const feeModel = new FeeModel({
    ...guardrails.fees,
    coinbase: {
      ...guardrails.fees.coinbase,
      spot: { maker_bps: feeTier.makerBps, taker_bps: feeTier.takerBps },
    },
  });

  const evGateMode = String(argv.evGate) as EvGateMode;
  const venueOverride = argv.venue ? (String(argv.venue) as MarketVenue) : undefined;
  const allowSynthetic = Boolean(argv.allowSynthetic);

  logger.info('Starting backtest', {
    startDate: argv.startDate,
    endDate: argv.endDate,
    products: argv.products,
    strategy: argv.strategy,
    feeRouting: argv.commission !== undefined ? 'flat-override' : 'per-symbol-feeModel',
    commissionOverride: argv.commission,
    feeTier,
    venueOverride: venueOverride ?? 'per-symbol',
    evGateMode,
    regimeGates: argv.regimeGates,
    allowSynthetic,
    fixtureDir,
    dataSource: fixtureDir ? 'fixture' : 'supabase',
  });
  if (allowSynthetic) {
    console.warn('WARNING: --allow-synthetic set. If real data is missing, output is SMOKE/VOID and stamped DATA: SYNTHETIC.');
  }

  const runnerConfig: BacktestRunnerConfig = {
    resultsPath: String(argv.resultsPath),
    supabaseUrl: SUPABASE_URL || undefined,
    supabaseKey: SUPABASE_SERVICE_KEY || undefined,
    fixtureDir,
  };

  const runner = new BacktestRunner(runnerConfig, logger);

  // Build per-symbol overrides snapshot the same way live trading does
  // (signal-processor.loadPerSymbolOverridesFromGuardrails called twice in
  // api/server.ts:1631-1644 — once for per_symbol, once for perps_symbols).
  // Backtest then forwards this verbatim to the strategy registry.
  //
  // F4 follow-up (2026-05-19): same backtest/live drift class as #11 — the
  // CLI previously read only `guardrails.per_symbol` and silently dropped
  // `guardrails.perps_symbols.*.strategy_overrides`, so YAML-side perps
  // momentum/trend_follow tuning was invisible to backtests while live
  // honoured it. Mirror the live dual-call here so the backtest sees the
  // same per-symbol config the engine uses in paper/live. See
  // docs/research/2026-05-19_f4-followup-perps-action.md §3.
  const perSymbolOverrides: PerSymbolStrategyOverrides = {};
  for (const [symbol, cfg] of Object.entries(guardrails.per_symbol ?? {})) {
    if (cfg.strategy_overrides) {
      perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
    }
  }
  for (const [symbol, cfg] of Object.entries(guardrails.perps_symbols ?? {})) {
    if (cfg.strategy_overrides) {
      perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
    }
  }

  const initialCapital = Number(argv.initialCapital);

  // #11 (2026-05-18): only set `commission` when the user passed
  // `--commission` explicitly. When omitted, the engine routes per-fill
  // via `feeModel.getFeeRate(venue, marketForSymbol(symbol), 'taker')`
  // so mixed --products lists (spot + perps) charge the correct tier
  // per symbol — the bug that 402e757 fixed in the paper path.
  const commissionOverride =
    argv.commission !== undefined ? Number(argv.commission) : undefined;

  // Configure backtest
  const backtestConfig: BacktestConfig = {
    startDate: new Date(String(argv.startDate)),
    endDate: new Date(String(argv.endDate)),
    initialCapital,
    feeModel,
    venue: 'coinbase',
    ...(commissionOverride !== undefined ? { commission: commissionOverride } : {}),
    // TASK_017 B2/B3: venue capability + EV gate + regime gate wiring.
    venueOverride,
    allowShort: guardrails.strategy.allow_short,
    evGate: {
      mode: evGateMode,
      minEvThreshold: guardrails.risk.min_ev_threshold,
    },
    regimeGates: String(argv.regimeGates) !== 'off',
    products: argv.products as string[],
    // Strategy parameters mirror atlas/config/guardrails.yaml. trend_follow
    // is wired here too — defect #1: prior backtests silently dropped it.
    signals: {
      breakout: {
        enabled: argv.strategy === 'breakout' || argv.strategy === 'all',
        parameters: {
          period: 20,
          atrPeriod: 14,
          atrMultiplier: 2,
          volumeThreshold: 1.5,
        },
      },
      vwapMeanReversion: {
        enabled: argv.strategy === 'vwap' || argv.strategy === 'all',
        parameters: {
          deviationEntry: 2,
          deviationExit: 0.5,
          minVolume: 1000,
        },
      },
      momentum: {
        enabled: argv.strategy === 'momentum' || argv.strategy === 'all',
        parameters: {
          // strategy-tuning: was 55/40 — restored to canonical 70/30 to
          // match the plugin schema and guardrails.yaml.
          rsiPeriod: 10,
          rsiOverbought: 70,
          rsiOversold: 30,
          macdFast: 8,
          macdSlow: 21,
          macdSignal: 5,
        },
      },
      trendFollow: {
        enabled: argv.strategy === 'trend_follow' || argv.strategy === 'all',
        parameters: {},
      },
    },
    risk: {
      // Hard ceiling on per-position notional. Risk-based sizing is now
      // primary; this is a guardrail, not the sizing function (defect #5).
      maxPositionSize: initialCapital * guardrails.risk.max_position_exposure_pct,
      // Total exposure = equity × max_account_leverage (matches live).
      maxTotalExposure: initialCapital * guardrails.account.max_account_leverage,
      stopLossPercent: 0.02, // fallback only; signals carry ATR-based stops
      takeProfitPercent: 0.04, // fallback only; signals carry ATR-based TPs
    },
    account: {
      equityUsd: initialCapital,
      riskPerTrade: guardrails.account.risk_per_trade,
      maxPositionExposurePct: guardrails.risk.max_position_exposure_pct,
      minNotionalBuffer: guardrails.account.min_notional_buffer,
    },
    // Defect #2: honour the same kill list live uses.
    disabledStrategies: guardrails.disabled_strategies,
    // F4 follow-up §8 (2026-05-19): same shape as the live API server reads
    // — flatten per-(symbol, strategy) disable from per_symbol /
    // perps_symbols / hyperliquid_symbols blocks into a single map.
    perSymbolDisabledStrategies: buildPerSymbolDisabledStrategies(guardrails),
    // Defect #1: forward per-symbol parameter overrides so trend_follow on
    // ETH-USD uses emaFast=12 / emaSlow=15, momentum on ETH uses rsi 10/40/55, etc.
    perSymbolOverrides,
    realism: {
      ...(guardrails.backtest
        ? {
            nextBarFill: guardrails.backtest.next_bar_fill,
            entrySlippageBps: guardrails.backtest.entry_slippage_bps,
            stopOvershootBarRangePct: guardrails.backtest.stop_overshoot_bar_range_pct,
            stopOvershootMinBps: guardrails.backtest.stop_overshoot_min_bps,
            sizeDecimals: guardrails.backtest.size_decimals,
          }
        : {}),
      // TASK_017 B5: `--slippage` (decimal) is now honoured — it overrides
      // the guardrails bps when passed explicitly.
      ...(argv.slippage !== undefined ? { entrySlippageBps: Number(argv.slippage) * 10_000 } : {}),
    },
  };

  const dataOptions = {
    allowSynthetic,
    minCoverage: Number(argv.minCoverage),
  };

  try {
    if (argv.optimize) {
      // Run optimization
      logger.info('Running parameter optimization');

      const parameterRanges = {
        'signals.breakout.parameters.period': { min: 10, max: 30, step: 5 },
        'signals.breakout.parameters.atrMultiplier': { min: 1, max: 3, step: 0.5 },
        'signals.vwapMeanReversion.parameters.deviationEntry': { min: 1.5, max: 3, step: 0.5 },
        'risk.stopLossPercent': { min: 0.01, max: 0.03, step: 0.005 },
        'risk.takeProfitPercent': { min: 0.02, max: 0.06, step: 0.01 },
      };

      const result = await runner.runOptimization(backtestConfig, parameterRanges, 'sharpeRatio', dataOptions);

      logger.info('Optimization complete', {
        bestParams: result.bestParams,
        bestSharpe: result.bestMetric,
      });

      console.log('\nOptimization Results:');
      console.log('====================');
      console.log(`Best Sharpe Ratio: ${result.bestMetric.toFixed(2)}`);
      console.log('Best Parameters:');
      console.log(JSON.stringify(result.bestParams, null, 2));
    } else {
      // Run single backtest
      const result = await runner.runBacktest(backtestConfig, dataOptions, { feeTier });
      printSummary(result, feeTier);
    }
  } catch (error) {
    if (isDataUnavailableError(error)) {
      logger.error('Backtest aborted: DATA_UNAVAILABLE', {
        symbol: error.symbol,
        windowStart: error.windowStart.toISOString(),
        windowEnd: error.windowEnd.toISOString(),
        attempted: error.attempted,
      });
      console.error(`\n${error.message}`);
      process.exit(2);
    }
    logger.error('Backtest failed:', error);
    console.error('Backtest failed:', error);
    process.exit(1);
  }

  // The Supabase client (used by BacktestRunner to read candles from
  // public.bars) keeps the Node event loop alive after main() resolves —
  // its connection pool / realtime subscription holds open handles. Without
  // an explicit exit here, the process hangs indefinitely after results
  // print and the CI step has to wrap us in `timeout`. Exit cleanly now
  // that we have nothing useful left to do.
  logger.info('Backtest CLI exiting cleanly');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
