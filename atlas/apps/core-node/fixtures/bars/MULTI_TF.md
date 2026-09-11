# Multi-timeframe bar fixtures (4h, 1d) — E4 harness data

Real Coinbase spot candles for **separate per-timeframe** FeeModel experiments
(Dev Strategies owns E4; this directory only supplies data + the loader path).
Run order per the E4 brief: **4H first, then 1D**. Never mix directories in one
run — each `--fixture-dir` is one timeframe **and one window**.

The 15m fixtures in the parent directory (`fixtures/bars/BTC-USD.json`,
`ETH-USD.json`) belong to the `backtest-gate` CI workflow and are **not** part
of this set — see `README.md` there. The long native-15m holdout / tune
windows for E2-MOM-ISO (`15m/holdout-2025-03_2026-03/`,
`15m/tune-2023-03_2025-03/`) are documented in `15m/README.md`; they cover the
same two windows as the 4h sets below and were cross-checked against them.

## What is committed

| Dir (`--fixture-dir`) | Role | Symbols | Bars / symbol | Window (UTC, bar starts, inclusive) | Bar width | Derivation |
|---|---|---|---|---|---|---|
| `4h/holdout-2025-03_2026-03/` | **HOLDOUT — hard-preflight source of truth** (counted E[n]) | BTC-USD, ETH-USD, SOL-USD | **2188** | 2025-03-01T00:00 → 2026-02-28T20:00 (12 months) | 4h (`FOUR_HOUR`, 14400 s) | 8755 native `ONE_HOUR` candles / symbol rolled up offline; 2188 / 2190 buckets (one upstream 8h gap, below) |
| `4h/tune-2023-03_2025-03/` | **TUNE** — parameter fitting only; never out-of-sample evidence | BTC-USD, ETH-USD, SOL-USD | **4384** | 2023-03-01T00:00 → 2025-02-28T20:00 (24 months) | 4h | 17541 (BTC, ETH) / 17539 (SOL) native `ONE_HOUR` candles rolled up; 4384 / 4386 buckets (one upstream 8h gap, below) |
| `4h/smoke-aug2026/` | **SMOKE ONLY — not hard-preflight** | BTC-USD, ETH-USD, SOL-USD | 186 | 2026-08-01T00:00 → 2026-08-31T20:00 (August 2026 month-block) | 4h | 744 native `ONE_HOUR` candles rolled up; 186 / 186 complete |
| `1d/` | 1D experiments (E4 second pass) | BTC-USD, ETH-USD, SOL-USD | 730 | 2024-09-01 → 2026-08-31 (24 months) | 1d (`ONE_DAY`, 86400 s) | native `ONE_DAY` candles, no rollup |

- Tune and holdout are **adjacent and disjoint**: the last tune bar is
  2025-02-28T20:00, the first holdout bar is 2025-03-01T00:00 (asserted by the
  unit test). Fit on tune, count on holdout, never the other way round.
- **Aug 2026 (`smoke-aug2026/`) was vetoed as hard-preflight by the Algo
  Creator.** A 31-day month-block is a harness smoke. Any result from it is
  a smoke, not evidence, and must not be counted toward E[n] or a go/no-go.
  It is kept only so the E4 harness has a fast fixture.
- The bare `fixtures/bars/4h/` directory holds **no** fixture files. Passing it
  as `--fixture-dir` is `DATA_UNAVAILABLE` (exit 2) by design — a run has to
  name its window.

Source for everything here: Coinbase Advanced Trade **public** market-data
endpoint (no auth) —
`GET https://api.coinbase.com/api/v3/brokerage/market/products/{SYMBOL}/candles`.
Every file records `source`, `endpoint`, `fetchedAt`, `granularity`,
`granularitySeconds`, `start`, `end`; rolled-up files additionally carry a
`rollup` block (see below). Format: `BarFixtureFile` in
`src/backtesting/data-loader.ts` — `candles[].time` is epoch **seconds**.

Every series is UTC-aligned and contiguous **except** for the upstream gaps in
the next section (asserted by `src/__tests__/backtest-multi-tf-fixtures.test.ts`,
which fails on any undocumented hole and on any silently filled one).

