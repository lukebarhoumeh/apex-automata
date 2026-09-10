# TASK_016: Dashboard Live Safety — truthful state, working emergency controls, no fake data

**Priority:** P0
**Status:** PENDING
**Depends on:** TASK_015 (token), TASK_011 (`liveAccount` in `/api/status`)
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 0
**Rule:** `.cursor/rules/50-dashboard-ui.mdc`

---

## Context (audit 2026-09-10)

| # | Problem | Evidence |
|---|---|---|
| U1 | Risk page **KILL ALL has no onClick**; ⌘K "Flatten all positions" is a placeholder toast; no Resume UI | `src/components/apex/risk/RiskHero.tsx:97-100`, `CommandPalette.tsx:68-105`, `AppShell.tsx:18-26` |
| U2 | **Positions table adds `Math.random` jitter** to marks and freezes rows at mount | `PositionsTable.tsx:14-36`, `ActivePositionsStrip.tsx:14-33` |
| U3 | No global LIVE/PAPER/HALTED/STALE state; pill defaults to "paper" and stays green after kill | `EngineControls.tsx:56-74`, `useDashboardData.ts:72` |
| U4 | **Stop = one-click market flatten** in live (flatten_on_shutdown) with no confirm | `EngineControls.tsx:77-89`, `trading-engine.ts:433-457` |
| U5 | Footer health chips hard-coded green; Model/Backtest/Journal/Alerts/Settings are 100% seeded mock data (Settings shows a fake "LIVE · connected" key) | `Footer.tsx:33-43`, `hooks/apex/mock/seed-data.ts` |
| U6 | Hero "Unrealized" hard-coded 0; equity falls back to yaml $10,000 | `useDashboardData.ts:84`, `server.ts:2869` |
| U7 | Status events replace the query cache wholesale → `sessionId` flaps → invalidates every `["apex"]` query → likely refetch storm into the 600/min limit | `applyEventToCache.ts:175-178`, `ActiveSessionProvider.tsx:39-64` |
| U8 | No ErrorBoundary — a render crash takes the Kill button with it | `AppShell.tsx` |
| U9 | Supabase reads have no session/mode filter → paper history mixes with live | `useOrdersData.ts`, `useSignalsData.ts`, `useDashboardData.ts:191` |

## IMPORTANT CONSTRAINTS

1. Every mutating call goes through one `src/services/controlApi.ts` (bearer token, 10s timeout, error surfacing). Remove raw `fetch` in `EngineControls.tsx:10-14`.
2. Destructive actions in live require a typed phrase (`STOP`, `CLOSE ALL`, `RESUME`, `LIVE <nonce>`).
3. Anything not wired to real data is labeled **DEMO** or hidden while `mode==='live'`.
4. No new deps (shadcn `AlertDialog` already present).

---

## Steps

1. `controlApi.ts` — `kill()`, `resume()`, `flattenAll(reason)`, `stop()`, `liveChallenge()`, `startLive(phrase)`.
2. `ConfirmPhraseDialog.tsx` — generic typed-confirm dialog.
3. `ModeBanner.tsx` above `TopBar` — states: `BACKEND DOWN/STALE` (status age > 10s) · `HALTED (reasons) — positions NOT auto-closed` + Resume · `LIVE · REAL MONEY · Coinbase · equity $X · tier Intro 1 (60/120 bps)` · `PAPER` · `STOPPED`. Remove `?? "paper"` fallbacks → `UNKNOWN`.
4. Wire RiskHero KILL ALL + ⌘K flatten to `controlApi`; delete ⌘K "Switch to Live/Paper/Pause" placeholders.
5. Positions: delete `useTickingMarks`/`useLiveMarks`; marks from WS ticker; P&L `—` when mark missing; rows derived from props every render; add `GET /api/positions` (backend `tradingEngine.getOpenPositions()`) and use it instead of Supabase.
6. Footer chips from `/api/status` (`ws`, `rest`, `exchangeHealth`, user-stream health from TASK_010).
7. `<DemoDataBanner/>` on Model, Backtest, Journal, Alerts, Settings; hide those routes in nav when `mode==='live'`.
8. Status cache: merge instead of replace; backend includes `sessionId`/`sessionStartedAt` in every `StatusUpdate` (`server.ts:710`, `:767`); delete forced refetch in `RuntimeWsProvider.tsx:170-172`.
9. `PageBoundary` error boundary around `<Outlet/>`; replace `return null` loading states with skeleton + error.
10. Scope Orders/Signals/Fills queries to the active session (`gte created_at sessionStartedAt`) and `execution_mode` (after TASK_014).

## Tests (Vitest + jsdom)

1. `ModeBanner` renders HALTED when `killSwitch.active`, LIVE when `mode==='live'`, STALE when status age > 10s.
2. `ConfirmPhraseDialog` blocks confirm until phrase matches.
3. `PositionsTable` output is deterministic for identical props (no randomness).
4. `controlApi` attaches bearer token and surfaces server error text.

## Acceptance Criteria

- [ ] Root `pnpm test` green (add `"test": "vitest run"` at root if missing); `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 016` PASS
- [ ] Manual: kill → banner HALTED → resume via typed phrase → banner clears (paper)
