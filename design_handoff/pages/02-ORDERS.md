# 02 — Orders & Positions

**Route:** `/orders` · **Screenshot:** `screenshots/02-orders.png` · **Source:** `source/src/orders.jsx`

## Purpose

Manage live orders (working, filled, cancelled) and open positions. Enter/modify/close orders manually.

## Layout

```
┌────────────────────────────────────────────────────────┬──────────────┐
│ Tabs: [Open orders · Positions · History]              │              │
│ ──────────────────────────────────────────────────────  │ Quick order │
│                                                         │ form panel  │
│ Filters:   symbol · strategy · status ·   [export]     │ (right rail │
│                                                         │  320px)     │
│ <large table with row actions>                          │              │
│                                                         │              │
└────────────────────────────────────────────────────────┴──────────────┘
```

Page padding 24px. Left column flex-1, right rail 320px, gap 20px.

## Tabs

Use shadcn `<Tabs>`:
- **Open orders** — status in (NEW, PARTIAL, WORKING)
- **Positions** — currently open
- **History** — filled + cancelled combined, time-desc

## Filters row

Mono-style filter chips + a right-aligned export button.
- Symbol select (multi)
- Strategy select (multi)
- Status select
- Date range picker (History only)
- Right: `[⤓ Export CSV]` ghost button

## Open orders table

Columns:
| TS | ID | SYM | SIDE | TYPE | QTY | LIMIT PX | STATUS | FILLED | AVG FILL | STRAT | VENUE | — |
- SIDE as `<Pill tone="up">BUY</Pill>` / `<Pill tone="down">SELL</Pill>`
- STATUS pill: `WORKING` accent, `PARTIAL` warn, `FILLED` up, `CANCELLED` muted
- Actions cell (hover reveals): `Modify · Cancel · Details`
- Row hover: `bg-obsidian-2`

## Positions table

Columns:
| SYM | SIDE | QTY | ENTRY | MARK | P&L $ | P&L % | STOP | TARGET | OPENED | STRAT | SPARK | — |
- MARK column ticks live (500ms color flash on change)
- P&L color-coded and formatted `+$XXX.XX`
- SPARK: 80×22 sparkline of the position's unrealized P&L since entry
- Actions: `[Close] [Move stop] [Scale]`
- Clicking a row expands an inline detail strip showing: fill breakdown, slippage vs entry signal, running R-multiple.

## History table

Columns:
| TS | SYM | SIDE | QTY | FILL PX | P&L (if closed lot) | STRAT | VENUE | STATUS |

Pagination: 50 rows, shadcn `<Pagination>`.

## Quick order form (right rail)

Small panel, sticky top, ~560px tall:
- **Symbol** select (default to last viewed)
- Side segmented: `[BUY | SELL]` (color-toned, up/down)
- Type segmented: `[MKT | LMT | STOP]`
- Quantity input with stepper
- Limit price input (conditional on LMT/STOP)
- Risk summary row: `Notional: $18,240` `Max loss: $420 (2R)`
- Big primary button matching side color: `[SUBMIT MARKET BUY]` or similar
- Below: "Last 3 orders" compact list of 3 recent orders (mono 11px)

Form validation: disable submit if qty≤0, missing limit px when LMT, or exceeds max position-size limit.

## Interactions

- Cancelling a working order → optimistic update, row fades + flash warn, then removed on server ack
- Modifying → opens Popover with editable px/qty, save button
- Closing a position → confirm dialog ("Close 0.4182 BTC-USD at MARKET?") → fires order → row updates
- Real-time: subscribe to order-update stream; flash updated rows (`row-flash` animation)

## Data hooks

```ts
useOrders({ status?, symbol?, strategy?, range? })
usePositions()
usePlaceOrder()        // mutation
useCancelOrder()
useModifyOrder()
useClosePosition()
```
