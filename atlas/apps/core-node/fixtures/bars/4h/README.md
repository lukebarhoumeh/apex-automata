# 4h fixtures — one window per directory

This directory holds **no** fixture files itself; `--fixture-dir fixtures/bars/4h`
is `DATA_UNAVAILABLE` by design. Pass one of the window directories:

| `--fixture-dir` | Role | Window (UTC) | Bars / symbol |
|---|---|---|---|
| `fixtures/bars/4h/holdout-2025-03_2026-03` | **HOLDOUT — hard-preflight source of truth** (counted E[n]) | 2025-03-01 → 2026-03-01 | 2188 |
| `fixtures/bars/4h/tune-2023-03_2025-03` | **TUNE** — parameter fitting only, in-sample | 2023-03-01 → 2025-03-01 | 4384 |
| `fixtures/bars/4h/tune-2019-01_2023-03` | **TUNE (deep history)** — parameter fitting only, in-sample; **BTC-USD + ETH-USD only** | 2019-01-01 → 2023-03-01 | 9114 BTC · 9116 ETH |
| `fixtures/bars/4h/smoke-aug2026` | **SMOKE ONLY — not hard-preflight** (Algo Creator veto) | 2026-08-01 → 2026-09-01 | 186 |

Holdout, 2023 tune and smoke: BTC-USD, ETH-USD, SOL-USD; the 2019 tune is
BTC-USD + ETH-USD (no SOL file — `SOL-USD` there is `DATA_UNAVAILABLE`). All
are real Coinbase Advanced Trade public `ONE_HOUR` candles rolled up offline
to UTC-aligned 4h bars (complete buckets only). The two tune windows are
adjacent (2023-02-28T20:00 → 2023-03-01T00:00) and both end before the
holdout. Never `--allow-synthetic` for evidence. Full details, upstream
gaps, invocation and regeneration commands: [`../MULTI_TF.md`](../MULTI_TF.md).
