# Apex Automata / AtlasBot v2 — Final Sprint Plan

> **Tracked location since 2026-05-14 (Wave 2 G7).** Previously at `atlas/var/tmp/monitor/` (gitignored).

**Synthesized:** 2026-05-13 17:00 CT (22:02Z)
**Synthesizer:** quant-dev sprint planner
**Scope:** Post-2026-05-13 paper run + Supabase Pro upgrade + accumulated workstream backlog
**Source-of-truth status:** This file. Multiple parallel subagents will execute against it.

---

## 0. Executive summary (60-second scan)

- **Run verdict.** 8 trades / 0 wins / `−$96.29` realized PnL / `$89.64` fees / `−$111.08` daily PnL net / `1.11%` peak drawdown / kill switch tripped on 8th consecutive loss. **Fees consumed 93.1 % of gross losses.** Strategy emission was healthy (30 signals → 9 trades = 30 % funnel pass), so the live engine itself is honest; the loss is fee/edge-geometry driven, not engine-broken.
- **The single biggest economic lever is venue.** Round-trip taker on Coinbase spot is ~80 bps. On Hyperliquid perps it is ~9 bps. **8.9× improvement.** Re-pricing today's tape at HL fees would have moved the realized loss from `−$96` to `≈ −$17`. Strategies remain negative-EV on raw price action at current params, but become *survivable* on HL — they currently are not survivable on Coinbase.
- **The single biggest engineering bug is the backtest funnel-latch.** Live takes 30 signals/day; backtests take 12 signals total regardless of window length, all in the first 36–48 simulated hours. Three `Date.now()` sites in the strategy pipeline (`signal-processor.ts:1046,1058`, `signal-arbiter.ts:184,415`, `meta-filter.ts:529,533,998,1095`) latch state by wall-clock time, killing all post-startup signals when the engine is fed historical bars. Fix this and we can finally measure HL EV with statistical significance.
- **Risk Desk UI is mathematically wrong.** `useRiskData.ts:121` uses the heuristic `Math.abs(ddFrac) * (Math.abs(ddFrac) <= 1 ? 100 : 1)`, which **double-multiplies** when the backend already reports drawdown in percent (`maxDrawdownPct: 1.11` becomes `111 %`; `maxDrawdown: 0.05` becomes `5.46 %`; the user sees `12.4 %` when actual is `1.11 %`). Same hook also falls back to `ACCOUNT_EQUITY_INITIAL = 10_000` when analytics is null, hiding live equity drift. Both are CRITICAL Wave-1 fixes.
- **Four pages return literal mock seed data.** `useModelData.ts`, `useBacktestData.ts`, `useJournalData.ts`, `useAlertsData.ts` all do `Promise.resolve(SEED_*)`. Zero backend wiring.
- **Schema drift is worse than the research file estimated.** Two competing migrations create `positions` (`20251013171848` UUID/user-id flavor and `20251013180100` TEXT-id/service-role flavor); the second silently no-ops. But the backend code (`position-tracker.ts:153`) reads a *third* schema (`qty_open`, `opened_at`, `closed_at`, `realized_pnl_usd`, `stop_price_at_entry`, `take_profit_price`) which only emerges via subsequent corrective migrations (`20251016_fix_trading_tables.sql`, `20260203_step8_pnl_columns.sql`, etc.). 10 of 42 migrations are corrective patches. Consolidation must introspect the live DB first.
- **Paper-mode perps fee accounting is wrong.** ETH-PERP-INTX trades today show ~65 bps round-trip fees (spot rate) instead of ~10 bps (perps INTX rate from `guardrails.yaml`). Either the paper-mode router sends perps through the spot adapter, or the FeeModel is hardcoded. **Quant impact:** if paper has been mis-pricing perps for weeks, every backtest/paper EV number for a perps symbol is biased by ~55 bps round-trip — which is bigger than most strategies' edge. **Treat as Wave-1 bug.**
- **Pro plan upgrade is correct and cheap.** Realistic monthly Supabase bill: $25–28 with branching, no PITR, no log drains. The biggest non-obvious win is patching `auth.uid()` → `(SELECT auth.uid())` in RLS for ~100× speed-up on large tables.
- **Ship targets.** 14-day Hyperliquid paper run with > 0 % net return after fees; 100 % UI parity (no mock cards); 548/548 (verified 2026-05-14) backend tests; Edge Functions 11 → 4; alerts firing real events on real triggers; Trade Journal real with at least one entry; signal funnel diagnostic chart visible in Backtest UI.

---

## 1. Run snapshot — quantitative facts of record

### 1.1 Engine state at synthesis time (22:02Z / 17:02 CT)

```
engineState           : stopped
engineDesiredState    : stopped
runtimeAlive          : true (supervisor up; engine subprocess down)
warmupComplete        : true
candlesBuffered       : 200 each for ETH-USD, SOL-USD, BTC-USD, ETH-PERP-INTX, BTC-PERP-INTX
killSwitch.active     : true
killSwitch.reasons    : ["User activated kill switch"]
killSwitch.since      : 1778709210429 (2026-05-13T21:53:30Z = 16:53 CT)
exchangeHealth        : null (engine off)
restartCount          : 0
```

### 1.2 Risk state

| Metric | Value | Threshold | Headroom |
|---|---|---|---|
| `dailyPnLUsd` | `−$111.08` | `−$200` (`−2 %` of `$10 000`) | $89 left |
| `maxDrawdownPct` | `1.11 %` | `15 %` (`max_drawdown_limit`) | 13.89 pp left |
| `consecutiveLosses` | reset to 0 (engine stopped) | 8 (env `CONSECUTIVE_LOSS_LIMIT`, `trading-engine.ts:841`) | tripped at 8 |
| `exposureUsd` | $0 (flatten_on_shutdown) | per-symbol caps | n/a |
| `dailyStopHit` | false | n/a | the consec-loss circuit fired first |

### 1.3 Trade book — 8 closed trades, 2026-05-13

| # | Time UTC | Symbol | Side | Strategy | Notional | PnL | Fees | Exit |
|---|---|---|---|---|---|---|---|---|
| 1 | 19:34→20:10 | BTC-USD | long | trend_follow | $1,528 | `−$8.03` | $9.91 | take_profit |
| 2 | 19:39→19:44 | BTC-PERP-INTX | long | trend_follow | $1,436 | `−$12.35` | $9.30 | stop_loss |
| 3 | 20:19→20:35 | SOL-USD | short | momentum | $2,703 | `−$24.37` | $17.64 | stop_loss |
| 4 | 20:29→20:33 | BTC-USD | short | trend_follow | $1,683 | `−$14.31` | $10.98 | stop_loss |
| 5 | 20:34→20:36 | BTC-USD | long | trend_follow | $1,457 | `−$12.29` | $9.43 | stop_loss |
| 6 | 20:48→21:10 | SOL-USD | short | trend_follow | $1,749 | `−$6.84` | $11.37 | take_profit |
| 7 | 21:04→21:10 | ETH-USD | short | trend_follow | $1,613 | `−$9.05` | $10.50 | take_profit |
| 8 | 21:04→21:10 | ETH-PERP-INTX | short | trend_follow | $1,613 | `−$9.05` | $10.50 | take_profit |
| | | **TOTALS** | | | **~$13,782 gross notional** | **`−$96.29`** | **$89.64** | |

**Strategy split:** trend_follow 7 trades / momentum 1 trade.
**Exit split:** stop_loss 4 / take_profit 4.
**Pair observation (CRITICAL):** trades 7+8 (ETH-USD + ETH-PERP-INTX) share entry/exit time-to-the-millisecond and identical price. Same applies to several earlier paired entries. Confirms the paper engine emits the same signal to both spot and perp variants of an asset, doubling fees and exposure. This is by design (per current router) but needs explicit policy: **on HL we only need the perp; we shouldn't be paying spot fees on ETH-USD when the EV is in the perp**.

### 1.4 Fee math

| Quantity | Value | Note |
|---|---|---|
| Avg notional per trade | $1,723 | gross/trades |
| Avg fee per trade | $11.21 | sum/trades |
| Avg single-side fee bps | ~32.5 | $11.21 / $1,723 / 2 |
| Avg round-trip fee bps | ~65 | matches Coinbase Advanced Trade tier 4 (40 bps × 2 with mix) |
| Fees as % of gross loss | **93.1 %** | $89.64 / $96.29 |
| Risk per trade (configured) | $50 | guardrails `risk_per_trade: 0.005` × $10k |
| Effective risk (incl. fees) | $50 + $11 = ~$61 | fees are 22 % of intended risk unit |

**Quant interpretation:** with 65 bps round-trip and 1× ATR stop on a typical 0.05 % ATR % asset, fees alone consume 24 % of the stop distance. The strategy needs to win at least `~1.30R` per win (vs `~1.0R` per loss) just to break even on fees. Today the avg take-profit win was actually `−$8.74` (already a loss after fees) because the take-profit was set at `4 ATR` but the exit price was within fee-of-entry. **The TP geometry is rationally sized for the price move but irrationally sized given fee drag.**

### 1.5 Hyperliquid economic re-pricing (today's tape)

| Quantity | Coinbase actual | Hyperliquid projected | Δ |
|---|---|---|---|
| Round-trip taker bps | ~65 | 9 | −56 bps |
| Total fees (8 trades) | $89.64 | $12.42 | **−$77.22** |
| Realized PnL | `−$96.29` | `−$96.29` | (price moves identical) |
| Net of fees | `−$185.93` | `−$108.71` | +$77.22 |
| dailyPnLUsd (engine-tracked) | `−$111.08` | `≈ −$33.86` | +$77.22 |
| `−2 %` daily stop hit? | No (1.11 %) | No (~0.34 %) | safer |
| Consec-loss kill triggered? | Yes (8) | Likely yes (same trade outcomes) | not solved by venue alone |

**Quant verdict:** HL alone is necessary but **not sufficient**. We still need either better strategies, better regime gates, or longer holding periods to climb out of negative EV on the strategy mix. HL turns "catastrophic" into "survivable so we can iterate".

### 1.6 Signal funnel (live, today)

| Stage | Count | Survival |
|---|---|---|
| Strategy emits | 30 (13 momentum + 17 trend_follow) | 100 % |
| Reached executor (became orders) | ~9 | 30 % |
| Filtered out | ~21 | 70 % |

**Per-stage breakdown is pending** — will be reconstructed by Workstream H5 (signal-arbitration analysis subagent). Today's pulse log (`run-2026-05-13_1433.log`) does not surface per-stage funnel counters; the `recordSignalFunnel` instrumentation exists in `signal-processor.ts:1024-1059` but the pulse harness only polls `/api/metafilter/decisions?limit=10` — H5 will add `/api/strategies/funnel` snapshot capture next run.

### 1.7 Pulse-monitor false positives

