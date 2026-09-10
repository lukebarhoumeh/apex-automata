# TASK_012: Live Guardrails Profiles, Spot Long-Only, Perps Off in Live

**Priority:** P0
**Status:** PENDING
**Depends on:** TASK_010
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 0
**Skills:** `sprint-task-execution` · **Review subagent:** `risk-guardian`

---

## Context

- `loadGuardrails(atlasRoot)` always loads `atlas/config/guardrails.yaml` (`config/loadGuardrails.ts:268-269`). There is no way to run live with different limits without editing the paper config.
- `strategy.allow_short: true` (`guardrails.yaml`) makes `server.ts:1914-1915` treat a spot SELL as a **short entry**; the only guard is `risk-engine.ts:746`, keyed to the same flag. On Coinbase spot a SELL either rejects (no base) or **sells existing holdings**.
- `/api/engine/start` initializes the `CoinbasePerpsAdapter` for every session and starts `PerpsRiskMonitor` in live (`server.ts:1204-1245`). INTX perps are non-US and the Advanced Trade INTX endpoints are deprecated.
- `atlas/config/live.local.yaml` / `paper.local.yaml` are consumed only by the legacy CLI (`cli/index.ts`) and still enable breakout/vwap_mr — they are not the API runtime config and are misleading.

## IMPORTANT CONSTRAINTS

1. `guardrails.yaml` remains the base and the paper default — zero behaviour change when `GUARDRAILS_FILE` is unset.
2. Overlay = deep merge (objects merge, arrays replace, explicit `{}` clears a map).
3. Spot long-only is enforced **in code by venue capability**, not only by a yaml flag.
4. Zod-validate the merged result with the existing schema + a new `live` block.

---

## Step 1 — Profile overlay loader

- `loadGuardrails(atlasRoot, opts?: { overlayFile?: string })`; server reads `process.env.GUARDRAILS_FILE` (relative to `atlas/config/`).
- Merge `guardrails.yaml` ← overlay; record `profile` name + overlay sha256 in logs and `/api/status.guardrailsProfile`.
- Add schema block:
  ```ts
  live: z.object({
    symbols: z.array(z.string()).min(1),
    max_round_trips: z.number().int().positive().optional(),
    ev_gate_mode: z.enum(['enforce', 'shadow']).default('enforce'),
    require_exchange_protection: z.boolean().default(true),
    reconcile_interval_sec: z.number().int().min(15).default(60),
    account_refresh_sec: z.number().int().min(15).default(60),
    min_quote_usd: z.number().positive().default(20),
    monthly_loss_budget_usd: z.number().positive(),
  }).optional()
  ```
- In `mode:'live'`: `live` block is **required**; engine products = `live.symbols` (not `per_symbol` keys); refuse start if absent.

## Step 2 — Create profiles

- `atlas/config/guardrails.live-canary.yaml` and `atlas/config/guardrails.live-1k.yaml` exactly as in `docs/plans/SPRINT-9-LIVE-COINBASE.md` §4.
- Move `atlas/config/live.local.yaml` + `paper.local.yaml` to `atlas/config/legacy-cli/` with a README line: "legacy CLI only — not used by the API runtime".

## Step 3 — Spot long-only by venue capability

- Add `capabilities: { shorting: boolean }` to the execution adapter factory output (Coinbase spot = false; paper inherits the live venue's capability when `PAPER_VENUE_PARITY=true`, default true).
- `server.ts` signal routing: `shortAllowed = guardrails.strategy.allow_short && capabilities.shorting`.
- SELL on spot with an open long ⇒ exit; SELL with no position ⇒ drop with telemetry stage `spot_short_blocked`.
- **Never** sell a base asset the engine did not buy this session (protect pre-existing holdings, e.g. manual GALA/BTC): exit size = min(position qty, engine-owned base balance).

## Step 4 — Perps off in live

- If `mode==='live'`: skip `CoinbasePerpsAdapter.initialize`, skip `PerpsRiskMonitor`, and fail start if any product matches `/-PERP-INTX$/`.

## Step 5 — Tests

1. No `GUARDRAILS_FILE` ⇒ merged config deep-equals current `guardrails.yaml` (snapshot).
2. Canary overlay ⇒ `strategy.allow_short=false`, `per_symbol.ETH-USD.max_notional_usd=25`, `perps_symbols={}`.
3. Live start without `live` block ⇒ `LIVE_PROFILE_REQUIRED`.
4. Spot SELL with no position ⇒ no order; SELL with position ⇒ exit order qty ≤ engine-owned qty.
5. Live mode does not construct `CoinbasePerpsAdapter` (spy).

## Acceptance Criteria

- [ ] Tests green; `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 012` PASS
- [ ] `risk-guardian` review clean
