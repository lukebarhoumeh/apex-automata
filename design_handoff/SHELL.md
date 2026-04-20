# Shell — Sidebar · Top bar · Ticker · Command palette · Footer

These five pieces wrap every page. Source: `source/src/shell.jsx`.

Layout:

```
┌─────────┬─────────────────────────────────────────────────┐
│         │  TopBar (56px)                                  │
│ Sidebar ├─────────────────────────────────────────────────┤
│ (224px) │  TickerTape (34px)                              │
│         ├─────────────────────────────────────────────────┤
│         │                                                 │
│         │             PAGE CONTENT                         │
│         │                                                 │
│         ├─────────────────────────────────────────────────┤
│         │  Footer (status strip, mono)                    │
└─────────┴─────────────────────────────────────────────────┘
```

---

## Sidebar

- Fixed width: **224px**. Sticky at top, `height: 100vh`.
- `bg-obsidian-1`, `border-r border-obsidian-line`, padding `14px`.
- Structure (top to bottom):
  1. **Logo + wordmark** (see `<Logo/>` below)
  2. Section label "Terminal" (mono 10px uppercase, fg-2)
  3. 9 nav items (listed below)
  4. Spacer (grows)
  5. **Session card** — compact inset card showing uptime
  6. **Version footer** — `v2.4.1 · main` + "all systems" green dot

### `<Logo>`

28×28 rounded-[7px] tile with a small bolt/apex glyph on it. Background is the accent radial gradient:
```css
background: radial-gradient(circle at 30% 30%, var(--accent-2), var(--accent));
box-shadow: 0 0 0 1px rgba(255,255,255,0.08), 0 6px 16px -4px var(--accent-glow);
```
Inside, a white SVG path: `M4 20L12 4L20 20` + `M8 14H16` (rough chevron-with-bar). Stroke 2.2, round caps/joins.

Wordmark: "Apex Automata" (Geist 13.5px, 600, -0.01em tracking). Below it, "EXECUTION TERMINAL" label (mono 9px uppercase, fg-2).

### Nav items

Array:
```ts
const NAV = [
  { id: 'dashboard', label: 'Dashboard', icon: 'LayoutGrid',     kbd: 'D' },
  { id: 'orders',    label: 'Orders',    icon: 'ListOrdered',    kbd: 'O' },
  { id: 'signals',   label: 'Signals',   icon: 'TrendingUp',     kbd: 'S' },
  { id: 'risk',      label: 'Risk',      icon: 'Shield',         kbd: 'R' },
  { id: 'model',     label: 'Model',     icon: 'Brain',          kbd: 'M' },
  { id: 'backtest',  label: 'Backtest',  icon: 'FlaskConical',   kbd: 'B' },
  { id: 'journal',   label: 'Journal',   icon: 'BookOpen',       kbd: 'J' },
  { id: 'alerts',    label: 'Alerts',    icon: 'Bell',           kbd: 'A' },
  { id: 'settings',  label: 'Settings',  icon: 'Settings',       kbd: ',' },
];
```

