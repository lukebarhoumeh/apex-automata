# 15m bar fixtures — E2-MOM-ISO holdout / tune windows

Real Coinbase spot `FIFTEEN_MINUTE` candles, **native** (no rollup), one
window per directory, for the E2-MOM-ISO experiment (Dev Strategies owns the
experiment; this directory only supplies data + the loader path).

This directory holds **no** fixture files itself; `--fixture-dir fixtures/bars/15m`
is `DATA_UNAVAILABLE` (exit 2) by design — a run has to name its window.

| `--fixture-dir` | Role | Symbols | Bars / symbol | Window (UTC, bar starts, inclusive) | Bar width |
|---|---|---|---|---|---|
| `fixtures/bars/15m/holdout-2025-03_2026-03` | **HOLDOUT — hard-preflight / counted path** (out-of-sample) | BTC-USD, ETH-USD, SOL-USD | **35017** BTC · **35015** ETH · **35017** SOL (of 35040 slots) | 2025-03-01T00:00 → 2026-02-28T23:45 (12 months) | 15m (`FIFTEEN_MINUTE`, 900 s) |
| `fixtures/bars/15m/tune-2023-03_2025-03` | **TUNE** — parameter fitting only; never out-of-sample evidence | BTC-USD, ETH-USD, SOL-USD | **70147** BTC · **70148** ETH · **70144** SOL (of 70176 slots) | 2023-03-01T00:00 → 2025-02-28T23:45 (24 months) | 15m |

- **Holdout vs tune.** Fit on `tune-2023-03_2025-03/`, count on
  `holdout-2025-03_2026-03/`, never the other way round. A number produced
  on the tune window is in-sample and must not be reported as E[n] evidence
  or feed a go/no-go. The two windows are **adjacent and disjoint**: the last
  tune bar is 2025-02-28T23:45, the first holdout bar is 2025-03-01T00:00
  (asserted by `src/__tests__/backtest-15m-window-fixtures.test.ts`).
- **The 7-day gate set is a different thing.** `fixtures/bars/BTC-USD.json`
  and `fixtures/bars/ETH-USD.json` (15m, 2026-09-03 → 2026-09-10, 673 bars)
  belong to the `backtest-gate` CI workflow and **stay CI-only**. They are
  not part of this set, are not a holdout, and must not be overwritten when
  regenerating these windows (different `--out-dir`). Conversely the CI gate
  never reads `15m/…` — it is far too large for a 15-minute PR check.
- **Never `--allow-synthetic`.** Any `DATA: SYNTHETIC` output is SMOKE/VOID
  and is not evidence of anything. Never commit synthetic output under
  `fixtures/`. Never hand-edit OHLC — regenerate from source instead.
- 4h and 1d sets for E4 live in `../4h/` and `../1d/` and are documented in
  [`../MULTI_TF.md`](../MULTI_TF.md); this set does not touch them.

Source: Coinbase Advanced Trade **public** market-data endpoint (no auth) —
`GET https://api.coinbase.com/api/v3/brokerage/market/products/{SYMBOL}/candles`,
`granularity=FIFTEEN_MINUTE`, paged 300 candles per request. Every file
records `source`, `endpoint`, `fetchedAt`, `granularity` (`FIFTEEN_MINUTE`),
`granularitySeconds` (900), `start`, `end`; there is no `rollup` block
because the bars are native. Format: `BarFixtureFile` in
`src/backtesting/data-loader.ts` — `candles[].time` is epoch **seconds**.

Every series is UTC-aligned (`time % 900 == 0`), strictly increasing,
de-duplicated, OHLC-sane (`low ≤ min(open, close)`, `high ≥ max(open, close)`,
`volume > 0`) and contiguous at 900 s **except** for the upstream holes in
the next section. Nothing was thinned and no hole was filled.

## Upstream Coinbase gaps (real, not fetch defects)

Coinbase's own public 15m series has no candle at these bar starts — each
range was re-queried directly against the endpoint after generation and the
candles do not exist upstream (BTC-USD returns the full 2025-04-25 07:00–08:00
hour, for example, while ETH-USD returns 07:00, 07:15, 08:00 only). The
fixtures reproduce the holes as-is; the engine steps straight from the bar
before a hole to the bar after it. The unit test asserts the set of holes
found equals exactly this list, so an undocumented hole (or a silently
filled one) fails the suite.

### `holdout-2025-03_2026-03/` — 23 / 25 / 23 slots missing of 35040

| Missing bar starts (UTC, inclusive) | Bars | Symbols |
|---|---|---|
| 2025-04-25T07:30 → 07:45 | 2 | ETH-USD only |
| 2025-10-25T15:15 → 20:45 | 23 | BTC-USD, ETH-USD, SOL-USD |

The 2025-10-25 hole is the same exchange outage that removes the 16:00 and
20:00 4h buckets from `../4h/holdout-2025-03_2026-03/` (its `ONE_HOUR`
series is missing 16:00–20:59; the 15m series is missing 15:15–20:45).