### Upstream Coinbase gaps (real, not rollup defects)

Coinbase's own public candle series has no `ONE_HOUR` (nor `FIFTEEN_MINUTE`)
candles for a few hours on two days — exchange outages. The rollup writes
**complete buckets only**, so it refuses to fabricate a 4h bar over those
hours and the two affected buckets per day are absent:

| Set | Missing 4h bucket starts (UTC) | Native hours absent upstream |
|---|---|---|
| `holdout-2025-03_2026-03/` | 2025-10-25T16:00, 2025-10-25T20:00 | 16:00–20:59 on BTC, ETH and SOL (15m series: 15:15–20:45) |
| `tune-2023-03_2025-03/` | 2023-03-04T16:00, 2023-03-04T20:00 | 18:00–20:59 on BTC, ETH; 17:00–21:59 on SOL |

Consequences: the engine steps from the 12:00 bar straight to the next
00:00 bar on those days (bar-count indicators see 8 hours of price change in
one step); the CLI coverage line reads `2188/2191` and `4384/4387`, not 100 %.
Do not "repair" these gaps — regenerate from source if in doubt.

## How Strategies should invoke (from `atlas/apps/core-node`)

Always `pnpm exec tsx src/cli/backtest.ts …` — never `pnpm backtest -- --flags`
(pnpm forwards the `--` and yargs then treats every flag as positional). The
CLI flags are `--start-date` / `--end-date` (YYYY-MM-DD or ISO).

```bash
# 4H HOLDOUT — hard preflight / counted E[n] (12 months, pooled 3-symbol spot, long-only by venue)
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/4h/holdout-2025-03_2026-03 \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2025-03-01 --end-date 2026-03-01

# 4H TUNE — parameter fitting only (24 months)
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/4h/tune-2023-03_2025-03 \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2023-03-01 --end-date 2025-03-01

# 4H SMOKE — harness smoke only, NOT hard-preflight (August 2026 month-block)
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/4h/smoke-aug2026 \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2026-08-01 --end-date 2026-09-01

# 1D, 24 months
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/1d \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2024-09-01 --end-date 2026-08-31
```

Add the usual experiment flags (`--fee-tier`, `--commission`, `--slippage`,
`--ev-gate`, `--strategy`, …) as needed. Expected stdout / report header for
the holdout run:

```
DATA: REAL
Backtest Results:
=================
Data source BTC-USD: fixture bars=2188/2191 coverage=99.9% spacing=240m
Data source ETH-USD: fixture bars=2188/2191 coverage=99.9% spacing=240m
Data source SOL-USD: fixture bars=2188/2191 coverage=99.9% spacing=240m
Bar timeframe: 240 min (native stored bars)
```

- `spacing=240m` / `1440m` confirms the engine is stepping true 4h / 1d bars.
- `2188/2191` (holdout), `4384/4387` (tune), `186/187` (smoke): the `+1` is
  the inclusive end bound counting a would-be bar at `--end-date T00:00`; the
  remaining shortfall is the upstream gap above. Using `--end-date 2026-02-28`
  instead of `2026-03-01` silently **drops the last five 4h bars of Feb 28**
  (the loader keeps bars with `time <= end-date T00:00`) — use the month
  boundary.
- The loader judges coverage against the **fixture's declared bar width**
  (`granularitySeconds`), so no `--min-coverage` tweak is needed for 4h/1d.
- A symbol without a file in the directory, or a window the file does not
  cover, is `DATA_UNAVAILABLE` (exit 2). The loader never falls through to
  Supabase or synthetic data when `--fixture-dir` is set.

### Stamp discipline

Evidence requires `DATA: REAL` on line 1 of stdout and of the saved report,
plus `source=fixture` for every symbol. For hard preflight the data must also
be the holdout set: the JSON result's `dataProvenance.<SYMBOL>.fixturePath`
points into `4h/holdout-2025-03_2026-03/` and the per-symbol `sha256` printed
in the text report (`fixture=BTC-USD.json sha256=…`, first 12 hex) matches the
committed files:

