# TASK_013: Exchange-Side Protective Orders + Boot/Reconnect Reconciliation

**Priority:** P0 — a crashed process must never leave a naked live position
**Status:** PENDING
**Depends on:** TASK_010, TASK_011
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 0
**Skills:** `coinbase-advanced-trade`, `live-incident-response` · **Review subagent:** `risk-guardian`

---

## Context

Stops and take-profits are enforced only in-process by `PositionMonitor` (`trading/position-monitor.ts`: `stop_loss | take_profit | time_stop | trailing_stop`). Nothing rests on Coinbase. The runtime lives on a Windows PC (sleep, updates, reboots). Any crash with an open position = unlimited downside until a human notices.

Coinbase Advanced Trade supports attaching a TP/SL bracket to the entry order:
```json
"attached_order_configuration": {
  "trigger_bracket_gtc": { "limit_price": "<TP>", "stop_trigger_price": "<SL>" }
}
```
(size is inherited from the parent order). Standalone `trigger_bracket_gtc` and `stop_limit_stop_limit_gtc` also exist. `POST /api/v3/brokerage/orders/preview` validates a configuration without executing — use it to prove spot support per symbol before any live order.

## IMPORTANT CONSTRAINTS

1. `live.require_exchange_protection: true` (default in live profiles) ⇒ **no entry without protection**. If attach/preview fails ⇒ do not enter; risk event `PROTECTION_UNAVAILABLE`.
2. In-process `PositionMonitor` stays as a second layer (trailing/time stops). When it exits, it must first cancel the resting bracket, then exit, then verify both on the exchange.
3. Exchange state wins. The DB is a journal.
4. No real orders in tests.

---

## Step 1 — Protection model

- Entry request carries `protection: {takeProfitPrice, stopTriggerPrice}` rounded to `quote_increment`. **Rounding rule: both prices round toward the entry price** (long: TP rounds down, stop trigger rounds up). Realized risk can then never exceed the sized R, and TP can never sit beyond the target. Test both directions.
- Adapter attaches `trigger_bracket_gtc`. Track `bracketOrderId` from the user stream / `listOrders` (child order).
- If Coinbase returns the entry filled but no child bracket within 10s ⇒ place standalone `trigger_bracket_gtc` for filled size; if that fails ⇒ immediate market exit + halt (`PROTECTION_PLACEMENT_FAILED`).

## Step 2 — Exits

- Strategy/trailing/time exit: `cancel bracket` → confirm canceled → `market_market_ioc sell base_size` → confirm filled → position closed. If cancel fails because bracket already triggered, reconcile instead of double-selling.
- Kill switch semantics (unchanged): halt entries, keep brackets. `close-all`: cancel all → market exit all engine-owned positions → verify flat.

## Step 3 — Reconciler (`LiveReconciler`)

File: `atlas/apps/core-node/src/trading/execution/live-reconciler.ts`

Runs at boot (before accepting signals), after user-stream reconnect, and every `live.reconcile_interval_sec`:

| Exchange | Engine/DB | Action |
|---|---|---|
| base balance > 0 with engine-owned record, bracket open | position open | adopt; ensure monitor registered |
| base balance > 0, engine-owned record, **no bracket** | position open | place bracket; fail ⇒ market exit + halt |
| engine-owned record, base balance ≈ 0 | position open | close from fills (bracket triggered while offline); journal exit reason `exchange_protection` |
| open order unknown to engine with our `client_order_id` prefix | missing | adopt or cancel per config (`live.orphan_policy: cancel` default) |
| any other divergence | — | halt entries + risk event `RECONCILE_DIVERGENCE` with diff payload |

Engine-owned = orders whose `client_order_id` carries the session prefix `apx-<sessionId>-`.

## Step 4 — Tests

1. Entry body contains `attached_order_configuration.trigger_bracket_gtc` with string prices at tick size.
2. Preview error ⇒ no entry, `PROTECTION_UNAVAILABLE`.
3. Filled entry without child bracket after 10s ⇒ standalone bracket placed; its failure ⇒ market exit + halt.
4. Boot with position + no bracket ⇒ bracket placed before signals are accepted.
5. Boot with DB position open + exchange base 0 + bracket fill present ⇒ closed with `exchange_protection`.
6. Strategy exit cancels bracket first (call order asserted).

## Acceptance Criteria

- [ ] Tests green; `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 013` PASS
- [ ] Stage-1 drill script documented in `docs/runbooks/live-drills.md` (restart-with-position, kill, close-all) — executed only during canary
- [ ] `risk-guardian` review clean
