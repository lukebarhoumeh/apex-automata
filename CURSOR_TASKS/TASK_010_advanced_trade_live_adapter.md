# TASK_010: Advanced Trade Live Execution Adapter (JWT) — replace the dead legacy live path

**Priority:** P0 — nothing live can happen without this
**Status:** PENDING
**Depends on:** none
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 0 — see `docs/plans/SPRINT-9-LIVE-COINBASE.md` §2
**Skills:** `coinbase-advanced-trade`, `sprint-task-execution` · **Review subagent:** `risk-guardian` (mandatory before DONE)

---

## Context

`EXECUTION_MODE=live` builds `CoinbaseLiveExecutionAdapter` (`trading/execution/adapter-factory.ts:94-108`), which calls `CoinbaseExchange` → `CoinbaseRestClient`. That client signs every request with **legacy Coinbase Exchange HMAC-SHA256 + passphrase** (`exchanges/coinbase/rest-client.ts:131-150`, `:582-592`) against legacy paths (`/accounts`, `/orders`, `/fills`). The account key is a **CDP key** (`organizations/{org}/apiKeys/{id}` + EC P-256 PEM) that only authenticates with **ES256 JWT** on `api.coinbase.com/api/v3/brokerage/*`. Result: live cannot authenticate.

`exchanges/coinbase/advanced-trade-client.ts` (`AdvancedTradeRestClient`) already implements JWT auth and `/api/v3/brokerage` endpoints and **was verified against the real account on 2026-09-10** (`pnpm cb:preflight` → `repo.AdvancedTradeRestClient PASS`). It is imported by nothing, and has defects that make it unsafe for orders:

| # | Defect | Location |
|---|---|---|
| D1 | `createOrder` ignores `success:false` + `error_response` → rejected order is returned as `status:'pending'` with `id: undefined` | `advanced-trade-client.ts:312-362` |
| D2 | Response is synthesized (`filled_size:'0'`, `status:'pending'`) — no truth about the order | same |
| D3 | `getProducts` hard-codes `base_min_size 0.001`, `quote_increment 0.01`, `base_increment 0.00000001` for **every** product | `:277-305` |
| D4 | `getAccounts` does not paginate (default page size) | `:254-275` |
| D5 | JWT adds `aud:['cdp_service']` (not in current spec; currently tolerated) and DER→raw conversion by hand | `:140-181` |
| D6 | No `stop`/bracket support; `type:'stop'` silently produces no `order_configuration` | `:312-336` |
| D7 | Errors logged as raw axios errors (can include request headers → JWT) | all methods |

## IMPORTANT CONSTRAINTS

1. **DO NOT** modify `rest-client.ts`, `websocket.ts` (CLAUDE.md rule). Build a new adapter beside them.
2. **DO NOT** add npm dependencies (JWT via `node:crypto`, WS via existing `ws`).
3. **DO NOT** place real orders in tests. Mock `fetch`/axios. Real-money checks happen only in Stage 1 via the canary profile.
4. **NEVER** log `Authorization` headers, JWTs, key material, or full axios error objects. Log `{status, code, message}` only.
5. Keep `IExecutionAdapter` (`trading/execution/execution-adapter.ts:156-205`) unchanged; implement it.
6. Paper mode behaviour must be bit-for-bit unchanged (`execution-adapters.test.ts` stays green).

---

## Step 1 — Harden `AdvancedTradeRestClient` (fix D1–D5, D7)

- Spec-exact JWT: header `{alg:'ES256', kid, nonce, typ:'JWT'}`, claims `{sub, iss:'cdp', nbf, exp:+120, uri:'METHOD api.coinbase.com/path'}`; sign with `crypto.sign('sha256', input, {key, dsaEncoding:'ieee-p1363'})`; drop `aud`; path excludes query string. Reference implementation: `src/cli/coinbase-preflight.ts` `signJwt()` (verified live).
- New typed method `createOrderRaw(body: AtCreateOrderBody): Promise<AtCreateOrderResult>` returning a discriminated union:
  ```ts
  export type AtCreateOrderResult =
    | { ok: true; orderId: string; clientOrderId: string; raw: unknown }
    | { ok: false; code: string; message: string; previewFailureReason?: string; newOrderFailureReason?: string; raw: unknown };
  ```
  `success:false` ⇒ `ok:false` (never throw for business rejects; throw only for transport/auth failures).
- `previewOrder(body)` → `POST /api/v3/brokerage/orders/preview` (no execution) — used by preflight + tests of order shapes.
- `getOrder(orderId)`, `listOrders({status, product_id, cursor})`, `listFills({order_ids?, product_ids?, cursor})` with pagination (`cursor`, `has_next`).
- `getProduct(productId)` returning real `base_increment`, `quote_increment`, `base_min_size`, `quote_min_size`, `status`, `trading_disabled`, `cancel_only`, `limit_only`, `post_only`.
- `getAccountsAll()` paginated (`limit=250`, follow `cursor`).
- `cancelOrders(orderIds[])` → `batch_cancel`, returns per-id `{success, failure_reason}`.
- Central `request()` with: 15s timeout, 429 handling (respect `Retry-After`, bounded retries), safe error mapping (D7).

