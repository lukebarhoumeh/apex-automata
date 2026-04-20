# 06 — Backtest

**Route:** `/backtest` · **Screenshot:** `screenshots/06-backtest.png` · **Source:** `source/src/backtest.jsx`

## Purpose

Strategy research lab. Configure, run, and inspect backtest results.

## Layout

Left rail (config, 340px) · main results area.

### Config form (left rail)

Sticky panel with scrollable body:
- Run name input
- Strategy select (same list as dashboard)
- Universe (multi-select symbols)
- Date range picker (from / to)
- Timeframe select (`1m`, `5m`, `15m`, `1h`, `4h`, `1d`)
- Starting capital input
- Fee/slippage accordion (taker bps, maker bps, slippage bps)
- Risk block: max position size, max portfolio heat, per-trade stop
- Model toggle: `Use meta-model gating` with threshold slider (0–1)
- Advanced accordion: walk-forward windows, bootstrap iterations

Bottom pinned: `[RUN BACKTEST]` primary full-width, duration hint "est. 42s".

### Results area

**Top KPI strip** — 6 stats: Total return · CAGR · Sharpe · Max DD · Win rate · # Trades. Each with delta vs buy-and-hold baseline.

**Equity + drawdown chart** (panel, ~320px)
- Top chart (70%): strategy equity curve (solid accent) + benchmark (dashed fg-2)
- Bottom strip (30%): drawdown filled area in red, inverted (0 at top, more negative below)
- Shared x-axis, crosshair on hover shows date + values

**Monthly returns heatmap** (panel, ~220px)
- Matrix: years as rows, months as columns
- Cell colored on diverging red→neutral→green scale, value `+3.2%` in mono 10px
- Row totals at right, column totals at bottom

**Trade log** (panel, ~280px scrollable table)
Columns: `# · OPENED · SYMBOL · SIDE · ENTRY · EXIT · BARS · P&L $ · P&L % · R-MULT · REASON_IN · REASON_OUT`
- R-multiple shown as small bar with color tone
- Row click → inline expansion showing trade-level chart snippet (candles + entry/exit markers)

**Parameter sensitivity** (optional panel, bottom, ~200px)
- Shows one or two tornado charts: "Sharpe vs threshold", "Return vs stop size"

### Saved runs dropdown

At top of results: `Load previous run ▾` select. Selecting switches the whole results view to that archived run.

## Data hooks

```ts
useBacktestRuns()
useBacktestResult(runId)  // full payload: equity, trades, heatmap, stats
useRunBacktest()          // mutation
```
