-- 2026-04-22 — orphan-position cleanup on engine start needs an explicit
-- exit_reason. Without it, any positions left open by a crashed/killed
-- engine bleed into the next session's UI as "still open" forever, and
-- analytics can't distinguish them from genuine manual exits.
--
-- See atlas/apps/core-node/src/api/server.ts openTradingSession() — the
-- engine now stamps closed_at + exit_reason='session_end' for every row
-- with closed_at IS NULL before opening a new trading_sessions row.

ALTER TYPE public.trade_exit_reason ADD VALUE IF NOT EXISTS 'session_end';
