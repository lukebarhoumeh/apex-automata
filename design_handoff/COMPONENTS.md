# Components — Apex Automata

Atoms and molecules used throughout the app. Port each as a typed React component (`src/components/apex/*.tsx`), using shadcn/ui primitives where possible.

All source lives in `source/src/primitives.jsx`. This document gives you the semantic contract and suggested shadcn mapping.

---

## Icon

Source uses a hand-rolled SVG icon set (`<Icon name="..." size={16} stroke={1.6}/>`). **Replace with `lucide-react`**. Mapping:

| Prototype name | lucide-react              |
|----------------|---------------------------|
| `grid`         | `LayoutGrid`              |
| `activity`     | `Activity`                |
| `pulse`        | `Activity` (or `Waves`)   |
| `chart`        | `LineChart`               |
| `shield`       | `Shield`                  |
| `book`         | `BookOpen`                |
| `bell`         | `Bell`                    |
| `brain`        | `Brain`                   |
| `flask`        | `FlaskConical`            |
| `settings`     | `Settings`                |
| `orders`       | `ListOrdered`             |
| `trend`        | `TrendingUp`              |
| `trendDown`    | `TrendingDown`            |
| `play`         | `Play`                    |
| `pause`        | `Pause`                   |
| `power`        | `Power`                   |
| `zap`          | `Zap`                     |
| `check`        | `Check`                   |
| `x`            | `X`                       |
| `arrowUp/Down/Right` | `ArrowUp/Down/Right` |
| `plus`         | `Plus`                    |
| `minus`        | `Minus`                   |
| `search`       | `Search`                  |
| `command`      | `Command`                 |
| `filter`       | `Filter`                  |
| `info`         | `Info`                    |
| `alert`        | `TriangleAlert`           |
| `download`     | `Download`                |
| `refresh`      | `RefreshCw`               |
| `sliders`      | `Sliders`                 |
| `eye`          | `Eye`                     |
| `lock`         | `Lock`                    |
| `layers`       | `Layers`                  |
| `dots`         | `MoreHorizontal`          |
| `chevRight`    | `ChevronRight`            |
| `chevDown`     | `ChevronDown`             |
| `external`     | `ExternalLink`            |
| `flag`         | `Flag`                    |
| `target`       | `Target`                  |
| `heart`        | `Heart`                   |
| `user`         | `User`                    |
| `plug`         | `Plug`                    |
| `mail`         | `Mail`                    |
| `phone`        | `Phone`                   |
| `terminal`     | `Terminal`                |
| `slack`        | `Slack`                   |
| `copy`         | `Copy`                    |

Default props: `size={16}`, `strokeWidth={1.6}`. For heavier hero badges use `strokeWidth={2}`.

---

## `<Panel>`

A bordered card with an optional header bar.

```tsx
interface PanelProps {
  title?: string;          // small-caps mono label
  subtitle?: string;       // sm body text
  right?: React.ReactNode; // slot at top-right of header
  pad?: number;            // body padding (default 16)
  header?: boolean;        // default true; set false when you build the header yourself
  tone?: 'default' | 'accent';  // 'accent' gives a subtle blue border tint
  className?: string;
  children: React.ReactNode;
}
```

Visual: `bg-obsidian-1`, `border border-obsidian-line`, `rounded-[10px]`. Header row: `px-4 py-3`, bottom border, label in mono uppercase.

Suggested implementation: plain `div` (shadcn `Card` is similar but has different padding defaults; wrap it or roll your own).

---

## `<Pill>`

Tag/badge with tone variants.

```tsx
type PillTone = 'default' | 'up' | 'down' | 'warn' | 'accent';
<Pill tone="up">LONG</Pill>
```

Styling: rounded-full, mono text, 10.5px, uppercase-ish letterspacing. Background is tone color @ 8% alpha, text is full tone color, border is tone @ 20%.

Suggested: port to shadcn `Badge` with `variant` prop.

---

## `<Stat>`

Big number tile with label and delta.

```tsx
<Stat
  label="SESSION P&L"
  value="+$1,284.56"
  delta="+2.4% · 18 trades"
  tone="up"             // 'up' | 'down' | 'accent' | 'neutral'
  large                 // bumps font size
/>
```

Uses `mono` display font at 20–26px, label in mono 10px uppercase, delta in sans 11px fg-2.

---

## `<Switch>`

Toggle switch with glowing "on" state. Use shadcn `Switch` and theme it:
- `data-state="checked"` → `bg-accent`, knob white
- `data-state="unchecked"` → `bg-obsidian-3`, knob `bg-fg-1`
- Size: `w-[34px] h-[20px]` (knob 16×16)

---

## `<Segmented>`

Tab strip for segmenting views (e.g. order type LIMIT/MARKET, strategy filter). Use shadcn `ToggleGroup` (type="single", variant="outline") and restyle:
- Wrapper: `bg-obsidian-2 border border-obsidian-line rounded-[7px] p-0.5`
- Item: `mono text-[11px] tracking-wider uppercase`, active → `bg-obsidian-4` + inner ring.

---

## `<LiveClock>`

