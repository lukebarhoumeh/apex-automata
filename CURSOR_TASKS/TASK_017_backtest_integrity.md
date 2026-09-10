# TASK_017: Backtest Integrity — no synthetic data, spot long-only, EV gate parity, equity-based sizing, bar aggregation

**Priority:** P1 — blocks every strategy claim (Stage 2 Door A, Stage 3)
**Status:** PENDING
**Depends on:** TASK_012 (venue capability / long-only semantics)
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 3
**Skills:** `strategy-research` · **Subagents:** `backtest-runner`, `quant-skeptic` (review)

---

## Context (quant audit 2026-09-10)

| # | Defect | Evidence | Consequence |
|---|---|---|---|
| B1 | **Silent synthetic fallback.** Loader tries Supabase → exchange API → `generateSyntheticData` with only a warning | `backtesting/data-loader.ts:102-145`, `:357` | All `*-PERP-INTX` runs (R14, R18–R20, R26) used random-walk prices (BTC-PERP ≈ 52K when BTC-USD ≈ 90K). F4-follow-up perps decisions and the perps share of H6/A6 are unreliable |
| B2 | **Spot backtests take shorts** (~40% of sampled spot trades are SELL entries) | report trade logs vs `server.ts:1914-1915` | Backtest ≠ live on spot |
| B3 | **EV gate not in backtest** (R07/R08 identical trade sets across 8.9× fee change) | `trading/risk/ev-gate.ts` only called from `server.ts:2252` | Fee-aware filtering unmeasured |
| B4 | **Sizing equity fixed at initial capital** | `backtest-engine.ts:869` | R09 max DD 112% |
| B5 | `--slippage` flag unused; hold-time metric broken (negative avg in R22) | `cli/backtest.ts`, report R22 | Misleading reports |
| B6 | No timeframe flag; bars table has no timeframe column; AT client maps unsupported granularities (e.g. 4H) silently to ONE_MINUTE | `advanced-trade-client.ts:551-558`, `20260305015154_create_bars_table.sql` | Can't test the frequency lever |
| B7 | Dead config: `strategy.stop_trail_atr`, `time_stop_bars` unused by builtin plugins | `guardrails.yaml` | Exit logic narrower than configured |

## IMPORTANT CONSTRAINTS

1. Default must **fail** on missing data: throw `DATA_UNAVAILABLE` naming symbol + window. Synthetic data only behind explicit `--allow-synthetic` and every report stamps `DATA: SYNTHETIC` on line 1.
2. Parity with live semantics from TASK_012 (venue capability drives shorting).
3. Reports must print: data source per symbol, bar timeframe, fee bps/side used, long/short split, EV-gate rejects, regime-gate state.
4. No new deps.

## Steps

1. Loader: fail-closed + provenance (`source: supabase|exchange|synthetic`, candle count vs expected).
2. `--venue spot|perps` (default from symbol) → capability-driven shorting; spot SELL = exit-only.
3. Call `evaluateEvGate` in `backtest-engine` using the same FeeModel + p estimator as live (TASK_011 Beta prior); `--ev-gate enforce|shadow|off` (default `enforce`).
4. Size from current equity (`initialCapital + realized`), keep exposure cap semantics identical to live.
5. `--bar-minutes <15|60|240|1440>`: aggregate from stored 15m bars (OHLCV rollup, UTC-aligned); rescale bar-count params (EMA/RSI/ATR periods stay in *bars* of the aggregated TF; document).
6. Fix hold-time metric; remove or implement `--slippage`.
7. `--fee-tier intro1|t1k|t10k|custom:<maker>,<taker>` → maps to 60/120, 35/75, 25/40 bps; default `t10k` for back-compat but reports must print it.
8. Backfill script: `pnpm backtest:backfill --products BTC-USD,ETH-USD,SOL-USD --since 2023-01-01 --granularity FIFTEEN_MINUTE` into `bars` (idempotent upsert on `(symbol,time,exchange)`).

## Tests

1. Missing bars ⇒ throws `DATA_UNAVAILABLE` (no synthetic) unless `--allow-synthetic`.
2. Spot run produces zero short entries.
3. EV gate in backtest rejects a known negative-EV fixture at 120 bps and allows at 0 bps.
4. 15m→60m rollup equals hand-computed OHLCV fixture.
5. Sizing uses current equity after a loss.

## Acceptance Criteria

- [ ] Tests green; `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 017` PASS
- [ ] Re-run baseline (`strategy-research` skill, experiment E1) and record in `docs/research/<date>_e1-parity-baseline.md`
- [ ] `quant-skeptic` review of the E1 doc
