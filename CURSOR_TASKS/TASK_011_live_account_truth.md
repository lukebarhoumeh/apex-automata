# TASK_011: Live Account Truth — equity, fee tier, product specs, preflight on Advanced Trade

**Priority:** P0
**Status:** PENDING
**Depends on:** TASK_010 (hardened `AdvancedTradeRestClient`)
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 0
**Skills:** `coinbase-advanced-trade`, `live-preflight` · **Review subagent:** `risk-guardian`

---

## Context

In live mode the engine currently sizes from yaml, not from the account:

- `runLivePreflight` reads **USD only** (`api/server.ts:2542-2553`). Account holds USD **and** USDC. If the USD balance can't be determined the check is *skipped with a warning* and `equity_usd` stays **$10,000** → ~10× over-sizing on a $1K account (fail-open).
- Scaling only triggers when `balance < 0.95 × configured`; `risk-engine.ts:991` clamps sizing equity to 0.5–2× `accountEquity`, `:210` exposure cap = 30% × `accountEquity`.
- `FeeModel` is static from yaml (`coinbase.spot` 25/40 bps, `core/fee-model.ts`, built at `server.ts:266` and `:1188`). Real tier on 2026-09-10: **Intro 1 = 60/120 bps**. The A3 EV gate (`trading/risk/ev-gate.ts`, called at `server.ts:2252`) therefore under-charges fees 3×.
- EV gate allows every trade when win-rate history is missing (fail-open) and assumes every winner reaches TP.
- Product specs come from hard-coded defaults (`buildDefaultProductSpecs`).

## IMPORTANT CONSTRAINTS

1. Live equity/fees/specs must come from Coinbase; **any unknown ⇒ refuse to start** (no silent fallback to yaml).
2. Paper mode unchanged (paper keeps yaml/`PAPER_INITIAL_EQUITY_USD`).
3. No new deps. No real orders in tests.
4. Single source of truth: one `LiveAccountSnapshot` object consumed by RiskEngine, FeeModel, EV gate, `/api/pnl`, `/api/status`.

---

## Step 1 — `LiveAccountTruth` service

File: `atlas/apps/core-node/src/trading/account/live-account-truth.ts`

```ts
export interface LiveAccountSnapshot {
  fetchedAt: number;
  quoteAvailableUsd: number;   // USD + USDC available (USDC treated 1:1)
  quoteHoldUsd: number;
  baseBalances: Record<string, { available: number; hold: number }>; // e.g. ETH, BTC
  equityUsd: number;           // quote available + hold + Σ base × mid (only live symbols' bases)
  feeTier: { name: string; makerRate: number; takerRate: number; volume30dUsd: number };
  products: Record<string, ProductSpec>; // from getProduct()
}
```

- `refresh()` pulls `/accounts` (paginated), `/transaction_summary`, `/products/{id}` for live symbols, mid prices from the market-data feed.
- `refresh()` every 60s (config `live.account_refresh_sec`) and immediately after every fill.
- Staleness > 3× interval ⇒ adapter health `degraded` + risk engine blocks new entries (`ACCOUNT_TRUTH_STALE`).

## Step 2 — Wire into sizing, fees, EV gate

- RiskEngine: in live, `accountEquity = snapshot.equityUsd`; remove the 0.5–2× clamp in live (use snapshot directly; keep clamp in paper).
- FeeModel: add `withRuntimeOverride({venue:'coinbase', product:'spot', makerBps, takerBps})` returning a new immutable model; the engine swaps its model when the tier changes (log tier transitions as risk events `FEE_TIER_CHANGED`).
- EV gate:
  - fees = **live taker** both sides unless entry is post-only (then maker in / taker out);
  - missing win-rate ⇒ use prior `p0 = 0.40` with pseudo-count `n0 = 30` (Beta prior), never allow-by-default;
  - use realized payoff (avg win / avg loss from last 50 closed trades, fallback TP/SL geometry with a 0.6 haircut);
  - new config `live.ev_gate_mode: enforce | shadow`; `shadow` logs `EV_GATE_SHADOW_ALLOW` for every would-be reject and prints a startup banner.

## Step 3 — Preflight rewrite (`runLivePreflight`)

Replace the legacy block with checks mirroring `src/cli/coinbase-preflight.ts`, using `LiveAccountTruth`:

| Check | Fail condition |
|---|---|
| `COINBASE_API_VERSION` | ≠ `advanced` |
| key permissions | `can_trade=false` → FAIL; `can_transfer=true` → FAIL in live (require View+Trade key) |
| clock skew | > 30s |
| equity | `quoteAvailableUsd < live.min_quote_usd` (default 20) |
| fee tier | unknown |
| products | any live symbol missing / not tradable / `cancel_only` |
| order shape | `POST /orders/preview` for a minimum-size limit buy + attached bracket on each live symbol returns errors |
| INTX | any `*-PERP-INTX` in live products → FAIL |

Response includes the snapshot summary (equity, tier, specs) so the dashboard can show it.

## Step 4 — Surface

- `/api/status` and `/api/pnl`: add `liveAccount: {equityUsd, quoteAvailableUsd, feeTier, fetchedAt}` in live; remove `?? 50_000` / `equity_usd` fallbacks for live (`server.ts:829-846`, `:2869`).
- `package.json` (core-node): ensure script `"cb:preflight": "tsx src/cli/coinbase-preflight.ts"` exists.

## Step 5 — Tests

`src/__tests__/live-account-truth.test.ts`:
1. USD 2.90 + USDC 500 ⇒ `quoteAvailableUsd` 502.90.
2. `/transaction_summary` 0.006/0.012 ⇒ FeeModel taker 120 bps; EV gate charges 2 × 120 bps.
3. Missing snapshot in live ⇒ `startEngine` rejects with `ACCOUNT_TRUTH_UNAVAILABLE` (no yaml fallback).
4. EV gate with no history uses Beta(12,18) prior (p0=0.40, n0=30) — a 15m momentum setup at 120 bps is rejected in `enforce`, allowed + logged in `shadow`.
5. Preflight FAILs on `can_transfer=true`, on `*-PERP-INTX` symbol, on preview error.

## Acceptance Criteria

- [ ] All tests green; no new tsc errors in touched files
- [ ] `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 011` PASS
- [ ] Manual: `pnpm cb:preflight` still READY; `POST /api/engine/start {"mode":"live"}` with `CONFIRM_LIVE=NO` still 403 (unchanged gate)
- [ ] `risk-guardian` review clean
