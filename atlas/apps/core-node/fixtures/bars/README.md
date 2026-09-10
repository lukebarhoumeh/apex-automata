# Bar fixtures (real Coinbase candles)

Committed OHLCV fixtures consumed by `pnpm backtest --fixture-dir fixtures/bars`
and the `backtest-gate` CI workflow. They exist so CI never depends on a
Supabase secret **or** on a silent synthetic fallback (TASK_017 B1).

| File | Symbol | Granularity | Window (UTC, inclusive) | Bars | Source |
|---|---|---|---|---|---|
| `BTC-USD.json` | BTC-USD | 15m (`FIFTEEN_MINUTE`) | 2026-09-03T00:00 → 2026-09-10T00:00 | 673 | Coinbase Advanced Trade public `GET /api/v3/brokerage/market/products/BTC-USD/candles` |
| `ETH-USD.json` | ETH-USD | 15m (`FIFTEEN_MINUTE`) | 2026-09-03T00:00 → 2026-09-10T00:00 | 673 | same endpoint, ETH-USD |

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
