# Sprint 4 Backtest Findings — 2026-04-27

Pair with commits `af1d9b6` (data wiring) and `74ee8d5` (strategy fixes).
Both pushed to `origin/main`.

## Executive summary

The backtest infrastructure is now functional end-to-end after fixing
five real bugs uncovered along the way (one of which had been silently
disabling `trend_follow` in **live trading** for months — see Bug 1).

But: with 15-minute candles and a 4-strategy mix, **the 90-day, 3-symbol
window produced only 6 trades**. That's not enough data to draw any
edge conclusion. Before the user makes a Coinbase-vs-Hyperliquid call,
the next session needs to widen the trade count by an order of magnitude.

Headline number with current parameters:

| Fee model            | Trades | Win rate | Net P&L | Sharpe  | Fees    |
| -------------------- | -----: | -------: | ------: | ------: | ------: |
| Coinbase (0.60%)     |      6 |    16.7% |  −$249  |  −3.72  | $362    |
| Hyperliquid (0.02%)  |      6 |    33.3% |  +$100  |  +3.88  | $12     |

Same 6 trades, same prices, same hold times — only fees differ. Coinbase
turns a +$112 gross winning sequence into a −$249 net loss. Hyperliquid
preserves +$100. With this trade count the Sharpe figures are not
meaningful, but the fee-impact comparison is the genuine signal.

## Per-strategy contribution (90d, 3 symbols, Coinbase fees)

| Strategy      | Trades | Wins | Net P&L  |
| ------------- | -----: | ---: | -------: |
| trend_follow  |      3 |    0 | −$271    |
| breakout      |      1 |    0 |  −$30    |
| momentum      |      1 |    0 |  −$84    |
| vwap_mr       |      1 |    1 | +$136    |

