# Backtest / Journal / Alerts / Settings Pages — Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Pattern established by prior 5 pages (Dashboard/Orders/Signals/Risk/Model): types → seed → hook → components → page → playwright verify → commit. Refer to `design_handoff/source/src/{page}.jsx` and `design_handoff/pages/{06,07,08,09}-*.md` for layout specifics.

**Goal:** Build `/backtest`, `/journal`, `/alerts`, `/settings` pages matching design_handoff specs, then verify frontend ↔ backend ↔ DB wiring.

**Architecture:** Same as prior 5 pages — TanStack Query hooks over deterministic mock seeds in `src/hooks/apex/mock/seed-data.ts`. Visual-only; no mutations wired to real APIs. Replace `queryFn` with real fetches later without touching consumers.

**Constraints:** no new npm deps, follow Obsidian theme tokens, commit per page, dev server runs on :8081.

---

## Task 1 — Backtest page

**Files:**
- `src/types/backtest.ts` — `BacktestConfig`, `BacktestResults`, `BacktestEquityPoint`, `MonthlyReturn`, `BacktestTrade`, `RDistBucket`, `BacktestData`
- `src/hooks/apex/useBacktestData.ts` — `useBacktestData()`
- Append `BACKTEST_SEED` to `seed-data.ts` (port from `data2.jsx` lines 135–205)
- `src/components/apex/backtest/BacktestHero.tsx` — Return / Sharpe / Sortino / Trade economics
- `src/components/apex/backtest/ConfigPanel.tsx` — Strategy select, symbol chips, date range, capital, 4 sliders, Run button (no-op state)
- `src/components/apex/backtest/EquityWithDD.tsx` — SVG equity line + drawdown underlay
- `src/components/apex/backtest/MonthlyReturnsPanel.tsx` — per-month horizontal bars
- `src/components/apex/backtest/RHistogram.tsx` — horizontal bars for R-distribution buckets
- `src/components/apex/backtest/TradeLogTable.tsx` — trade sample table
- Replace `src/pages/Backtest.tsx` with composition

**Verify:** navigate `/backtest` — expect hero (+24.38%, Sharpe 2.14, MaxDD -6.2%), config form, equity chart with green/red DD underlay, Jan/Feb/Mar/Apr bars, R-histogram, 8-row trade log.

**Commit:** `Phase 1: Backtest — hero / config / equity+DD / monthly / R-dist / trade log`

---

## Task 2 — Journal page

**Files:**
- `src/types/journal.ts` — `JournalEntry`, `JournalOutcome`
- `src/hooks/apex/useJournalData.ts` — `useJournalEntries()`
- Append `JOURNAL_SEED` (6 entries from `data2.jsx` lines 207–257)
- `src/components/apex/journal/JournalHero.tsx` — wins/losses breakdown, tag cloud
- `src/components/apex/journal/JournalFilterBar.tsx` — ALL/WIN/LOSS buttons + New entry
- `src/components/apex/journal/JournalCard.tsx` — trade card with mini chart, thesis, entry/exit/stop/target cells, tags, expand-to-lessons
- `src/components/apex/journal/MiniTradeChart.tsx` — small SVG candle-like line (seeded) with entry/exit markers
- Replace `src/pages/Journal.tsx` with composition

**Verify:** `/journal` renders hero with 4 wins / 2 losses, filter bar, 2-col grid of 6 cards with mini charts + outcome pills + tags + expandable lessons section.

**Commit:** `Phase 1: Journal — hero / filter / entry cards with mini-charts + lessons`

---

## Task 3 — Alerts page

**Files:**
- `src/types/alerts.ts` — `AlertRule`, `AlertAction`, `AlertFiredEvent`, `AlertWhenSpec`
- `src/hooks/apex/useAlertsData.ts` — `useAlertRules()`, `useAlertFired()`
- Append `ALERT_RULES_SEED` + `ALERT_FIRED_SEED` (from `data2.jsx` lines 259–297)
- `src/components/apex/alerts/AlertsHero.tsx` — rules count / 24h triggers / channel fingerprint
- `src/components/apex/alerts/RuleList.tsx` — left column with selectable rule cards (toggle + name + metric summary + fire-count pill)
- `src/components/apex/alerts/RuleEditor.tsx` — right column: rule name, WHEN flow block, THEN action list, compiled rule preview
- `src/components/apex/alerts/TriggerLogTable.tsx` — fired events table with level pills
- Replace `src/pages/Alerts.tsx` with composition

**Verify:** `/alerts` hero shows 4 triggers (4 warn, 1 danger), 5 rules listed, first rule selected with WHEN/THEN blocks + compiled preview, 4-row trigger log.

**Commit:** `Phase 1: Alerts — hero / rule list / rule editor (WHEN/THEN) / trigger log`

---

## Task 4 — Settings page

**Files:**
- `src/types/settings.ts` — `AccountInfo`, `Venue`, `NotificationChannel`, `RiskLimits`, `SettingsData`
- `src/hooks/apex/useSettingsData.ts` — `useSettings()`
- Append `SETTINGS_SEED` (from `data2.jsx` lines 299–325)
- `src/components/apex/settings/SettingsNav.tsx` — left rail with sections + workspace card + kill-switch card
- `src/components/apex/settings/sections/AccountSection.tsx`
- `src/components/apex/settings/sections/VenuesSection.tsx`
- `src/components/apex/settings/sections/RiskLimitsSection.tsx` — sliders bound to local state
- `src/components/apex/settings/sections/NotificationsSection.tsx` — channel toggle table
- `src/components/apex/settings/sections/AdvancedSection.tsx`
- `src/components/apex/settings/parts/SectionHeader.tsx` + `FormRow.tsx` + `ToggleSwitch.tsx` — shared primitives
- Replace `src/pages/Settings.tsx` with composition (section state + routing)

**Verify:** `/settings` renders left nav with 5 sections, clicking each swaps the right pane. Default `Account` section shows Display name, Email, Plan badge, 2FA pill, API key. Kill-switch card bottom-left toggles green/red armed state.

**Commit:** `Phase 1: Settings — nav + account/venues/risk/notifications/advanced sections`

---

## Task 5 — Backend & DB connection audit

After all 4 pages are committed:

1. **Inventory hook → data-source mapping** — grep `src/hooks/apex/` for `queryFn`; note which return mock seeds vs. real fetches.
2. **Check `src/runtime/` and `src/services/` for real API clients** — Coinbase WS, Supabase client, backend HTTP client.
3. **Inspect `RuntimeWsProvider` + `UnifiedEventProvider`** in `src/App.tsx` composition — what events do they broadcast?
4. **Check Supabase usage** — `src/integrations/supabase/` or similar; any direct `supabase.from(...)` calls that back the new pages?
5. **Start backend** (`pnpm backend` from root, or `pnpm api` inside `atlas/apps/core-node/`) and check:
   - GET `/health` returns 200
   - GET `/api/status` returns JSON
   - WebSocket `/events` accepts a connection
6. **Deliver a connection report** as a markdown block listing: (a) which pages/panels are live vs. mock, (b) backend endpoints expected, (c) concrete next steps to wire them.

---

## Known deviations from spec (pragmatic)

- Sliders render as read-only progress bars unless interaction is required for local demo state. Matches prior pages.
- `New entry` dialogs in Journal / `New rule` in Alerts are buttons only (no dialog implementation yet).
- Backtest `RUN BACKTEST` button is a no-op; no mutation wired.
- Settings Save buttons no-op; state persists only locally.