Ticking UTC clock. Updates every 1000ms. Format: `HH:MM:SS UTC`. Accompanying green pulsing dot (use `animate-live-pulse`).

---

## `<HeatBar>`

Horizontal progress bar with semantic warning color.

```tsx
<HeatBar value={0.72} cap={1} warn={0.7} />
```

4px tall, rounded-full. Fill `bg-up` normally, `bg-warn` when `value/cap > warn`. Subtle glowing box-shadow on fill.

---

## `<Sparkline>`

Tiny inline line chart (e.g. 46×16 or 80×22). Auto-colors green/red based on first vs last value. Used in:
- Ticker tape (46×16)
- Position rows (80×22)
- Stat card footer (160×24)

**Implementation:** keep hand-rolled SVG (easiest) or use recharts `<LineChart width={46} height={16}>` with no axes/grid. Either is fine — sparklines don't need recharts' full machinery.

---

## `<AreaChart>`

Equity curve / P&L curve chart. Full chart with Y-axis labels, dashed grid, gradient fill underneath line, dot on last point.

Source props:
```tsx
{ data: [{t, v}], width, height, color, showAxis, compact, highlightLast }
```

**Target:** use recharts `<AreaChart>` with:
- `<defs><linearGradient>` fading accent → transparent
- `<CartesianGrid stroke="#1a2030" strokeDasharray="2 4" vertical={false}/>`
- `<YAxis tick={{fontFamily:'Geist Mono', fontSize: 9.5, fill: '#6a7588'}}/>`
- `<Area stroke={color} strokeWidth={1.6} fill="url(#gradient)" type="monotone"/>`
- Custom `<Dot>` on last point (ref point + glow circle)

---

## `<CandleChart>`

OHLC candlestick with a dashed live-price line and a colored price label at the right edge.

**Target:** recharts doesn't have native candles. Two options:
1. **Use `recharts-candlestick` package** — simplest.
2. **Build a custom component using `<ComposedChart>` + `<Bar>` for bodies + custom shape for wicks** — matches the prototype exactly.

Right-edge live-price label: overlay a div absolute-positioned over the chart, `bg-accent`, `text-accent-ink`, mono 10.5px, padded rectangle.

---

## Data formatting helpers

Port these from `source/src/data.jsx`:

```ts
export const fmt = (n: number, dec = 2) =>
  n.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });

export const fmtMoney = (n: number, dec = 2) =>
  (n >= 0 ? '$' : '-$') + fmt(Math.abs(n), dec);

export const fmtSign = (n: number, dec = 2) =>
  (n >= 0 ? '+' : '-') + fmt(Math.abs(n), dec);

export const fmtPct = (n: number, dec = 2) =>
  (n >= 0 ? '+' : '') + n.toFixed(dec) + '%';
```

All number formatting across the app MUST use tabular-nums. Put a `.mono` class (or Tailwind `font-mono tabular-nums`) on every numeric cell.

---

## Table conventions

- Header: `text-[10px] tracking-wider uppercase font-mono text-fg-2`, padded `px-3 py-2.5`, bottom border `border-obsidian-line`, sticky-top, `bg-obsidian-1`.
- Row: 36px tall (`h-9`), border-bottom `border-obsidian-line`. Hover → `bg-obsidian-2`.
- Number cells: right-aligned, `font-mono tabular-nums`.
- Semantic color: long → green, short → red, long/short → pill in row.

Use shadcn `<Table>` and override styles with `className`.

---

## Motion

| Event                        | Animation                                             |
|------------------------------|-------------------------------------------------------|
| Price change on ticker       | `animate-[flash-up_600ms]` bg tint (green or red)    |
| Stat value change            | `text-up` or `text-down` for 500ms, then back         |
| New row arrival              | `animate-row-flash` 900ms (subtle accent tint)        |
| Live dot                     | 1.6s ease-in-out pulse ring                           |
| Ticker scroll                | 90s linear infinite                                   |
| Hover button                 | `transition-all duration-150`                          |
| Panel entry on route change  | no explicit animation (fast route swap)               |

---

## Keyboard shortcuts (global)

Implement as a `useEffect` in the app shell. Skip when focus is in an input/textarea/select.

| Key     | Action                     |
|---------|----------------------------|
| `⌘/Ctrl + K` | Open command palette   |
| `Esc`   | Close command palette      |
| `D`     | Go to Dashboard            |
| `O`     | Go to Orders               |
| `S`     | Go to Signals              |
| `R`     | Go to Risk                 |
| `M`     | Go to Model                |
| `B`     | Go to Backtest             |
| `J`     | Go to Journal              |
| `A`     | Go to Alerts               |
| `,`     | Go to Settings             |

---

## File suggestions

```
src/components/apex/
├── Panel.tsx
├── Stat.tsx
├── Pill.tsx
├── Sparkline.tsx
├── HeatBar.tsx
├── LiveClock.tsx
├── Segmented.tsx
├── format.ts
└── chart/
    ├── ApexAreaChart.tsx    ← wraps recharts
    ├── ApexCandleChart.tsx  ← custom composed
    ├── ApexRadarChart.tsx
    └── ApexHeatmap.tsx
```
