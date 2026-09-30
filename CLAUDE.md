# Apex Automata (AtlasBot v2) — Claude Code Context

State as of the 2026-09-29 handoff PR #82 (base c9bfae1 / PR #81, plus that PR's regime-gate loosening, `donchian_daily_s3` plugin + book reconcile, persistence fixes, the paper 22:30 CT hard stop and the desk DB read surface).

## What This Is
Algorithmic crypto trading system: React frontend + Node.js trading runtime + Supabase persistence. **Currently PAPER ONLY** on Coinbase spot market data. Live paths exist but are locked (`CONFIRM_LIVE=NO`) and every change must leave them byte-for-byte unchanged.

## Quick Commands

### Frontend (root directory)
```bash
pnpm dev              # Vite dev server on port 8080
pnpm build            # Production build
pnpm lint             # ESLint across repo (pre-existing no-explicit-any errors)
pnpm preview          # Preview production build
pnpm exec vitest run  # Frontend tests (vitest.config.ts, jsdom) — root has no `test` script
```

### Backend (from root)
```bash
pnpm backend          # Start API server (port 3001)
pnpm backend:build    # Build backend TypeScript
pnpm check:config     # Desk pins + single-source guardrails (delegates to core-node)
pnpm install:all      # Install all dependencies (root + backend)
```

### Backend (from atlas/apps/core-node/, prefix with ENCRYPTION_KEY=<64 hex>)
```bash
pnpm api              # Express API + WebSocket server
pnpm check:config     # Must print "config-drift: OK" before any commit
pnpm test             # vitest run — 98 files / 1625 tests, all pass (~40s)
pnpm exec vitest run <file>   # single file
pnpm build            # rimraf dist && tsc (has pre-existing type errors; runtime uses tsx)
pnpm exec tsx src/cli/backtest.ts --start-date <s> --end-date <e> --products BTC-USD --fixture-dir fixtures/bars/15m/<set>
                      # NEVER `pnpm backtest -- --flags` (yargs eats the flags). 12-month runs take minutes.
pnpm diagnose         # System diagnostics
```

### Full System
```bash
pnpm start            # node start.cjs — frontend + backend
```

## Architecture
```
Root (/)              → React + Vite + shadcn/ui frontend
atlas/apps/core-node/ → Node.js trading runtime (Express API + engine)
supabase/             → PostgreSQL migrations (75 files incl. reconciliation stubs) + 4 Edge Functions
deploy/               → Docker + Kubernetes + Prometheus/Grafana
```
**Runtime flow**: Coinbase WS → ticker → candles → SignalProcessor → router gates in `api/server.ts` `signal:generated` (disabled-strategy, per-symbol, time, atr_vol, regime_gate, ev_gate) → RiskEngine (kill ladder, halts) → OrderManager → PositionTracker → Supabase sync → UI via WebSocket + Supabase Realtime.

## Key Directories
- `src/` — Frontend (components/{apex,model,status,debug,ui}, hooks, contexts, services)
- `src/runtime/` — Frontend runtime integration (ws, event-bus, state, session, pnl, realtime)
- `atlas/apps/core-node/src/api/server.ts` — API + the signal router (all router-stage gates live here)
- `atlas/apps/core-node/src/trading/` — engine, orders, positions, `risk-engine.ts`, `risk/` (kill ladder, boot guard, EV gate), `cfm/`
- `atlas/apps/core-node/src/strategies/` — signal-processor, regime-detector, regime-filter, regime-gate, meta-filter, `plugins/builtin/`
- `atlas/apps/core-node/src/exchanges/` — Coinbase (spot, perps, CFM guard), Hyperliquid adapter
- `atlas/apps/core-node/src/indicators/` — EMA, RSI, MACD, ADX, ATR, BB
- `atlas/apps/core-node/src/config/` — `loadGuardrails.ts` (zod schema), `config-drift.ts` (desk pins)
- `atlas/apps/core-node/src/cli/` — backtest.ts, check-config-drift.ts, diagnose.ts, audit-trades.ts
- `atlas/apps/core-node/fixtures/bars/{15m,4h,1d}/` — sealed real candle fixtures (NEVER edit)
- `atlas/config/guardrails.yaml` — the ONLY editable source of risk limits + strategy config
- `docs/research/` — dated research notes (backtest evidence, desk verdicts)
- `supabase/migrations/` — SQL migrations; `AGENTS.md` — env/setup gotchas (rollup native binary, .env)

