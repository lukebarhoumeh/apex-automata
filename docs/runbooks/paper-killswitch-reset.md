# Paper Kill-Switch Reset Runbook

> **Audience:** on-call operator running the **paper** engine. **Premise:** the kill switch tripped (streak / daily stop / manual), the halt state is now stale, and you want the paper session trading again without a phantom halt lingering in Supabase.

> **Scope:** PAPER ONLY. None of the paths below are approved for `EXECUTION_MODE=live`. A live halt is a desk decision, not an ops reset.

> **Last updated:** 2026-09-10. **Code of record:** `atlas/apps/core-node/src/trading/risk-engine.ts` (`loadRiskState`, `deactivateKillSwitch`, `persistClearedRiskState`), `atlas/apps/core-node/src/trading/risk-state.ts`, `atlas/apps/core-node/src/api/server.ts` (`POST /api/killswitch/deactivate`). **Single-user id:** `b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f` (`USER_ID` in `server.ts`).

---

## Symptoms

Any of the following after a paper restart or after pressing "Resume" in the UI:

- UI banner shows the kill switch / `HALTED` while the engine log says it is trading (or vice versa).
- `GET /api/risk/status` returns `killSwitchActive: true` with `consecutiveLosses` still at the old streak count.
- `risk_metrics.kill_switch_active = true` for the user id above even though the engine was restarted "clean".
- `risk_events` rows for the user with `active = true` and `cleared_at IS NULL` that are hours or days old (the UI's `useActiveRiskEvents` and the Grafana "active halts" panel both query `WHERE active = true`).
- Kill switch deactivates and then re-trips within ~5 seconds.

## Why this happens (the bug, and what the 2026-09-10 fix changed)

The risk engine keeps its halt state in memory and mirrors it to Supabase on a **5-second metrics tick** (`updateMetrics()` -> `persistMetrics()`). Three code paths cleared memory without writing that mirror:

| Path | Before the fix | After the fix |
|------|----------------|---------------|
| `loadRiskState()` finds a `risk_metrics` row from a **previous day** | Zeroes `dailyPnL`, `maxDrawdown`, `consecutiveLosses`, `killSwitchActive` **in memory only**. The DB row keeps `kill_switch_active = true` until the next tick happens to overwrite it — never, if the engine is stopped first. | Eagerly upserts the cleared row and sweeps `risk_events.active = true` -> `false` for the user (`source: day_boundary`). |
| `loadRiskState()` with `ignorePersistedKillSwitch` (`PAPER_RESET_RISK_STATE_ON_START=true`) | Same memory-only clear. | Same eager upsert + sweep (`source: startup_reset`). |
| `deactivateKillSwitch()` (`POST /api/killswitch/deactivate`, `POST /api/risk/killswitch {active:false}`) | Flipped the in-memory flag and returned. Persistence waited for the next tick. Worse: `consecutiveLosses` was **never reset**, so if the halt was a losing streak the next tick saw `consecutiveLosses >= limit` and re-halted — the resume was a no-op. `risk_events` only ever got `cleared_at` stamped; `active` stayed `true` forever, and the API's own manual-kill-switch insert (`event_type = 'kill_switch'`) was never cleared at all. | Resets the streak counters (`consecutiveLosses`, error-rate/latency windows), eagerly upserts `risk_metrics`, sweeps `risk_events`, and only then resolves — the HTTP response reports success once the DB agrees. Daily P&L is intentionally **not** re-anchored (see Path 2 caveat). |

Two things that did *not* change and that you should know about:

- `RiskStateMachine.loadPersistedState()` is not wired into startup. The state machine always boots `RUNNING`; only `RiskEngine.killSwitchActive` is restored from `risk_metrics`, and only for a same-day row. That is why a same-day halt survives a restart without the reset flag (by design — parity with live) and a previous-day halt does not.
- Persistence failures are logged (`Failed to persist risk metrics`, `Failed to clear stale risk_events`) and swallowed. A Supabase outage never turns a successful in-memory resume into an API error, but it does mean you must **verify** (below) rather than trust the 200.

---

## Path 1 (preferred): restart paper with `PAPER_RESET_RISK_STATE_ON_START=true`

Use when the engine can be restarted. This is the only path that also re-anchors the weekly equity tracker to the current paper balance.

1. Stop the engine (keeps the API process alive):
   ```bash
   curl -X POST localhost:3001/api/engine/stop
   ```
2. Set the flag in `.env` at the repo root (read by `dotenv` at **process** start, consumed in `TradingEngine.initializeRiskEngine()` at **engine** start):
   ```bash
   PAPER_RESET_RISK_STATE_ON_START=true
   ```
3. Restart the backend process so the new env is loaded:
   ```bash
   pm2 restart apex-backend --update-env      # pm2 deployments
   # or: Ctrl-C the `pnpm api` terminal and re-run `cd atlas/apps/core-node && pnpm api`
   ```
4. Start the engine in paper mode:
   ```bash
   curl -X POST localhost:3001/api/engine/start \
     -H 'Content-Type: application/json' \
     -d '{"mode":"paper"}'
   ```
5. Confirm in `atlas/var/logs/api-server.jsonl` (or `pm2 logs apex-backend`) that all three lines appear, in this order:
   - `Paper mode overrides active (divergence from live)` with `resetRiskStateOnStart` listed
   - `Resetting persisted risk state for clean session start` (only logged if today's persisted row was dirty; a previous-day row is discarded by the day-boundary branch first and logs `Risk metrics from previous day detected, starting fresh` instead)
   - `Eagerly persisting cleared risk state` with `source: 'startup_reset'`, followed by `Cleared stale active risk_events`
6. Run the [verification checklist](#verification-checklist).
7. **Set the flag back to `false`** and restart the backend again when convenient. Leaving it on means every paper restart silently discards halt state, which defeats paper/live parity (`docs/risk-parity.md`).

## Path 2: `POST /api/killswitch/deactivate` while the engine is running

Use when you want to resume without a restart. The engine **must be running** — if `tradingEngine` is `null` the endpoint only clears the supervisor's in-process flag and touches nothing in Supabase; fall back to Path 1.

```bash
curl -X POST localhost:3001/api/killswitch/deactivate \
  -H 'Content-Type: application/json' \
  -d '{"confirm":"RESUME TRADING"}'
```

Expected: `{"success":true,"message":"Kill switch deactivated - trading can resume"}` and a `KillSwitchDeactivated` WebSocket broadcast. Log lines: `Kill switch deactivated` (with `wasActive`), `Eagerly persisting cleared risk state` (`source: 'manual_resume'`), `Cleared stale active risk_events`.

Caveats:

- **Daily-stop halts re-trip by design.** `deactivateKillSwitch()` clears streak counters but does not re-anchor `dailyStartEquity`; if the day's realised loss still exceeds `risk.daily_loss_limit` the next 5-second tick halts again. Either wait for the UTC day rollover, use Path 1, or — paper only, and understand that it rewrites today's `daily_equity` start row — call `POST /api/risk/reset/daily` first.
- `POST /api/risk/killswitch` with `{"active": false}` does the same thing without the confirmation phrase. Prefer the confirmed endpoint.

## Path 3 (last resort, offline): direct SQL against `risk_metrics` / `risk_events`

> **Document only.** This section exists so the path is written down once, with its guardrails. It is not something to run casually, and engineering agents must never execute it. **TM/Luke applied this once on 2026-09-10** to unstick the paper session before the code fix landed; with the fix in place Paths 1 and 2 should make it unnecessary.

Preconditions — all of them:

1. The engine is **stopped** (`POST /api/engine/stop`) and stays stopped until you are done. A running engine's 5-second tick will overwrite `risk_metrics` with its in-memory (still-halted) view within seconds of your update.
2. You are targeting **exactly one** `user_id`: `b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f`.
3. You touch **only** `public.risk_metrics` and `public.risk_events`.

**Forbidden.** Do not `UPDATE`/`DELETE`/`TRUNCATE` any of: `orders`, `fills`, `positions`, `exchange_credentials`, `agentic_heartbeats`. They are the audit trail and the credential store; a "reset" that touches them is an incident, not a fix.

```sql
-- Paper kill-switch reset — LAST RESORT. Engine must be STOPPED first.
-- Scope: exactly one user_id AND the paper rows only. Touches ONLY
-- risk_metrics + risk_events. The `execution_mode = 'paper'` predicate keeps
-- a live session's row/halts untouched (TASK_014 P5); if the column does not
-- exist yet (migration 20260910205000_risk_state_execution_mode not applied)
-- there is exactly one row per user and the predicate must be dropped.
BEGIN;

UPDATE public.risk_metrics
SET kill_switch_active   = false,
    consecutive_losses   = 0,
    daily_pnl            = 0,
    max_drawdown         = 0,
    -- error_rate is NOT part of the 2026-09-10 one-off. Added here because a
    -- restored error_rate >= 20 re-trips the switch on the first tick after
    -- restart (orderHistory is empty, so nothing recomputes it downward).
    error_rate           = 0,
    updated_at           = now()
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
  AND execution_mode = 'paper';

UPDATE public.risk_events
SET active     = false,
    cleared_at = COALESCE(cleared_at, now())
WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f'
  AND execution_mode = 'paper'
  AND active = true;

COMMIT;
```

Expected row counts: `risk_metrics` -> 1 (one row per `(user_id, execution_mode)` once the migration is applied; `UNIQUE (user_id)` before it), `risk_events` -> however many stale paper halts had accumulated (0 is fine).

Then restart the engine (Path 1 steps 4-6 without the flag) and run the verification checklist.

---

## Verification checklist

Run after any path. Read-only.

- **API:**
  ```bash
  curl -s localhost:3001/api/risk/status | jq '{killSwitchActive, consecutiveLosses: .metrics.consecutiveLosses, dailyPnL: .metrics.dailyPnL}'
  curl -s localhost:3001/api/status | jq '{engineRunning, killSwitch, risk}'
  ```
  Expect `killSwitchActive: false` and `consecutiveLosses: 0` from `/api/risk/status` immediately. In `/api/status`, `killSwitch.active` flips to `false` immediately; `risk.killSwitchActive` is refreshed from the 5-second metrics tick, so allow one tick before reading it.
- **Supabase (read-only, Dashboard SQL editor or `psql`):**
  ```sql
  SELECT execution_mode, kill_switch_active, consecutive_losses, daily_pnl, max_drawdown, error_rate, updated_at
  FROM public.risk_metrics
  WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f';

  SELECT execution_mode, count(*) AS stale_active_halts
  FROM public.risk_events
  WHERE user_id = 'b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f' AND active = true
  GROUP BY execution_mode;
  ```
  (Drop the `execution_mode` column from both statements if the migration has not been applied yet.)
  Expect `kill_switch_active = false`, `consecutive_losses = 0`, `stale_active_halts = 0`, and `updated_at` within the last minute.
- **Stability:** wait two metrics ticks (~10 s) and re-run the API check. If `killSwitchActive` flipped back to `true`, read the `KILL SWITCH TRIGGERED:` log line — it names the guardrail that is still genuinely breached (usually daily loss), which no reset path is meant to override.
- **UI:** the kill-switch banner clears and the active risk-events list is empty after the next realtime event or a hard refresh.

## Related

- `docs/risk-parity.md` — why the reset flag defaults to `false` and what the other `PAPER_*` overrides do.
- `docs/risk.md` — guardrail inventory and halt reason codes.
- `atlas/apps/core-node/src/__tests__/risk-engine-killswitch-persist.test.ts` — the regression suite for the persistence fix described above.
