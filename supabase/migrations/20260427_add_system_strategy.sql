-- 2026-04-27 — system-originated orders (flatten, position exits, kill-switch
-- closes) are tagged strategy: 'system' by trading-engine.ts but the value
-- isn't in the strategy_name enum. server.ts normalizeStrategy() falls back
-- to 'breakout' with a WARN, which mislabels every system exit as a real
-- strategy and pollutes per-strategy P&L.
--
-- See atlas/apps/core-node/src/trading/trading-engine.ts:690 (flatten) and
-- :820 (position exit). The matching change in server.ts adds 'system' to
-- the valid list in normalizeStrategy() so the WARN stops firing.

ALTER TYPE public.strategy_name ADD VALUE IF NOT EXISTS 'system';
