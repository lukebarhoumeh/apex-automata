# 09 — Settings

**Route:** `/settings` · **Screenshot:** `screenshots/09-settings.png` · **Source:** `source/src/settings.jsx`

## Purpose

Account, venues, risk limits, notifications, appearance.

## Layout

Left section nav (200px) · right form area. Classic master/detail settings pattern.

### Section nav

Vertical list, sticky:
1. Profile
2. Venues & API keys
3. Risk limits
4. Notifications
5. Appearance
6. Audit log
7. Danger zone

Active item: accent left bar + `bg-obsidian-2` (same pattern as sidebar nav).

### Section: Profile

Form with:
- Avatar (gradient circle with initials) + "Upload" button
- Display name, email, timezone (select), UTC-offset preview
- Role (read-only: Admin / Trader / Viewer)
- Two-factor auth — status pill + `[Enable]` / `[Regenerate codes]`
- Session list — table of active sessions with revoke button

### Section: Venues & API keys

Cards — one per venue (Coinbase, Binance, Alpaca, etc.):
```
┌─ Coinbase ──────────────────────── [●] CONNECTED ─┐
│ Key: ck_*****2f9a                 Added 3d ago    │
│ Permissions: trade ✓  withdraw ✗                   │
│ Venue fee tier: T2 · taker 15bps                   │
│ [Rotate key] [Disconnect] [Test connection]        │
└────────────────────────────────────────────────────┘
```
+ `[Connect new venue]` button.

### Section: Risk limits

Grouped form, uses shadcn `<Slider>` + number input pairs:
- Max position size ($ + % of capital)
- Max portfolio heat (0–1)
- Daily loss limit ($)
- Max open positions (n)
- Max leverage
- Per-trade stop (%)
- Meta-model threshold (0–1)
- Emergency kill-switch password (set/change)

Each row shows current value + slider + numeric input. Changes require a `[Save all limits]` button at bottom (not auto-save).

### Section: Notifications

- Global toggles for: Fills, Signals taken, Risk breaches, Model drift, Training runs, Daily summary
- Per-channel routing: Slack webhook, Email, Phone. Test button for each channel.
- Quiet hours picker

### Section: Appearance

- Accent color — 4 swatches (electric / emerald / amber / violet) with selected outline
- Density — segmented `[Comfortable | Compact]`
- Layout — segmented `[Focus | Expanded]`
- Live price flash — toggle
- Font scale — slider (0.9x – 1.1x)

### Section: Audit log

Table: `TS · ACTOR · ACTION · SUBJECT · IP`. Filter by actor, action type, date range.

### Section: Danger zone

Red-tinted panel:
- `[Export all data]`
- `[Reset to defaults]`
- `[Delete account]` — requires type-to-confirm

## Data hooks

```ts
useProfile()
useVenues()
useRiskLimits()
useNotificationSettings()
useAppearance()
useAuditLog()
```
