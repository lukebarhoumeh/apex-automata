# Action Plan — 2026-04-22 (morning after overnight paper run)

Written 2026-04-22 03:55 UTC at the end of a long debugging session. This file is the single source of truth for what to tackle next. Pair with the commit history on `main` from `dad6aaf` onward.

---

## Before anything else — verify the overnight run

If you left the engine running overnight, pull two numbers before touching code:

```sql
-- From Supabase (public.positions)
SELECT
  exit_reason::text,
  COUNT(*),
  SUM(realized_pnl_usd)::numeric(10,2) AS pnl_usd,
  AVG(EXTRACT(EPOCH FROM (closed_at - opened_at)))::int AS avg_hold_sec
FROM positions
WHERE opened_at > '2026-04-22 03:34:00+00'
  AND closed_at IS NOT NULL
GROUP BY exit_reason;
```

**Interpretation cheat-sheet:**
- Mostly `stop_loss` exits with short hold times (<5 min) → P1 TP bug (below) is dominating; R/R is broken, not the edge
- Mix of `stop_loss` + `take_profit` with reasonable holds → strategies have edge, we tune from there
- Many `time_stop` exits → positions aren't trending, momentum might be firing in the wrong regime

Then check engine state:
```
git log -5 --oneline     # should end with 2293dac URGENT B
curl -s http://localhost:3001/api/status | head -c 200  # engineRunning state
```

If engine stopped on its own overnight, grep backend log for `engine:fatal` / `supervisor` to see why.

---

## P0 — Strategy coherence (the "not stepping on each other" work)

**Why now:** observed live at 03:00–03:31 UTC:
- Momentum fired both BUY (RSI 39.7) and SELL (RSI 56.7) on ETH-PERP-INTX within the same second
- Momentum opened ETH-USD LONG while ETH-PERP-INTX SHORT was already open — same asset, opposite direction, different venues

**What to build:** a new `SignalArbitrator` layer that sits between `signal-processor.ts` (generates signals) and the server's `signal:generated` handler (places orders).

```
signal-processor → [SignalArbitrator] → signal:generated → createOrder
```

Responsibilities:
1. **Per-symbol direction lock.** While a position is open on `symbol X`, reject any new signal in the OPPOSITE direction unless it's explicitly a reversal signal (e.g., strength > 0.8 with a documented regime change).
2. **Cross-venue asset netting.** Treat `ETH-USD` and `ETH-PERP-INTX` as one position bucket keyed by base asset. Reject signals that would result in opposing exposure on the same base.
3. **Intra-window dedup.** If the same `(strategy, symbol, side)` fires twice within 60 sec, drop the later one (keep the first — momentum RSI crosses are real edge; rapid re-fires are noise).
4. **Log every rejection** with the reason + source signal ID so you can audit coherence decisions later.

Where to put it: new file `atlas/apps/core-node/src/strategies/signal-arbitrator.ts`. Inject it in `server.ts` between the `signal:generated` listener and the existing disabled-strategy gate. Should reuse the `PositionTracker.getAllPositions()` API to know what's currently open.

**Estimate:** 2–3 hours including tests.

---

## P1 — Take-profit math is catastrophically wrong on perps

**Observed (session `sess_1776826808443_y8aorc`):**
- BTC-PERP SHORT: entry 76,157 · stop 76,476 (+319) · TP **76,139 (-18)** — R/R is ~1:17 against you
- ETH-PERP SHORT: entry 2,324 · stop 2,334 (+10) · TP **2,322 (-1.76)** — R/R is ~1:6 against you

**Not a strategy-code bug at first glance.** `momentum-strategy.ts:238-239` looks right:
```ts
stopLoss: currentPrice - stopDistance,        // stop for LONG
takeProfit: currentPrice + targetDistance,
// …
stopLoss: currentPrice + stopDistance,        // stop for SHORT
takeProfit: currentPrice - targetDistance,
```
where `stopDistance = atr × stopAtr` and `targetDistance = atr × takeProfitAtr`. Default `stopAtr=2`, `takeProfitAtr=4`. So `targetDistance` should be **2× `stopDistance`**, not 1/17th.