`atlas/var/tmp/monitor/pulse.sh:84` regex `"maxDrawdownPct":(0\.[1-9]|[1-9])` fires when drawdown crosses `0.1 %`, not `10 %`, because the field is already in percent units, not a fraction. Today's alerts log has 22 false positives. **Workstream E5 trivial fix.**

### 1.8 Migration drift — three competing `positions` schemas

| Migration | Creates `positions` | Key columns | Verdict |
|---|---|---|---|
| `20251013171848_*` | yes (`CREATE TABLE`) | UUID id, user_id FK auth.users, entry_price, current_price, pnl, pnl_r, time_opened, time_closed | original Lovable-era UI schema |
| `20251013180100_trading_tables.sql` | yes (`CREATE TABLE IF NOT EXISTS`) | TEXT id, no user_id, average_price, market_price, unrealized_pnl, realized_pnl, open_time, last_update_time | silent no-op in prod (table already exists) |
| Backend code expects | (read by `position-tracker.ts:152-176`, `api/server.ts:330,340,4238`) | qty_open, opened_at, closed_at, entry_price, stop_price_at_entry, take_profit_price, realized_pnl_usd, exit_reason | **third schema, evolved via `20251016_fix_trading_tables.sql` + `20260203_step8_pnl_columns.sql` + others** |

**Confirmed by code grep:** `position-tracker.ts:153` SELECT lists columns that exist in NEITHER initial migration. The deployed table is the additive result of ~5 corrective migrations on top of the original `20251013171848` shell. **Migration consolidation MUST introspect the live DB before squashing**, or it will silently fail.

### 1.9 Edge Functions inventory (confirmed by glob)

11 functions present in `supabase/functions/`. Per Phase 2.2 of `supabase-pro-research.md` and confirmed:
- **Active (4):** `runtime-health`, `journal-entry`, `risk-settings-update`, `strategy-signal-upsert`
- **Dead (7):** `ingest-position-update`, `ingest-risk-metrics`, `ingest-order-event`, `ingest-fill`, `ingest-alert`, `alerts-ack`, `strategy-toggle`

Workstream D2 deletes the 7 dead.

### 1.10 Frontend mock vs. real wiring

| Page | Hook | Status | Backend endpoint(s) needed |
|---|---|---|---|
| Risk | `useRiskData.ts` | **REAL but BUGGY** (calc errors) | exists; just fix maths |
| Model | `useModelData.ts` | **MOCK** (`Promise.resolve(MODEL_SEED)`) | `/api/metafilter/stats`, `/api/metafilter/decisions`, `/api/metafilter/performance` (already exist) |
| Backtest | `useBacktestData.ts` | **MOCK** (`Promise.resolve(BACKTEST_SEED)`) | new: `/api/backtest/runs`, `/api/backtest/runs/:id` (read `atlas/var/backtest_results/*.json`) |
| Journal | `useJournalData.ts` | **MOCK** (`Promise.resolve(JOURNAL_SEED)`) | new: `/api/journal/entries` (CRUD) + new `trade_journal` table |
| Alerts | `useAlertsData.ts` | **MOCK** (`Promise.resolve(ALERT_*_SEED)`) | new: `/api/alerts/rules`, `/api/alerts/fired` + alert evaluator + transports (Resend, Twilio) |

### 1.11 Other facts captured

- Hyperliquid kill switch double-locked: `hyperliquid.enabled: false` in YAML AND `HYPERLIQUID_ENABLED` env required. Adapter present in code (`atlas/apps/core-node/src/exchanges/hyperliquid/`) but signal routing not wired.
- Cold streak threshold (`meta-filter.ts:210`) defaults to 10 — would have triggered AFTER risk-engine kill (8). The risk-engine is the harder of the two stops.
- ML outcomes tracker captures 32 signals, 9 outcomes recorded — this is signal-capture telemetry only, not an actual ML model.
- Today's run had 0 restarts, healthy WS, healthy REST, no degraded states.

---

## 2. Workstream definitions

Each workstream gets: **rationale → tasks → expected outcome → parallel-safety**. Per-task detail (file paths, effort, risk, deps, owner subagent, success criteria, test plan) lives in **Section 3**.

### A. Trading Engine Core
**Rationale.** Today's run proved the engine is mechanically sound and the strategies emit at a healthy rate. The losses come from (i) fee geometry, (ii) TP set too tight relative to fees, (iii) the consec-loss kill firing on a normal sequence of bad luck. Tune the parameters that we have empirical evidence to tune.

**Tasks.** A1 strategy parameter retune; A2 ATR multiplier review; A3 fee-adjusted min-position-sizing; A4 circuit-breaker tuning (8 → 10–12 with cooldown ramp); A5 wire `recordTradeOutcome` from BacktestEngine to MetaFilter; A6 signal-arbiter regime-conditional gate experiment.

**Outcome.** A param set that, on the next paper run, produces fewer false take-profits below fee floor and lets the bot survive normal losing streaks.

**Parallel-safety.** A1+A2+A3 can run in parallel (config edits in `guardrails.yaml`). A4 touches `risk-engine.ts` + env. A5 touches `BacktestEngine` + tests. A6 touches `signal-arbiter.ts`. All four merge cleanly because they touch disjoint code regions.

### B. Exchange Layer
**Rationale.** Coinbase spot is provably negative EV at current strategy params. Hyperliquid is the only viable venue at our scale. The adapter exists but is locked. Until it's wired, every paper-trade dollar lost is meaningless to the live thesis.

**Tasks.** B1 Hyperliquid adapter completion (signal routing, credential path, kill-switch unlock procedure); B2 venue selector per symbol (explicit, not implicit); B3 funding-rate signal integration (1h funding as regime input); B4 per-venue fee config audit (verify FeeModel reads `guardrails.yaml.fees`, not hardcoded — **today's data suggests it doesn't**); B5 paper-mode perps fee accounting fix (perps trades currently charged at spot rate).

**Outcome.** A 14-day HL paper run becomes mechanically possible with correct fee accounting, and the next backtest can be re-run on HL with the right realism.

**Parallel-safety.** B1 (adapter completion) is the largest piece and blocks B2 + B5. B3 is independent. B4 is a code audit (independent).

### C. Frontend / UI / UX
**Rationale.** Per locked-in user decisions (sprint-plan-staging §150-161): five pages move from mock to real, plus a critical Risk Desk fix.

**Tasks.** C1 Risk Desk math fix (drawdown + equity); C2 Model page wired to rule-based meta-filter (no ML mocks); C3 Backtest page wired to real CLI output; C4 Trade Journal as real feature (schema + API + UI); C5 Alerts page real wiring (Resend + Twilio + rules engine); C6 dashboard polish (clean placeholder/garbled times in signal feed if any).

**Outcome.** 100 % UI parity. No more "this is mock data" caveats anywhere.

**Parallel-safety.** C1 frontend-only; C2/C3/C5 each need a backend endpoint added (server.ts changes); C4 needs DB migration + API + UI (largest). C6 cosmetic. C1+C6 can land in Wave 1; C2+C3 in Wave 2; C4+C5 in Wave 3.

### D. Database / Supabase (Pro plan utilization)
**Rationale.** Pro upgrade unlocks specific wins enumerated in `supabase-pro-research.md`. The biggest single performance lever is the RLS `(SELECT auth.uid())` patch. The biggest single hygiene lever is consolidating 42 migrations to ~8.

**Tasks.** D1 migration consolidation (BLOCKED, see decision gates); D2 delete 7 dead Edge Functions; D3 delete `supabaseRealtimeBridge.ts`; D4 centralize `createClient` calls (13 → 1); D5 RLS `auth.uid()` perf patch; D6 re-enable Branching (after D1); D7 `pg_cron` for nightly reconciliation; D8 `pgmq` evaluation (recommend defer); D9 Supabase budget alert at $50/mo; D10 coalesce realtime position-update messages.

**Outcome.** Stable, observable, cheap-to-operate Supabase footprint that survives schema evolution without silent drift.

**Parallel-safety.** D2/D3/D5/D9/D10 are all independent and parallel-safe. D1 is on a blocking path (needs decision-gate D-MIG-CONSOL). D4 follows D1 + D2. D6 follows D1. D7 + D8 standalone migrations.

### E. Observability
**Rationale.** Pro gives us a Prometheus-compatible metrics endpoint + 7-day log retention. We already have `deploy/monitoring/` Prometheus + Grafana — wire it up. Plus fix today's pulse-alert false-positive bug.