| Holdout file | sha256 |
|---|---|
| `holdout-2025-03_2026-03/BTC-USD.json` | `f66050a9ea4a3d87964efb2bc1345fde2a08c3e018b2aa5ddf894984dee59c25` |
| `holdout-2025-03_2026-03/ETH-USD.json` | `4a8998b1a62cf0e8c311e0a244aadabe4300253817abe3dd921f5bdfbf29cfa5` |
| `holdout-2025-03_2026-03/SOL-USD.json` | `21abcfe17420dd8d0fd4f9ad13bc51c5a0460c9702d345eba0f70e0917cbcf15` |

(`fetchedAt` is part of the hash, so a regenerated file has a new sha256 even
when every candle is identical — update this table when regenerating.)

**Never** pass `--allow-synthetic` for an E4 / preflight run — any
`DATA: SYNTHETIC` output is SMOKE/VOID and is not evidence of anything. Never
commit synthetic output under `fixtures/`. A run on `smoke-aug2026/` is a
smoke even when it says `DATA: REAL`.

## 4h rollup — how the bars were derived (and why)

Coinbase's candle enum is `ONE_MINUTE | FIVE_MINUTE | FIFTEEN_MINUTE |
THIRTY_MINUTE | ONE_HOUR | TWO_HOUR | SIX_HOUR | ONE_DAY` — there is **no
FOUR_HOUR**. `SIX_HOUR` is not 4h and is never labelled as such. True 4h bars
are produced by fetching `ONE_HOUR` and aggregating offline with
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
| completeness | only buckets with all `bucketSeconds / sourceSeconds` (= 4) distinct source bars are written; partial buckets are dropped and counted in `rollup.bucketsDroppedIncomplete` (a bucket with **zero** source bars never forms and is not counted — hence 2190 − 2188 = 2 missing but `bucketsDroppedIncomplete: 1` on the holdout) |

Each 4h file records the derivation, e.g. the holdout:

```json
"granularity": "FOUR_HOUR",
"granularitySeconds": 14400,
"rollup": {
  "method": "utc-aligned-ohlcv",
  "sourceGranularity": "ONE_HOUR",
  "sourceGranularitySeconds": 3600,
  "bucketSeconds": 14400,
  "sourceBarsPerBucket": 4,
  "sourceBars": 8755,
  "bucketsEmitted": 2188,
  "bucketsDroppedIncomplete": 1,
  "rules": "bucket=floor(time/14400)*14400 (UTC); open=first, high=max, low=min, close=last, volume=exact decimal sum; complete buckets only"
}
```

`FOUR_HOUR` is a fixture label, not a Coinbase enum; it only appears together
with a `rollup` block.

### Verification performed at generation

Holdout + tune (2026-09-10):

- Internal consistency vs native daily: rolling the committed 4h files → 1d
  reproduced the native `ONE_DAY` files' **OHLC exactly** on all 364 complete
  holdout days × 3 symbols and on all 181 tune days the 1d set covers
  (2024-09-01 → 2025-02-28) × 3; volume within 0.08 %. These are unit tests
  now. (The 2025-10-25 and 2023-03-04 gap days are 4/6 buckets and are
  dropped by the 4h → 1d rollup, not compared.)
- Independent path: `FIFTEEN_MINUTE` fetched for both windows and rolled
  15m → 4h. Of the 19 696 buckets present in both paths, **19 669 (99.86 %)
  match the committed OHLC exactly**. The 27 that differ do so in one field
  each — 13 opens, 13 closes, 1 high, 0 lows — by ≤ 0.13 % (typically
  0.01–0.03 %), and 26 of the 27 are the close of one bucket / open of the
  next at an hour boundary. In every case Coinbase's own native `ONE_HOUR`
  candle disagrees with its own four `FIFTEEN_MINUTE` candles (re-queried
  directly; e.g. BTC-USD 2025-04-21T16:00Z hourly high 88322.07 vs max 15m
  high 88315.67). The committed values are the native `ONE_HOUR` aggregates —
  the series that also reproduces native `ONE_DAY` exactly.
- The 15m series has **more** holes upstream than the 1h series (e.g.
  2024-05-31T22:15–23:00Z and 2024-10-26T16:15–17:00Z on all three symbols,
  2025-04-25T07:30–07:45Z on ETH), so a 15m-sourced rollup would have dropped
  5–6 further buckets per tune symbol. `ONE_HOUR` is the right source.
- Gaps: re-queried the endpoint directly at `ONE_HOUR` and `FIFTEEN_MINUTE`
  around both holes — the candles do not exist upstream (table above).
- Regenerating both windows a second time returned byte-identical candles
  (Coinbase serves stable history for these dates).

Aug 2026 smoke (2026-09-10): 15m → 4h reproduced OHLC on all 186 × 3 buckets;
4h → 1d reproduced native 1d OHLC on all 31 × 3 days (unit test).

Cross-granularity caveat (upstream, not a rollup defect): Coinbase's own
series disagree across granularities on volume for a small share of hours —
e.g. BTC-USD 2026-08-28T23:00Z native `ONE_HOUR` volume 149.85 vs the sum of
Coinbase's own four `FIFTEEN_MINUTE` candles 161.05, with identical OHLC — and,
as above, on the boundary open/close of roughly 1 in 700 hours. The committed
4h volume is the exact sum of the native `ONE_HOUR` volumes. Do not build
volume-precise or tick-precise cross-TF logic on these files.

## Regenerate

```bash
cd atlas/apps/core-node

