# Cursor Task Queue — Apex Automata

## How to Use

1. **Cowork Claude (architecture)** writes task files here with numbered prefixes.
2. **You (Luke)** tell Cursor: `Read and execute CURSOR_TASKS/TASK_XXX_name.md` (or run the `/next-task` command). Cursor follows the `sprint-task-execution` skill.
3. **After Cursor completes**, run the verify script:
   - Sprint 9 tasks: `node CURSOR_TASKS/verify/verify_sprint9.cjs --task XXX`
   - Older tasks: `node CURSOR_TASKS/verify/verify_XXX.js|cjs`
4. **Green = move on.** Red = come back to Cowork Claude for diagnosis.
5. Only Luke marks a task VERIFIED.

## Current Phase: Sprint 9 — Live on Coinbase (Advanced Trade)

Plan: `docs/plans/SPRINT-9-LIVE-COINBASE.md` · Evidence: `docs/research/2026-09-10_live-readiness-audit.md`

**Critical path:** 010 → (011, 012, 014 in parallel) → 013 → 015 → 016 → Stage 1 canary → Stage 2 capital
**Parallel edge track:** 017 → 018 (2-week kill rule)

| Task | Priority | Description | Depends on | Subagents | Status |
|------|----------|-------------|------------|-----------|--------|
| 010 | P0 | Advanced Trade live execution adapter (JWT, typed results, user stream, fail-closed factory) | — | execution-engineer → risk-guardian | PENDING |
| 011 | P0 | Live account truth: equity (USD+USDC), fee tier → FeeModel, product specs, EV gate prior, preflight rewrite | 010 | execution-engineer → risk-guardian | PENDING |
| 012 | P0 | Live guardrails profiles (`GUARDRAILS_FILE`), spot long-only by capability, perps off in live | 010 | risk-guardian | PENDING |
| 013 | P0 | Exchange-side protective brackets + boot/reconnect reconciliation | 010, 011 | execution-engineer → risk-guardian | PENDING |
| 014 | P0 | Persistence for live: positions upsert, fills FK, monotonic status, `execution_mode`, durable writer | 010 | supabase-dba → risk-guardian | PENDING |
| 015 | P0 | Control-plane security: API token, CORS, localhost bind, edge-function auth | — | risk-guardian | PENDING |
| 016 | P0 | Dashboard live safety: mode banner, real kill/flatten/resume, typed confirms, no fake data | 015, 011 | test-gatekeeper | PENDING |
| 017 | P1 | Backtest integrity: no synthetic, long-only spot, EV gate parity, equity sizing, `--bar-minutes`, `--fee-tier` | 012 | backtest-runner → quant-skeptic | PENDING |
| 018 | P1 | Edge experiments E1–E6 (frequency lever, exits, maker bounds) with kill rule | 017 | backtest-runner → quant-skeptic | PENDING |

**Already done this sprint (2026-09-10, by Cowork):**
- Supabase security hardening applied: `supabase/migrations/20260910175414_security_hardening.sql` (advisors: 0 ERROR)
- Read-only live preflight CLI: `atlas/apps/core-node/src/cli/coinbase-preflight.ts` (`pnpm cb:preflight`) — account verified: auth OK, can_trade, no transfer, Intro 1 fees, $2.90 available
- Paper-history archive script prepared (not run): `supabase/manual/20260910_archive_paper_history.sql`
- Cursor kit: `.cursor/rules`, `.cursor/skills`, `.cursor/agents`, `.cursor/commands`, `.cursor/mcp.json`

## Historical tasks (pre-Sprint 9)

> Statuses for 004–009 predate the May Wave 1/2 work (vitest migration, FeeModel, A1/A3/A6, per-symbol disable). Re-verify before relying on them. 007 (Hyperliquid) is superseded: US persons are excluded and backtests showed no edge at 4.5 bps.

| Task | Description | Status |
|------|-------------|--------|
| 000 | Regime detector confidence fix | ✅ VERIFIED |
| 001 | Phase 4A — Exchange abstraction layer | ✅ VERIFIED |
| 002A | Extend CoinbaseAdapter for perpetual futures | ✅ VERIFIED |
| 002B | Guardrails update for perps config | ✅ VERIFIED |
| 002C | Perps risk module (liquidation/funding/leverage) | ✅ VERIFIED |
| 002D | Strategy layer wiring for perps + shorting | ✅ VERIFIED |
| 003A | Wire perps_symbols strategy overrides + notional limits | ✅ VERIFIED |
| 003B | Perps market data proxy + order routing | ✅ VERIFIED |
| 004 | Startup resilience — non-fatal perps init + state cleanup | RE-VERIFY |
| 005 | Runtime bug fixes — 6 paper mode critical bugs | RE-VERIFY |
| 006 | trading-signals indicator swap | RE-VERIFY |
| 007 | Hyperliquid exchange adapter | SUPERSEDED |
| 008 | TWAP execution hardening | PARKED |
| 009 | CCXT multi-exchange evaluation | PARKED |

## Naming Convention
- Task files: `TASK_XXX_short_description.md`
- Verify scripts: `verify/verify_XXX.cjs` (Sprint 9: `verify/verify_sprint9.cjs --task XXX`)
- Status: PENDING → IN_PROGRESS → DONE → VERIFIED
