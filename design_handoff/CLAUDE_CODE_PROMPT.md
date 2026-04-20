# CLAUDE CODE PROMPT — Apex Automata UI rebuild

Copy this entire block and paste it into Claude Code at the repo root.

---

I've dropped a design handoff package at `design_handoff/` in this repo. It contains a full high-fidelity UI redesign of the Apex Automata algorithmic-trading terminal — 9 tabs plus shared shell chrome. Your job is to implement it in our actual stack.

**Read these files first, in this exact order, before writing any code:**

1. `design_handoff/README.md` — overview and ground rules
2. `design_handoff/DESIGN_TOKENS.md` — colors, type, spacing, Tailwind config additions
3. `design_handoff/COMPONENTS.md` — shared atoms/molecules, icon map, formatting helpers
4. `design_handoff/SHELL.md` — sidebar, top bar, ticker, command palette, footer

Then for each page you're working on, read the matching page spec + its screenshot + its source `.jsx`:

- `design_handoff/pages/01-DASHBOARD.md`   + `screenshots/01-dashboard.png` + `source/src/dashboard.jsx`
- `design_handoff/pages/02-ORDERS.md`      + `screenshots/02-orders.png`    + `source/src/orders.jsx`
- `design_handoff/pages/03-SIGNALS.md`     + `screenshots/03-signals.png`   + `source/src/signals.jsx`
- `design_handoff/pages/04-RISK.md`        + `screenshots/04-risk.png`      + `source/src/risk.jsx`
- `design_handoff/pages/05-MODEL.md`       + `screenshots/05-model.png`     + `source/src/model.jsx`
- `design_handoff/pages/06-BACKTEST.md`    + `screenshots/06-backtest.png`  + `source/src/backtest.jsx`
- `design_handoff/pages/07-JOURNAL.md`     + `screenshots/07-journal.png`   + `source/src/journal.jsx`
- `design_handoff/pages/08-ALERTS.md`      + `screenshots/08-alerts.png`    + `source/src/alerts.jsx`
- `design_handoff/pages/09-SETTINGS.md`    + `screenshots/09-settings.png`  + `source/src/settings.jsx`

**The source/*.jsx files are a visual/behavioral reference only. Do not port them literally** — they use Babel-in-browser globals, inline styles, and hand-rolled SVG charts. Rewrite everything in our actual stack:

- TypeScript React (strict)
- Tailwind CSS (extend `tailwind.config.ts` per `DESIGN_TOKENS.md`)
- shadcn/ui components (already scaffolded under `src/components/ui/`)
- recharts for all charts
- react-router-dom for routing (9 new routes)
- TanStack Query for server data (data hooks per page spec)
- lucide-react for icons (mapping table in `COMPONENTS.md`)
- sonner for toasts

## Execution plan — work in this order

**Phase 0 — Foundation**
1. Update `tailwind.config.ts` and `src/index.css` with tokens from `DESIGN_TOKENS.md`. Load Geist, Geist Mono, Instrument Serif from Google Fonts in `index.html`.
2. Build shared primitives in `src/components/apex/`: `Panel`, `Stat`, `Pill`, `Sparkline`, `HeatBar`, `LiveClock`, `Segmented`, `format.ts`.
3. Build the `AppShell` composing `AppSidebar` (rewrite of existing one), `TopBar`, `TickerTape`, `Footer`, and the `CommandPalette`. Wire all keyboard shortcuts from `SHELL.md`.
4. Update `src/App.tsx` with the 9 routes.

**Phase 1 — Pages, in priority order**
1. Dashboard (already partially exists — rewrite the page body to match `pages/01-DASHBOARD.md`)
2. Orders
3. Signals
4. Risk
5. Model
6. Backtest
7. Journal
8. Alerts
9. Settings

For each page: build the page component, any page-specific subcomponents, and define the TanStack Query hooks (keep them mocked against synthetic data until a backend endpoint exists — mirror the shapes from `source/src/data.jsx` and `data2.jsx`).

**Phase 2 — Types & data shapes**
- Put domain types in `src/types/{orders,positions,signals,risk,model,backtest,journal,alerts}.ts`
- Mirror the synthetic shapes exactly so a future backend can match the contract

**Phase 3 — Polish**
- Real-time streams: wire WebSocket / SSE for the ticker, signal feed, inference stream, positions marks (mock with `setInterval` if the backend isn't ready; put the mock behind a feature flag)
- Number-flash animations, row-flash on new arrivals, ticker scroll
- Responsive behavior per page spec

## Ground rules

- ❌ No new dependencies without asking. Use what's already in `package.json`.
- ❌ No emojis, no AI-slop gradients, no unnecessary iconography.
- ❌ Don't skip the keyboard shortcuts or command palette — core to the feel.
- ❌ Don't `git commit` until I've reviewed at least Phase 0.
- ✅ Match spacing, colors, and typography exactly from the screenshots and tokens file.
- ✅ All numbers in the UI must be `font-mono` with `tabular-nums`.
- ✅ Strong TypeScript — no `any`, proper prop types, types for every data hook return.
- ✅ Accessibility: keyboard navigable, focus rings visible (accent ring 2px offset 2px), semantic HTML.
- ✅ Keep component files under ~300 lines; extract subcomponents when a page gets big.

## Questions to raise before coding

If anything in the handoff is ambiguous for the real codebase, stop and ask me instead of guessing. In particular:
- If a page spec mentions a data shape that conflicts with an existing type in our repo, confirm which wins.
- If a shadcn component needs heavy restyling to match, confirm whether to theme globally or add a variant.
- If recharts can't hit the visual target (e.g. candlesticks), confirm whether to add a chart library or roll a custom SVG component.

Start with Phase 0. When you've got the shell rendering with the real sidebar, top bar, ticker, and command palette on a placeholder page, show me before moving on to Dashboard.