# --until is the LAST source (1h) bar of the block; the tool floors --since to
# the bucket and writes only complete 4h buckets.

# 4h HOLDOUT — 2025-03-01 → 2026-03-01 (12 months)
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2025-03-01 --until 2026-02-28T23:00:00Z \
  --granularity ONE_HOUR --rollup-minutes 240 --out-dir fixtures/bars/4h/holdout-2025-03_2026-03

# 4h TUNE — 2023-03-01 → 2025-03-01 (24 months)
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2023-03-01 --until 2025-02-28T23:00:00Z \
  --granularity ONE_HOUR --rollup-minutes 240 --out-dir fixtures/bars/4h/tune-2023-03_2025-03

# 4h SMOKE — August 2026 month-block
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2026-08-01 --until 2026-08-31T23:00:00Z \
  --granularity ONE_HOUR --rollup-minutes 240 --out-dir fixtures/bars/4h/smoke-aug2026

# 1d — native ONE_DAY, 24 months
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2024-09-01 --until 2026-08-31 \
  --granularity ONE_DAY --out-dir fixtures/bars/1d
```

Notes:

- Each run takes well under a minute (holdout ≈ 22 s, tune ≈ 45 s for the
  trio; ≤ 300 candles per request, 150 ms between pages).
- `--rollup-minutes` is fixtures-only; it refuses `--upsert` because
  `public.bars` holds native candles.
- The rollup accepts any `--granularity` that divides the bucket
  (`FIFTEEN_MINUTE --rollup-minutes 240` works too), and any bucket that
  divides the UTC day.
- Regenerating a window is expected to reproduce the committed OHLC exactly
  (`fetchedAt` will differ). If bar counts change, Coinbase back-filled or
  removed history — update the table above **and** the counts / gap lists in
  `src/__tests__/backtest-multi-tf-fixtures.test.ts` in the same PR.
- `--until` truncates to the source granularity; with `--rollup-minutes` a
  trailing partial bucket is dropped and reported (`… incomplete bucket(s)
  dropped`) rather than written.
- Adding a new window: new sibling directory `4h/<role>-<from>_<to>/`, one
  timeframe per directory, plus a row in the table and a test block.

## Rules

- Never hand-edit candle values. Regenerate instead.
- Never commit synthetic output here; never use `--allow-synthetic` for
  evidence (SMOKE/VOID).
- Hard preflight / counted E[n] reads `4h/holdout-2025-03_2026-03/` only.
  `4h/smoke-aug2026/` is SMOKE ONLY; `4h/tune-2023-03_2025-03/` is in-sample.
- One timeframe and one window per directory; do not put 4h and 1d files, or
  two windows, in the same `--fixture-dir`.
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
- Across the two documented 8h gaps the engine sees consecutive bars whose
  starts are 12 hours apart. Bar-count indicators do not notice; the ATR /
  return of the first post-gap bar absorbs the whole move across the hole.