**Diagnostic path:**
1. Log the signal at generation time:
   ```ts
   this.logger.info('Signal emitted', { id, symbol, direction, stopLoss, takeProfit, atr, stopDistance, targetDistance });
   ```
   Add to `momentum-strategy.ts` near line 239 and line 285 (both signal createSignal calls).
2. Log the position record right before DB upsert in `server.ts syncPositionToSupabase`:
   ```ts
   logger.info('Position sync', { id, symbol, side, entry_price, stop_price_at_entry, take_profit_price });
   ```
3. Start engine, wait for a momentum signal, compare the two logs.

**Suspects (in order):**
- `positionTracker.processFill()` accepts `context.stopPrice` + `context.takeProfit` but also has fallback logic. Something downstream may be clobbering `takeProfit` with a tighter value.
- `server.ts:1631+` (signal-generated handler) reads `signal.takeProfit` into the order's metadata — look for any `Math.min` or clamp.
- Guardrails' per-symbol overrides for `takeProfitAtr` — SOL-USD has no override in guardrails; BTC-USD has overrides for `breakout` and `vwap_mr` but not momentum; ETH-USD momentum has `takeProfitAtr: 4.0`. So defaults should be correct. But worth double-checking that ETH-PERP-INTX inherits from somewhere (or gets class defaults).

**Estimate:** 1.5–2 hours. This one is pure debugging, low code change once found.

---

## P2 — Rate limiter loosening

**Symptom:** My monitor at 4 req/min gets 429'd constantly. Your browser during the session got zeroed-out UI because the frontend's React Query polling hit the same wall.

**File:** probably `atlas/apps/core-node/src/api/server.ts` — grep for `rateLimit` or `express-rate-limit`.

**Fix:** bifurcate the limit:
- Read endpoints (`/api/status`, `/api/analytics/*`, `/api/risk/*`, `/api/regime/*`, `/api/strategies`, `/api/metafilter/*`) — raise to 300/min or remove the limit (the engine runs behind a firewall anyway)
- Write endpoints (`/api/engine/start|stop|kill`, any config mutations) — keep strict, 10/min

**Estimate:** 30 min.

---

## P3 — Orphan positions cleanup on session start

**Symptom:** 4 positions from pre-fix sessions still have `closed_at IS NULL` in Supabase. They don't affect trading because positionTracker doesn't know about them, but `useOpenPositions` in the Dashboard will include them.

**Fix:** in `server.ts openTradingSession()` (around line 256), before inserting the new session row, run:
```sql
UPDATE positions
SET closed_at = NOW(),
    exit_reason = 'session_end',
    exit_price = entry_price,
    realized_pnl_usd = 0
WHERE user_id = $1 AND closed_at IS NULL;
```
Or do it via Supabase `.update().is('closed_at', null)`.

Rationale: when an engine restarts without cleanly stopping, anything left open belongs to a dead tracker. Either it recovers via reconciliation or it's an orphan — neither should bleed into the new session's UI.

**Estimate:** 20 min including a one-shot query to clean the existing orphans today.

---

## P4 — Add `system` to the strategy_name enum

**Symptom:** stop-loss exit orders get `strategy: 'system'` tag, which isn't in the enum. `normalizeStrategy()` falls back to `'breakout'` with a WARN. The orders table shows `breakout` for exits — confusing when reviewing.

**Fix:** migration:
```sql
ALTER TYPE public.strategy_name ADD VALUE IF NOT EXISTS 'system';
```
Then in `server.ts normalizeStrategy()`: include `'system'` in the valid list.

**Estimate:** 20 min.

---

## P5 — Frontend self-heal on rate-limit / session change

**Symptom:** when the engine restarts, the frontend's session-change invalidation + simultaneous 429s can leave all apex hooks in a pending-retry state, showing an empty dashboard.

**Fixes (pick a subset):**
1. In `ActiveSessionProvider`, after `invalidateQueries({queryKey:["apex"]})`, explicitly trigger a refetch with 1s delay.
2. Add `window.online` listener that triggers apex cache invalidation.
3. Increase React Query's retry backoff on 429 to exponential (they're retrying too aggressively).
4. Add a top-level error boundary that says "Connection lost — refreshing…" with a manual refresh button.