**Tasks.** E1 Pro metrics endpoint → existing Prometheus stack; E2 saved log queries in Supabase Studio (4 queries); E3 frontend error tracking (Sentry — DECISION GATE); E4 trade lifecycle audit log integrity check; E5 pulse-monitor regex fix (today's known bug); E6 backtest report archival (promote post-monitor-fixes to `docs/`, gzip stdout dumps).

**Outcome.** End-to-end visibility from frontend to Supabase to engine. Alert false-positives gone.

**Parallel-safety.** E1–E6 fully independent.

### F. Backtest System
**Rationale.** The funnel-latch bug killed the entire May 11 4-run matrix's statistical value. Fix it, then re-run. Then add HL fee schedule. Then wire CLI output to UI.

**Tasks.** F1 funnel residuals fix (3 backtest-only `Date.now()` sites); F2 wire `recordTradeOutcome` into BacktestEngine for cold-streak parity; F3 re-run May 11 4-run matrix on current main HEAD post-fixes; F4 new Hyperliquid backtest run on same data; F5 backtest CLI output → Supabase `backtest_runs` table for `/backtest` UI page wiring (C3 dependency).

**Outcome.** Backtest produces statistically meaningful EV measurements that the UI can display.

**Parallel-safety.** F1 + F2 must precede F3. F3 + F4 are sequential (same matrix, different fee schedule). F5 follows F3/F4.

### G. Documentation / Hygiene
**Rationale.** Several docs are stale. `env.example` is missing 90 % of required vars. No secret-rotation runbook. No Pro-plan setup runbook. `go_live_criteria` block is operationally undefined.

**Tasks.** G1 `env.example` completion; G2 secret rotation runbook; G3 Supabase Pro setup runbook; G4 CoinDesk integration A/B procedure docs; G5 `go_live_criteria` operational doc (what does `manual_approval_required: true` mean?); G6 CLAUDE.md/AGENTS.md updates (remove ML aspirational language once C2 lands; verify test count = 548/548 (verified 2026-05-14)).

**Outcome.** Onboarding-ready repo. New operator can spin up paper from `git clone` to first signal in < 30 min.

**Parallel-safety.** All independent (different files).

### H. Strategy Research / Analysis
**Rationale.** Real questions we now have data to answer: (i) what's the min ATR move that nets positive at HL fees? (ii) what's the per-stage signal funnel today? (iii) is the consec-loss circuit too tight? (iv) does CoinDesk sentiment improve EV? (v) is May 21 CoinDesk sunset confirmed?

**Tasks.** H1 HL backtest comparison (depends on F1+F2+F4); H2 fee-adjusted min-profitable-trade-size analysis at HL fees; H3 regime-conditional strategy enable/disable proposal; H4 CoinDesk sentiment A/B kickoff (post C2 + C5); H5 signal-arbitration analysis (per-stage funnel chart); H6 drawdown/consec-loss circuit-breaker review with quantified trade-off; H7 CoinDesk free-tier sunset May 21 confirmation (with sales OR alternative provider).

**Outcome.** Strategy decisions are data-backed, not vibes-backed.

**Parallel-safety.** H1 sequential after F. H2/H3/H5/H6 independent analysis. H4/H7 are external/blocking.

### I. Infrastructure / DevOps
**Rationale.** PM2 ecosystem just merged but untested. Cloud Agent VM cannot resolve external DNS, breaking Supabase from CI. Branch protection and PR templates would have caught the migration-drift PRs in review.

**Tasks.** I1 PM2 ecosystem config functional test; I2 Cloud Agent VM secret-injection (since `.env` no longer in git, alternative for CI); I3 CI/CD pipeline review; I4 branch protection rules on `main`; I5 PR template (force fee-impact analysis on strategy changes; schema review on migration changes).

**Outcome.** Code lands safely; secrets stay out of git; tests run on every PR.

**Parallel-safety.** All independent.

### J. Compliance / Risk
**Rationale.** Live-trading switchover requires answering: are daily/weekly/DD limits well-tuned? Is `flatten_on_shutdown` actually flattening in prod? What's the kill-switch deactivation procedure?

**Tasks.** J1 daily/weekly/max-DD limit revalidation post-strategy-tune; J2 pre-live-trading checklist tied to `go_live_criteria`; J3 audit-trail completeness verification; J4 `flatten_on_shutdown: true` flatten-actually-runs-in-prod test; J5 kill-switch deactivation procedure documentation (someone needs this to restart after today).

**Outcome.** When the user says "go live," there is a single paged checklist and they walk down it.

**Parallel-safety.** All independent docs/tests.

---

## 3. Per-task detail

### Workstream A — Trading Engine Core

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **A1** | Tune momentum + trend_follow params for HL fee floor | Today's TPs at 4× ATR closed at near-entry (avg `−$8.74` net of fees per "win"). Raise TP to ≥ 6× ATR for HL, drop stop slightly. Re-validate from H2's min-profitable-trade-size analysis. | `atlas/config/guardrails.yaml` (per_symbol + perps_symbols + hyperliquid_symbols blocks) | M | Med (worse params can hurt next paper run) | H2 | generalPurpose | New params committed; backtest with old vs new on May 11 data shows higher avg win-multiple after fees | Run F4 backtest with both param sets; tabulate avg win$, avg loss$, expectancy |
| **A2** | ATR multiplier audit (stop 2.0 → keep, TP 4.0 → 5.0) | TPs are firing too close to entry on Coinbase fees, becoming losses after fees. Raising TP forces winners to actually move. | Same as A1 | S | Low (config-only) | A1 | generalPurpose | Same as A1 | Same as A1 |
| **A3** | Fee-adjusted min-position-sizing | Add a check: if predicted-EV-after-fees < 0, don't enter. Read from FeeModel + risk per trade. | `atlas/apps/core-node/src/trading/order-manager.ts` (new pre-trade EV check); `atlas/apps/core-node/src/trading/risk-engine.ts` (gate) | M | Med (could over-filter and block entries) | A1 (params first) | generalPurpose | Pre-trade EV gate logged on every signal; rejects logged in `signals` table with `reason: 'eEV_negative'` | Unit test: simulate a signal with known fee/strength/ATR, assert blocked vs passed |
| **A4** | Loosen consec-loss kill 8 → 10 with progressive cooldown | The 8-consec kill is statistically aggressive (expected once per ~256 trades at 50 % WR). Move to 10 with a 2× cooldown ramp on the 6th, 8th losses. | `atlas/apps/core-node/src/trading/trading-engine.ts:841` (CONSECUTIVE_LOSS_LIMIT default); `atlas/apps/core-node/src/trading/risk-engine.ts:1114` (kill check); `atlas/config/guardrails.yaml` add `circuit_breakers.max_consecutive_losses` + `cooldown_ramp` | M | Med (looser kill = bigger drawdowns possible if strategies degrade) | H6 | generalPurpose | Env-overridable; unit-tested cooldown ramp; default reads from yaml not env | `risk-engine` unit tests; integration test in trading-engine |
| **A5** | Wire `recordTradeOutcome` from BacktestEngine to MetaFilter | Currently MetaFilter only sees outcomes when `signalProcessor.recordTradeOutcome` is called from `api/server.ts:3158` (live path). Backtest never calls it → cold-streak never accumulates → backtest doesn't reflect live behavior. | `atlas/apps/core-node/src/backtesting/backtest-engine.ts` (call `signalProcessor.recordTradeOutcome` per closed trade); `atlas/apps/core-node/src/__tests__/backtest-engine.test.ts` | M | Low (additive call) | F1 | generalPurpose | Backtest run shows non-zero `coldStreakActive` events when ≥ `coldStreakThreshold` losses accumulate | Run backtest on a known losing window; assert `signalProcessor.getMetaFilter().getStats()` shows cold streak fired |
| **A6** | Signal-arbiter regime-conditional gates | Today: 30 signals → 9 trades = 70 % filtered. Quantify which filter rejects most. Then: trend_follow only when `regime.adx > 25`; momentum only when `regime.atrPercent` in `[0.0005, 0.02]` and not "ranging". | `atlas/apps/core-node/src/strategies/signal-arbiter.ts`; `atlas/config/guardrails.yaml` (filters block) | M | Med (over-gating may cause "no trades" days) | H5 | generalPurpose | Per-stage funnel logged; new gates produce ≥ 5 trades/day on a normal-regime tape | Replay May 11 + May 13 tape through the arbiter with old vs new gates; tabulate signal counts |

### Workstream B — Exchange Layer

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **B1** | Complete Hyperliquid adapter signal routing | Adapter exists in `atlas/apps/core-node/src/exchanges/hyperliquid/index.ts` but the engine never sends signals to it. Wire (i) `OrderManager.routeOrder()` to consult venue selector; (ii) HL adapter's `placeOrder` to talk to `https://api.hyperliquid.xyz/exchange`; (iii) HL fills → `position-tracker.applyFill()`. | `atlas/apps/core-node/src/exchanges/hyperliquid/index.ts`, `atlas/apps/core-node/src/exchanges/hyperliquid-init.ts`, `atlas/apps/core-node/src/trading/order-manager.ts`, `atlas/apps/core-node/src/api/server.ts` (env unlock + signal route) | XL | High (real venue, real money path) | DECISION D-HL-TIMING | generalPurpose + manual review | HL testnet order placed end-to-end; fill received; position tracked; round-trip on testnet < 2 s | Testnet integration test: place 1 test order, assert fill, assert position state machine transitions correctly |
| **B2** | Explicit per-symbol venue selector | Today the BTC-USD/ETH-USD/SOL-USD spot symbols and the BTC-PERP-INTX/ETH-PERP-INTX symbols are routed implicitly by symbol prefix. Make it explicit in `guardrails.yaml`: `venue_routing: { BTC-USD: hyperliquid, ETH-PERP-INTX: hyperliquid, ... }`. | `atlas/config/guardrails.yaml` (new `venue_routing` block); `atlas/apps/core-node/src/exchanges/exchange-registry.ts` (read it); `atlas/apps/core-node/src/trading/order-manager.ts` (route on it) | M | Low | B1 | generalPurpose | A signal for `ETH-PERP-INTX` routes to HL only; spot variants drop or route to HL-perp | Unit test: feed router a signal, assert chosen adapter |
| **B3** | Funding-rate signal integration | HL exposes 1h funding via `/info`. When funding is heavily skewed (e.g., > +50 bps/8h), bias entry against the crowd. Add as a regime input. | `atlas/apps/core-node/src/exchanges/hyperliquid/index.ts` (`getFundingRate(symbol)`); `atlas/apps/core-node/src/strategies/regime-detector.ts` (consume) | M | Low | B1 | generalPurpose | `regime.fundingRateBps` populated for HL symbols; arbiter can read it | Unit test on regime-detector with synthetic funding values |
| **B4** | FeeModel reads `guardrails.yaml.fees` block (no hardcoded constants) | Audit `atlas/apps/core-node/src/core/fee-model.ts` and any callers; assert all fee constants come from yaml. Today's perps trades suggest the spot rate is being applied to perps, indicating the FeeModel is venue-blind. | `atlas/apps/core-node/src/core/fee-model.ts`; grep for `0.004`, `0.0040`, `40 * 0.0001` etc. across `atlas/apps/core-node/src/` | M | Med (fix may change paper PnL accounting) | none | generalPurpose | All fee constants come from yaml; per-venue per-side correct | Unit test: instantiate FeeModel for `coinbase.spot`, `coinbase.perps_intx`, `hyperliquid.perps`; assert correct bps for each |
| **B5** | Paper-mode perps fee accounting fix | Paper mode currently charges spot fees on perp symbols (today's ETH-PERP-INTX trade fees ≈ 65 bps round-trip vs configured 10 bps). Trace router and FeeModel. | `atlas/apps/core-node/src/exchanges/coinbase-perps-adapter.ts`, `atlas/apps/core-node/src/exchanges/coinbase-adapter.ts`, `atlas/apps/core-node/src/core/fee-model.ts` | M | Med (fix changes paper EV — re-baseline needed) | B4 | generalPurpose | Next paper run shows ETH-PERP-INTX fees ≈ $1–2 per trade not $10 | Inject a test perp trade in paper mode; assert fee within 1 bps of expected |

### Workstream C — Frontend / UI / UX

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **C1** | Risk Desk drawdown + equity calculation FIX (CRITICAL) | `useRiskData.ts:121` does `Math.abs(ddFrac) * (Math.abs(ddFrac) <= 1 ? 100 : 1)` — this double-multiplies values already in percent units. Equity falls back to `ACCOUNT_EQUITY_INITIAL = 10_000` when analytics is null. Fix by reading `/api/status.risk.maxDrawdownPct` (single source, unambiguous percent) and `/api/pnl.totalEquityUsd` (single source, dollars). Drop the `≤ 1 ? 100 : 1` heuristic. | `src/hooks/apex/useRiskData.ts` (rewrite `buildPortfolio`); `src/components/apex/risk/RiskHero.tsx` (verify it consumes the fixed values); `src/components/apex/risk/KillSwitchLadder.tsx` (verify thresholds are in PERCENT not fraction) | S | Low | none | generalPurpose | UI shows `0.07 %` drawdown and `$9,889` equity (matches backend) on next paper run | Open `/risk` against running engine; compare values to `/api/status` JSON |
| **C2** | Model page wired to real rule-based meta-filter | Replace `Promise.resolve(MODEL_SEED)` with calls to `/api/metafilter/stats`, `/api/metafilter/decisions?limit=200`, `/api/metafilter/performance`. Repurpose page sections: ColdStreakState (instead of ConfusionMatrix), TimeOfDayHeatmap (instead of CalibrationChart), RecentDecisionsFeed (replace SHAP), MetaFilterHistory (replace TrainingRunsTable). Keep the "no ML loaded" banner. | `src/hooks/apex/useModelData.ts` (rewrite); `src/components/apex/model/*` (rename + repurpose); `src/types/model.ts` (update types) | L | Med (large component changes) | none (backend endpoints exist) | generalPurpose | `/model` shows live cold-streak counter, time-of-day filter state, last 50 meta-filter decisions, with timestamps that update | Manual page open against running engine; real decisions appear |
| **C3** | Backtest page wired to real CLI output | Replace `Promise.resolve(BACKTEST_SEED)`. Add backend endpoints `/api/backtest/runs` (lists files in `atlas/var/backtest_results/`) and `/api/backtest/runs/:id` (returns parsed `backtest_*.json`). Hook reads from there. Remove "+24.38 % Donchian" mock. | `atlas/apps/core-node/src/api/server.ts` (new endpoints); `src/hooks/apex/useBacktestData.ts` (rewrite); `src/components/apex/backtest/BacktestHero.tsx` (use real config); `src/types/backtest.ts` (align with backtest JSON schema) | M | Low | F5 | generalPurpose | `/backtest` lists 4 May-11 runs; selecting one renders correct equity curve, trade log, monthly returns | Manual page open; values match `report_2026-05-11T*.txt` files |
| **C4** | Trade Journal real feature (schema + API + UI) | New `trade_journal` table linking to `trades.id`, with thesis (text), outcome (win/loss), tags (text[]), lessons (text), created_at. New endpoints `/api/journal` (CRUD). UI lets user enter thesis pre-trade (or post-hoc), outcome filled from `trades` row, post-mortem editable. | `supabase/migrations/2026MMDD_trade_journal.sql` (new); `atlas/apps/core-node/src/api/server.ts` (CRUD); `src/hooks/apex/useJournalData.ts` (rewrite); `src/components/apex/journal/JournalCard.tsx` (add edit form); `src/types/journal.ts` (update) | XL | Med (new table + RLS + endpoints) | D6 (after branching re-enabled, OK to land) | generalPurpose | At least 1 user-entered entry visible; entry survives backend restart | Migration applies; insert + read + update + delete via API; UI form saves |
| **C5** | Alerts page real wiring (Resend + Twilio) | `useAlertsData.ts` returns mocks. Replace with `/api/alerts/rules` and `/api/alerts/fired`. Backend evaluator runs on every status broadcast: if rule matches (e.g., DD > 3 %, consec losses ≥ 3, venue latency > 500 ms), insert into `alerts` table + dispatch via Resend (email `lukebarhoumeh11@gmail.com`) + Twilio (SMS `224-343-4320`). | `atlas/apps/core-node/src/runtime/alerts-evaluator.ts` (new); `atlas/apps/core-node/src/runtime/alerts-transport.ts` (Resend + Twilio HTTP); `atlas/apps/core-node/src/api/server.ts` (CRUD); `src/hooks/apex/useAlertsData.ts` (rewrite); env: `RESEND_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ALERTS_EMAIL_TO`, `ALERTS_SMS_TO` | XL | Med-High (real outbound transports — small $ cost; need to throttle) | D6 + DECISION D-NEW-DEPS (Resend + Twilio dep approval) | generalPurpose | A real alert (e.g., trigger "consec losses ≥ 3") fires both email and SMS within 60 s; trigger row visible in UI | Force a 3rd consecutive paper loss; verify email + SMS received; verify trigger log row |
| **C6** | Dashboard polish (signal feed timestamps + minor) | Today's review noted no major issues but a placeholder/garbled times in some panels. Audit `src/components/apex/dashboard/LiveSignalFeed.tsx` and adjacent components for `--:--:--` or NaN displays. | `src/components/apex/dashboard/LiveSignalFeed.tsx`, `KpiRow.tsx`, others as found | S | Low | none | generalPurpose | No `NaN`/`--:--:--`/placeholder strings visible during active engine | Visual review during running engine |

### Workstream D — Database / Supabase

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **D1** | Migration consolidation: 42 → ~8 logical baselines | Squash to: `01_auth_and_profiles.sql`, `02_core_trading_tables.sql`, `03_risk_and_metrics.sql`, `04_signals_and_meta_filter.sql`, `05_ml_outcomes.sql`, `06_indexes.sql`, `07_rls.sql`, `08_seeds.sql`. **MUST introspect live DB first** (backend code expects columns neither initial migration defines — see §1.8). | All of `supabase/migrations/` | XL | **High** (data corruption risk on restore) | DECISION D-MIG-CONSOL; SUPABASE_ACCESS_TOKEN provided OR manual staging via dashboard | generalPurpose | New baseline applies cleanly to a fresh DB; deployed schema unchanged; CI green | (i) `supabase db dump` of live; (ii) apply new baseline to a temp DB; (iii) `pg_diff` shows zero diff |
| **D2** | Delete 7 dead Edge Functions | Remove `ingest-position-update`, `ingest-risk-metrics`, `ingest-order-event`, `ingest-fill`, `ingest-alert`, `alerts-ack`, `strategy-toggle`. Confirm zero callers (already done in research file Phase 2.2). Delete folders + dashboard registrations. | `supabase/functions/{ingest-position-update,ingest-risk-metrics,ingest-order-event,ingest-fill,ingest-alert,alerts-ack,strategy-toggle}/` (delete) | S | Low (already proven unused) | none | shell | 4 functions remain (`runtime-health`, `journal-entry`, `risk-settings-update`, `strategy-signal-upsert`) | `pnpm lint && pnpm test`; deploy + smoke check `/runtime-health` |
| **D3** | Delete dead `supabaseRealtimeBridge.ts` | Per research file §2.4: two managers exist; the bridge is the older shorter version, no callers expected. Verify zero imports, delete. | `src/runtime/realtime/supabaseRealtimeBridge.ts` (delete) | XS | Low | none | shell | File gone; build green | `pnpm build && pnpm lint`; `rg supabaseRealtimeBridge src/` returns zero |
| **D4** | Centralize `createClient()` calls (13 → 1) | New `atlas/apps/core-node/src/persistence/supabase-client.ts` exporting `getSupabaseAdmin()` singleton. Refactor all 13 callers. | New `atlas/apps/core-node/src/persistence/supabase-client.ts`; refactor in `persistence/supabase-writer.ts`, `config/secrets.ts`, `api/server.ts`, `strategies/meta-filter.ts`, `strategies/signal-processor.ts`, `trading/risk-engine.ts`, `trading/position-tracker.ts`, `trading/order-manager.ts`, `trading/trade-analytics.ts`, `trading/risk-state.ts`, `trading/risk-controller.ts`, `ml/trade-outcome-collector.ts`, `backtesting/data-loader.ts` | M | Med (touches every write path) | D1 (after schema stable) | generalPurpose | One `createClient` call total in production code; all paths green | All existing tests pass; integration smoke test for risk + order writes |
| **D5** | RLS auth.uid() perf patch | New corrective migration: wrap `auth.uid() = user_id` as `(SELECT auth.uid()) = user_id` in every policy. Same migration sets `search_path = public, pg_catalog` on `handle_updated_at`, `handle_new_user`. | New migration `2026MMDD_rls_initplan_optimization.sql` | M | Low (semantically equivalent, faster) | D6 (best to test on branch first) | generalPurpose | Performance Advisor `auth_rls_initplan` lint clean; query plans show subquery cached | Run `EXPLAIN ANALYZE SELECT * FROM positions LIMIT 100` before/after; assert improved |
| **D6** | Re-enable Branching with config: Deploy-to-prod OFF, Branch-limit 2, Supabase-changes-only ON | Pro feature; ~$1.34/mo at our PR cadence. Re-enables preview branches per PR. | Supabase Dashboard config; `.github/workflows/db-diff.yml` (new CI gate) | M | Low | D1 (clean baseline first) | shell | Branching active; preview check passes on a sample PR with a no-op SQL change | Open a PR with one trivial migration; verify preview branch spins up + tears down |
| **D7** | `pg_cron` for nightly reconciliation | Schedule (i) hourly equity snapshot from `account_metrics` → `daily_equity`, (ii) nightly `signals` retention purge (90 days), (iii) nightly trade rollup `refresh_strategy_pnl_rollup()`. | New migration `2026MMDD_pg_cron_jobs.sql` (per research §13 SQL) | M | Low | D1 | generalPurpose | `cron.job_run_details` shows successful runs after 24h | Manual `SELECT * FROM cron.job_run_details` 24h after deploy |
| **D8** | `pgmq` evaluation (recommend defer) | Research recommends defer until we have a second worker process. Document the decision in CLAUDE.md. | `CLAUDE.md` (parking lot section) | XS | Low | none | generalPurpose | One-line note "pgmq evaluated, deferred until multi-worker" added | n/a |
| **D9** | Set Supabase budget alert at $50/mo | Dashboard config; spend cap on Pro is also ON by default — verify. | Supabase Dashboard | XS | Low | none | shell | Email alert at $50; spend cap ON | Manual dashboard verification |
| **D10** | Coalesce realtime position-update messages (5–10× msg reduction) | `position-tracker.ts` writes per-tick UPDATE to `positions`. Add a debounce: max 1 UPDATE per second per symbol. | `atlas/apps/core-node/src/trading/position-tracker.ts` | M | Low (write-side only; UI updates 1Hz instead of per-tick) | none | generalPurpose | Realtime msg/min metric drops by 5-10× on next paper run | Run paper for 30 min; compare `atlas_realtime_messages_used` before/after |

### Workstream E — Observability

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **E1** | Wire Supabase Pro metrics endpoint → existing Prometheus stack | Pro feature; one config edit in `deploy/monitoring/prometheus.yml`. | `deploy/monitoring/prometheus.yml` (add `scrape_configs.supabase`) | S | Low | D9 | generalPurpose | Supabase metrics visible in Grafana | Open Grafana, find `supabase_*` metrics |
| **E2** | Saved log queries in Supabase Studio | 4 queries: DB errors 24h, EdgeFn ≥ 500, slow queries > 100ms, RLS denies. Document in `docs/runbooks/supabase-log-queries.md`. | Supabase Dashboard config + new `docs/runbooks/supabase-log-queries.md` | S | Low | none | shell | All 4 saved + documented | Manual dashboard verification |
| **E3** | Frontend error tracking (Sentry — NEEDS APPROVAL) | New dep, blocked by user policy. If approved: `@sentry/react` + `@sentry/node`, wire to a free Sentry tier. | DECISION D-NEW-DEPS | n/a | n/a | DECISION D-NEW-DEPS | generalPurpose | If approved: errors visible in Sentry within 60 s of UI exception | Force a UI error (`throw new Error('test')`); verify Sentry receipt |
| **E4** | Trade lifecycle audit log integrity check | Verify every closed `trade` has matching `fills`, `orders`, `positions` rows. Cross-foreign-key validation script. | New `atlas/apps/core-node/src/cli/audit-trades.ts` | M | Low | none | generalPurpose | Script outputs PASS for May 11 + May 13 sessions | Run script; expect 0 mismatches |
| **E5** | Pulse-monitor regex fix | `atlas/var/tmp/monitor/pulse.sh:84` regex matches drawdown ≥ 0.1 %, not 10 %. Replace with `jq` extraction + numeric comparison. | `atlas/var/tmp/monitor/pulse.sh` | XS | Low | none | shell | Next pulse run does NOT fire `drawdown ≥ 10pct` at 1 % drawdown | Replay against today's `_latest.txt`; expect zero false positives |
| **E6** | Backtest report archival | Promote `report_2026-05-11_post-monitor-fixes.txt` to `docs/`; gzip raw stdout dumps in `_session_2026-05-11/`. | Move + `gzip` (file ops) | S | Low | none | shell | `docs/backtest-reports/2026-05-11_post-monitor-fixes.md` exists; raw dumps gzipped | `ls -lh atlas/var/backtest_results/_session_2026-05-11/` shows `.gz` files |

### Workstream F — Backtest System

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **F1** | Funnel residuals fix — 3 backtest-only `Date.now()` sites | Replace `Date.now()` with `currentBarTime` parameter that backtest passes. Live mode passes `Date.now()`. | `atlas/apps/core-node/src/strategies/signal-processor.ts:1046,1058` (dedup window); `atlas/apps/core-node/src/strategies/signal-arbiter.ts:184,415` (cooldown windows); `atlas/apps/core-node/src/strategies/meta-filter.ts:529,533,1095` (cold-streak cooldown — most critical); plus `meta-filter.ts:998` ID gen (cosmetic) | M | Med (touches hot strategy code paths) | none | generalPurpose | Backtest of May 11 90d window emits > 50 final signals (vs current 12) | Re-run F3 matrix; assert signal count |
| **F2** | Wire `recordTradeOutcome` into BacktestEngine for cold-streak parity | Per A5 — included here for completeness; same task. | Same as A5 | M | Low | F1 | generalPurpose | Same as A5 | Same as A5 |
| **F3** | Re-run May 11 4-run matrix on current main HEAD post-fixes | After F1+F2 land, re-run all 4 windows. Confirm > 12 signals/run. | `atlas/apps/core-node/scripts/run-backtest-matrix.sh` (existing); store under `atlas/var/backtest_results/_session_2026-05-XX/` | L | Low | F1, F2 | shell | All 4 runs produce ≥ 50 trades; reports archived | Script runs to completion; reports exist |
| **F4** | New Hyperliquid backtest run (HL fee schedule) | Same matrix as F3 but with `--commission 0.00045` (4.5 bps taker). Compare EV vs Coinbase. | Same as F3 with `--commission 0.00045` | M | Low | F3 | shell | HL EV measurable with statistical significance (≥ 100 trades total across windows) | Tabulate Coinbase vs HL net PnL, profit factor, Sharpe per window |
| **F5** | Backtest CLI output → Supabase `backtest_runs` table | New table `backtest_runs(id, started_at, config_jsonb, summary_jsonb, trades_jsonb)`. Backtest CLI on completion writes one row. | New migration `2026MMDD_backtest_runs.sql`; `atlas/apps/core-node/src/backtesting/backtest-engine.ts` (write on completion); `atlas/apps/core-node/src/api/server.ts` (`/api/backtest/runs` endpoint) | M | Low | D1 | generalPurpose | Running `pnpm backtest` writes a row visible via `/api/backtest/runs` | Manual: run a backtest, query the endpoint |

### Workstream G — Documentation / Hygiene

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **G1** | `env.example` completion | Add backend vars (SUPABASE_URL, SUPABASE_SERVICE_KEY, ENCRYPTION_KEY, COINBASE_API_KEY, COINBASE_API_SECRET, COINBASE_API_PASSPHRASE, EXECUTION_MODE, MARKETDATA_ENV, RUNTIME_API_URL, RUNTIME_WS_URL, RESEND_API_KEY, TWILIO_*, ALERTS_*, HYPERLIQUID_PRIVATE_KEY, HYPERLIQUID_WALLET_ADDRESS, HYPERLIQUID_ENABLED, CONSECUTIVE_LOSS_LIMIT). With placeholder + comment per var. | `env.example` (rewrite) | S | Low | none | shell | All env vars referenced in code present with comment | `rg 'process\.env\.' atlas/apps/core-node/src` cross-checked |
| **G2** | Secret rotation runbook | Document rotation procedure for SUPABASE_SERVICE_KEY, ENCRYPTION_KEY, COINBASE_*, RESEND_*, TWILIO_*, HYPERLIQUID_PRIVATE_KEY. Include ROLE-OF-LAST-RESORT for incident. | New `docs/runbooks/secret-rotation.md` | S | Low | none | generalPurpose | Doc exists with one-line per secret | Manual review |
| **G3** | Supabase Pro setup runbook | Specific to this project: Pro toggle, Micro compute, branching config, advisors run, metrics endpoint enable, budget alert. | New `docs/runbooks/supabase-pro-setup.md` | M | Low | D6, D9 | generalPurpose | New operator can reproduce setup in 30 min | Self-test by following the doc on a new project |
| **G4** | CoinDesk integration A/B procedure docs | How to enable `meta_filter.coindesk_sentiment.enabled: true`, what to measure, how to compare against control. | New `docs/runbooks/coindesk-ab.md` | S | Low | H4 | generalPurpose | Doc exists | Manual review |
| **G5** | `go_live_criteria` operational doc | Define what `manual_approval_required: true` means in practice. List the human-eyeball checks needed before flipping `EXECUTION_MODE=live`. | New `docs/runbooks/go-live-checklist.md`; cross-reference J2 | M | Low | J2 | generalPurpose | Doc lists ≥ 10 checks | Manual review with operator |
| **G6** | CLAUDE.md / AGENTS.md updates | Once C2 lands, remove "ML aspirational" language. Verify test count is 548/548 (verified 2026-05-14) (was 493/493 in AGENTS.md). | `CLAUDE.md`, `AGENTS.md` | XS | Low | C2 | shell | No "aspirational" mentions of ML; test count current | `pnpm test` — note count, update doc |

### Workstream H — Strategy Research / Analysis

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **H1** | HL backtest comparison after F4 | Tabulate Coinbase vs HL EV per strategy per symbol. Identify best (strategy, symbol, venue) combos. | New `docs/research/2026-05-XX_hl-vs-cb.md` | M | Low | F4 | generalPurpose | Doc with per-strategy verdict + recommendation | n/a |
| **H2** | Fee-adjusted min-profitable-trade-size analysis at HL fees | Compute: with 9 bps round-trip + 5 bps slippage = 14 bps total cost per trade, what's the min ATR move that nets positive at our risk-per-trade ($50)? Solve for ATR % threshold. Output: `min_atr_pct` per symbol. | New `docs/research/2026-05-XX_min-trade-size.md`; informs A1 + A2 | M | Low | none | generalPurpose | Min ATR % per symbol with derivation | n/a |
| **H3** | Regime-conditional strategy enable/disable proposal | Per A6: trend_follow only when ADX > 25; momentum only when ATR % in [0.0005, 0.02] AND not "ranging". Quantify on May 11 + May 13 tape. | New `docs/research/2026-05-XX_regime-gates.md` | M | Low | A6 | generalPurpose | Doc with backtest evidence for proposal | n/a |
| **H4** | CoinDesk sentiment A/B kickoff (post C2 + C5) | Flip `meta_filter.coindesk_sentiment.enabled: true` in yaml; run 4-week paper run with vs without. Compare EV. | `atlas/config/guardrails.yaml`; new `docs/research/2026-MM-DD_coindesk-ab.md` | XL (4-week run) | Low | C2, C5, H7 | generalPurpose | After 4 weeks, doc with verdict | n/a |
| **H5** | Signal-arbitration funnel analysis | Build per-stage funnel diagnostic chart: emit → dedup → regime gate → cold streak → time-of-day → meta-quality → arbiter → executor. Counts per stage. Surface in Backtest UI (C3). | `atlas/apps/core-node/src/api/server.ts` (new `/api/strategies/funnel` endpoint); `src/components/apex/backtest/FunnelChart.tsx` (new) | M | Low | none | generalPurpose | UI shows live + historical funnel chart | Visual on `/backtest` page |
| **H6** | Drawdown / consec-loss circuit-breaker review | Quantify trade-off: 8 vs 10 vs 12 consec loss limit. Probability of false-positive halt at 50 % WR. | New `docs/research/2026-05-XX_circuit-breaker-review.md`; informs A4 | S | Low | none | generalPurpose | Doc with probability table | n/a |
| **H7** | CoinDesk free-tier sunset May 21 — confirm tier | Email CoinDesk sales; confirm whether free tier persists or we need to upgrade. If upgrade > $25/mo, evaluate alternative (e.g., CryptoCompare, Messari). | Communications log; doc decision in `docs/research/coindesk-tier-decision.md` | S (just emails) | Med (8-day deadline) | DECISION D-COINDESK | user (then generalPurpose to document) | Decision made before May 21 | n/a |

### Workstream I — Infrastructure / DevOps

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **I1** | PM2 ecosystem config functional test | PR #12 just merged. Test that `pm2 start ecosystem.config.cjs` brings up frontend + backend + restarts on crash. | `ecosystem.config.cjs` (verify); manual test | M | Low | none | shell | `pm2 status` shows both processes online; killing one auto-restarts | Manual test |
| **I2** | Cloud Agent VM secret-injection alternative | `.env` no longer in git. Need GitHub Actions secret injection or mount-via-secret for Cloud Agent CI. Document the chosen mechanism. | `.github/workflows/ci.yml`; doc in `docs/runbooks/ci-secrets.md` | M | Low | none | generalPurpose | CI run can read SUPABASE_URL, SUPABASE_SERVICE_KEY without `.env` in repo | CI green on a PR |
| **I3** | CI/CD pipeline review | What runs on PR? On merge? Audit and document. | `.github/workflows/*.yml`; doc in `docs/runbooks/ci-pipeline.md` | M | Low | none | generalPurpose | Doc lists each job with trigger + duration | Manual review |
| **I4** | Branch protection rules on `main` | Require PR review, require CI green, no force-push, no direct push. | GitHub repo settings | XS | Low | none | shell | Direct push to `main` blocked; PR with red CI cannot merge | Test by attempting both |
| **I5** | PR template (forces fee-impact + schema review) | Auto-checklist on PRs: "Touches strategy params? Run fee-impact analysis. Touches `supabase/migrations/`? Schema review by code-reviewer." | `.github/PULL_REQUEST_TEMPLATE.md` (new) | XS | Low | none | shell | New PRs render the template | Open a test PR |

### Workstream J — Compliance / Risk

| ID | Title | Description | Files | Effort | Risk | Deps | Owner | Success criteria | Test plan |
|---|---|---|---|---|---|---|---|---|---|
| **J1** | Daily/weekly/max-DD limit revalidation post-strategy-tune | After A1+A4, re-derive daily_loss_limit (-2%), weekly_loss_limit (-5%), max_drawdown_limit (-15%) given the new expected expectancy/volatility. | `atlas/config/guardrails.yaml`; doc decision in `docs/research/2026-05-XX_risk-limits.md` | S | Low | A1, A4 | generalPurpose | Doc with derivation | n/a |
| **J2** | Pre-live-trading checklist tied to `go_live_criteria` | Per G5 — same artifact. Checklist of what must be true before `EXECUTION_MODE=live`. | Same as G5 | M | Low | (artifact merged with G5) | generalPurpose | Same as G5 | n/a |
| **J3** | Audit trail completeness verification | Per `audit_trail_enabled: true` — verify every kill-switch trip, every order rejection, every config change is in `audit_log`. | `atlas/apps/core-node/src/cli/audit-completeness.ts` (new) | M | Low | none | generalPurpose | Script reports PASS for last 7 days | Run script |
| **J4** | `flatten_on_shutdown: true` flatten-actually-runs-in-prod test | Verify on next paper run: stop engine with open position; confirm position is flattened (not just engine stopped). | Manual test | S | Low | none | shell | Open position becomes closed at shutdown; trade record shows exit_reason: 'shutdown' | Manual: open paper position, stop engine, query positions |
| **J5** | Kill-switch deactivation procedure documentation | After today's run, the kill switch is active. Document: (i) check engine state, (ii) review what tripped it, (iii) `POST /api/risk/killswitch/reset` (or whatever the endpoint is), (iv) restart engine. | New `docs/runbooks/kill-switch-reset.md` | S | Low | none | generalPurpose | Operator can reset kill switch in < 2 min following the doc | Self-test against current stopped engine |

---

## 4. Wave plan (parallel-safe execution order)

**Conventions.** "P-safe" = can run in parallel with everything else in the wave (different files / no shared types). Each wave has a **success gate** that must be true before the next wave starts.

### Wave 0 — Mandatory pre-work (sequential, blocking everything)

| ID | Title | Owner | Duration |
|---|---|---|---|
| W0.1 | Kill outstanding `auto-stop.sh` background script (target was 20:34 CT, manual stop happened at 16:57 CT — script still sleeping) | shell | 1 min |
| W0.2 | J5 — Document kill-switch deactivation procedure | generalPurpose | 30 min |
| W0.3 | Reset kill switch (manual) so next paper run can start | user | 1 min |
| W0.4 | E5 — pulse-monitor regex fix (so next paper run doesn't spam alerts) | shell | 15 min |
| W0.5 | G1 — `env.example` completion (so next operator/agent can boot the stack) | shell | 30 min |
| W0.6 | Decisions D-MIG-CONSOL, D-HL-TIMING, D-NEW-DEPS, D-COINDESK answered (see §5) | user | 30 min |

**Success gate W0:** kill switch off, env vars documented, decisions made, no orphaned background scripts. Total wall clock: < 2 hours.

### Wave 1 — Big parallel batch (the bulk of the sprint)

All 19 tasks (D9 + I4 are no-PR ops items) below are P-safe (touch disjoint files, no shared types touched).

| ID | Title | Owner | Estimated effort |
|---|---|---|---|
| C1 | Risk Desk math fix | generalPurpose | S |
| C6 | Dashboard polish | generalPurpose | S |
| D2 | Delete 7 dead Edge Functions | shell | S |
| D3 | Delete `supabaseRealtimeBridge.ts` | shell | XS |
| D5 | RLS auth.uid() perf patch (writeable in Wave 1, deploy in Wave 2 after D6) | generalPurpose | M |
| D9 | Supabase budget alert at $50/mo | shell | XS |
| D10 | Coalesce realtime position-update messages | generalPurpose | M |
| E1 | Pro metrics endpoint → Prometheus | generalPurpose | S |
| E2 | 4 saved log queries | shell | S |
| E4 | Trade lifecycle audit log integrity check | generalPurpose | M |
| E6 | Backtest report archival | shell | S |
| F1 | Funnel residuals fix (3 `Date.now()` sites) | generalPurpose | M |
| F2 | `recordTradeOutcome` in BacktestEngine | generalPurpose | M |
| G2 | Secret rotation runbook | generalPurpose | S |
| G6 | CLAUDE.md / AGENTS.md updates (test count + ML language) | shell | XS |
| H2 | Fee-adjusted min-trade-size analysis | generalPurpose | M |
| H6 | Circuit-breaker review (informs A4) | generalPurpose | S |
| I4 | Branch protection rules | shell | XS |
| I5 | PR template | shell | XS |

**Success gate W1:** all 19 tasks (D9 + I4 are no-PR ops items) merged green; backend tests still 548/548 (verified 2026-05-14); lint clean; `/risk` page shows correct numbers on a quick paper smoke test.
**Wall clock estimate:** 1.5–2 days with full parallelization.

### Wave 2 — Wave-1-dependent work

| ID | Title | Owner | Effort | Depends on |
|---|---|---|---|---|
| A1 | Strategy param retune (HL-fee aware) | generalPurpose | M | H2 |
| A2 | ATR multiplier tweak | generalPurpose | S | A1 |
| A3 | Fee-adjusted min-position-sizing | generalPurpose | M | A1, B4 |
| A4 | Loosen consec-loss kill 8 → 10 | generalPurpose | M | H6 |
| A5 | (same as F2 — already done in Wave 1) | — | — | — |
| A6 | Signal-arbiter regime-conditional gates | generalPurpose | M | H3 (which can run in W1 too) |
| B4 | FeeModel reads `guardrails.yaml.fees` audit | generalPurpose | M | none (could be W1; placed here to feed B5) |
| B5 | Paper-mode perps fee accounting fix | generalPurpose | M | B4 |
| C2 | Model page wired to real meta-filter | generalPurpose | L | (no backend change needed; can start W1 if capacity) |
| C3 | Backtest page wired to real CLI output | generalPurpose | M | F5 |
| D1 | Migration consolidation (collapse 51 files into ~5 baseline) | generalPurpose | XL | DECISION D-MIG-CONSOL |
| D7 | `pg_cron` jobs | generalPurpose | M | D1 |
| **D11** | **`meta_filter_decisions` schema gap restore** — `ALTER TABLE ADD COLUMN user_id UUID, outcome TEXT, pnl DECIMAL(18,8), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` + backfill `user_id` strategy + re-add 7 indexes + unstub `20260107000002_*.sql` | generalPurpose | M | none (Wave 1 drift fix stubbed the file — see project memory) |
| **D12** | **Root `pnpm-lock.yaml` workspace unification** — root lockfile's `importers:` is missing `atlas/apps/core-node`; `pnpm install --frozen-lockfile` fails. Stash@{1} from `experiment/pnpm-workspace-consolidation` has a draft fix. Removes the `--no-frozen-lockfile` workaround from backtest-gate.yml. | generalPurpose | M | none (independent of D1 migration consolidation) |
| F3 | Re-run May 11 4-run matrix | shell | L | F1, F2 |
| F4 | New HL backtest run | shell | M | F3 |
| F5 | Backtest CLI output → Supabase table | generalPurpose | M | D1 |
| **F6** | **Backtest CLI `process.exit(0)`** — `atlas/apps/core-node/src/cli/backtest.ts` doesn't exit after results print (Supabase client keeps event loop alive). Removes the `timeout 240` workaround in backtest-gate.yml. Small standalone PR. | generalPurpose | S | none |
| G3 | Supabase Pro setup runbook | generalPurpose | M | D6, D9 |
| G4 | CoinDesk A/B procedure docs | generalPurpose | S | (independent of H4 timing) |
| **G7** | **Promote plan docs to tracked location** — `atlas/var/tmp/monitor/*.md` (SPRINT-PLAN-FINAL, SPRINT-PHASE-STATUS, wave1-pr-adversarial-review, WAVE1-CLOSURE-CHECKLIST) are gitignored by `atlas/.gitignore: var/**/*.md`. Doc count drift fixes from Wave 1 closure (522→548, 18→19 tasks) live only on disk. Move to `docs/plans/` so updates are version-controlled. | generalPurpose | S | none |
| H1 | HL backtest comparison | generalPurpose | M | F4 |
| H3 | Regime-conditional strategy proposal | generalPurpose | M | H5 |
| H5 | Signal-arbitration funnel analysis (UI + endpoint) | generalPurpose | M | none |
| I1 | PM2 ecosystem config test | shell | M | none |
| I2 | Cloud Agent VM secret-injection alternative | generalPurpose | M | none |
| I3 | CI/CD pipeline review | generalPurpose | M | none |
| J1 | Risk-limit revalidation | generalPurpose | S | A1, A4 |
| J3 | Audit trail completeness | generalPurpose | M | none |
| J4 | flatten_on_shutdown live test | shell | S | none |

**Success gate W2:** F3+F4 backtests show ≥ 50 trades/run; D1 migration consolidation deployed cleanly; tests still 548/548+ (verified 2026-05-14); D11+D12+F6+G7 land as discrete PRs (no bundling with strategy work).

**Wave 1 → Wave 2 carryover (added 2026-05-14 after Wave 1 closure):** D11, D12, F6, G7 are pre-existing debt deferred from Wave 1 reconciliation. None block A-/B-/J-track strategy work — pick up opportunistically alongside the planned items.
**Wall clock estimate:** 3–5 days.

### Wave 3 — Integration / verification

| ID | Title | Owner | Effort | Depends on |
|---|---|---|---|---|
| B1 | Hyperliquid adapter completion | generalPurpose | XL | DECISION D-HL-TIMING (decides if this is sprint or next-sprint) |
| B2 | Per-symbol venue selector | generalPurpose | M | B1 |
| B3 | Funding-rate signal integration | generalPurpose | M | B1 |
| C4 | Trade Journal real feature | generalPurpose | XL | D6 |
| C5 | Alerts page real wiring (Resend + Twilio) | generalPurpose | XL | D6 + DECISION D-NEW-DEPS |
| D4 | Centralize createClient calls (13 → 1) | generalPurpose | M | D1 |
| D6 | Re-enable Branching | shell | M | D1 |
| D8 | pgmq decision doc | generalPurpose | XS | none |
| E3 | Frontend error tracking (Sentry) | generalPurpose | n/a | DECISION D-NEW-DEPS |
| G5 / J2 | Go-live checklist | generalPurpose | M | A1, A4, B1, J1 |
| H4 | CoinDesk sentiment A/B kickoff (4-week run begins) | generalPurpose | XL run | C2, C5, H7 |
| H7 | CoinDesk tier confirmation | user | S (8-day deadline) | DECISION D-COINDESK |

**Success gate W3 (sprint complete):** All Section 6 KPIs hit. 14-day HL paper run kicked off. Trade Journal seeded with first thesis. Alerts firing real events.
**Wall clock estimate:** 3–5 days plus the 14-day HL paper run window.

**Total sprint window: ~14 days of engineering + 14 days of HL paper validation = ~4 weeks end-to-end.**

---

## 5. Decision gates for the user (≤ 8)

User must answer these before W0 ends, otherwise sprint stalls.

### D-HL-TIMING — Hyperliquid adapter completion timing

| Option | Description | Cost (engineering days) | Benefit |
|---|---|---|---|
| **A. This sprint (Wave 3)** | Complete adapter + venue selector + funding rate. Run HL paper for 14 days starting ~day 7 of sprint. | 5 d | Sprint produces HL EV evidence. Real go/no-go signal. |
| **B. Next sprint** | Lock current sprint scope. HL becomes Sprint 2's headline item. | 0 d this sprint | Smaller sprint scope; lower risk of scope creep. |
| **C. Hybrid: testnet now, mainnet next sprint** | Wire HL signal routing this sprint but only against HL testnet (so Coinbase paper continues). Mainnet flip = next sprint after testnet validation. | 3 d | De-risks the live flip. Generates testnet evidence. |

**Recommendation: C — hybrid.** HL adapter completion has high engineering risk (real venue, real money path even on testnet). Doing it against testnet generates real fill data to feed B5 (perps fee accounting fix) and F4 (HL backtest). Mainnet switchover is a separate, smaller PR after 7 days of clean testnet operation.

### D-MIG-CONSOL — Migration consolidation execution path

| Option | Description | Cost | Benefit |
|---|---|---|---|
| **A. Self-serve via `SUPABASE_ACCESS_TOKEN`** | User provides PAT; agent runs `supabase db dump`, drafts new baseline, applies to a preview branch, diffs, opens PR. | 0 d user time + 2 d agent | Fast, automatable, repeatable. |
| **B. Manual staging via Supabase Dashboard** | User exports schema dump; agent drafts baseline; user applies via dashboard. | 0.5 d user time + 2 d agent | No PAT needed, but slow + error-prone. |
| **C. Defer to next sprint** | Keep current 42 migrations. Do not enable Branching. | 0 d | Lowest risk, biggest tech debt. |

**Recommendation: A.** The schema drift is real and growing. With Pro daily backups now active, the blast radius is bounded. A `SUPABASE_ACCESS_TOKEN` is also needed for D6 (Branching CI gate) so it's a one-time investment with multiple uses.

### D-NEW-DEPS — Approve new npm dependencies (Sentry, Resend, Twilio)

CLAUDE.md says "Do NOT add new npm dependencies without explicit approval."

| Dep | Purpose | Cost | Risk |
|---|---|---|---|
| `@sentry/react` + `@sentry/node` | Frontend + backend error tracking (E3) | $0/mo (free tier) | Free tier limits at 5K events/mo — sufficient |
| `resend` | Transactional email for alerts (C5) | $0–10/mo | Transactional; 100 emails/day free |
| `twilio` | SMS for alerts (C5) | $1–5/mo | Trial $15 credit, then $0.0079/SMS |

| Option | Description |
|---|---|
| **A. Approve all three** | Unblocks E3 + C5 in full. Net cost $1–15/mo. |
| **B. Approve Resend + Twilio only** | C5 ships. E3 deferred to next sprint. |
| **C. Approve Resend only** | C5 ships email-only. SMS deferred. E3 deferred. |
| **D. Approve none** | C5 + E3 both deferred. |

**Recommendation: A.** Total monthly cost $1–15 is well within budget and Sentry catches frontend errors that today are invisible (no telemetry on the React app). Resend + Twilio are both lightweight, well-maintained, and fit the use case better than rolling our own SMTP/SMS.

### D-COINDESK — CoinDesk free tier sunset May 21 (8 days)

| Option | Description | Cost | Risk |
|---|---|---|---|
| **A. Confirm with sales now; assume paid tier** | Email CoinDesk this week; budget for $25–50/mo. | $25–50/mo if paid | If paid is required and exceeds budget, scramble to migrate after May 21. |
| **B. Assume free tier persists** | Don't act; rely on H7 confirmation. | $0 | If free tier doesn't persist, integration breaks May 21. |
| **C. Pause CoinDesk integration** | Don't enable in `meta_filter.coindesk_sentiment`. Park for next sprint. | $0 | Loses 4-week A/B opportunity. |

**Recommendation: A.** Email CoinDesk sales this week (W0); reserve $0–50/mo budget. The A/B requires a 4-week run, so we want to start it ASAP. Worst case the paid tier exceeds budget — then we evaluate alternatives (CryptoCompare, Messari, NewsAPI) in a small spike.

### D-LIVE-SEQ — Live-trading sequencing

| Option | Description |
|---|---|
| **A. 14-day HL paper → 7-day HL live ($100 stake) → scale** | Most cautious. Standard 3-stage. |
| **B. 7-day HL paper → 7-day HL live ($100 stake) → scale** | Faster. Higher risk if HL paper hides bugs. |
| **C. 28-day HL paper → 14-day HL live ($1k stake) → scale** | Most cautious AND most conviction-building. |

**Recommendation: A.** 14 days of HL paper covers normal market regime variation (ranging, weak trend, strong trend). $100 live for 7 days is small enough to absorb full loss as tuition.

### D-PARAM-LOCK — Strategy parameter changes — lock current params for full HL backtest first, or retune now?

| Option | Description |
|---|---|
| **A. Lock current params; HL backtest validates current state** | Cleanest "is HL alone enough?" answer. |
| **B. Retune now (A1, A2 in Wave 2); HL backtest validates new state** | Faster path to a profitable bot. |

**Recommendation: B.** A1 + A2 are derived from H2 (data-driven). The current params are demonstrably bad (4 take-profits closed at near-entry today). Locking known-bad params for a backtest just confirms what we already know. Retune first, then backtest the new state.

### D-PITR-TIMING — PITR ($100/mo) — when to enable?

| Option | Description |
|---|---|
| **A. Enable now** | Insurance against today's drift bugs. |
| **B. Enable on first $1k+ live trade** | Standard recommendation per research §3. |

**Recommendation: B.** Per research §3 and §4 D1. Daily backups + disk spool is sufficient for paper. PITR's $100/mo would more than 4× the Pro bill.

### D-BRANCH-PROT — Branch protection on `main` — enable now or after sprint?

| Option | Description |
|---|---|
| **A. Enable now (W1, I4)** | Forces all sprint work through PR review. |
| **B. After sprint** | Faster sprint execution; lower review overhead. |

**Recommendation: A.** Already in Wave 1 (I4). With multiple parallel subagents merging, branch protection is the only mechanism that catches "two PRs touch same file" conflicts before they break `main`. Cost is ~5 min/PR for review; benefit is no bad merge.

---

## 6. Cost projection

### 6.1 Sprint execution cost

| Item | Estimate |
|---|---|
| Total agent dispatches | ~50 (Wave 1) + ~25 (Wave 2) + ~12 (Wave 3) = ~87 |
| Avg agent cost | $0.50 (mix of S/M/L tasks at typical token use) |
| **Sprint compute cost** | **~$45** |
| Engineering hours (user review + decision) | ~15 hours over 4 weeks |

### 6.2 Monthly run-rate post-sprint

| Line item | Quantity | Rate | Cost |
|---|---|---|---|
| Supabase Pro | 1 | $25/mo | $25.00 |
| Supabase compute (Micro) | 1 | $10 included credit | $0.00 |
| Supabase branching | ~100 br-hrs/mo | $0.01344/hr | $1.34 |
| Supabase PITR | DEFERRED | $100 per 7-day | $0.00 |
| Supabase log drains | SKIPPED | $60+ | $0.00 |
| CoinDesk | TBD | $0–50 | $0–50 |
| Resend (email) | < 100/mo | $0 free tier | $0.00 |
| Twilio (SMS) | < 50/mo | $0.0079/msg | $0–5 |
| Sentry | TBD | $0 free tier | $0.00 |
| Hyperliquid (platform) | n/a | $0 | $0.00 |
| **Best case (CoinDesk free, no surprises)** | | | **$26.34** |
| **Realistic (CoinDesk paid mid-tier)** | | | **$56.34** |
| **Worst case (CoinDesk paid + msg overage)** | | | **$70+** |

**Target ceiling: ≤ $50/mo all-in for paper + alerts.** Hit if CoinDesk free tier persists OR mid-tier ≤ $25/mo.

### 6.3 Trading cost (paper, real venue commission for accounting only)

| Venue | Round-trip | Daily est. (10 trades) | Monthly est. (200 trades) |
|---|---|---|---|
| Coinbase spot (4 paper) | 80 bps | ~$120 | ~$2,400 |
| Hyperliquid perps (target) | 9 bps | ~$13 | ~$260 |

**Quant:** until we move to HL, every paper run is a "what could have been" exercise. Once on HL, paper trading is cheap enough to run continuously.

---

## 7. Success metrics (sprint KPIs)

Sprint is **DONE** when ALL the following are true:

| # | KPI | Target | Measurement |
|---|---|---|---|
| 1 | 14-day Hyperliquid paper run | Net return > 0 % after fees | Read from `account_metrics` daily_pnl rollup; Sharpe > 0.5; profit factor > 1.0 |
| 2 | UI parity | 100 % (no mock cards) | Manual checklist; `rg "MOCK\|SEED\|Promise.resolve" src/hooks/apex/` returns zero seed-data calls |
| 3 | Backend tests | ≥ 548/548 (verified 2026-05-14) pass | `pnpm test` in `atlas/apps/core-node/` exit code 0 |
| 4 | Lint baseline | ≤ baseline error count | `pnpm lint` warning/error count from sprint start |
| 5 | Migration consolidation | Clean fresh-DB applies in CI | Branching preview check passes on a sample PR |
| 6 | Edge Functions | 11 → 4 | `ls supabase/functions/` count |
| 7 | Alerts firing | All 5 channels (email, SMS) on real triggers | Force a 3-consecutive-loss; verify email + SMS receipt |
| 8 | Trade Journal | ≥ 1 user-entered thesis-and-postmortem entry | Query `trade_journal` table |
| 9 | Signal funnel diagnostic chart | Visible in Backtest UI | Visual on `/backtest` page |
| 10 | Pulse-monitor false positives | 0 in next paper run | New pulse alert log |
| 11 | Risk Desk | Drawdown + equity match `/api/status` exactly | Visual + math check |
| 12 | Funnel-latch fix | Backtest signals/run > 50 (was 12) | F3 reports |

---

## 8. Risk register (top 10)

| # | Risk | Probability | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Migration consolidation (D1) corrupts `positions` table data due to undocumented schema evolution | Med | **Critical** (loss of trade history) | (a) PITR ON for the consolidation window; (b) test on preview branch first; (c) `pg_dump` before applying; (d) rollback plan documented |
| 2 | Hyperliquid adapter (B1) places a live order on mainnet by mistake (instead of testnet) | Low | **Critical** (real money loss) | Double-locked: `hyperliquid.testnet: true` + `HYPERLIQUID_TESTNET=true` env required; abort if both not set; explicit testnet endpoint URL in code |
| 3 | Strategy param retune (A1) makes things worse, not better | Med | High (lost paper days) | A/B against current params on May 11 backtest before merge; require H2 evidence in PR |
| 4 | Resend/Twilio rate-limit during alert storm (e.g., DD breach + losses + venue degraded all at once) | Med | Med (alerts dropped) | Throttle: max 1 SMS/min per channel; max 5 emails/min; queue with TTL |
| 5 | Pro plan budget alert at $50 fires due to realtime msg overage (today's 4.3M close to 5M cap) | Med | Low ($) | D10 (coalesce position updates) lands in Wave 1; metric `atlas_realtime_messages_used` alerts at 4M |
| 6 | Cold-streak meta-filter blocks ALL signals after BacktestEngine integration (A5/F2) due to wall-clock vs sim-time bug | Med | Med (backtest unusable) | F1 fixes the underlying `Date.now()` issue first; F2 depends on F1 |
| 7 | Frontend mock removal (C2/C3/C4/C5) breaks UI when backend returns null/error | Low | Low (page renders empty) | Each hook rewrite includes null-safe rendering; existing `if (!data) return null` pattern preserved |
| 8 | Trade Journal table (C4) RLS misconfigured — entries leak across users (currently single-user but schema is multi-user-ready) | Low | Med (privacy if multi-tenant later) | RLS uses `(SELECT auth.uid()) = user_id` pattern (per D5); test with a second user before sprint close |
| 9 | CoinDesk free tier sunsets May 21 with no migration plan, breaking `meta_filter.coindesk_sentiment` if enabled | Med | Low (filter is OFF by default) | H7 confirmation by May 18; alternative provider scoped if paid > $25/mo |
| 10 | `flatten_on_shutdown` doesn't actually flatten in production paths (J4 not yet verified) | Low | High (open positions left over weekend) | J4 explicit live test before sprint close |

---

## 9. Open questions (for sprint kickoff)

These are NOT in the decision gates (those are required answers); these are open for discussion and may surface during execution.

1. **Slack channel for alerts** — staging file mentions `#trading-alerts` placeholder. Real channel name? Webhook URL? Or skip Slack (email + SMS is sufficient)?
2. **Multi-user roadmap** — Trade Journal schema is built for `user_id`. Are we planning to ever onboard a second trader? If yes, Wave 3 should add a `users` admin UI; if no, simplify Journal to single-user.
3. **Backtest data freshness** — current cached `bars` ends 2026-03-05. Mar 5 → today is 2 months of un-backtested data. Do we want to backfill before the F3 re-run, or accept the 12m-window-ending-Mar-5 baseline?
4. **Strategy plugin lifecycle** — `vwap_mr` and `breakout` plugin files are kept as `@deprecated` reference. Are we ever going to revive them (e.g., regime-conditional revival per H3) or formally delete?
5. **Symbol expansion** — currently 5 symbols. Add AVAX, LINK, ARB to per-symbol caps? Today's Risk hook already lists them in `PER_SYMBOL_CAP`.
6. **Position sizing model** — `risk_per_trade: 0.005` (0.5 %) for spot, `perps.risk_per_trade: 0.015` (1.5 %) for perps. With HL leverage, is 1.5 % too aggressive? H2 will quantify.
7. **CI runner topology** — does CI live on GitHub Actions? Cloud Agent VM only? If GH Actions, where do we get a `SUPABASE_SERVICE_KEY` for integration tests?
8. **Audit trail retention** — `audit_log` table — do we have a retention policy or does it grow forever?
9. **Time-of-day filter** — currently `time_filter_enabled: false`. CLAUDE.md says lo-liq 04–07 UTC, preferred 13–17 UTC. Should we A/B-test enabling?
10. **`primary_signal_id` in positions** — migration `20251216_add_positions_primary_signal_id.sql` exists. Is it used? UI shows `signal_id` in trades but `primary_signal_id` in positions schema feels like a half-finished feature.

---

## 10. Quick-reference

### File index for synthesizer worker outputs

| File | Purpose |
|---|---|
| `atlas/var/tmp/monitor/SPRINT-PLAN-FINAL.md` | **THIS FILE** — source of truth for parallel subagent dispatch |
| `atlas/var/tmp/monitor/sprint-plan-staging.md` | Staging file with accumulated decisions (now superseded by this) |
| `atlas/var/tmp/monitor/supabase-pro-research.md` | 715-line Supabase Pro research; cited throughout |
| `atlas/var/tmp/monitor/final-snapshot/00_run-summary.txt` | Run summary header |
| `atlas/var/tmp/monitor/final-snapshot/01_pre-synthesis-snapshot.txt` | All-endpoint snapshot at synthesis time |
| `atlas/var/tmp/monitor/final-snapshot/02_kill-switch-context.txt` | Kill switch + risk state context |
| `atlas/var/backtest_results/report_2026-05-11_post-monitor-fixes.txt` | Operator's funnel-latch diagnosis (CANONICAL) |
| `atlas/var/backtest_results/report_2026-05-11T*.txt` | 4-run May 11 backtest matrix outputs |
| `atlas/config/guardrails.yaml` | Live trading config (single source of truth) |

### Subagent dispatch table (Wave 1)

| Task ID | Subagent type | Agent prompt skeleton |
|---|---|---|
| C1 | generalPurpose | "Fix Risk Desk math in `src/hooks/apex/useRiskData.ts` per SPRINT-PLAN-FINAL.md C1. Read current file, write fixed file, verify against `/api/status` JSON shape." |
| C6 | generalPurpose | "Audit `src/components/apex/dashboard/*` for placeholder/garbled timestamps; fix found instances." |
| D2 | shell | "Delete `supabase/functions/{ingest-position-update,ingest-risk-metrics,ingest-order-event,ingest-fill,ingest-alert,alerts-ack,strategy-toggle}/`. Run lint+test." |
| D3 | shell | "`rg supabaseRealtimeBridge src/` — confirm zero callers — then delete `src/runtime/realtime/supabaseRealtimeBridge.ts`. Run build." |
| D5 | generalPurpose | "Create new migration `2026MMDD_rls_initplan_optimization.sql` patching `auth.uid() = user_id` → `(SELECT auth.uid()) = user_id` in all RLS policies. Set `search_path = public, pg_catalog` on `handle_updated_at`, `handle_new_user`." |
| D10 | generalPurpose | "Add 1-second debounce to `position-tracker.ts` Supabase UPDATE writes. Test that final position state still reaches DB on close." |
| E1 | generalPurpose | "Add `scrape_configs.supabase` to `deploy/monitoring/prometheus.yml`; verify Grafana shows `supabase_*` metrics." |
| E2 | shell | "Document 4 Supabase Studio saved queries in `docs/runbooks/supabase-log-queries.md`." |
| E4 | generalPurpose | "Write `atlas/apps/core-node/src/cli/audit-trades.ts` cross-checking trades ↔ fills ↔ orders ↔ positions integrity." |
| E5 | shell | "Fix `atlas/var/tmp/monitor/pulse.sh:84` regex. Use `jq` to extract `maxDrawdownPct` and compare numerically `>= 10`." |
| E6 | shell | "Move `atlas/var/backtest_results/report_2026-05-11_post-monitor-fixes.txt` → `docs/backtest-reports/2026-05-11_post-monitor-fixes.md`. Gzip raw stdout dumps." |
| F1 | generalPurpose | "Replace 3 `Date.now()` sites in `signal-processor.ts:1046,1058`, `signal-arbiter.ts:184,415`, `meta-filter.ts:529,533,1095` with a `currentTimestamp` parameter. Live mode passes `Date.now()`; backtest passes the bar timestamp." |
| F2 | generalPurpose | "Wire `signalProcessor.recordTradeOutcome(outcome)` into `BacktestEngine` per closed trade. Add unit test." |
| G2 | generalPurpose | "Write `docs/runbooks/secret-rotation.md` covering all secrets in `env.example`." |
| G6 | shell | "Run `pnpm test` in `atlas/apps/core-node/`; update CLAUDE.md and AGENTS.md test count to actual; remove ML aspirational language." |
| H2 | generalPurpose | "Compute min-profitable-trade-size at HL fees (9 bps round-trip + 5 bps slippage = 14 bps total) for each (symbol, ATR profile). Output `docs/research/2026-05-XX_min-trade-size.md`." |
| H6 | generalPurpose | "Quantify probability of false-positive consec-loss kill at 8 vs 10 vs 12 limit, given win rates 30/40/50/60 %. Output `docs/research/2026-05-XX_circuit-breaker-review.md`." |
| I4 | shell | "Configure GitHub branch protection on `main`: require PR review, require CI green, no force-push, no direct push." |
| I5 | shell | "Add `.github/PULL_REQUEST_TEMPLATE.md` with strategy-change + migration-change checkboxes." |

### Key code locations

| Concern | File:line |
|---|---|
| Consec-loss kill limit (8) | `atlas/apps/core-node/src/trading/trading-engine.ts:841` |
| Cold-streak threshold (10) | `atlas/apps/core-node/src/strategies/meta-filter.ts:210` |
| Kill switch trip | `atlas/apps/core-node/src/trading/risk-engine.ts:1114` |
| Risk Desk math bug | `src/hooks/apex/useRiskData.ts:117-138` |
| Position-tracker schema | `atlas/apps/core-node/src/trading/position-tracker.ts:152-176` |
| FeeModel usage | `atlas/apps/core-node/src/api/server.ts:18`, callers across `trading/`, `backtesting/` |
| Meta-filter Date.now() — biggest backtest funnel-latch suspect | `atlas/apps/core-node/src/strategies/meta-filter.ts:529,533,1095` |
| Signal-processor dedup window — backtest funnel-latch suspect | `atlas/apps/core-node/src/strategies/signal-processor.ts:1046,1058` |
| Signal-arbiter cooldown — backtest funnel-latch suspect | `atlas/apps/core-node/src/strategies/signal-arbiter.ts:184,415` |
| Pulse-alert regex bug | `atlas/var/tmp/monitor/pulse.sh:84` |
| Hyperliquid double-lock | `atlas/config/guardrails.yaml:332-333` |
| Mock seed hooks | `src/hooks/apex/useModelData.ts`, `useBacktestData.ts`, `useJournalData.ts`, `useAlertsData.ts` |

---

**END OF SPRINT-PLAN-FINAL.md**

Sprint plan synthesizer signing off. Estimated wall clock to W3 success gate: 14 engineering days + 14 paper-validation days = 4 weeks.
