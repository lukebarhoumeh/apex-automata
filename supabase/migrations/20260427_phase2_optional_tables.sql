-- 2026-04-27 Phase 2.1 — create the two "optional" tables that the runtime
-- has been silently failing to write to. validateSchema.ts lists both as
-- expected, and meta-filter.ts:837 actively inserts into meta_filter_decisions
-- on every signal. equity_snapshots has no writer yet but is reserved for
-- intra-session equity-curve persistence (separate from the existing
-- daily_equity table which is one-row-per-day).

CREATE TABLE IF NOT EXISTS public.meta_filter_decisions (
  id TEXT PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  signal_id TEXT,
  symbol TEXT NOT NULL,
  strategy TEXT,
  direction TEXT,
  signal_strength DOUBLE PRECISION,
  volume_ratio DOUBLE PRECISION,
  regime TEXT,
  hour_of_day SMALLINT,
  day_of_week SMALLINT,
  passed BOOLEAN NOT NULL,
  meta_score DOUBLE PRECISION,
  rules_evaluated JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_filter_decisions_signal ON public.meta_filter_decisions(signal_id);
CREATE INDEX IF NOT EXISTS idx_meta_filter_decisions_timestamp ON public.meta_filter_decisions(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_meta_filter_decisions_symbol_passed ON public.meta_filter_decisions(symbol, passed);

ALTER TABLE public.meta_filter_decisions ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='meta_filter_decisions' AND policyname='Service role full access on meta_filter_decisions') THEN
    CREATE POLICY "Service role full access on meta_filter_decisions" ON public.meta_filter_decisions FOR ALL USING (true);
  END IF;
END $$;

-- equity_snapshots: intra-session equity-curve persistence. Reserved for
-- future use (no current writer); creating now so a writer can be wired
-- without an additional migration round-trip mid-session.
CREATE TABLE IF NOT EXISTS public.equity_snapshots (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID,
  session_id TEXT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_equity_usd NUMERIC(20, 8) NOT NULL,
  realized_pnl_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  unrealized_pnl_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  exposure_usd NUMERIC(20, 8) NOT NULL DEFAULT 0,
  open_positions_count INTEGER NOT NULL DEFAULT 0,
  daily_pnl_usd NUMERIC(20, 8),
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_equity_snapshots_session ON public.equity_snapshots(session_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_equity_snapshots_recorded_at ON public.equity_snapshots(recorded_at DESC);

ALTER TABLE public.equity_snapshots ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='equity_snapshots' AND policyname='Service role full access on equity_snapshots') THEN
    CREATE POLICY "Service role full access on equity_snapshots" ON public.equity_snapshots FOR ALL USING (true);
  END IF;
END $$;