**Estimate:** 30–45 min depending on how many of the four you ship.

---

## Sequencing

**Sprint 1 (do P0 + P1 together, 4–5 hrs):**
Without coherence (P0) we can't interpret fill behavior. Without correct TPs (P1) we're losing money on real trades. These two unlock Sprint 2.

**Sprint 2 (P2 + P3 + P5, 1.5–2 hrs):** ops polish. The session feels good after this.

**Sprint 3 (P4 + metrics instrumentation, 1.5 hrs):** data hygiene, add per-strategy realized-P&L + hold-time dashboards so we can evaluate edge.

**Sprint 4 (strategy refinement, 4–6 hrs):** backtest momentum + trend_follow against 30–90d of candles now that infrastructure is clean. Measure win rate, profit factor, avg R per strategy × regime. Decide what to tune or add.

**Sprint 5 (Hyperliquid migration, 4–8 hrs):** ONLY if Sprint 4 shows edge on Coinbase paper. Otherwise you'd just be moving broken strategies to a cheaper venue.

---

## What's already in `main` as of night-of

All at `origin/main`, green path end-to-end:

```
2293dac URGENT B: mirror perps price into trading-engine marketPrices (risk gate)
59cf352 URGENT A: mirror perps into positionMonitor + positionTracker
d80b69b Phase C:  paper sim now fills perps limits
612958e Phase B:  strategy labels + signal_id + defense-in-depth gate
dad6aaf Phase A:  UI truth — no fake P&L, real market count, no flicker
944a3e2 DB reconciliation — trading_sessions schema matches live
f643c90 Phase 3b — Orders/Signals/Risk wired, Model banner
d5a9f9c Phase 3a — Dashboard wired to real backend + Supabase
83aafaa Phase 2c — ActiveSessionProvider + cache reset on new session
bca72ce Phase 2b — trading_sessions persistence on engine start/stop
5ca8bde Phase 2a — TickerTape live via useLiveTicker
```

**What the infrastructure will do tomorrow before any P0–P5 work:**
- Trades on BTC/ETH/SOL spot + ETH/BTC perps
- Momentum strategy firing; trend_follow silent when market is weak_trend/ranging
- Stops + TPs detect and fire on both spot AND perps
- Orders correctly labeled with strategy + signal_id
- UI shows real P&L, real session stats, real positions — no animation fakes

**What it won't do yet:**
- Block opposing signals on the same symbol from the same strategy (P0)
- Place a sensible TP on perps shorts (P1) — they'll still stop out with bad R/R
- Self-heal the UI when the backend rate-limits (P2/P5)
- Correctly tag system exit orders (P4)

---

## File locations

Tomorrow's first files to open:
- This file: `docs/ACTION_PLAN_2026-04-22.md`
- Coherence layer goes here: `atlas/apps/core-node/src/strategies/signal-arbitrator.ts` (new)
- TP bug investigation starts here: `atlas/apps/core-node/src/strategies/plugins/builtin/momentum-strategy.ts:238-285` then trace into `atlas/apps/core-node/src/trading/position-tracker.ts`
- Rate limiter config: grep `rateLimit` in `atlas/apps/core-node/src/api/server.ts`
- Previous state: `C:\Users\lukeb\.claude\projects\C--Users-lukeb\memory\project_apex_automata_state.md` (auto-loaded into session)

---

## Overnight processes

Status at end of this session (2026-04-22 ~03:55 UTC):
- Backend will be killed: `pnpm backend` process stopped
- Frontend will be killed: `pnpm dev` process stopped
- Coherence monitor will be killed
- All commits pushed to `origin/main`

If you want to resume with a fresh paper run in the morning:
```bash
pnpm backend          # starts engine supervisor, :3001
pnpm dev              # starts Vite, :8080
# then click Start Paper in the TopBar, or:
curl -X POST http://localhost:3001/api/engine/start -H 'Content-Type: application/json' -d '{"mode":"paper"}'
```
