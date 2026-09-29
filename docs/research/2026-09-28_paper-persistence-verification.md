# P3 — Paper persistence verification: fills → `positions`, restart restamp, trade_id integrity

**Date:** 2026-09-28 · **Repo:** `main @ c9bfae1` (PR #81) plus the 2026-09-28 handoff branch · **Requested by:** Apex desk handoff (P3) · **Audience:** TM + Eng + Risk

**Authority:** read-only. Every database statement below is a `SELECT` against Supabase project `gdrdaajvutmewgxbjurk` (`public` schema) run on 2026-09-28; nothing was written, no `agentic_*` table was touched, no runtime was started. Code findings come from a read of `atlas/apps/core-node/src/{api,trading,persistence}` and the existing test suites.

**Why this note exists:** PRs #69 (positions upsert on `id`, 42P10 fallback), #74 (hydrate restamps open positions onto the new paper `session_id`) and #76 (per-session `trade_id` namespace) shipped on 2026-09-21/22. The handoff asked whether they hold under real fills. No paper session with fills has run since they merged, so this note (a) checks what the production data can already prove or refute, (b) records the code-review findings and their disposition, and (c) gives the operator an exact runbook for the first soak with fills.

---

## 0. Verdict

| Contract | Status | Evidence (§1) |
|---|---|---|
| **#69** — an opening paper fill creates one `positions` row; the closing fill updates the SAME row in place (`qty_open = 0`, `closed_at`, `exit_price`, `exit_reason`, `realized_pnl_usd`) | **VERIFIED in production data.** Session `sess_1790091200890_9q7egp` (2026-09-22 15:33 → 21:07 UTC): 5 positions, 5 rows, all closed in place, 0 duplicate rows, 0 open rows. A SOL-USD scale-in (two entry fills 13.073006 + 12.256946) closed by one 25.329952 exit collapsed into ONE row with a VWAP entry (117.3509665…). | Q3, Q5, Q6 |
| **#76** — paper `trade_id` is namespaced `paper-<sessionId>-<seq>` so a new session cannot upsert over an earlier session's fills | **NOT YET EXERCISED in production.** 0 of 31 fill rows carry a `paper-…` id; every id is the old global counter (`1`…`28`) or NULL. The latest fill is 2026-09-22 17:30 UTC, before #76 ran on LukePC. **The defect it fixes is visible:** session `sess_1790017457369_hkub8j` has 18 filled orders but only 7 fill rows (11 orders have none), and the 5 positions opened 2026-05-13 have 0 fill rows left — their fills were overwritten by later sessions reusing ids 1…18. | Q4, Q7, Q8 |
| **#74** — on a restart with open positions, hydrate moves them onto the new paper `session_id` | **NOT YET EXERCISED.** Every restart since #74 started with 0 open positions (all Sep 22 positions were closed by 17:30 UTC; the Sep 23 session placed 0 orders). Pre-#74 evidence of the failure mode it targets: position `30b0fdd0` (SOL-USD long, opened 2026-09-21 18:07) carries `session_id = sess_1790015739698_cvjy53` (a session that started 18:35:39), while its exit fill (`trade_id 12`, 2026-09-22 02:53:40) is stamped `sess_1790017457369_hkub8j`. | Q2, Q6 |
| Shutdown-flatten fills keep their session stamp | **Fixed in code, not yet exercised.** Pre-fix evidence: fills `17` and `18` (2026-09-22 03:35:21.887 / .996, orders in `hkub8j`) have `session_id NULL` — they landed after `closeTradingSession()` cleared the live stamp. `api/server.ts` now captures the stamp synchronously in the `order:filled` listener (`stampAtEvent`) and `syncFillToSupabase` uses it; unit-tested. | Q7 |
| Handoff claim: the 2026-09-23 session ended flat, 0 orders, all 50 signals blocked by the regime gate | **CONFIRMED.** `sess_1790175475882_xov6sd`: `total_trades 0`, `final_equity 10000`, 50 signals `allowed = false` with reason prefix `regime_gate`; the evening session `sess_1790118549064_fv36j2` had 9 more. | Q2, Q9 |
| Risk state | 0 active `risk_events`; the last `consecutive_losses` event (2026-09-22 17:30:05) was cleared 2026-09-22 23:07:53. No open positions. | Q10 |
| `orders.position_id` | **Never written** (NULL on all 29 orders of the two sessions), so fills ↔ positions can only be joined by symbol + time. Low-severity gap for reconciliation tooling. | Q4 |

**Bottom line:** the happy path of #69 is proven on real fills. #76 and #74 are untested by production yet; the very first soak with fills must run the runbook in §3. The code review (§2) found three high-severity defects in the same path that a soak with ~1 Hz ticks and paper stop-outs would hit first; the ones fixed on this branch are marked in §2.

---

## 1. Read-only queries and results

Session ids are abbreviated by their suffix after the first mention.

**Q1 — schema (columns that matter).** `positions(id, user_id, symbol, strategy, side, qty_open, entry_price, stop_price_at_entry, take_profit_price, opened_at, closed_at, exit_price, exit_reason, realized_pnl_usd, realized_r, created_at, exchange_id, primary_signal_id, session_id, execution_mode)`. `fills(id, user_id, order_leg_id, order_id, trade_id, price, quantity, fee_currency, fee_amount, maker, slippage_bps, filled_at, exchange_id, external_order_id, session_id, execution_mode, fee_side, fee_side_source)`. `orders(…, position_id, session_id, execution_mode)`. `trading_sessions(session_id, user_id, mode, started_at, ended_at, initial_equity, final_equity, total_trades, total_pnl, realized_pnl, execution_mode)`. There is **no `status` column** on `positions`: open ⇔ `closed_at IS NULL`.

Row counts: `positions 20 · fills 31 · orders 365 · trading_sessions 79 · risk_events 18 · signals 1680`.

**Q2 — recent sessions.**
```sql
SELECT session_id, mode, started_at, ended_at, initial_equity, final_equity, total_trades, total_pnl
FROM trading_sessions ORDER BY started_at DESC LIMIT 15;
```
| session_id | started (UTC) | ended (UTC) | trades | total_pnl |
|---|---|---|---|---|
| `sess_1790175475882_xov6sd` | 2026-09-23 14:57:55 | 2026-09-24 01:08:13 | 0 | 0 |
| `sess_1790118549064_fv36j2` | 2026-09-22 23:09:09 | 2026-09-23 01:56:46 | 0 | 0 |
| `sess_1790115409235_j4ywtw` | 2026-09-22 22:16:49 | 2026-09-22 22:18:09 | 0 | 0 |
| `sess_1790114547482_4wlq3v` | 2026-09-22 22:02:27 | 2026-09-22 22:21:40 | 0 | 0 |
| `sess_1790091200890_9q7egp` | 2026-09-22 15:33:20 | 2026-09-22 21:07:01 | 5 | −94.1869 |
| `sess_1790017457369_hkub8j` | 2026-09-21 19:04:17 | 2026-09-22 03:35:22 | 6 | −126.8926 |
| `sess_1790015739698_cvjy53` | 2026-09-21 18:35:39 | 2026-09-22 03:38:06 | 1 | −38.72 |
| (8 more short sessions on 2026-09-21, all 0 trades) | | | | |

**Q3 — every `positions` row (20).** All 20 rows have `qty_open = 0` and `closed_at` set. By session: `9q7egp` 5 (all `stop_loss`), `hkub8j` 9 (`stop_loss` ×3, `take_profit` ×2, `time_stop`, `manual_exit` ×4 — the 03:35 shutdown flatten), `cvjy53` 1 (`stop_loss`), `session_id NULL` 5 (opened 2026-05-13, pre-session-stamp schema). `execution_mode = paper` wherever `session_id` is set.

**Q4 — per-order fill coverage for the two sessions with fills.**
```sql
SELECT o.session_id, o.symbol, o.side, o.status, o.quantity, o.position_id, o.created_at,
       count(f.id) AS fill_rows, coalesce(sum(f.quantity),0) AS filled_qty,
       string_agg(DISTINCT coalesce(f.session_id,'NULL'), ',') AS fill_session_ids
FROM orders o LEFT JOIN fills f ON f.order_id = o.id
WHERE o.session_id IN ('sess_1790091200890_9q7egp','sess_1790017457369_hkub8j')
GROUP BY o.id, o.session_id, o.symbol, o.side, o.status, o.quantity, o.position_id, o.created_at
ORDER BY o.session_id, o.created_at;
```
- `9q7egp`: 11 filled orders → 11 fill rows, one per order, every fill stamped `9q7egp`, `filled_qty = quantity` on all 11. `position_id` NULL on all.
- `hkub8j`: 18 filled orders → **7 fill rows** (orders created 2026-09-21 20:41 → 2026-09-22 01:50, eleven of them, have **0** fill rows); of the 7, two (`trade_id 17`, `18`, both 03:35:21) have `session_id NULL`. `position_id` NULL on all.

**Q5 — fills per session.** `9q7egp`: 11 fills, 11 distinct `trade_id` (`1`…`11`), fees 57.97289092. `hkub8j`: 5 stamped fills (`12`…`16`), fees 31.73770464. `cvjy53`: 3 fills with `trade_id NULL`, fee 0 (2026-09-21 18:36:01–03). `NULL` session: 12 fills, 2026-04-27 → 2026-09-22 03:35.

**Q6 — the `9q7egp` round trips (fills joined to orders, ordered by time).** SOL sell 14.180437 @117.10 (15:39) → SOL buy 14.180437 (15:42, exit); ETH-PERP sell 0.49141 + ETH sell 0.49141 @2745.81 (15:57); SOL sell 13.073006 @117.38 (15:58) + SOL sell 12.256946 @117.32 (16:07, scale-in); BTC sell 0.015629 @86345.88 (16:06) → BTC buy (16:51, exit); SOL buy 25.329952 (16:52, exit of both lots); ETH buy + ETH-PERP buy 0.49141 (17:30, exits). Positions table: 5 rows, SOL scale-in position `entry_price 117.35096651584652`, `qty_open 0`, `closed_at 16:52:08.958`.

**Q7 — unstamped / non-namespaced fills.**
```sql
SELECT count(*) FILTER (WHERE trade_id LIKE 'paper-%') AS namespaced,
       count(*) FILTER (WHERE trade_id ~ '^[0-9]+$') AS numeric_ids,
       count(*) FILTER (WHERE trade_id IS NULL) AS null_ids, count(*) AS total,
       count(*) FILTER (WHERE filled_at::date = '2026-05-13') AS fills_on_2026_05_13,
       (SELECT count(*) FROM positions WHERE opened_at::date = '2026-05-13') AS positions_on_2026_05_13
FROM fills;
```
→ `namespaced 0 · numeric_ids 28 · null_ids 3 · total 31 · fills_on_2026_05_13 0 · positions_on_2026_05_13 5`. The 12 `session_id NULL` fills are ids `19`–`28` (2026-04-27 / 2026-05-11, no session column yet) plus `17`, `18` (2026-09-22 03:35, orders in `hkub8j`).

**Q8 — reading of Q4 + Q7.** Before #76 the simulator's `trade_id` was a per-process counter; `fills` upserts on `(user_id, trade_id)`. `hkub8j` produced ids `1`…`18`; `9q7egp` (a new process) produced `1`…`11` again and **overwrote** `hkub8j`'s first eleven rows (which had already overwritten the 2026-05-13 rows). That is exactly the "prior-session fill orphans" #76 fixed. Because no post-#76 fill exists in the database, #76 is unverified in production; §3 step 1.2 verifies it on the first soak.

**Q9 — signal funnel since 2026-09-22.** `xov6sd`: 50 × `allowed=false`, reason prefix `regime_gate` (2026-09-23 15:27 → 2026-09-24 01:04). `fv36j2`: 9 × `regime_gate`. `9q7egp`: 6 allowed (`Bearish EMA crossover (12/15)`), 19 × `runtime_state`, 2 × `cross_venue`. `hkub8j`: 6 allowed, 6 × `risk_engine`, 5 × `cross_venue`.

**Q10 — risk events.** 18 rows, all `active = false`. Most recent: `consecutive_losses` 2026-09-22 17:30:05 → cleared 2026-09-22 23:07:53.

---

## 2. Code review findings and disposition

Independent adversarial review of `src/api/server.ts` (`order:filled` / `position:update` handlers, `syncFillToSupabase`, `syncPositionToSupabase`), `src/trading/position-tracker.ts`, `src/trading/trading-engine.ts`, `src/trading/paper-trading-simulator.ts`, `src/persistence/{fill-row,position-upsert,position-session-restamp,session-stamp}.ts` and their suites. Each finding survived a refutation attempt. Findings 1–5 were then each reproduced by a test that FAILED on the pre-fix tree and fixed on the handoff branch in four `fix(persistence):` commits (the failure messages observed on the pre-fix tree are quoted in those commit bodies).

| # | Sev | Where | Failure scenario | Disposition |
|---|---|---|---|---|
| 1 | high | `server.ts` `position:update` → `syncPositionToSupabase` (per-id full-row upsert, no ordering) | A 1 s-debounced ticker update `{closed_at: null, qty_open: N}` is in flight when the closing fill's upsert lands; the stale update completes second and **reopens** the row → phantom open position hydrated by every later session. | **FIXED** — `src/persistence/position-write-sequencer.ts` (`PositionWriteSequencer`): writes for one position id are serialised (a write for X waits for the previous write for X); once a close has been issued for X, any later non-close write for X is dropped at debug level. Test on pre-fix tree: row ended `closed_at null / qty_open 0.05`. |
| 2 | high | `server.ts` supervisor restart → `TradingEngine.start()` → new `PaperTradingSimulator` (`fillSequence` = 0) while `activeSessionStamp` is unchanged | After an in-session engine restart the next fills are `paper-<sameSession>-1…` and **overwrite this session's earlier fills** on `fills_user_trade_key` — the #76 collision class inside one session. | **FIXED** — `PaperTradingConfig.fillSequenceStart` + `getFillSequence()`; `TradingEngine.initializePaperSimulator` seeds the replacement simulator with the retired one's last sequence, so numbering continues (`paper-<sess>-1…k`, restart, `k+1…`). Test on pre-fix tree: both fills were `paper-<sess>-1`. |
| 3 | high | `server.ts` `syncPositionToSupabase` close write is single-shot; `position-tracker.ts` deletes the Position from memory right after `position:closed` | One transient upsert error (network, timeout, 23505) → the row stays **open forever** and is re-hydrated as a phantom (and restamped) by every later session. | **FIXED** — the sequencer retries CLOSE writes on a bounded schedule (250 / 1000 / 3000 / 8000 ms: 1 initial + 4 retries, ~12 s worst case; transient SQLSTATEs, PostgREST pool errors, HTTP 5xx, thrown fetch failures); a non-transient error gets exactly one retry; the final failure logs `positions: close write failed after N attempt(s) — row left open; reconcile manually or on next start` with id / symbol / session. In-process only (no disk spool). Test on pre-fix tree: one `08006` left the row open after 1 attempt. |
| 4 | medium | `position-tracker.ts` size-changing fills (partial close, scale-in) only schedule the 1 s debounced update | Process kill inside the window → `qty_open` / `realized_pnl_usd` stale; restart hydrates the pre-fill size (hydrate reads only `positions`). | **FIXED** — a size-changing fill cancels the pending tick update and emits `position:updated` synchronously; mark-price ticks stay debounced. Test on pre-fix tree: no update emitted after the partial close. |
| 5 | medium | `position-tracker.ts` hydrate and `position-session-restamp.ts` ignore `execution_mode` | A paper start hydrates a LIVE open row and restamps it `execution_mode = paper` / paper session (and vice versa) in the shared project. | **FIXED** — `hydrateOpenPositions(userId, { executionMode })` skips rows whose non-null mode differs (warn with ids / symbols; NULL legacy rows still hydrate; schema without the column falls back to the legacy select); the restamp reports such rows as `foreign` / `foreignRows` (also on the `/api/engine/start` `hydrateRestamp` block) and never moves them. Test on pre-fix tree: the live row was hydrated (3 instead of 2) and restamped onto the paper session. |
| 6 | low | `position-tracker.ts` hydrated position (`trades = []`) + first scale-in fill → `trades.length === 1` → emits `position:opened` again | `TradeAnalytics.recordEntry` overwrites the trade_log entry's price/size/time; "opened" counted twice. | FIXED in this PR (round 2): `processFill` decides `position:opened` from `existedBeforeFill`, not `trades.length`; `position-tracker-hydrate.test.ts` scale-in + partial-close cases failed on HEAD and pass now. |
| 7 | low | `server.ts` positions row writes `strategy = position.strategy || 'breakout'` without `normalizeStrategy()` | A context-less position is labelled with a killed strategy; a display-name strategy string would fail the enum (22P02) on every write including the close. | FIXED in this PR (round 2): shared `persistence/strategy-name.ts` (`resolvePositionStrategy`, default `system`, warn once per position id) used by both the orders and positions paths; `donchian_daily_s3` normalises to `system` until the `strategy_name` enum gains it (`signals.strategy` is still written raw — open item). |

Also **FIXED**: `src/runtime/session-context.ts generateDedupeKey` embedded `Date.now()` in a key documented as deterministic; the `supabase-writer.test.ts` case "should generate consistent dedupe keys" therefore failed intermittently (once in a full run on 2026-09-28, then 5/5 green in isolation) and a replay across a millisecond could never be deduped. No production caller exists (audited); the wall-clock group is now a second hash of the same input.

Operator-visible changes from these fixes: new log lines `positions: close write failed; retrying`, `positions: close write succeeded after retry`, `positions: close write failed after N attempt(s) — row left open; reconcile manually or on next start`, `positions: dropping stale update write` (debug), `positions: open rows stamped with another execution_mode were NOT hydrated (cross-mode isolation)`, `positions: hydrated open rows carry another execution_mode — left on their own session`; `Paper trading simulator initialized` now carries `fillSequenceStart`; the `/api/engine/start` response's `hydrateRestamp` block gains `foreign`.

**Untested scenarios a real soak hits first (in addition to the table):** duplicate exit fills for one position (PositionMonitor stop + strategy exit) opening an inverse phantom row; hydrated paper positions closed against a fresh simulator holding no inventory (base balance goes negative, simulator P&L diverges from the FIFO tracker); position flip (close overshoot) changing `side` on the same row with a blended `entry_price`; a restamp `UPDATE … RETURNING` that moves fewer rows than asked against a real PostgREST; a ticker self-heal write landing before the restamp read (`hydrateRestamp.outcome = 'noop'`, `alreadyCurrent = N`, which is acceptable).

---

## 3. Operator runbook — first paper soak with real fills (LukePC)

Read-only. `<UID>` = the runtime `USER_ID` (`SELECT DISTINCT user_id FROM trading_sessions`), `<SID>` = the active session, `<PREV_SID>` = the session before the restart. Nothing here writes.

**Step 0 — identify sessions, confirm schema.**
- `GET http://127.0.0.1:3001/api/status` → note `sessionId`, `session.mode = paper`, `engineRunning = true`.
- `SELECT session_id, mode, started_at, ended_at, total_trades FROM trading_sessions WHERE user_id = '<UID>' ORDER BY started_at DESC LIMIT 5;` — top row is `<SID>` (`ended_at NULL`).
- `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('positions','fills','orders') AND column_name IN ('session_id','execution_mode');` — expect 6 rows (migration `20260911170000` applied). If 0, every `session_id =` filter below becomes a time window and the log will say `columns missing — writing legacy shape`.
- Reminder: open ⇔ `closed_at IS NULL`; closed ⇔ `closed_at IS NOT NULL AND qty_open = 0`.

**Step 1 — every fill has a positions row in the SAME session (#69).**
```sql
SELECT f.filled_at, f.trade_id, o.symbol, o.side, f.quantity, f.price, f.session_id AS fill_sid,
       p.id AS position_id, p.session_id AS pos_sid, p.execution_mode AS pos_mode, p.qty_open, p.opened_at, p.closed_at, p.realized_pnl_usd
FROM fills f
LEFT JOIN orders o ON o.id = f.order_id
LEFT JOIN positions p ON p.user_id = '<UID>' AND p.symbol = o.symbol
     AND p.opened_at <= f.filled_at + interval '2 seconds'
     AND (p.closed_at IS NULL OR p.closed_at >= f.filled_at - interval '2 seconds')
WHERE f.session_id = '<SID>' ORDER BY f.filled_at;
```
PASS: no `position_id NULL`; every `pos_sid = '<SID>'`, `pos_mode = 'paper'`; entry fills have `opened_at ≈ filled_at`; exit fills have `closed_at ≈ filled_at` and `qty_open = 0`. (`orders.position_id` is never written, hence the symbol + time join.)

1.2 **Trade-id namespace (#76) and one fill per filled order:**
```sql
SELECT count(*) AS fills, count(*) FILTER (WHERE trade_id NOT LIKE 'paper-<SID>-%') AS wrong_namespace,
       count(DISTINCT order_id) AS distinct_orders FROM fills WHERE session_id = '<SID>';
SELECT count(*) AS filled_orders FROM orders WHERE session_id = '<SID>' AND status = 'filled';
```
PASS: `wrong_namespace = 0` and `fills = distinct_orders = filled_orders`. FAIL (`filled_orders > fills`, or `fills` stops growing while orders keep filling) = trade_id collision; check the log for `Supervisor requested engine restart` (finding 2).

1.3 **Prior session untouched:** `SELECT session_id, count(*) FROM fills WHERE trade_id LIKE 'paper-%' GROUP BY 1 ORDER BY 1;` — record `<PREV_SID>`'s count before the new session starts and again after fills flow; it must not decrease.

1.4 **Unstamped fills:** `SELECT count(*) FROM fills WHERE user_id = '<UID>' AND session_id IS NULL AND filled_at >= (SELECT started_at FROM trading_sessions WHERE session_id = '<PREV_SID>');` — expect 0.

**Step 2 — closes close rows; never a second row, never a zero-size open row.**
```sql
-- 2.1 invariants (expect 0 rows)
SELECT id, symbol, side, qty_open, opened_at, closed_at, exit_price, exit_reason, realized_pnl_usd
FROM positions WHERE user_id = '<UID>' AND session_id = '<SID>'
  AND ((closed_at IS NULL AND qty_open <= 0)
    OR (closed_at IS NOT NULL AND (qty_open <> 0 OR exit_price IS NULL OR realized_pnl_usd IS NULL)));
-- 2.2 one open row per symbol (expect 0 rows)
SELECT symbol, count(*) FROM positions WHERE user_id = '<UID>' AND closed_at IS NULL GROUP BY symbol HAVING count(*) > 1;
-- 2.3 DB open set == engine open set
SELECT id, symbol, side, qty_open, entry_price, opened_at, session_id FROM positions WHERE user_id = '<UID>' AND closed_at IS NULL ORDER BY opened_at;
```
Compare 2.3 with `GET /api/positions?status=open`: `positions[]` (DB) and `engineOpenPositions[]` (memory) must list the same ids and sizes. A DB row with no engine counterpart = phantom (reopened by a late update, or a failed close) → grep the API log for `Failed to sync position to Supabase:`.
```sql
-- 2.4 fill flow vs open quantity (spot long-only; hydrated rows add their prior-session entry)
SELECT o.symbol, SUM(CASE WHEN o.side = 'buy' THEN f.quantity ELSE -f.quantity END) AS net_filled_qty,
       (SELECT coalesce(sum(qty_open),0) FROM positions p WHERE p.user_id = '<UID>' AND p.symbol = o.symbol AND p.closed_at IS NULL) AS open_qty
FROM fills f JOIN orders o ON o.id = f.order_id WHERE f.session_id = '<SID>' GROUP BY o.symbol;
-- 2.5 closed history, one row per closed position
SELECT symbol, count(*) AS closed_rows, sum(realized_pnl_usd) AS realized FROM positions
WHERE user_id = '<UID>' AND session_id = '<SID>' AND closed_at IS NOT NULL GROUP BY symbol;
```
Cross-check `sum(realized)` against `/api/status` `pnl.realizedPnlUsd`.

**Step 3 — restart with open positions (#74).**
Note: `compliance.flatten_on_shutdown: true` means a graceful stop flattens everything. To exercise hydrate + restamp you need a non-graceful stop (kill the API process) — record which you did.
- 3.1 BEFORE: `SELECT id, symbol, qty_open, opened_at, session_id FROM positions WHERE user_id = '<UID>' AND closed_at IS NULL;` and `SELECT count(*), max(closed_at) FROM positions WHERE session_id = '<PREV_SID>' AND closed_at IS NOT NULL;`
- 3.2 `POST /api/engine/start` `{"mode":"paper"}`. In the JSON response read `sessionId` (new `<SID>`) and `hydrateRestamp`: expect `{outcome:'restamped', hydrated:N, restamped:N, alreadyCurrent:0, symbols:[…], fromSessionIds:['<PREV_SID>']}`. Acceptable: `outcome:'noop'` with `alreadyCurrent = N` (a ticker write landed first). FAIL: `'error'`, `'skipped_columns_missing'`, or `hydrated = 0` while 3.1 listed open rows. `hydrateRestamp` is ONLY on the start response (not on `/api/status`); there is no `hydrateRestamp=restamped` log line.
- 3.3 Log order: `Startup state hydration: starting` → `PositionTracker hydrated open positions` → `Startup state hydration: complete` → `Session reconcile (observational)` (`inDbNotEngine: []`, `inEngineNotDb: []`) → `positions: restamped hydrated open positions onto the active session` (or `… already carry the active session_id`) → `Trading session opened`.
- 3.4 AFTER: `SELECT id, symbol, qty_open, opened_at, session_id, execution_mode FROM positions WHERE user_id = '<UID>' AND closed_at IS NULL;` — every `session_id` = new `<SID>`, `execution_mode = 'paper'`, ids identical to 3.1, `opened_at` unchanged. `SELECT count(*) FROM positions WHERE session_id = '<PREV_SID>' AND closed_at IS NULL;` → 0. The `<PREV_SID>` closed count from 3.1 is unchanged.
- 3.5 Let a hydrated position close in the new session, then re-run Step 1 for its exit fill: `closed_at` set, `qty_open 0`, `session_id` = new `<SID>`, `entry_price` still the original.

**Step 4 — hourly during the soak:** re-run 1.2, 2.1, 2.3; grep the API log for the lines in §4; `fills` count and `orders WHERE status = 'filled'` count must grow together. Any `Timeout waiting for positions to close`, `Flatten-on-shutdown failed` or `Supervisor requested engine restart` → immediately re-run 1.2 and 2.3.

---

## 4. Log lines to grep (exact substrings)

Persistence errors: `Failed to sync position to Supabase:` · `Error syncing position:` · `Failed to sync fill to Supabase:` · `Error syncing fill:` · `Failed to sync order to Supabase:` · `Failed to handle order:filled` · `Failed to handle position:update` · `Skipping position sync: no persistable side/entry price` · `Fill persisted with UNLOGGED fee_side` · `session_id/execution_mode columns missing — writing legacy shape`.

Hydrate / restamp: `Startup state hydration: starting` · `PositionTracker hydrated open positions` · `Startup state hydration: complete` · `Startup hydration: positions fetch failed` · `Skipping malformed open position during hydrate` · `Session reconcile (observational)` · `positions: restamped hydrated open positions onto the active session` · `positions: hydrated open positions already carry the active session_id` · `positions: failed to restamp hydrated open positions onto the active session` · `positions: failed to read session stamps of hydrated open positions` · `positions: hydrated open position restamp threw (non-fatal)` · `positions upsert conflict target`.

Sessions / lifecycle: `Trading session opened` · `Trading session closed` · `Failed to persist trading_sessions row` · `Supervisor requested engine restart` · `Paper trading simulator initialized` · `Paper trading simulator reset` · `Flatten order created for` · `Flatten complete:` · `Timeout waiting for positions to close` · `Flatten-on-shutdown failed` · `Ignoring fill with non-finite/invalid size or price`.
