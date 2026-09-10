# Multi-timeframe bar fixtures (4h, 1d) — E4 harness data

Real Coinbase spot candles for **separate per-timeframe** FeeModel experiments
(Dev Strategies owns E4; this directory only supplies data + the loader path).
Run order per the E4 brief: **4H first, then 1D**. Never mix directories in one
run — each `--fixture-dir` is one timeframe.

The 15m fixtures in the parent directory (`fixtures/bars/BTC-USD.json`,
`ETH-USD.json`) belong to the `backtest-gate` CI workflow and are **not** part
of this set — see `README.md` there.

## What is committed

| Dir | Symbols | Bars | Window (UTC, bar starts, inclusive) | Bar width | Derivation |
|---|---|---|---|---|---|
| `4h/` | BTC-USD, ETH-USD, SOL-USD | 186 each | 2026-08-01T00:00 → 2026-08-31T20:00 (August 2026 month-block) | 4h (`FOUR_HOUR`, 14400 s) | 744 native `ONE_HOUR` candles per symbol rolled up offline (below); 186/186 buckets complete, 0 dropped |
| `1d/` | BTC-USD, ETH-USD, SOL-USD | 730 each | 2024-09-01 → 2026-08-31 (24 months, ends on the same month-block boundary) | 1d (`ONE_DAY`, 86400 s) | native `ONE_DAY` candles, 730/730, no rollup |

Source for both: Coinbase Advanced Trade **public** market-data endpoint (no
auth) — `GET https://api.coinbase.com/api/v3/brokerage/market/products/{SYMBOL}/candles`.
Every file records `source`, `endpoint`, `fetchedAt`, `granularity`,
`granularitySeconds`, `start`, `end`; rolled-up files additionally carry a
`rollup` block (see below). Format: `BarFixtureFile` in
`src/backtesting/data-loader.ts` — `candles[].time` is epoch **seconds**.

Coverage is 100 % and every series is contiguous and UTC-aligned (asserted by
`src/__tests__/backtest-multi-tf-fixtures.test.ts`, which also re-derives the
August 1d OHLC from the 4h files and checks it matches the native 1d files).

## How Strategies should invoke (from `atlas/apps/core-node`)

Always `pnpm exec tsx src/cli/backtest.ts …` — never `pnpm backtest -- --flags`
(pnpm forwards the `--` and yargs then treats every flag as positional). The
CLI flags are `--start-date` / `--end-date` (YYYY-MM-DD or ISO).

```bash
# 4H, August 2026 month-block, pooled 3-symbol spot (long-only by venue)
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/4h \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2026-08-01 --end-date 2026-09-01

# 1D, 24 months
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/1d \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2024-09-01 --end-date 2026-08-31
```

Add the usual experiment flags (`--fee-tier`, `--commission`, `--slippage`,
`--ev-gate`, `--strategy`, …) as needed. Expected stdout / report header:

```
DATA: REAL
Data source BTC-USD: fixture bars=186/187 coverage=99.5% spacing=240m
…
Bar timeframe: 240 min (native stored bars)
```

- `spacing=240m` / `1440m` confirms the engine is stepping true 4h / 1d bars.
- `186/187` on 4h is the inclusive end bound counting a would-be
  `2026-09-01T00:00` bar; the fixture is August-only by design. Using
  `--end-date 2026-08-31` instead reads 100 % but drops the last five 4h bars
  of Aug 31.
- The loader judges coverage against the **fixture's declared bar width**
  (`granularitySeconds`), so no `--min-coverage` tweak is needed for 4h/1d.
- A symbol without a file in the directory, or a window the file does not
  cover, is `DATA_UNAVAILABLE` (exit 2). The loader never falls through to
  Supabase or synthetic data when `--fixture-dir` is set.

### Stamp discipline

Evidence requires `DATA: REAL` on line 1 of stdout and of the saved report,
plus `source=fixture` for every symbol. **Never** pass `--allow-synthetic`
for an E4 run — any `DATA: SYNTHETIC` output is SMOKE/VOID and is not evidence
of anything. Never commit synthetic output under `fixtures/`.

## 4h rollup — how the bars were derived (and why)

