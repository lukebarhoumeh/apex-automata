# 4h fixtures — one window per directory

This directory holds **no** fixture files itself; `--fixture-dir fixtures/bars/4h`
is `DATA_UNAVAILABLE` by design. Pass one of the window directories:

| `--fixture-dir` | Role | Window (UTC) | Bars / symbol |
|---|---|---|---|
| `fixtures/bars/4h/holdout-2025-03_2026-03` | **HOLDOUT — hard-preflight source of truth** (counted E[n]) | 2025-03-01 → 2026-03-01 | 2188 |
| `fixtures/bars/4h/tune-2023-03_2025-03` | **TUNE** — parameter fitting only, in-sample | 2023-03-01 → 2025-03-01 | 4384 |
| `fixtures/bars/4h/smoke-aug2026` | **SMOKE / SCREEN ONLY — not hard-preflight** (Algo Creator veto) | 2026-08-01 → 2026-09-01 | 186 |

All three: BTC-USD, ETH-USD, SOL-USD; real Coinbase Advanced Trade public
`ONE_HOUR` candles rolled up offline to UTC-aligned 4h bars (complete buckets
only). Never `--allow-synthetic` for evidence. Full details, upstream gaps,
invocation and regeneration commands: [`../MULTI_TF.md`](../MULTI_TF.md).
