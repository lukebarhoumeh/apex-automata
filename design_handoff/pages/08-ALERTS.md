# 08 — Alerts

**Route:** `/alerts` · **Screenshot:** `screenshots/08-alerts.png` · **Source:** `source/src/alerts.jsx`

## Purpose

Visual if/then/route rule builder. Pipe signals, fills, risk breaches, and model events to Slack/email/phone/webhook.

## Layout

Top: rule-count KPIs + `[+ New rule]`. Main: 2-column split — rule list (left, 1/2) · rule editor / trigger log (right, 1/2).

### KPI strip
- Active rules · Fires today · Fires this week · Silenced

### Rule list (left)

Cards, one per rule. Each card shows the rule as a **visual flow**:

```
 ┌─────────┐      ┌─────────┐      ┌─────────┐
 │  WHEN   │  →   │ CONDITION│  →  │  THEN   │
 │ Signal  │      │ score>0.8│      │ Slack   │
 │ taken   │      │ strat=MR │      │ #trades │
 └─────────┘      └─────────┘      └─────────┘
```

Each block is a rounded rectangle, `bg-obsidian-2 border border-obsidian-line-2 rounded-md px-3 py-2`, with:
- A colored label strip at top (`WHEN` in accent, `CONDITION` in warn, `THEN` in up)
- Stacked mono-labeled rows inside
Arrows between blocks are 1px fg-2 with a chevron tip.

Card footer: status toggle switch, "last fired 3m ago · 47 times today", `[Edit] [Duplicate] [Silence] [Delete]`.

Filter/search at top of list.

### Rule editor (right, appears when editing/creating)

Form with three big sections mirroring the flow blocks:

**WHEN (trigger)**  — dropdown of event types:
- Signal generated / Signal taken / Signal blocked
- Order placed / Order filled / Order cancelled
- Position opened / Position closed / Stop hit
- Risk heat > threshold / VaR breach
- Model drift detected / Training run finished
- Market regime change

**CONDITION (filters)** — dynamic form based on trigger:
- Symbol in, Strategy in, Score >/</>=, Side ==, Notional >, etc.
- Conditions are ANDed; click `+ OR group` for alternatives

**THEN (actions)** — one or more:
- Send Slack message (channel + template with vars: `{symbol}`, `{pnl}`, `{score}`, `{strategy}`)
- Email (to, subject, body)
- SMS / Phone call (phone, script)
- Webhook (URL, headers, JSON template)
- Internal: Pause bot / Pause strategy / Flatten symbol

**Throttle** — "at most N per hour", "quiet hours 22–07".

Bottom: `[Test rule] [Save] [Save & enable]`.

### Trigger log (right, when not editing)

Scrollable timeline:
```
12:48:09  signal.taken  BTC-USD  →  Slack #trades
12:12:01  stop.hit      ETH-USD  →  SMS +1...
...
```
Each entry shows rule name, event summary, action routed. Click to expand full payload.

## Data hooks

```ts
useRules()
useRule(id)
useTriggerLog({ ruleId?, range? })
useSaveRule()
useSilenceRule()
useTestRule()
```