Coinbase's candle enum is `ONE_MINUTE | FIVE_MINUTE | FIFTEEN_MINUTE |
THIRTY_MINUTE | ONE_HOUR | TWO_HOUR | SIX_HOUR | ONE_DAY` — there is **no
FOUR_HOUR**. `SIX_HOUR` is not 4h and is not used. True 4h bars are produced
by fetching `ONE_HOUR` and aggregating offline with
`pnpm backtest:backfill --rollup-minutes 240` (`rollupCandles` in
`src/cli/backtest-backfill.ts`):

| Field | Rule |
|---|---|
| bucket start | `floor(time / 14400) * 14400` — epoch seconds are UTC, and 14400 divides 86400, so buckets start at 00:00, 04:00, 08:00, 12:00, 16:00, 20:00 UTC |
| `open` | open of the **first** source bar in the bucket |
| `high` | **max** of source highs |
| `low` | **min** of source lows |
| `close` | close of the **last** source bar in the bucket |
| `volume` | **exact decimal sum** of source volumes (`decimalAdd`, no float accumulation) |
| completeness | only buckets with all `bucketSeconds / sourceSeconds` (= 4) distinct source bars are written; partial buckets are dropped and counted in `rollup.bucketsDroppedIncomplete` |

Each 4h file records the derivation:

```json
"granularity": "FOUR_HOUR",
"granularitySeconds": 14400,
"rollup": {
  "method": "utc-aligned-ohlcv",
  "sourceGranularity": "ONE_HOUR",
  "sourceGranularitySeconds": 3600,
  "bucketSeconds": 14400,
  "sourceBarsPerBucket": 4,
  "sourceBars": 744,
  "bucketsEmitted": 186,
  "bucketsDroppedIncomplete": 0,
  "rules": "bucket=floor(time/14400)*14400 (UTC); open=first, high=max, low=min, close=last, volume=exact decimal sum; complete buckets only"
}
```

`FOUR_HOUR` is a fixture label, not a Coinbase enum; it only appears together
with a `rollup` block.

### Verification performed at generation (2026-09-10)

- Independent path: `FIFTEEN_MINUTE` fetched for the same window and rolled
  15m → 4h reproduced the committed 1H → 4h **OHLC exactly on all 186 × 3
  buckets**.
- Internal consistency: rolling the committed 4h files → 1d reproduced the
  native `ONE_DAY` files' **OHLC exactly on all 31 × 3 August days** (this is a
  unit test now).
- Volume caveat (upstream, not a rollup defect): Coinbase's own series disagree
  on volume across granularities for a small share of hours — e.g. BTC-USD
  2026-08-28T23:00Z native `ONE_HOUR` volume 149.85 vs the sum of Coinbase's
  own four `FIFTEEN_MINUTE` candles 161.05, with identical OHLC. About 6 % of
  4h buckets therefore differ in volume between a 1H-sourced and a 15m-sourced
  rollup (worst observed 1.2 %), and native 1d volume differs from the 4h sum
  by ≤ 0.02 % on a few days. The committed 4h volume is the exact sum of the
  native `ONE_HOUR` volumes. Do not build volume-precise cross-TF logic on
  these files.

## Regenerate

```bash
cd atlas/apps/core-node

# 4h — August 2026 month-block. --until is the LAST source (1h) bar of the block;
# the tool floors --since to the bucket and writes only complete 4h buckets.
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2026-08-01 --until 2026-08-31T23:00:00Z \
  --granularity ONE_HOUR --rollup-minutes 240 --out-dir fixtures/bars/4h

# 1d — native ONE_DAY, 24 months
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2024-09-01 --until 2026-08-31 \
  --granularity ONE_DAY --out-dir fixtures/bars/1d
```

Notes:

- `--rollup-minutes` is fixtures-only; it refuses `--upsert` because
  `public.bars` holds native candles.
- The rollup accepts any `--granularity` that divides the bucket
  (`FIFTEEN_MINUTE --rollup-minutes 240` works too), and any bucket that
  divides the UTC day.
- To move the 4h block to another month, change `--since` / `--until` and
  update this table plus the window asserted in
  `src/__tests__/backtest-multi-tf-fixtures.test.ts`.
- `--until` truncates to the source granularity; with `--rollup-minutes` a
  trailing partial bucket is dropped and reported (`… incomplete bucket(s)
  dropped`) rather than written.

## Rules

- Never hand-edit candle values. Regenerate instead.
- Never commit synthetic output here; never use `--allow-synthetic` for
  evidence (SMOKE/VOID).
- One timeframe per directory; do not put 4h and 1d files in the same
  `--fixture-dir`.
- Leave the 15m gate fixtures (`fixtures/bars/*.json`) and
  `.github/workflows/backtest-gate.yml` alone when touching this set.

## Caveats for E4 (engine behaviour on wide bars — not fixed here)

- Strategy parameters in `guardrails.yaml` / the CLI are tuned for 15m bars.
  Default-parameter 4h/1d runs are a harness smoke, not a result; e.g. a
  15m-sized ATR stop can be hit intrabar on the entry bar of a 4h candle
  (hold time 0).
- `SignalProcessor`'s MTF filter buckets incoming bars by clock into
  5m/15m/1h groups; with ≥ 1h base bars the "1h" series degenerates to the
  base timeframe.
