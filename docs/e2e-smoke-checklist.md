# E2E Smoke Checklist (Backbone)

## Prereqs
- Frontend running with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` set
- Trading engine (runtime API + WS) available

## Supabase Edge Functions
- `GET /functions/v1/runtime-health` returns `{ ok: true, dbOk: true }`
- `POST /functions/v1/ingest-alert` inserts a new alert row
- `POST /functions/v1/alerts-ack` sets `acked_at` for a known alert
- `POST /functions/v1/journal-entry` create/update/delete works for a test entry
- `POST /functions/v1/strategy-toggle` flips a strategy and persists
- `POST /functions/v1/risk-settings-update` persists an update for the user
- `POST /functions/v1/strategy-signal-upsert` updates `meta` threshold params

## Realtime + Catch-up
- With WS connected, create a new order → UI updates without manual refresh
- Simulate disconnect → reconnect → `catchUp` backfills missing data
- Dedupe check: no duplicate entries after reconnect

## Trading State / Alerts
- Trigger kill switch → `KillSwitchBanner` is persistent and `AlertModal` shows
- Acknowledge alert → row updates and badge count drops

## Charts / PnL
- Equity chart follows `pnl:snapshot` stream (no jumps > $0.10)

