# 03 — Signals

**Route:** `/signals` · **Screenshot:** `screenshots/03-signals.png` · **Source:** `source/src/signals.jsx`

## Purpose

Live stream of generated trading signals plus strategy status. See what the bot is seeing — what passed, what was gated, what triggered.

## Layout

Top: 3 KPI strip (Candidates / Gated by meta / Taken · with today deltas).
Main: 2-column split — signal stream (left, 2/3) · regime + strategy status (right, 1/3).

## Signal stream (left)

A large panel with a live-updating table / card list (pick: dense table at default density, card list at comfortable density — or just table always).

Row format (table):
| TIME | SYMBOL | STRAT | HEADLINE | SCORE | GATE | RISK | ACTION |
- `HEADLINE` e.g. "BTC breakout above 4h VWAP with volume"
- `SCORE` shown as a **mini horizontal gauge** (60px wide, 6px tall), value 0–1, colored accent. Number right of bar: `0.78`
- `GATE` pill: `PASSED` up / `BLOCKED` warn / `COOLDOWN` muted, with tooltip explaining why
- `RISK` pill: `LOW` / `MED` / `HIGH`
- `ACTION` rightmost: `TAKEN` accent pill (with link to resulting order) or `—`
- Row expansion reveals: feature snapshot (table of feature → value), meta-model prediction, decision reason

New signals arrive at top with row-flash animation; auto-pause on hover.

Header controls:
- Live/Pause toggle (pause freezes stream for reading)
- Filter: strategy multi-select, only-taken switch, symbol search
- Status: `LIVE · 43ms` green indicator

## Regime panel (top-right)

Same market regime card as dashboard, larger here:
- Big serif italic label: "TRENDING"
- 4 meters: Volatility, Momentum, Breadth, Funding
- Last updated timestamp in mono

## Strategy status (below regime)

Cards for each strategy (3–5 strategies):

```
┌──────────────────────────────┐
│ vwap_mr        [●] ENABLED   │
│ Mean reversion to VWAP        │
│                               │
│ Signals today    12           │
│ Taken            4 (33%)      │
│ P&L today       +$412.84      │
│                               │
│ [sparkline]                   │
└──────────────────────────────┘
```

Status dot: green=enabled, amber=cooldown, red=disabled. Clicking a card flips enabled state (with confirm for "disable while positions open").

## Interactions

- Clicking a signal row opens side drawer with full feature inspector (all features the model saw + SHAP-like contribution bars)
- Taking manual action on a blocked signal requires admin role → fires with confirm dialog

## Data hooks

```ts
useSignalStream()          // WS
useStrategies()            // with today's stats
useMarketRegime()
useFeatureInspect(signalId)
```
