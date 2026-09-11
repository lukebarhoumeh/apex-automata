# Bar fixtures (real Coinbase candles)

Committed OHLCV fixtures consumed by `pnpm backtest --fixture-dir fixtures/bars`
and the `backtest-gate` CI workflow. They exist so CI never depends on a
Supabase secret **or** on a silent synthetic fallback (TASK_017 B1).

| File | Symbol | Granularity | Window (UTC, inclusive) | Bars | Source |
|---|---|---|---|---|---|
| `BTC-USD.json` | BTC-USD | 15m (`FIFTEEN_MINUTE`) | 2026-09-03T00:00 → 2026-09-10T00:00 | 673 | Coinbase Advanced Trade public `GET /api/v3/brokerage/market/products/BTC-USD/candles` |
| `ETH-USD.json` | ETH-USD | 15m (`FIFTEEN_MINUTE`) | 2026-09-03T00:00 → 2026-09-10T00:00 | 673 | same endpoint, ETH-USD |

Multi-timeframe sets for E4 experiments (BTC, ETH, SOL) live in
subdirectories and are documented in [`MULTI_TF.md`](./MULTI_TF.md); they are
not read by the gate:

- `4h/holdout-2025-03_2026-03/` — 12-month 4h **holdout**; the hard-preflight
  source of truth for counted E[n].
- `4h/tune-2023-03_2025-03/` — 24-month 4h **tune** window (in-sample only).
- `4h/tune-2019-01_2023-03/` — 50-month deep-history 4h **tune** window
  (BTC-USD + ETH-USD only; in-sample only), adjacent to the 2023 tune.
- `4h/smoke-aug2026/` — August 2026 4h month-block, **SMOKE ONLY — not
  hard-preflight**.
- `1d/` — 24-month native daily bars; the loose files are the **sealed
  HO-H1-DAILY** source (do not regenerate in place — see
  [`1d/README.md`](./1d/README.md)).
- `1d/tune-2017-01_2025-03/` — 98-month deep-history native daily **tune**
  window (BTC-USD + ETH-USD only; in-sample only), ending the day before
  the sealed holdout window.
- `1d/btc-eth-2017_plus/` — **full** native daily series 2017-01-01 →
  present (last complete UTC day; BTC-USD + ETH-USD only). Research /
  continuity — it contains the holdout months, so it is not counted
  evidence; the sealed `1d/` files remain the HO-H1-DAILY source.

Long 15m windows for E2-MOM-ISO (BTC, ETH, SOL; native `FIFTEEN_MINUTE`, no
rollup) live in `15m/` and are documented in [`15m/README.md`](./15m/README.md);
they are **not** read by the gate either — the 7d files above stay CI-only:

- `15m/holdout-2025-03_2026-03/` — 12-month 15m **holdout**; hard-preflight /
  counted path for E2-MOM-ISO.
- `15m/tune-2023-03_2025-03/` — 24-month 15m **tune** window (in-sample only).

Format: `BarFixtureFile` (`src/backtesting/data-loader.ts`) — `candles[].time`
is epoch **seconds**, matching the `public.bars` convention. Each file records
`fetchedAt`, `endpoint` and `source` for provenance; the loader logs the file
sha256 into the report.

## Regenerate / extend

```bash
cd atlas/apps/core-node
pnpm backtest:backfill --products BTC-USD,ETH-USD \
  --since 2026-09-03 --until 2026-09-10 \
  --granularity FIFTEEN_MINUTE --out-dir fixtures/bars
```

If you move the window, update `FIXTURE_START` / `FIXTURE_END` in
`.github/workflows/backtest-gate.yml` in the same PR.

## Rules

- Never hand-edit candle values.
- Never commit synthetic output here. Synthetic candles are only produced
  behind `--allow-synthetic` and are stamped `DATA: SYNTHETIC` (SMOKE/VOID).
- A fixture that does not cover the requested window is `DATA_UNAVAILABLE`
  — the loader does not fall through to Supabase or synthetic data.