## Critical Conventions
- **Strict TypeScript** in backend (`"strict": true`), relaxed in frontend
- **Files**: `kebab-case.ts` | **Classes**: `PascalCase` | **Interfaces**: `IPascalCase` | **Config**: `snake_case`
- **Financial values**: strings / `NUMERIC(20,8)`, never float arithmetic on money (indicator math on prices as numbers is existing practice)
- **Logger**: `import { Logger } from '../core/logger'` — never console.log (CLI scripts under `src/cli` may print reports)
- **Errors**: never swallow — `this.logger.error()` then re-throw
- **No new npm deps** without explicit approval; **Path alias**: `@/*` → `./src/*` (frontend only)
- **Never invent numbers**: every performance claim needs the runnable backtest command + fixture it came from

## Active Strategies
Controlled by `atlas/config/guardrails.yaml` `disabled_strategies` (pinned by `pnpm check:config`):
- **trend_follow** (EMA crossover + MTF alignment, `plugins/builtin/trend-follow-strategy.ts`) — the ONLY active strategy, heavily gated: EMA12/EMA15 cross + price on the correct side + regime agreement + plugin `regimeCompatibility` (refuses ranging/choppy) + router regime gate + EV gate + 15-min cooldown. Silence for hours in weak/ranging markets is by design. stopAtr 2.5 / takeProfitAtr 6.0 pinned on every symbol block.
- **momentum** (RSI/MACD) — RETIRED: E2-MOM-ISO KILL, 2026-09-11 (PR #55). In `disabled_strategies`; parameter blocks stay as a one-line undo.
- **vwap_mr, breakout** — killed per Phase 3 backtest verdict (March 2026).
- **donchian_daily_s3** (`plugins/builtin/donchian-daily-s3-strategy.ts`, card PAPER-S3-DONCHIAN-v0) — daily Donchian in20/out10 long-only, research verdict HOLD (`docs/research/2026-09-22_s3-donchian-breakout-replication.md`), default OFF in `disabled_strategies` (desk pin), backtest-only via `--strategy donchian_daily_s3 --include-disabled donchian_daily_s3 --bar-minutes 1440 --fixture-dir fixtures/bars/1d`. The paper runtime has no daily-candle feed yet, so even if enabled it would refuse to emit (follow-up). Since PR #82 the plugin reconciles its IN/OUT rule state with the actual book through `MarketContext.openPosition` (`SignalProcessor.setOpenPositionProvider`, wired in the backtest engine and `api/server.ts`), so a stop-out re-arms the entry and a restart re-adopts an open long instead of emitting orphan sells. `donchian_daily_s3` is in the `strategy_name` Postgres enum since migration `20260929203106` (applied 2026-09-29); orders, positions AND signals go through `persistence/strategy-name.ts`, and all three writers fall back to `system` on a 22P02 for any label the deployed enum lacks (`persistence/strategy-enum-fallback.ts`, warned once per process).
Killed plugin files stay as `@deprecated` reference (DO NOT delete). Disabled strategies are never registered (`StrategyRegistry.register` skips them), so they generate no signals; the router re-checks `disabled_strategies` at `signal:generated` as defence in depth.

## Meta-filter
The meta-filter is **rule-based** (cold-streak cooldown after 10 losses → 5 min pause, time-of-day filter for lo-liq 04–07 UTC / preferred 13–17 UTC, plus optional ATR/strength/volume gates). There is **no ML model** in this codebase — `signals.meta_prob` is always NULL. The `/model` page renders rule-based meta-filter state today (cold-streak, time-of-day, recent decisions); any ML-style metrics displayed there (ROC AUC, SHAP, calibration) are placeholder mocks and the on-page banner says so. Treat ML as a future workstream, not a current feature.

## Paper safety rails (all PAPER ONLY — live never reads these)
- **Regime gate** (`regime_gates` in guardrails, `src/strategies/regime-gate.ts`, enforced at the router): `paper_only: true` is a desk pin; NEW ENTRIES ONLY (exits/reversals and position-monitor exits are never gated); unknown regime never gated. Current rule: trend_follow blocks `[choppy]` only (weak_trend allowed since 2026-09-28, Luke decision 2026-09-23, so the soak takes trades; PF ~0.8 in weak_trend is known — purpose is soak observability, not edge). In the default `adx_primary` detector mode `choppy` is never emitted, so the rule is belt-and-braces. Blocked entries persist as `allowed=false`, reason `regime_gate: …`, funnel stage `regime_gate`. Backtests measure it with `--regime-conditional-gates` (NOT `--regime-gates on|off`, which is the unrelated RegimeFilter toggle).
- **Graduated kill ladder L1–L6** (`src/trading/risk/paper-kill-ladder.ts`, guardrails `paper_kill_ladder`): L1 consec>=3 or dailyR<=-1 → size x0.5; L2 consec>=5 or dailyR<=-2 → x0.25; L3 4 consecutive losses in one strategy → strategy frozen for session; L4 trend_follow stopped out twice in weak_trend/choppy → paused 4h; L5 sleeve stub (disabled); L6 dailyR<=-4 or (consec>=12 and dailyR<=-2) → hard kill (`daily_stop` / `consecutive_losses`). Thresholds are desk pins. L1–L5 write `risk_events` rows and never latch the kill switch.
- **Boot guard** (`src/trading/risk/paper-boot-guard.ts`, PR #81): a paper start REFUSES to boot while risk state is latched (`risk_metrics.kill_switch_active` or an open halt `risk_events` row) unless `RISK_CLEAR=YES`; `PAPER_RESET_RISK_STATE_ON_START` only acts together with `RISK_CLEAR=YES`, otherwise it is logged and ignored; boot never clears the halt row. NEVER set those env vars or clear `risk_events` / kill-switch rows without an explicit Risk / Luke OK.
- **Paper hard stop** (`paper_session_hard_stop` in guardrails, `src/runtime/paper-hard-stop.ts`, PR #82, handoff P5): an engine-side backstop that stops a PAPER session at 22:30 America/Chicago (DST-safe, re-arms by calendar day) through the same shared stop path as `POST /api/engine/stop` (`stopTradingEngineShared`, supervisor reason `paper_hard_stop`, `flatten_on_shutdown` applies as before). Armed only in the paper branch of `/api/engine/start`, refuses live at three layers, disarmed by every stop path including SIGTERM; `/api/status` + WS carry `paperHardStop` (`nextFireAtIso`, null when idle or live). Not a desk pin; an absent block means disabled. If a start/stop is mid-flight it retries every 10s up to 6 times, then gives up for the day (logged).
- **Desk pins** (`src/config/config-drift.ts`: SCALAR_PINS, LIST_PINS, TRADE_COOLDOWN_FLOOR_EXCLUSIVE, TREND_FOLLOW_PIN): trade_cooldown_min 15 (floor >5), min_ev_threshold 0, atr_volatility_min 0.005, fee books (spot 25/40 paper book; CFM 9.5/10 + $0.10/ct; never mixed), cfm max_leverage 2 / post_only / no_chase, regime_gates.enabled + paper_only, kill-ladder thresholds, disabled_strategies list, trend_follow stopAtr 2.5 / takeProfitAtr 6.0 on every symbol block, and the regime-gate FLOOR (`REGIME_GATE_RULE_PINS`): the trend_follow rule must exist, stay unscoped (no `venues` / `symbols`) and keep blocking choppy. Changing a pin = YAML + config-drift.ts in the SAME PR, called out loudly in the PR.

## Desk hard rules
- PAPER ONLY. Never set `EXECUTION_MODE=live`; `CONFIRM_LIVE` stays `NO`; never weaken a live-path gate. Every commit body carries a `live impact:` line ("none" or an exact explanation).
- Every change via branch + PR. Never push to main, never force-push. Do not touch PRs #66 and #61.
- Never run a risk reset (`PAPER_RESET_RISK_STATE_ON_START` / `RISK_CLEAR`) and never edit Supabase rows by hand. Supabase project `gdrdaajvutmewgxbjurk` is shared with an agentic-equity workflow: never touch `agentic_*` tables / `agentic_control`. Migrations only via PRs.
- Never invent numbers: every performance claim needs a runnable backtest command + fixture, with the stdout saved.
- Persistence contracts to preserve: per-session `trade_id` namespace (#76); positions upsert on `id` with 42P10 fallback (#69, `src/persistence/position-upsert.ts`); hydrate restamps open positions onto the new paper session_id (#74, log key `hydrateRestamp`); FE blotters are session-scoped (#71–#73). Since PR #82: positions writes are serialised per id with close retries (`persistence/position-write-sequencer.ts`); a hydrated position's first fill emits `position:updated`, never a second `position:opened`; `positions.strategy` is normalised onto the `strategy_name` enum (`persistence/strategy-name.ts`, default `system`, never `breakout`); `orders.position_id` is written after a confirmed positions write (`persistence/order-position-link.ts`); the observational session reconcile is execution_mode-scoped and reports foreign-mode rows instead of calling them drift (`persistence/session-reconcile.ts`); the legacy destructive reconcile (`STARTUP_RECONCILE=false`) only zeroes same-mode rows (NULL-mode rows for paper only) and skips entirely without the `execution_mode` column; hydrate/restamp are execution_mode-scoped too. `/api/status` + WS carry a `persistence` health block (hydrateRestamp, reconcile, closeWriteFailures, orderLinks; null when stopped).
- Paper runtime runs on LukePC (Windows) at `C:\Users\lukeb\apex-automata-paper`, API :3001, Vite :8080; soak window ~9am–10:30pm CT. After merges touching `vite.config.ts` confirm the frontend→API path (the `/api` dev proxy, where configured) still works.

## Exchange Status
- **Coinbase spot** (BTC-USD / ETH-USD / SOL-USD) — the paper venue (paper fee book 25/40 bps).
- **Coinbase INTX perps** (`*-PERP-INTX`) — parked; momentum disabled per-symbol, no active strategy.
- **CFM nano futures** (`*-CDE`, PR #70, `src/trading/cfm/`) — infra only, all strategies disabled on the symbol; NOT a strategy GO.
- **Hyperliquid** — adapter inert behind two locks (`hyperliquid.enabled` in YAML AND `HYPERLIQUID_ENABLED=true`); no routing wired.

## What NOT to Do
- Do NOT modify `src/exchanges/coinbase/{rest-client,websocket,index}.ts`
- Do NOT delete or edit killed strategy plugin files (breakout, vwap_mr, momentum)
- Do NOT edit anything under `atlas/apps/core-node/fixtures/` (sealed real data)
- Do NOT change `paper_kill_ladder` thresholds or any other desk pin in a one-file edit
- Do NOT use floating point for financial calculations; do NOT add npm dependencies
- Do NOT hard-code exchange-specific logic in OrderManager or TradingEngine
- Do NOT change Logger or ConfigLoader patterns; do NOT create a second editable `guardrails.yaml` (check:config fails)

## Testing
- Backend: `cd atlas/apps/core-node && ENCRYPTION_KEY=<64 hex> pnpm test` — **98 files / 1625 tests**, all pass (~40s, verified 2026-09-29). Frontend: 7 files / 107 tests. Rollup native binary gotcha → `AGENTS.md` item 1. Claude Code worktrees under `.claude/` are skipped by the config-drift scan.
- `pnpm check:config` must print `config-drift: OK` in the same run.
- Frontend: `pnpm exec vitest run` from root (Vitest + jsdom).
- ZERO test failures allowed; any failure is a regression.

## Environment
- `.env` at project root — Coinbase keys, Supabase credentials, `ENCRYPTION_KEY` (64 hex, required by tests too); loaded by `atlas/apps/core-node/src/core/env.ts`
- `EXECUTION_MODE=paper`, `CONFIRM_LIVE=NO` (defaults); `RISK_CLEAR` / `PAPER_RESET_RISK_STATE_ON_START` unset
- `VITE_RUNTIME_API_URL=http://localhost:3001`, `VITE_RUNTIME_WS_URL=ws://localhost:3001/events`

## Database
- Supabase PostgreSQL with RLS enabled; paper and live share one project and `USER_ID`, scoped by `execution_mode` columns
- All migrations idempotent (`IF NOT EXISTS`); naming `YYYYMMDDHHMMSS_description.sql`. MCP `apply_migration` records the APPLY-TIME version, so name the repo file after the version `list_migrations` reports (see `20260929005509_*`), otherwise Supabase Preview branches refuse to run ("remote migration versions not found").
- **Desk read surface** (applied 2026-09-29, `docs/db/DESK_QUERIES_2026-09-29.md`): `public.desk_session_status` / `public.desk_risk_status` (read-only, `security_invoker`, SELECT for authenticated + service_role) answer "is a paper session open / is the kill switch on / would the boot guard refuse". GENERATED alias columns on `trading_sessions` (`id`, `status`, `starting_equity`, `ending_equity`, `equity`, `trade_count`, `trades_count`, `pnl`) and `risk_metrics` (`kill_switch`, `halt`, `exposure`) exist only so the external desk-monitor poller (Supabase MCP, `docs/db/EXTERNAL_CONSUMERS.md` §2) stops failing with 42703 — NEVER send those keys in a write (428C9). The 2026-09-28 "142 Postgres errors" were that poller, not the runtime.
- `account_metrics.total_equity` is open-position market value written by the `upsert_account_metrics()` RPC (0.00 when flat), NOT account equity; the only persisted equity anchor is `daily_equity.start_equity`. Do not build equity reads on it. Since PR #82 round 3 RiskEngine never reads it: `weeklyStartEquity` anchors on the earliest `daily_equity.start_equity` in the last 7 days (this re-enabled the weekly-loss halt on boots where it was inert, paper AND live — pending Risk desk sign-off before merge).
- Edge Functions in `supabase/functions/` (Deno runtime)

## Deployment
- Docker: `deploy/docker/Dockerfile.api` + `Dockerfile.web`
- Kubernetes: `deploy/k8s/` (namespace, deployments, services, ingress)
- Monitoring: Prometheus + Grafana in `deploy/monitoring/`
