-- Reconciliation file pulled from supabase_migrations.schema_migrations
-- (version 20251016044541, name (empty)) on 2026-05-14 via Supabase MCP.
-- Captures DDL applied directly to prod via dashboard/Lovable IDE.

-- Enable REPLICA IDENTITY FULL for complete row data during updates
-- This ensures all column data is available in realtime subscriptions

ALTER TABLE public.orders REPLICA IDENTITY FULL;
ALTER TABLE public.order_legs REPLICA IDENTITY FULL;
ALTER TABLE public.fills REPLICA IDENTITY FULL;
ALTER TABLE public.positions REPLICA IDENTITY FULL;
ALTER TABLE public.risk_events REPLICA IDENTITY FULL;
ALTER TABLE public.alerts REPLICA IDENTITY FULL;