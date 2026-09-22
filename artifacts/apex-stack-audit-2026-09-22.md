# Apex Automata — Paper Soak Stack Audit — 2026-09-22

**Scope:** paper soak stack (runtime → persistence → FE blotter), sessions 2026-09-21 → 2026-09-22.
**Supersedes:** CA `bc-53a264b3` (errored before finishing). This audit is complete but deliberately tight.
**Locks honoured:** `CONFIRM_LIVE` stays locked (`server.ts` refuses live unless `CONFIRM_LIVE=YES`). No strategy re-enable. No AWS rewrite.
**Evidence sources:** repo `main @ 44e66d4`; read-only SQL against the Apex Supabase project (21:38–21:40 UTC); Vitest run `84 files / 1298 tests`.

## 0. Verdict in one screen

| # | Item | Class | Status |
|---|---|---|---|
| 1 | `sess_1790091200890_9q7egp` — −$94.19 TF stop-losses in `weak_trend` | **Working as designed** | Confirmed against DB + code (§2.1) |
| 2 | Kill switch on 8 consecutive losses | **Working as designed** | Confirmed (§2.2) |
| 3 | Post-halt signal denies (`runtime_state: kill_switch_active` ×19) | **Working as designed** | Confirmed (§2.3) |
| 4 | Prior sessions `hkub8j` 18 filled orders / 5 fills, `3z950m` 3 / 0 | **MUST-FIX bug** | Root cause found; fixed in [PR #76](https://github.com/lukebarhoumeh/apex-automata/pull/76) (§3) |
| 5 | `hkub8j` fills 17/18 persisted with `session_id = NULL` | **MUST-FIX bug** (same rows, same PR) | Fixed in [PR #76](https://github.com/lukebarhoumeh/apex-automata/pull/76) (§3.3) |
| 6 | FE: blocked signal vs rejected order copy | **SHOULD-FIX (copy only, not paper-blocking)** | Documented, no PR (§4.1) |
| 7 | FE: kill-ON banner | **SHOULD-FIX (UX gap, not paper-blocking)** | Documented, no PR (§4.2) |
| 8 | FE: disabled strategy chips | **Working as designed** | Confirmed (§4.3) |
| 9 | FE: Command-palette "kill switch" is a placeholder toast | **SHOULD-FIX** (found during audit) | Documented, no PR (§4.4) |
| 10 | Docs drift: `CLAUDE.md` says Momentum enabled; guardrails SoT has it killed | **Docs drift** | Noted (§5) |

Only #4/#5 met the bar "clear MUST-FIX paper bug" → exactly one fix PR opened, per the brief.

---

## 1. Stack state (SoT, not rediscovered)

- **Guardrails SoT** (`atlas/config/guardrails.yaml`): `disabled_strategies: [vwap_mr, breakout, momentum]`. Only **trend_follow** reaches order routing in paper. `pnpm check:config` → `OK — single-source guardrails and desk pins intact`.
- **Kill threshold:** `consecutiveLossLimit = CONSECUTIVE_LOSS_LIMIT || 8` (`trading-engine.ts`, Phase 2.7 bump 5→8 with rationale in-line).
- **Live lock:** `POST /api/engine/start` with `mode: live` returns `Live trading is blocked. Set CONFIRM_LIVE=YES…` (`server.ts`). Untouched.
- **Session scoping (PR #71/#72/#73/#74 chain):** `orders` / `fills` / `signals` / `positions` are stamped with `session_id` / `execution_mode`; FE blotters read by the active `session_id`.

### Healthy session — `sess_1790091200890_9q7egp` (DB, 2026-09-22 15:39 → 17:30 UTC)

| Table | Result |
|---|---|
| `orders` | 11 rows, 11 `filled`, 11 fill rows — **1:1, healthy** |
| `positions` (closed) | 5 × `trend_follow` / `stop_loss`, Σ `realized_pnl_usd` = **−94.19** |
| `signals allowed=true` | 6 × `trend_follow` |
| `signals allowed=false` | 19 × `runtime_state: kill_switch_active`, 2 × `cross_venue: cross_venue_opposing_position` |

Matches the desk SoT exactly. No integrity defect in this session.

---

## 2. Working as designed (do not "fix")

### 2.1 TF stop-losses in `weak_trend` (−$94.19)

- `trend-follow` declares `regimeCompatibility`: `strong_trend: optimal (1.0×)`, `weak_trend: compatible (0.7×)`, `ranging`/`choppy: incompatible (refuse to emit)`. The registry gates incompatible regimes before `generateSignals` runs.
- `weak_trend` is therefore an *allowed, reduced-size* regime by design. Five stops at 0.7× sizing over ~2 h in a market that never developed into `strong_trend` is the expected loss profile of a trend strategy in chop — it is the cost of being positioned when the trend does arrive. This is the Phase-3 verdict, not a regression.
- **What would be a bug:** TF emitting in `ranging`/`choppy`, or a stop not firing. Neither occurred: all 5 exits are `stop_loss`, and 0 `time_stop`/`manual_exit` leaks.

### 2.2 Kill switch at 8 consecutive losses

- `risk-engine.ts`: `consecutiveLosses` increments only on **closed** losing trades (not on order failures) and `risk:killswitch:triggered` fires at `>= consecutiveLossLimit` (8).
- `trading-engine.ts`: on trigger the engine goes `halted`, does **not** stop, and does **not** auto-close positions (HeroStatePanel copy: "positions NOT auto-closed" — accurate).
- **Streak reconstruction from `positions.closed_at` (DB):** after the last winner (`BTC-PERP-INTX take_profit +2.26`, 00:54 UTC) the closes run `−7.48, −26.27, −38.72, −9.33, −15.28, −17.40, −15.71` (6 in `hkub8j`, the last four being the 03:35 engine-stop flatten `manual_exit`s) then `−20.42` (15:42) and `−15.51` (**16:51:47, loss #8**) in `9q7egp`. The streak survives the restart because `risk-engine.ts` reloads `consecutive_losses` from the persisted risk state unless `resetRiskStateOnStart` is set — by design. The 19 `kill_switch_active` denies and the three later `stop_loss` closes (exits stay allowed) all sit after 16:51:47. Correct.
- **Design observation (not a bug, desk call):** 4 of the 8 counted losses were shutdown-flatten `manual_exit` closes, not strategy exits. If the desk wants the consec-loss kill to measure *strategy* quality only, exclude `manual_exit`/`session_end` from the streak. Left as-is per "no strategy changes".

### 2.3 Post-halt signal denies

- `server.ts` route gate: `if (!isExitSignal && (paused || dailyStopHit || killSwitch.active))` → signal is **recorded** with `allowed=false`, `reason='runtime_state: kill_switch_active'` and never reaches order routing; exits are still allowed.
- 19 such rows in `9q7egp` = the strategy kept producing entries after the halt and every one was denied and audited. This is the intended audit trail (signals are written even when blocked, "for auditability").

---

## 3. MUST-FIX: fills lost across paper sessions — root cause

### 3.1 Symptom (DB, read-only)

| session | orders | filled | fill rows | surviving `fills.trade_id` |
|---|---|---|---|---|
| `sess_1790091200890_9q7egp` | 11 | 11 | 11 | `1,2,3,4,5,6,7,8,9,10,11` |
| `sess_1790017457369_hkub8j` | 18 | 18 | **5** | `12,13,14,15,16` |
| `sess_1790016001996_3z950m` | 3 | 3 | **0** | — |
| `sess_1790015739698_cvjy53` | 3 | 3 | 3 | `NULL, NULL, NULL` (pre-P3 rows, no collision because NULLs are distinct) |

The surviving ids tell the whole story: `hkub8j` is missing exactly `trade_id` 1–11, which are exactly the ids `9q7egp` wrote.

### 3.2 Root cause (code)

1. `PaperTradingSimulator.recordFill` → `trade_id: ++this.fillSequence`. A **per-process integer** that restarts at 1 on every engine start and on `reset()`.
2. `public.fills` has `fills_user_trade_key UNIQUE (user_id, trade_id)` (migration `20260203000001_step7_persistence_hardening.sql`).
3. `server.ts → syncFillToSupabase` upserts with `onConflict: FILLS_UPSERT_ON_CONFLICT = 'user_id,trade_id'`.

→ Fill #k of a new paper session **upserts over** fill #k of the previous session. The old row keeps its PK but its `order_id`, `session_id`, `price`, `filled_at`… are rewritten to the new fill. The earlier session silently "loses" the fill; the filled `orders` row stays, hence "filled orders > fills".

`3z950m` (3 fills, ids 1–3) was overwritten by `hkub8j` (ids 1–18), which was in turn overwritten 1–11 by `9q7egp`. Single user → single collision domain across **every** paper session ever run.

This was a **known, documented, unimplemented** handoff: `persistence/fill-row.ts` header listed "P3 trade_id policy: exchange trade_id (live) / `paper-${sessionId}-${seq}` (paper)" as pending.

### 3.3 Second defect on the same rows: shutdown-flatten fills lose their stamp

`hkub8j` fills `17`/`18` (03:35:21 UTC, the engine-stop flatten) exist but have `session_id = NULL`, so the session-scoped blotter cannot see them either.

- `order:filled` handler: `broadcast → await syncOrderToSupabase → await syncFillToSupabase`, and `syncFillToSupabase` read `currentSessionStamp()` **after** the first await.
- `POST /api/engine/stop`: `await tradingEngine.stop()` (does not await the listener) → `closeTradingSession()` sets `activeSessionStamp = null`.
- Race: fills 15/16 got the stamp; 17/18 read it after it was cleared. Only 2 fills since 2026-09-20 have `session_id IS NULL` — exactly these two.

### 3.4 Fix — [PR #76](https://github.com/lukebarhoumeh/apex-automata/pull/76) (persistence + api only; simulator and Coinbase internals untouched)

- `persistence/fill-row.ts` — `resolveFillTradeId()`:
  - live → exchange `trade_id` unchanged;
  - paper → `paper-<sessionId>-<seq>` (unique across sessions and processes);
  - defensive fallback `paper-<orderId>-<seq>` if no stamp is present (client order UUID is unique per order);
  - already-namespaced ids pass through (idempotent on replay).
  - Paper detection: `session.executionMode === 'paper'` **or** the simulator's `fee_side_source: 'simulated'` marker.
- `api/server.ts` — `order:filled` captures `currentSessionStamp()` synchronously before its first `await` and threads it into `syncOrderToSupabase` / `syncFillToSupabase` → `buildFillRow({ session })`.
- Tests: 9 new cases in `fill-row.test.ts`; pre-fix 6 fail (incl. the two-session collision reproduced with **two real `PaperTradingSimulator` instances**, both emitting raw `trade_id: 1`); post-fix `84 files / 1298 tests` pass. `tsc --noEmit`: 9 pre-existing errors before and after.
- Not in scope / not possible: back-filling the overwritten rows (data is gone). `cvjy53`'s `NULL` trade_ids are pre-existing and harmless.

### 3.5 Verification for DB Eng after merge + one paper session

```sql
-- expect: every paper session filled == fills, and every paper trade_id is namespaced
SELECT o.session_id,
       count(*) FILTER (WHERE o.status='filled')            AS filled_orders,
       count(f.id)                                          AS fill_rows,
       count(f.id) FILTER (WHERE f.trade_id LIKE 'paper-%') AS namespaced
FROM orders o LEFT JOIN fills f ON f.order_id = o.id
WHERE o.execution_mode='paper' AND o.created_at > '2026-09-22'
GROUP BY 1 ORDER BY 1 DESC;
-- expect 0 after the fix
SELECT count(*) FROM fills WHERE session_id IS NULL AND filled_at > now() - interval '1 day';
```

---

## 4. Frontend audit (desk items) — classification

### 4.1 Blocked signal vs rejected order copy — SHOULD-FIX (copy only)

- `src/hooks/apex/useSignalsData.ts`: `state = row.allowed === false ? "REJECTED" : "ACCEPTED"`. A gate-blocked *signal* (`runtime_state: kill_switch_active`, `cross_venue…`, disabled strategy) renders as **REJECTED** in `SignalStreamPanel`, `MetaModelHero` ("REJECTED" counter), and `LiveSignalFeed` (`REJECT` kind).
- `src/components/apex/orders/*`: an *order* the venue/simulator refused (post-only miss, risk deny) is also **REJECTED** (`OrderBlotter`, `OrderDetailPanel` "Reject reason", `OrdersKpiStrip`).
- Two different facts share one word. In `9q7egp` that produced "19 REJECTED" on the Signals page next to "0 Rejected" on Orders, which reads as a contradiction.
- **Recommended copy (no logic change):** signals → `BLOCKED` (+ tooltip with `reason`), orders keep `REJECTED`. Touch points: `SignalState` type + `mapSignalRecord`, `SignalStreamPanel` filter options, `MetaModelHero` counter label, `LiveSignalFeed` `REJECT` → `BLOCKED`.
- Not paper-blocking: data is correct, only the label is ambiguous.

### 4.2 Kill-ON banner — SHOULD-FIX (UX gap)

- The persistent `KillSwitchBanner` component exists but is only mounted in `src/_archive/pages_original/Index.tsx` — **not in the active `AppShell`**.
- Active shell shows halt state in three places, none persistent across routes as a banner: `HeroStatePanel` `HALTED` pill (dashboard only), sidebar chip `engine halted` (`AppSidebar`), and the EngineControls Kill button toast.
- Backend exposes what a banner needs: `/api/status.killSwitch { active, reasons }` (already consumed by `useDashboardData` to derive the `halted` mode) and the `RiskEvent` WS broadcast.
- **Recommendation:** mount a slim halt banner in `AppShell` above `<Outlet>` driven by the same `killSwitch` block. Not paper-blocking: the halt is visible on the dashboard and in the sidebar; it is just not route-persistent.

### 4.3 Disabled strategy chips — working as designed

- `src/lib/strategy-policy.ts` overlays the guardrails policy (`/api/strategies` + policy) so killed strategies show once with `disabledBy: "guardrails"`.
- `StrategyCards`: label `Disabled · guardrails`, tooltip citing `guardrails.yaml → disabled_strategies`, inert stats (no fake "0"). `StrategyConfigCard`: pill `DISABLED · GUARDRAILS` + "killed in guardrails.yaml disabled_strategies — no signal reaches order routing", parameters marked "not loaded". Engine-offline state distinguished (`Off · engine stopped`).
- Chips are correct for the current SoT (`vwap_mr`, `breakout`, `momentum` killed).

### 4.4 Found during audit: Command-palette kill switch is a placeholder

- `src/components/apex/shell/AppShell.tsx` → `handleKillSwitch` only toasts `"Kill-switch pressed (placeholder)" / "Wire to /runtime/kill in Phase 3."`. The palette entry `flatten all positions kill switch` therefore does nothing.
- The real kill path works via `EngineControls` → `POST /api/engine/kill`. Risk: an operator using ⌘K under stress gets a toast instead of a halt.
- **Recommendation:** reuse `killEngine()` from `EngineControls.tsx` in `handleKillSwitch`, or remove the palette entry until wired. SHOULD-FIX; not paper-blocking because the primary control is wired.

---

### 4.5 Other observations from the DB pass (no action required now)

- A `SOL-USD` position stamped `sess_1790015739698_cvjy53` closed at 02:53 UTC while `hkub8j` was the active session — the hydrated-open-position restamp gap, already fixed on `main` by PR #74 (merged 2026-09-22). Expected to be zero in sessions started after that merge.
- `BTC-USD` closed `take_profit` with `realized_pnl_usd = −7.48` at 00:54:39.930, 8 ms after `BTC-PERP-INTX take_profit +2.26`. Both are **shorts with identical** `entry_price 86396.37`, `exit_price 86170.06`, at-entry `take_profit_price 86085.98`. Facts: (1) the P&L gap (−7.48 vs +2.26 on the same prices) is pure venue fee drag — Coinbase spot ~40 bps taker vs perps 5 bps — i.e. the negative-EV spot venue doing what the Phase-3 verdict said; (2) `exit_price` did **not** reach the at-entry TP for a short (86170 > 86086), so either the TP was re-anchored in flight (`trading/reanchor-stop-tp.ts` — `positions.take_profit_price` only stores the entry value) or the `exit_reason` label is inaccurate. Not root-caused here (out of scope). Hand-off to Risk: if TP-hit-rate analytics are used, persist the *effective* TP at exit or confirm the re-anchor path stamps the reason correctly.
- Spot `BTC-USD` **short** positions exist in paper. `guardrails.yaml` notes spot shorts are "blocked at execution level" on the live spot adapter; the paper simulator does not enforce that. Paper-only realism gap; irrelevant while `CONFIRM_LIVE` is locked, but it inflates paper short activity relative to what live spot could do.

## 5. Docs drift (no code impact)

- `CLAUDE.md` "Active Strategies" says Momentum is enabled and "produces most signals"; guardrails SoT has `momentum` in `disabled_strategies` and the DB shows only `trend_follow` signals. Update on the next docs pass; guardrails wins.
- `AGENTS.md`/`CLAUDE.md` test counts (38/529, 42/548) are stale — current baseline is **84 files / 1298 tests**.

---

## 6. Explicitly out of scope (per brief)

- No strategy re-enable (momentum stays killed; TF chop losses are design, §2.1).
- No `CONFIRM_LIVE` change.
- No AWS / deploy rewrite.
- No FE PR — items §4.1/4.2/4.4 are copy/UX and are handed off with exact file pointers.