### `tune-2023-03_2025-03/` — 29 / 28 / 32 slots missing of 70176

| Missing bar starts (UTC, inclusive) | Bars | Symbols |
|---|---|---|
| 2023-03-04T17:00 → 21:15 | 18 | BTC-USD |
| 2023-03-04T17:15 → 21:15 | 17 | ETH-USD |
| 2023-03-04T17:00 → 21:45 | 20 | SOL-USD |
| 2023-05-19T07:45 → 08:00 | 2 | BTC-USD, ETH-USD, SOL-USD |
| 2024-02-09T21:45 | 1 | BTC-USD, ETH-USD, SOL-USD |
| 2024-05-31T22:15 → 23:00 | 4 | BTC-USD, ETH-USD, SOL-USD |
| 2024-10-26T16:15 → 17:00 | 4 | BTC-USD, ETH-USD, SOL-USD |
| 2024-12-09T07:00 | 1 | SOL-USD only |

The 2023-03-04 hole is the outage behind the two missing 4h buckets in
`../4h/tune-2023-03_2025-03/`. The five short holes (1–4 bars) have no
`ONE_HOUR` counterpart — Coinbase's 15m series has more holes than its 1h
series (already noted in `MULTI_TF.md`) — so a 15m run sees a few more
skipped steps than the 4h run over the same months.

## How Strategies should invoke (from `atlas/apps/core-node`)

Always `pnpm exec tsx src/cli/backtest.ts …` — never `pnpm backtest -- --flags`
(pnpm forwards the `--` and yargs then treats every flag as positional). Use
the **month boundary** as `--end-date`: the loader keeps bars with
`time <= end-date T00:00`, so `--end-date 2026-02-28` would silently drop the
95 bars of Feb 28 after midnight.

```bash
# 15m HOLDOUT — hard preflight / counted path (12 months, pooled 3-symbol spot, long-only by venue)
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/15m/holdout-2025-03_2026-03 \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2025-03-01 --end-date 2026-03-01

# 15m TUNE — parameter fitting only (24 months)
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/15m/tune-2023-03_2025-03 \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2023-03-01 --end-date 2025-03-01
```

Add the usual experiment flags (`--fee-tier`, `--commission`, `--slippage`,
`--ev-gate`, `--strategy`, …) as needed. Expected stdout / report header for
the holdout run (verified at generation; the run itself takes ≈ 3–4 minutes
for the 105k-bar trio at the default strategy set):

```
DATA: REAL
Backtest Results:
=================
Data source BTC-USD: fixture bars=35017/35041 coverage=99.9% spacing=15m
Data source ETH-USD: fixture bars=35015/35041 coverage=99.9% spacing=15m
Data source SOL-USD: fixture bars=35017/35041 coverage=99.9% spacing=15m
Bar timeframe: 15 min (native stored bars; no aggregation)
```

and for the tune run:

```
DATA: REAL
Backtest Results:
=================
Data source BTC-USD: fixture bars=70147/70177 coverage=100.0% spacing=15m
Data source ETH-USD: fixture bars=70148/70177 coverage=100.0% spacing=15m
Data source SOL-USD: fixture bars=70144/70177 coverage=100.0% spacing=15m
Bar timeframe: 15 min (native stored bars; no aggregation)
```

- `spacing=15m` and `Bar timeframe: 15 min (native stored bars; no
  aggregation)` confirm the engine is stepping true native 15m bars.
- `35041` / `70177`: the `+1` is the inclusive end bound counting a would-be
  bar at `--end-date T00:00`, which is not in the file; the remaining
  shortfall is the upstream gaps above. Coverage is `99.9 %` / `100.0 %` at
  the CLI's one-decimal rounding, well above the loader's 50 % floor, so no
  `--min-coverage` tweak is needed.
- A symbol without a file in the directory, or a window the file does not
  cover, is `DATA_UNAVAILABLE` (exit 2). The loader never falls through to
  Supabase or synthetic data when `--fixture-dir` is set.

### Stamp discipline

Evidence requires `DATA: REAL` on line 1 of stdout and of the saved report,
plus `source=fixture` for every symbol. For the hard-preflight / counted path
the data must also be the holdout set: the JSON result's
`dataProvenance.<SYMBOL>.fixturePath` points into
`15m/holdout-2025-03_2026-03/` and the per-symbol `sha256` printed in the
text report (`fixture=BTC-USD.json sha256=…`, first 12 hex) matches the
committed files:

| File | sha256 |
|---|---|
| `holdout-2025-03_2026-03/BTC-USD.json` | `17f367b6965d548358ec3fcf99d752916f405e5bb96780d18e9f3e464640574d` |
| `holdout-2025-03_2026-03/ETH-USD.json` | `d0f8d5464ae5d8d87431218f83c6af675577484df828b5022250b8e239633476` |
| `holdout-2025-03_2026-03/SOL-USD.json` | `ce3d1dba82b617013fa39ca057593df958ebfae386efb0d3b179c050c4fb4494` |
| `tune-2023-03_2025-03/BTC-USD.json` | `8eeb1778c6df3ea0da6f083184b2bc505d898121741ebdab4fb05292255392b6` |
| `tune-2023-03_2025-03/ETH-USD.json` | `f9b04254fbd3b627b8dc29f3066e67197d1dd5e4a8af0855d18ed7706b2c8418` |
| `tune-2023-03_2025-03/SOL-USD.json` | `b557cacd66676d7d8ad55de0c1f9b55860b5325bc80d78bd47040a0e767ec62d` |

(`fetchedAt` is part of the hash, so a regenerated file has a new sha256 even
when every candle is identical — update this table when regenerating.)

## Verification performed at generation (2026-09-11)

- **Structure:** all six files pass the gap script (UTC-aligned, no
  duplicates, no OHLC violations, no zero-volume bars); every hole found is
  in the tables above and was re-queried upstream.
- **Independent path vs the committed 4h sets:** rolling these 15m files →
  4h with `rollupCandles` (`src/cli/backtest-backfill.ts`) and comparing
  with `../4h/<window>/` (which were rolled from native `ONE_HOUR`) matches
  OHLC exactly on **6552 / 6560** holdout buckets (99.88 %) and
  **13117 / 13136** tune buckets (99.86 %) — 19669 / 19696 combined, the same
  figures MULTI_TF.md recorded from its own 15m pass, i.e. Coinbase served
  byte-identical history. Every one of the 27 differing buckets differs in
  one field by ≤ 0.13 % and is the known upstream disagreement between
  Coinbase's native `ONE_HOUR` and its own four `FIFTEEN_MINUTE` candles at
  an hour boundary (e.g. BTC-USD 2025-04-21T16:00Z high 88322.07 in 1h vs
  88315.67 in 15m). Neither series was edited.
- **vs native daily:** rolling 15m → 1d reproduces the native `ONE_DAY`
  fixtures' OHLC **exactly** on every complete day both sets cover —
  364 / 363 / 364 holdout days (BTC / ETH / SOL) and 180 / 180 / 179 of the
  tune days in `../1d/` (which starts 2024-09-01). Gap days are incomplete
  and dropped by the rollup, not compared. This is a unit test now.
- **CLI:** both windows run end-to-end through `src/cli/backtest.ts` with the
  headers shown above, exit 0.

Caveat (upstream, not a fixture defect): Coinbase's own series disagree
across granularities on the boundary open/close of roughly 1 in 700 hours
and on volume for a small share of hours (see `MULTI_TF.md`). Do not build
tick-precise cross-TF logic on these files.

## Regenerate

```bash
cd atlas/apps/core-node

# --until is the LAST 15m bar of the block (23:45 of the last day), so the
# file stops at the month boundary and stays disjoint from the next window.

# 15m HOLDOUT — 2025-03-01 → 2026-03-01 (12 months; ≈ 30 s / symbol)
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2025-03-01 --until 2026-02-28T23:45:00Z \
  --granularity FIFTEEN_MINUTE --out-dir fixtures/bars/15m/holdout-2025-03_2026-03

# 15m TUNE — 2023-03-01 → 2025-03-01 (24 months; ≈ 60 s / symbol)
pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD \
  --since 2023-03-01 --until 2025-02-28T23:45:00Z \
  --granularity FIFTEEN_MINUTE --out-dir fixtures/bars/15m/tune-2023-03_2025-03
```

Notes:

- Native fetch only — no `--rollup-minutes`. Files are ≈ 4.7–5.0 MB
  (holdout) and ≈ 9.1–9.9 MB (tune) each; that is the price of 12 / 24
  months of real 15m bars and is intentional (no thinning).
- Regenerating a window is expected to reproduce the committed candles
  exactly (`fetchedAt` will differ). If bar counts change, Coinbase
  back-filled or removed history — update the tables above **and** the
  counts / gap lists in `src/__tests__/backtest-15m-window-fixtures.test.ts`
  in the same PR.
- Adding a new window: new sibling directory `15m/<role>-<from>_<to>/`, one
  window per directory, plus a row in the table and a test block.

## Rules

- Never hand-edit candle values. Regenerate instead.
- Never commit synthetic output here; never use `--allow-synthetic` for
  evidence (SMOKE/VOID).
- Hard preflight / counted path reads `15m/holdout-2025-03_2026-03/` only;
  `15m/tune-2023-03_2025-03/` is in-sample.
- One window per directory; do not put two windows or two timeframes in the
  same `--fixture-dir`.
- Leave the 7d gate fixtures (`fixtures/bars/*.json`),
  `.github/workflows/backtest-gate.yml`, and the `4h/` / `1d/` sets alone
  when touching this set.
