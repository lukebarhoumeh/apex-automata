# Apex Automata — Full UI/UX Redesign Handoff

> **Audience:** a developer (or Claude Code) implementing this redesign in the real `apex-automata` codebase.

## What this is

A complete, high-fidelity redesign of the Apex Automata algorithmic trading terminal — 9 tabs (Dashboard, Orders, Signals, Risk, Model, Backtest, Journal, Alerts, Settings) plus shared shell chrome (sidebar, top bar with kill-switch, command palette, ticker tape, footer).

The design was built as a **HTML/React prototype using Babel-in-browser + hand-rolled SVG charts** — it is a **visual + interaction reference**, not production code. Your job is to recreate it in the existing codebase's stack.

## Fidelity

**High-fidelity (hifi).** Colors, spacing, typography, layout densities, and interaction patterns are final and should be matched precisely. Chart rendering will change (SVG-by-hand → recharts) but visual output (colors, grid style, axis labels, data markers) should stay faithful.

## Target stack (already in the repo)

- Vite + React 18 + TypeScript
- Tailwind CSS 3.4 + `tailwindcss-animate` + `@tailwindcss/typography`
- shadcn/ui (Radix primitives + CVA, see `components.json`, `src/components/ui/`)
- recharts 2.15 for charts
- react-router-dom 6
- TanStack Query (server data)
- Supabase (auth/storage)
- lucide-react for icons
- sonner for toasts

**Do not** introduce new charting, styling, or icon libraries. Translate everything to the above.

## Folder contents

```
design_handoff/
├── README.md                    ← this file (start here)
├── CLAUDE_CODE_PROMPT.md        ← copy-paste prompt for Claude Code
├── DESIGN_TOKENS.md             ← colors, type, spacing, shadows — with Tailwind mappings
├── COMPONENTS.md                ← atoms/molecules used across the app
├── SHELL.md                     ← sidebar, top bar, ticker, command palette, footer
├── pages/
│   ├── 01-DASHBOARD.md
│   ├── 02-ORDERS.md
│   ├── 03-SIGNALS.md
│   ├── 04-RISK.md
│   ├── 05-MODEL.md
│   ├── 06-BACKTEST.md
│   ├── 07-JOURNAL.md
│   ├── 08-ALERTS.md
│   └── 09-SETTINGS.md
├── screenshots/                 ← one per tab, full viewport PNG
│   ├── 01-dashboard.png … 09-settings.png
└── source/                      ← original prototype (reference only)
    ├── index.html
    ├── styles2.css              ← all design tokens live here
    └── src/*.jsx                ← per-page React components + primitives
```

## How to use this handoff

1. **Read this README**, then `DESIGN_TOKENS.md`, then `COMPONENTS.md`, then `SHELL.md`. That is the foundation.
2. **Extend `tailwind.config.ts` and `src/index.css`** with the tokens from `DESIGN_TOKENS.md` — add CSS variables for the Obsidian neutrals, accent scale, up/down semantic colors, and font stacks.
3. **Port the shell** (`AppSidebar.tsx` + a new `TopBar`, `TickerTape`, `CommandPalette`, footer) using shadcn primitives and existing routing in `src/App.tsx`.
4. **For each page**, open its `.md` in `pages/`, its matching screenshot, and the source `.jsx` side-by-side. The `.md` tells you **what** to build; the `.jsx` is reference for **how** (layout math, data shape, interaction code). Rebuild as a proper TS React page using shadcn components and recharts.
5. **Hook up real data last.** The prototype uses synthetic data in `source/src/data.jsx` and `data2.jsx` — mirror those shapes as TypeScript interfaces, then wire TanStack Query to your actual backend endpoints.

## Scope summary

| Tab       | Purpose                                               | Key custom visuals                                          |
|-----------|-------------------------------------------------------|-------------------------------------------------------------|
| Dashboard | Overview of P&L, exposure, live signals               | Hero P&L card, equity sparkline, strategy cards, live feed  |
| Orders    | Manage open orders and positions                      | Tabbed blotter, inline order actions, position sparkline    |
| Signals   | Live signal stream + strategy status                  | Signal cards with score gauge, regime panel, stream table   |
| Risk      | Portfolio risk & exposure monitoring                  | **Radar chart**, **correlation heatmap**, exposure tree, kill-switch ladder |
| Model     | Meta-model diagnostics                                | **SHAP waterfall**, live inference, confusion matrix, calibration curve, training runs |
| Backtest  | Strategy research lab                                 | Config form, equity+DD chart, metrics grid, trade log, heatmap |
| Journal   | Trade stories & learnings                             | **Card grid** with chart thumbnails, mood/emoji, tags       |
| Alerts    | If/then/route rule builder                            | **Visual flow blocks** (WHEN → THEN), rule list, trigger log |
| Settings  | Account, venues, risk limits, notifications           | Section nav, toggles, API-key cards, kill-switch card       |

## Visual language cheat sheet

- **Mood:** dark-only "Obsidian" — deep blue-black backgrounds, electric-blue accent, semantic green (up) and red (down).
- **Type:** Geist (display/body), Geist Mono (numbers + all `mono` tags), Instrument Serif Italic (editorial hero headlines only). Exact values in `DESIGN_TOKENS.md`.
- **Charts:** thin strokes (1.4–1.6px), dashed grid (`2 4`), labels in Geist Mono 9.5px, muted foreground.
- **Tables:** zebra off, hover row highlights, right-aligned `mono` numbers, uppercase small caps headers.
- **Panels:** 1px border `--line`, no shadow, 4–6px radius. Headers are a 12/16 padded bar with a bottom border.
- **Status:** tiny 6px glowing dot + 11px mono text (e.g. `LIVE · 43ms`). Reuse throughout.
- **Motion:** brief value flashes on price change (green/red tint, 500ms), ticker tape scrolls linearly, otherwise keep it calm.

## What NOT to do

- ❌ Don't port the raw JSX files — they use Babel-in-browser globals, inline styles, and custom SVG charts.
- ❌ Don't invent new colors outside the token set. If you need more shades, use `color-mix(in srgb, <token> X%, transparent)`.
- ❌ Don't use emojis, gradients-for-gradient's-sake, or AI-slop visual tropes.
- ❌ Don't skip the keyboard shortcuts or command palette — they are core to the product feel.

## What TO do

- ✅ Match spacing, weights, and color temperatures exactly from screenshots.
- ✅ Use shadcn components wherever applicable (Dialog, Sheet, Popover, Tabs, Switch, Slider, Select, Command, Table, Tooltip, Toast).
- ✅ Use `lucide-react` icons (map from the prototype's custom icon set — see `COMPONENTS.md`).
- ✅ Use recharts with custom styling to match the SVG chart look (see each page `.md` for specifics).
- ✅ Strongly type all props and data shapes; put types in `src/types/` by domain.

---

Go tab by tab. The design is consistent — once the shell and Dashboard are in, the rest accelerates fast.