`vwap_mr` is in `disabled_strategies` per the Phase 3 verdict but its
plugin still runs and emits signals (the live engine's `processSignal`
hard-rejects them; the backtest engine doesn't). For backtest-only
evaluation it shows the only winner here. Sample is too small to read
into.

Exit-reason breakdown: `signal: 5, take_profit: 1`. **Zero `stop_loss`
exits.** Worth noting because the BacktestEngine uses fixed-percent
stops (2% / 4% from cli/backtest.ts), not the strategies' ATR-based
stops — that mismatch is documented under Limitations below.

## What got fixed this session

### Bug 1 — `trend_follow` was permanently broken (LIVE + backtest)

`atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts:374`
asks for `context.indicators[ema${emaSlow}]`. Defaults and
`atlas/config/guardrails.yaml` both use `emaSlow: 15`. But
`signal-processor.ts:497-499` only computed `ema9, ema12, ema21, ema26`
— never `ema15`. So `slowEma` was always `undefined`, `validateContext`
returned `{ valid: false }`, and the strategy never reached its analyze
phase. The action plan called this "by design silent". It wasn't.

Fix in commit `74ee8d5`:
- `signal-processor.ts` now computes `ema15`.
- `trend-follow-strategy.ts validateContext` fallback now uses `(ema9, ema21)` to match `analyze()` — the prior fallback to `ema15` was always undefined whenever the requested key was, which was tautological.

This means `trend_follow` will start firing in **live paper trading**
the next time the engine starts. Watch for it.

### Bug 2 — Backtest sized every crypto position to 0 units

`backtesting/backtest-engine.ts:441` — `Math.floor(maxPositionValue / signal.price)`.
At $5000 max position vs $85k BTC: `floor(0.0588)` = 0 → `openPosition`
bailed at the size-zero guard. Fix: round to 8 decimals (crypto precision).

### Bug 3 — Strategy signals carried wall-clock timestamps

`base-strategy.ts:191` set `timestamp: new Date()` which is fine in live
(close enough to candle time) but in backtest it's the time you launched
`pnpm backtest`. Hold times came back as `-187176 minutes`. Fix: pull
timestamp from `context.latestCandle.time`.

### Bug 4 — Backtest CLI parameters drifted from `guardrails.yaml`

CLI hardcoded `rsiPeriod=14, oversold=30, overbought=70`; live
guardrails are `10, 40, 55`. The live thresholds are tighter and would
fire more often. Fix in `cli/backtest.ts`. Comment added that they need
to stay in sync with guardrails.

### Bug 5 — `bars.time` epoch-seconds vs millis (commit `af1d9b6`)

`HistoricalDataLoader.loadFromSupabase` filtered with ISO strings
against a `BIGINT` column and treated returned `time` as millis when
it's seconds. `signal-processor.ts:loadFromSupabase` had the same bug
on the live warmup path (effect was cosmetic — candles ordered fine,
just tagged with 1970 timestamps).

### Cleanup also done

- Removed leftover `console.log("[BREAKOUT BTC-USD] ...")` from a prior debug session in `breakout-strategy.ts`.
- Supabase JS client's 1000-row default cap was silently truncating multi-week loads; now paginates via `.range()`.
- `SignalProcessor` was unconditionally calling `createClient(url, key)`, which threw "supabaseUrl is required" when the backtest passed empty creds. Now lazy-init.

## Why only 6 trades over 90d?

Three plausible factors:

1. **Capital cap interacts with hold time.** With `maxTotalExposure: 8000` and `maxPositionSize: 5000`, 1–2 positions fill the budget. Average hold is **22.8 hours**. While positions are open, no new entries can fire — `availableCapital` goes negative for the third symbol. So the actual trade rate is throttled by hold time × concurrency.

2. **5-minute dedup at `signal-processor.ts:953-957`.** Same `(strategy, symbol, direction)` within 5 min → drop. Probably fine in live but may cluster signals during rapid price moves in backtest.

3. **`SignalArbiter` deconfliction at `checkSignalsViaPlugins:625-638`.** When multiple strategies fire on the same bar, the arbiter picks one. With 4 strategies × 3 symbols, this could be filtering aggressively.

All three are by-design protections, but they make the backtest hard to
evaluate. Before re-running, consider:
- Bumping `maxTotalExposure` to `30000` so all 3 symbols can hold concurrently.
- Adding a `--no-arbiter` and `--no-dedup` flag to the backtest CLI for diagnostic runs.
- Running each strategy in isolation to see its uncontested signal rate.

## Limitations to be honest about

- **15-minute bars vs live 1-minute** — production runs on 1m candles. Signal frequency on 1m would be much higher; entry/exit prices would be tighter. Backtest at 15m underestimates the trade count and overestimates per-trade slippage relative to live. The bars table doesn't have 1m data.
- **Backtest engine's exit logic uses fixed-percent stops, not signal stops.** `BacktestEngine.checkExitConditions` reads `this.config.risk.stopLossPercent` (2%) and `takeProfitPercent` (4%), ignoring the strategy's ATR-based `signal.stopLoss` / `signal.takeProfit`. Live trading honors signal stops. So backtest stops are tighter than reality on low-vol bars and looser than reality on high-vol bars. Worth fixing.
- **`vwap_mr` is in `disabled_strategies` per Phase 3** but the plugin still emits in backtest. The live engine's `processSignal` hard-rejects it; the backtest engine has no equivalent gate. Either wire the gate or drop `vwap_mr` from the `--strategy all` set.
- **No regime cross-section.** I haven't broken P&L down by regime (`strong_trend / weak_trend / ranging / choppy`). The trade JSON has the data; the report doesn't surface it.
- **One window only.** September–December 2025 was a specific market regime. Runs across multiple windows (e.g. Mar–May, Jun–Aug, Sep–Dec) would show whether edge is window-dependent.

## Recommended next moves

In rough priority:

1. **Loosen the capital constraints and re-run.** Bump `maxTotalExposure` to allow all 3 symbols concurrently. Get to 50+ trades. Then per-strategy edge becomes meaningful.
2. **Honor signal stops in BacktestEngine.checkExitConditions.** This is a faithfulness fix — current backtest stops aren't what live trades against.
3. **Per-regime + per-symbol P&L breakdown.** Easy post-processing on the trade JSON. Add it to the report template or write a separate analysis script.
4. **Decide on Coinbase vs Hyperliquid.** The current data already says it: gross signals are roughly even, fees decide the outcome. But that conclusion is based on 6 trades; revisit after step 1 above.
5. **`vwap_mr` gate in backtest.** Either honor `disabled_strategies` in the backtest path, or drop it from `--strategy all`.

## Files to revisit next session

- `atlas/apps/core-node/src/cli/backtest.ts` — capital cap, vwap_mr handling.
- `atlas/apps/core-node/src/backtesting/backtest-engine.ts` — `checkExitConditions` should use `signal.stopLoss` / `signal.takeProfit`.
- `atlas/var/backtest_results/backtest_2026-04-27T19-22-36.json` — full trade list, regime annotations included in metadata.
