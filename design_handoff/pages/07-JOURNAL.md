# 07 — Journal

**Route:** `/journal` · **Screenshot:** `screenshots/07-journal.png` · **Source:** `source/src/journal.jsx`

## Purpose

Trade journaling. Capture learnings and context on closed trades, searchable + filterable over time.

## Layout

Top: filter + new-entry bar. Main: 3-column card grid (card list).

### Filter bar

- Search input (wide)
- Symbol multi-select
- Strategy multi-select
- Mood multi-select (`WIN · LOSS · MEH · LESSON · HIGH CONVICTION`)
- Tag multi-select
- Date range
- Right: `[+ New entry]` primary

### Entry cards

3 columns at ≥1280px, 2 at <1280px, 1 at <768px. Card structure:

```
┌─────────────────────────────────────┐
│ [THUMBNAIL CHART - 100% × 120px]    │  ← PnL colored miniature chart
│                                      │
│ BTC-USD · LONG · breakout            │  ← mono small header
│ Oct 14 · 09:34 → 12:18               │
│                                      │
│ ★ High conviction                    │  ← mood pill (tone-colored)
│                                      │
│ "Broke 4h VWAP with 2x avg volume.   │  ← excerpt (2 lines clamp)
│  Sized up because meta-model..."     │
│                                      │
│ [#breakout] [#high-vol] [#session-a] │  ← tags (small pills)
│                                      │
│ +$284.18 · +1.8R           [⋯]     │  ← footer: P&L + actions
└─────────────────────────────────────┘
```

- Thumbnail: 5-minute candle chart of the trade window, entry/exit markers drawn
- Clicking card opens `/journal/:id` detail view (or a Sheet) with: full chart, full markdown text body, screenshots, linked order details, linked signals, mood, tags
- Editing inline supported via `Edit` action in `⋯` menu

### New entry flow

`[+ New entry]` opens a Dialog:
- Link to recent closed trade (dropdown)
- Mood select (pills)
- Markdown textarea with toolbar (bold, italic, code, list, image upload)
- Tags input (comma-separated with auto-complete)
- Save draft / Publish buttons

## Empty state

Illustration placeholder + "No entries yet. Log your first trade to start building a playbook."

## Data hooks

```ts
useJournalEntries({ search?, symbols?, strategies?, moods?, tags?, range? })
useJournalEntry(id)
useCreateEntry()
useUpdateEntry()
useDeleteEntry()
```