Each item:
- 8px vertical padding, 10px horizontal, 6px border-radius, 10px gap.
- Icon (15px, stroke 1.5), label, `<kbd>` at right.
- Hover: `bg-obsidian-2`, fg-0.
- Active: `bg-obsidian-2` + a **left accent bar** (2px wide, rounded, glowing accent color) positioned at `left: -14px` (outside the nav item's padding), spanning most of its height.

Use `react-router-dom` `<NavLink>` — pass `end` and use its `isActive` to apply the active styling.

### Session card

```tsx
<div className="inset p-2.5">
  <div className="row between center mb-1.5">
    <span className="label">SESSION</span>
    <span className="dot-live"/>
  </div>
  <div className="mono text-[16px] font-medium">{uptime}</div>
  <div className="text-[11px] text-fg-2 mt-0.5">opened 14:02 UTC</div>
</div>
```

---

## Top bar

- Height: **56px**. Sticky, `z-30`.
- Background: `rgba(10,13,20,0.82)` + `backdrop-blur(12px)`. Bottom border `border-obsidian-line`.
- Horizontal layout (left to right):
  1. Breadcrumb — `APEX > {route title}` (mono label + chevron + sans 13px)
  2. **Command trigger** — fake search box 320×32, `bg-obsidian-2 border border-obsidian-line`. Shows "Command or search…" placeholder + `⌘ K` kbd hint at right. Click → opens palette.
  3. Spacer
  4. `<LiveClock>` (UTC)
  5. Vertical divider
  6. **Bot state pill** — 3-segment toggle: `PAPER | LIVE | PAUSED`. Colors: PAPER = accent blue, LIVE = up green, PAUSED = warn amber. Active segment shows a tiny glowing dot in its color before the label.
  7. **Kill switch** button — red/danger style (`btn-danger`): `<Power /> KILL`. Clicking should fire a confirm dialog, then flatten all positions via API (prototype just alerts).
  8. Vertical divider
  9. Tweaks icon button (only if tweaks mode is on)
  10. Avatar — 28×28 circle with accent gradient + "JD" initials.

---

## Ticker tape

- Height: **34px**, below top bar. `bg-obsidian-1`, bottom border.
- Horizontal mask gradient on both edges (3% fade in and out) — `mask-image: linear-gradient(to right, transparent 0, black 3%, black 97%, transparent 100%)`.
- Content: infinite linear scroll of `{SYMBOL  LAST_PRICE  ±PCT%  [sparkline]}` items, gap 32px between.
- Animation: `animate-[ticker-scroll_90s_linear_infinite]`. Double the items in the track so the wrap is seamless (translateX 0 → -50%).
- Price is `mono` 12px fg-0. Pct is green/red 11px with ▲/▼ glyph.
- Sparkline: 46×16, color matches direction.

Reimplement as a React component that reads a symbols feed (WebSocket or polling). Don't re-render the entire track each tick; only patch the affected symbol's cell (use `useRef` + DOM writes, or memoize by symbol).

---

## Command palette

shadcn provides `cmdk` (already in deps: `cmdk: ^1.1.1` and `@radix-ui/react-dialog`). Use the shadcn `<Command>` + `<CommandDialog>` components.

- Trigger: `⌘/Ctrl K` (global keydown listener).
- Content:
  - Search input with magnifier icon left, `ESC` kbd right.
  - Grouped command list:
    - **Navigate:** Go to Dashboard / Orders / Signals / Risk / Model / Backtest / Journal / Alerts / Settings
    - **Mode:** Switch to LIVE / Switch to PAPER / Pause bot
    - **Actions:** Flatten all positions (kill-switch), Open strategy X, Export session P&L CSV
  - Each row: icon (14px), label, small `pill` tag at right (e.g. `nav`, `mode`, `danger`, `export`).
- Dialog chrome: `bg-obsidian-1`, border `obsidian-line-2`, big backdrop blur, positioned ~12vh from top, 560px wide.

---

## Footer

- Height: ~40px. Thin strip at bottom of the main column (below page content, above the window edge).
- `border-t border-obsidian-line`, `bg-obsidian-1`, mono, 11px, tracking-wider, fg-2.
- Left side: three status chips (dot + label + latency):
  - `MD_STREAM · 43ms`    (green)
  - `BROKER · 112ms`       (green)
  - `META_MODEL · READY`   (green)
- Right side: `PID 48291 · build 2.4.1-main-a9f3c · 2026`

Dots change color when unhealthy (green → warn amber → down red).

---

## Keyboard shortcuts

Single global `useEffect` hooking `keydown` on `window`. Skip when focus is in an input/textarea/select (check `e.target.tagName`).

Keys → actions as listed in COMPONENTS.md.

---

## Route config

Existing repo uses react-router-dom already. In `App.tsx`, the route set expands from the current trio to all nine:

```tsx
<Routes>
  <Route path="/"          element={<Index />} />        {/* Dashboard */}
  <Route path="/orders"    element={<Orders />} />
  <Route path="/signals"   element={<Signals />} />
  <Route path="/risk"      element={<Risk />} />
  <Route path="/model"     element={<Model />} />
  <Route path="/backtest"  element={<Backtest />} />
  <Route path="/journal"   element={<Journal />} />
  <Route path="/alerts"    element={<Alerts />} />
  <Route path="/settings"  element={<Settings />} />
  <Route path="*"          element={<NotFound />} />
</Routes>
```

Replace the current SidebarProvider scaffold with the new `<AppShell>` component that composes: Sidebar + TopBar + TickerTape + `<Outlet/>` + Footer + CommandPalette.
