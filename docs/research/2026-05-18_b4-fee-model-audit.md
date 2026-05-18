# B4 — FeeModel / Paper-Mode Perps Fee Routing Audit

**Date:** 2026-05-18
**Commit:** `2041ba46093ca5e91bef1d40daff616870f01f43` (main)

## TL;DR

**The original B4/B5 bug is already fixed on main.** Commit `402e757` ("fix(fees): route perps trades to coinbase.perps_intx tier", PR #15, merged 2026-05-14) refactored `PaperTradingSimulator` to resolve fees per-fill via `FeeModel.getFeeRate(venue, market, side)`. Paper-mode ETH-PERP-INTX fills now correctly charge 5 bps (perps_intx) instead of 40 bps (spot). 7 simulator tests anchor this in `__tests__/paper-trading-simulator.test.ts`.

**Residual scope (the "B4 cleanup" PR #15's commit message explicitly deferred):**
- 3 exchange-adapter files still hardcode fees instead of consulting `FeeModel` (consumed by `AdapterMarketInfo` / UI cost-estimate surfaces, not fills — bug is cosmetic but contradicts the "FeeModel is single source of truth" invariant).
- **`BacktestConfig.commission` is a single flat decimal** — `backtest-engine.ts` has no per-symbol fee routing. F4 (HL backtest with perp symbols) cannot be considered correct until this is fixed. **This is the new pre-F4 blocker.**

## Fee resolution path — paper-mode ETH-PERP-INTX market buy (post-fix, current main)

| Hop | File:line | What happens |
|---|---|---|
| Order built | `trading-engine.ts:1493-1556` | `createOrder` — no `venue` field; perp-ness inferred from `XXX-PERP-INTX` symbol pattern |
| Order routed | `trading-engine.ts:1517-1556` | Paper mode forwards every order (spot + perp) to the single `paperSimulator.placeOrder(...)`. No spot/perps adapter split. |
| Fill simulated | `paper-trading-simulator.ts:545-606` | `executeMarketOrder` calls `resolveFeeRate(order.productId, 'taker')` at line 567 |
| Fee resolved | `paper-trading-simulator.ts:151-167` | `resolveFeeRate` → `feeModel.getFeeRate('coinbase', marketForSymbol(symbol), side)`. `marketForSymbol` (lines 136-138) returns `'perps'` for any symbol containing `-PERP-`. |
| Rate looked up | `core/fee-model.ts:74` | `coinbase.perps_intx.taker_bps = 5` → `0.0005` |
| Fee computed | `paper-trading-simulator.ts:578` | `fee = size * price * 0.0005` |

Hypothesis (a) — "paper-mode router sends perps through spot adapter" — **rejected**. There is no separate spot adapter in the paper path; all orders go through one simulator.

Hypothesis (b) — "FeeModel hardcoded a single Coinbase-style rate" — **confirmed historically; already fixed.** Pre-`402e757`, `PaperTradingSimulator` stored a single `(makerFee, takerFee)` decimal pair populated from `FeeModel.getFeeRate('coinbase', 'spot', taker)` at construction time — applied to every fill regardless of symbol.

## `guardrails.yaml.fees` consumption map

| Key | Value | Read sites | Status |
|---|---:|---|---|
| `fees.coinbase.spot.maker_bps` | 25 | `core/fee-model.ts:73` | LIVE |
| `fees.coinbase.spot.taker_bps` | 40 | `core/fee-model.ts:73`, `cli/backtest.ts:19` (`--commission` default) | LIVE |
| `fees.coinbase.perps_intx.maker_bps` | 0 | `core/fee-model.ts:74` | LIVE |
| `fees.coinbase.perps_intx.taker_bps` | 5 | `core/fee-model.ts:74` | LIVE |
| `fees.hyperliquid.perps.maker_bps` | -1.5 | `core/fee-model.ts:77` | LIVE (no caller routes `venue='hyperliquid'` through FeeModel yet) |
| `fees.hyperliquid.perps.taker_bps` | 4.5 | `core/fee-model.ts:77` | LIVE |

`FeeModel.fromGuardrails(...)` is loaded by: `trading-engine.ts:163` (RuntimeConfig, currently unused), `trading-engine.ts:1190` (live paper simulator), `cli/backtest.ts:18-19`, `adapter-factory.ts:91`, `paper-adapter.ts:118`, `coinbase-live-adapter.ts:75`.

## DEAD / duplicate fee config

- `guardrails.yaml:175-192` — `perps.maker_fee` (0), `perps.taker_fee` (0.0003 = 3 bps; stale vs YAML perps_intx.taker_bps = 5). Loaded into `PerpsRiskMonitor` via `api/server.ts:1217-1218` and `trading/perps/types.ts:20-22`. **`trading/perps/perps-risk-monitor.ts` never references `makerFee/takerFee`** — values are dropped on the floor.
- `guardrails.yaml:338-339` — `hyperliquid.maker_fee` (0.0002), `hyperliquid.taker_fee` (0.0005). Loaded by `loadGuardrails.ts:168-169`; **no read sites** in `atlas/apps/core-node/src`.

Both safe to mark `@deprecated` or delete in a housekeeping PR.

## Residual hardcoded fee sites (the deferred "B4 cleanup")

| File:line | Hardcoded value | Feeds | Bias vs YAML |
|---|---|---|---|
| `exchanges/coinbase-perps-adapter.ts:223-224` | `makerFee:'0.0000'`, `takerFee:'0.0003'` | `AdapterMarketInfo` (UI cost-estimate) | Stale — YAML says 5 bps, hardcode says 3 |
| `exchanges/coinbase-adapter.ts:286-287` | `makerFee:'0.004'`, `takerFee:'0.006'` | `AdapterMarketInfo` (UI cost-estimate) | YAML says 25/40 bps; hardcode says 40/60 |
| `exchanges/hyperliquid/index.ts:528-529` | `makerFee:'0.0002'`, `takerFee:'0.0005'` | `AdapterMarketInfo` (UI cost-estimate) | YAML says -1.5 maker (rebate) / 4.5 taker; hardcode loses rebate sign + 0.5 bps |

These do **not** bias paper-EV (fill path goes through `PaperTradingSimulator`, not `AdapterMarketInfo`). They DO contradict the "FeeModel is single source of truth" doc comment at `fee-model.ts:1-7` and will diverge over time.

## Structural latent defect — pre-F4 blocker

`backtesting/backtest-engine.ts:71,658,785` — `BacktestConfig.commission: number` is one flat decimal applied to every fill. `cli/backtest.ts:19` defaults it to `coinbase.spot.taker`. F3 ran spot-only so unaffected, but **F4 must not run on a `--products` list mixing spot + perps without first refactoring the backtest engine to take a `FeeModel` instead of a flat number.** Mixed runs would silently apply spot rates to perp legs (or vice versa) — reproducing the very bug `402e757` fixed in the paper path.

Estimate: M, +50-80 LOC. New `BacktestConfig.feeModel: FeeModel` field; replace flat-`commission` reads in `backtest-engine.ts:658,785` with per-fill `feeModel.getFeeRate(venue, marketForSymbol(symbol), side)`. CLI keeps `--commission` as an override for sensitivity analysis.

`execution/execution-adapter.ts:304-327` — `STRUCTURAL_DEFAULTS` lists only spot symbols; `ProductSpec` carries one `(makerFee, takerFee)` pair per symbol with no perp/spot distinction. `createAdapters` (`trading-engine.ts:22`) is imported but never called — if `PaperExecutionAdapter` is ever wired into the engine without first refactoring `ProductSpec`, perps silently inherit spot fees (same bug, second time).

## Recommended fix shape — residual B5

**Option A (S-M, ~30-40 LOC) — wire FeeModel into the 3 adapter sites:**

| File | Edit |
|---|---|
| `coinbase-perps-adapter.ts:211-228` | Inject `FeeModel` via constructor; replace hardcoded fees with `feeModel.getFeeRate('coinbase','perps',side).toString()`. |
| `coinbase-adapter.ts:277-289` | Same pattern with `('coinbase','spot',side)`. |
| `hyperliquid/index.ts:520-532` | Same pattern with `('hyperliquid','perps',side)`. Preserves the -1.5 maker rebate sign. |

Plumbing: pass `feeModel` through `ExchangeRegistry` / `multi-exchange-connector.ts` constructors (~10 LOC).

**New test file** `atlas/apps/core-node/src/__tests__/adapter-fee-routing.test.ts` — three tests asserting `parseFloat(adapter.getMarketInfo(sym).takerFee) === FeeModel(testFees).getFeeRate(venue, market, 'taker')`.

**New engine-level integration test** in `__tests__/trading-engine-lifecycle.test.ts`: drive `engine.createOrder({ product_id: 'ETH-PERP-INTX', ... })` end-to-end; assert `parseFloat(fill.fee) / (size*price) ≈ 0.0005`. Today only the simulator-in-isolation is tested.

**Option B (M, +50-80 LOC, blocks F4) — backtest engine per-symbol fee routing:**

Replace `BacktestConfig.commission: number` with `BacktestConfig.feeModel: FeeModel`; route per-fill via `feeModel.getFeeRate(venue, marketForSymbol(symbol), side)`. Keep `--commission` CLI flag as an override for sensitivity analysis.

**Optional housekeeping** — delete or `@deprecated`-mark `guardrails.yaml:175-192` and `:338-339`.

## Blast radius

| Surface | Biased pre-fix? | Magnitude RT | Notes |
|---|---|---|---|
| Live paper engine, perps, since `402e757` (2026-05-14) | No | 0 | Fixed; 7 simulator tests anchor it |
| Live paper engine, perps, **before** 2026-05-14 | **Yes** | ~+70 bps RT (~8× over-charge) | Stored Supabase rows have `fees` ~8× too high, `realized_pnl` correspondingly too negative |
| Backtest with perp symbol in `--products` | **Yes** | ~+70 bps RT on perp legs | No per-symbol routing — F3 ran spot only so unaffected; F4 must fix this first |
| `AdapterMarketInfo` consumers (UI cost-estimate) | Yes, mild | 1-20 bps | Not fill-path |
| `coinbase-perps-adapter.getMarketInfo()` consumers | Yes | UI cost-estimate −2 bps taker | Not fill-path |
| `coinbase-adapter.mapProduct()` consumers | Yes | UI cost-estimate +20/+20 bps spot | Not fill-path |
| `hyperliquid/index.ts.refreshMarketCache` consumers | Yes (sign flip) | Loses maker rebate; +0.5 bps taker | Inert until HL kill switch flips |
| Live Coinbase trading | No | 0 | Uses venue-reported `fill_fees` from `coinbase/rest-client.ts:234,273` |
| `PerpsRiskMonitor` decisions | No | 0 | Receives but never reads fee fields |

**Pre-2026-05-14 Supabase data backfill** — a one-time re-stamp of `fees` and `realized_pnl` on pre-fix perp rows is worth filing as a separate task; out of scope for the residual B5 PR.

## References

- Commit `402e757` — `git show 402e757` for the canonical fix diff and commit message that names the deferred B4 cleanup.
- `core/fee-model.ts:49-87` — `FeeModel.getFeeRate` (correct implementation; not the bug location).
- `paper-trading-simulator.ts:151-167` — `resolveFeeRate` (post-fix fill path).
- `__tests__/paper-trading-simulator.test.ts` — 7 tests covering perps fee routing.