## Step 2 — `CoinbaseAdvancedExecutionAdapter implements IExecutionAdapter`

File: `atlas/apps/core-node/src/trading/execution/coinbase-advanced-adapter.ts`

- `placeOrder(req)`: map `PlaceOrderRequest` → Advanced Trade body:
  - `limit` → `limit_limit_gtc {base_size, limit_price, post_only}` (sizes/prices as **strings**, rounded **down** to `base_increment` / to `quote_increment` via product spec from Step 4 cache).
  - `market` → `market_market_ioc {base_size}` for sells, `{quote_size}` allowed for buys.
  - `stop` → `stop_limit_stop_limit_gtc {base_size, limit_price, stop_price, stop_direction}`.
  - `req.metadata.protection = {takeProfit, stopTrigger}` → `attached_order_configuration.trigger_bracket_gtc {limit_price, stop_trigger_price}` (TASK_013 turns this on).
  - `client_order_id = req.clientOrderId` (idempotent; retries reuse it).
  - `ok:false` ⇒ emit `order_rejected {code, reason}`; `ok:true` ⇒ emit `order_accepted {exchangeOrderId}`.
  - Reject locally (emit `order_rejected`, no HTTP) when size < `base_min_size`, notional < `quote_min_size`, product not tradable, or `side:'sell'` on spot without sufficient base balance (coordinate with TASK_012).
- `cancelOrder` / `cancelAllOrders` via `batch_cancel`; emit `order_canceled` only on confirmed success.
- `getOpenOrders()` → `listOrders({order_status:['OPEN','PENDING']})` mapped to `OpenOrder`.
- `getFillsSince(cursor)` → `listFills` paginated; map `commission` → `fee`, `liquidity_indicator` → `maker|taker`, keep `trade_id` as `tradeId`.
- Fills/order status: primary = user stream (Step 3); fallback = poll `listFills` every 5s while any order is open.

## Step 3 — `AdvancedTradeUserStream`

File: `atlas/apps/core-node/src/exchanges/coinbase/advanced-trade-user-stream.ts`

- `wss://advanced-trade-ws-user.coinbase.com`; subscribe within 5s: `{type:'subscribe', channel:'user', jwt}` plus `{type:'subscribe', channel:'heartbeats', jwt}`; fresh JWT per subscribe (2-min expiry).
- Parse `user` events (`orders[]` with `order_id`, `client_order_id`, `status`, `cumulative_quantity`, `avg_price`, `total_fees`); diff cumulative quantity → emit `fill` deltas; dedupe by `(order_id, cumulative_quantity)`.
- Reconnect: exponential backoff + jitter; on reconnect trigger REST reconciliation (`listOrders` + `listFills` since last seen) before resuming.
- Heartbeat staleness > 15s ⇒ adapter health `degraded` + reason `USER_STREAM_STALE`.

## Step 4 — Factory + fail-closed wiring

- `adapter-factory.ts`: when `executionMode==='live'`:
  - `COINBASE_API_VERSION==='advanced'` ⇒ `CoinbaseAdvancedExecutionAdapter`.
  - otherwise ⇒ **throw** `LIVE_REQUIRES_ADVANCED_TRADE` (legacy Exchange keys are not supported for retail accounts).
- Product spec cache: load `getProduct` for every live symbol at `start()`; refuse to start if any is missing/not tradable.
- `runLivePreflight` (`api/server.ts:2434-2575`): replace the hard-coded `CoinbaseExchange` + `api.exchange.coinbase.com` block with the hardened client (full rewrite is TASK_011; minimum here: stop using the legacy client).

## Step 5 — Tests (Vitest, all mocked)

`src/__tests__/coinbase-advanced-adapter.test.ts` — minimum cases:
1. JWT: header/claims shape; `uri` excludes query string; signature verifies with the public key (`crypto.verify` with `ieee-p1363`).
2. `success:false` (`INSUFFICIENT_FUND`) ⇒ `order_rejected` with code; no `order_accepted`.
3. Limit order sizing rounds **down** to `base_increment`; price rounds to `quote_increment`; strings not numbers in body.
4. Below `base_min_size` ⇒ local reject, zero HTTP calls.
5. Retry of `placeOrder` with same `clientOrderId` sends identical `client_order_id`.
6. User-stream cumulative fills 0 → 0.4 → 1.0 emit two `fill` deltas (0.4, 0.6); duplicate event ignored.
7. Factory: `live` + `COINBASE_API_VERSION=exchange` throws `LIVE_REQUIRES_ADVANCED_TRADE`.
8. Error logging never contains `Bearer ` (spy on logger).

## Acceptance Criteria

- [ ] `pnpm test` green (625 + new tests), zero new failures
- [ ] `pnpm exec tsc -p tsconfig.json --noEmit` introduces no new errors in touched files
- [ ] `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 010` PASS
- [ ] `risk-guardian` subagent review: no Critical/High findings open
- [ ] Report: files created/modified with line ranges; list of remaining known gaps

## Out of scope

Equity/fees truth (TASK_011) · profiles/long-only (TASK_012) · bracket enforcement + boot reconciliation (TASK_013) · persistence (TASK_014).
