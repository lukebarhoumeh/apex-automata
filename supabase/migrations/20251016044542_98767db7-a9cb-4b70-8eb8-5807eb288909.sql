-- Enable REPLICA IDENTITY FULL for complete row data during updates
-- This ensures all column data is available in realtime subscriptions

ALTER TABLE public.orders REPLICA IDENTITY FULL;
ALTER TABLE public.order_legs REPLICA IDENTITY FULL;
ALTER TABLE public.fills REPLICA IDENTITY FULL;
ALTER TABLE public.positions REPLICA IDENTITY FULL;
ALTER TABLE public.risk_events REPLICA IDENTITY FULL;
ALTER TABLE public.alerts REPLICA IDENTITY FULL;