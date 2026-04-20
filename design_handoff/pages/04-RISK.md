# 04 — Risk

**Route:** `/risk` · **Screenshot:** `screenshots/04-risk.png` · **Source:** `source/src/risk.jsx`

## Purpose

Portfolio risk monitoring. Is the bot breaching any limits? What's the concentration? What's the correlation structure? One-click kill path.

## Layout

Top: 4-KPI hero row. Main: 2-column asymmetric grid.

### KPI hero row
Four big stat tiles:
1. **Portfolio heat** — e.g. "0.72 / 1.00" with horizontal heat bar, warns amber past 0.7
2. **VaR (99%, 1d)** — "-$2,840" ("based on 30d empirical")
3. **Leverage** — "1.8x" (caption "cap 3.0x")
4. **Beta to BTC** — "0.72"

### Left column (2/3 width)

**Risk radar chart** (panel, ~420px tall). A spider chart with 6 axes:
- Volatility, Concentration, Leverage, Drawdown risk, Correlation cluster, Liquidity
Two overlaid polygons: current (filled accent at 30% alpha, strong accent stroke) vs target envelope (dashed fg-2 stroke, no fill).
Labels in mono 10px. Gridlines at 20/40/60/80/100 as concentric hexagons, dashed (2 4).

**Correlation heatmap** (panel, ~360px tall). N×N grid (symbols) with cells colored on a red→black→green diverging scale. Cell size ~44px. Values in mono 10px centered in cell. Row + column labels in mono 11px.
Hover cell: tooltip shows pair + ρ + 30d window.
Sort toggle: alphabetical / clustered.

### Right column (1/3 width)

**Exposure tree** (panel, ~420px tall). Tree-like breakdown: `ASSET CLASS → SYMBOL → STRATEGY → POSITION`. Rendered as nested rows with indentation + value bars. Each row: label + $ value + % of total (bar).

**Kill-switch ladder** (panel). Five escalating actions, each a button:
1. `Pause new entries` (accent)
2. `Cancel all working orders` (accent)
3. `Flatten one symbol...` (warn) — opens symbol picker
4. `Close all positions` (down)
5. `KILL · HALT EVERYTHING` (down, solid, glowing) — requires confirm dialog with type-to-confirm input

Below ladder: "Recent kill events" — compact list of last 3 manual interventions.

### Bottom row

**Risk events log** (panel, 200px tall). Table:
| TS | SEVERITY | LIMIT | SUBJECT | MESSAGE |
- SEVERITY pill: `INFO` / `WARN` / `BREACH`
- Filter by severity.

## Data hooks

```ts
usePortfolioRisk()       // heat, var, leverage, beta
useRiskRadar()           // 6-axis current + target
useCorrelationMatrix(window: '30d' | '90d')
useExposureTree()
useRiskEvents()
useKillActions()         // mutations
```
