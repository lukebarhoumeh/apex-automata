# 01 — Dashboard

**Route:** `/` · **Screenshot:** `screenshots/01-dashboard.png` · **Source:** `source/src/dashboard.jsx`

## Purpose

Command-center landing page. At a glance: what state is the bot in, what's my P&L, what's happening right now.

## Layout (top to bottom)

1. **Hero state panel** — full width, ~260px tall, gradient background with subtle grid + noise
2. **KPI row** — 4 stat tiles, equal width
3. **Main split** — 2/3 equity chart + strategy list  |  1/3 live signal feed
4. **Secondary row** — open positions table + market regime card

All panels use the `<Panel>` primitive. Gaps between rows: 16px. Page padding: 24px.

## 1. Hero state panel

Layout: 3-column grid `1.05fr 1fr 1fr`, 28px column gap, 28px padding, tinted accent border (`rgba(59,130,246,0.18)`), linear gradient background, `.gridbg` + `.noise` overlays.

**Column 1 — State & narrative:**
- Mode pill: glowing dot + `PAPER MODE` / `LIVE MODE` / `PAUSED MODE` in mono 11px (color matches mode)
- `ENGINE v2.4.1` accent pill
- **Editorial headline** in Instrument Serif italic, 44px: "The engine is _scanning_ 6 markets for edge." (accent-color on verb, fg-1 on object)
- Subtitle paragraph (12.5px fg-1): bot state sentence + meta-model threshold + signals scanned/taken stats
- Action buttons: `[Intervene]` primary, `[Pause engine]` secondary, `[Logs]` ghost

**Column 2 — P&L headline:**
- Label "SESSION P&L" in eyebrow style
- Giant number in mono 56px, green/red with text glow (`0 0 32px` of tone at 30%)
- Row below: REALIZED / UNREALIZED / TRADES TAKEN mini-stats

**Column 3 — Heat & risk:**
- `RISK HEAT` label + 4px `<HeatBar>` filled accent→warn at 70%
- Current heat fraction (mono), capped at `heatCap`
- Compact sparkline of last hour equity (80×28)

The hero ticks live: P&L updates every 1.1s with jittered random walk.

## 2. KPI row

Four `<Stat>` tiles:
1. **Win rate** — "62.4%" · delta "18 winners / 29 total"
2. **Sharpe (30d)** — "2.14" · delta "+0.31 vs prior"
3. **Max DD (30d)** — "-3.82%" · delta "$-4,120 peak"
4. **Open exposure** — "$42,180" · delta "3 positions · 41% of capital"

All with tiny sparklines in the bottom-right corner.

## 3. Main split

### Left: Equity curve + strategy list (spans 2/3)

- **Equity chart panel** ~240px: segmented header `[1D|1W|1M|ALL]`, big area chart, last-value dot + label glued to the right edge
- **Strategy cards** below: 3 cards in a row with strategy name, P&L today, trades, win rate, status dot (on/off/cooldown), mini P&L sparkline. Clicking a card routes to Signals filtered by that strategy.

### Right: Live signal feed (spans 1/3, tall)

A scrolling feed of signal events (~8 visible, no hard cap, new items slide in from top with row-flash).

Each feed item:
```
[TIME]  [SYMBOL]  [STRAT_BADGE]  [headline]
        score: 0.78  ·  risk: LOW
```

Uses the `SIGNALS` and `FEED` streams in `data.jsx`. Header has `LIVE ·  43ms` status and a filter icon.

## 4. Secondary row

### Positions table

Full `table.t`, same columns as Orders/Positions tab's Positions view:
`SYM · SIDE · QTY · ENTRY · MARK · P&L · P&L% · STOP · TARGET · STRAT · [actions]`

P&L color-coded. Mark price ticks live (green/red flash). Rightmost actions: close, edit stop.

### Market regime card

Small panel, 240px wide, to the right of the positions table:
- Label "REGIME · 4h"
- Big serif italic word: "TRENDING" or "CHOPPY" or "RISK-OFF"
- 4 mini horizontal meters: Volatility, Momentum, Breadth, Funding. Each shows label + value + tiny bar colored by tone.

## Data hooks

```ts
useEquityCurve(range: '1D'|'1W'|'1M'|'ALL')
useOpenPositions()
useSessionStats()        // pnl, realized, unrealized, heat, trades
useStrategyStatus()
useSignalFeed()          // WebSocket stream
useMarketRegime()
```

## Responsive

Below 1280px: KPI row collapses to 2 columns. Below 1024px: hero columns stack to single column.
