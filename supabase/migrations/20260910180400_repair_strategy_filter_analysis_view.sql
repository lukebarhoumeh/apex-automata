-- Repair public.strategy_filter_analysis (meta-filter analytics view).
--
-- The original definition in 20260107000002_meta_filter_decisions.sql nested
-- aggregates (jsonb_object_agg(... COUNT(*))) and fails with SQLSTATE 42803.
-- Verified read-only on prod 2026-09-10: the view does NOT exist there (version
-- 20260107000002 is recorded, but the CREATE never took effect or the view was
-- dropped). Supabase Preview replays the chain from scratch and hit the error.
--
-- 20260107000002 is patched in place for fresh replays; this migration is the
-- idempotent safety net for any environment that partially applied it: it
-- drops whatever exists under the name and re-creates the fixed definition.
-- Body is the Database Engineer's CTE version, verbatim (hourly breakdown
-- pre-aggregated, no nested aggregates), security_invoker per desk rule.
-- On prod this CREATES the view (net-new object). TM-gated like the rest of
-- this pack; see docs/db/HANDOFF_2026-09-10.md.

DROP VIEW IF EXISTS public.strategy_filter_analysis;

CREATE OR REPLACE VIEW public.strategy_filter_analysis
WITH (security_invoker = true)
AS
WITH hourly AS (
  SELECT
    strategy,
    hour_of_day,
    COUNT(*) AS total,
    SUM(CASE WHEN passed THEN 1 ELSE 0 END) AS passed,
    SUM(CASE WHEN outcome = 'win' THEN 1 ELSE 0 END) AS wins
  FROM public.meta_filter_decisions
  WHERE hour_of_day IS NOT NULL
  GROUP BY strategy, hour_of_day
),
hourly_json AS (
  SELECT
    strategy,
    jsonb_object_agg(
      hour_of_day::TEXT,
      jsonb_build_object('total', total, 'passed', passed, 'wins', wins)
    ) AS hourly_stats
  FROM hourly
  GROUP BY strategy
)
SELECT
  m.strategy,
  COUNT(*) AS total_decisions,
  SUM(CASE WHEN m.passed THEN 1 ELSE 0 END) AS signals_passed,
  SUM(CASE WHEN NOT m.passed THEN 1 ELSE 0 END) AS signals_blocked,
  AVG(m.meta_score) AS avg_meta_score,
  SUM(CASE WHEN m.passed AND m.outcome = 'win' THEN 1 ELSE 0 END) AS passed_wins,
  SUM(CASE WHEN m.passed AND m.outcome = 'loss' THEN 1 ELSE 0 END) AS passed_losses,
  SUM(CASE WHEN NOT m.passed AND m.outcome = 'win' THEN 1 ELSE 0 END) AS blocked_would_win,
  SUM(CASE WHEN NOT m.passed AND m.outcome = 'loss' THEN 1 ELSE 0 END) AS blocked_would_lose,
  CASE
    WHEN SUM(CASE WHEN m.passed AND m.outcome IS NOT NULL THEN 1 ELSE 0 END) > 0
    THEN SUM(CASE WHEN m.passed AND m.outcome = 'win' THEN 1 ELSE 0 END)::DECIMAL
         / SUM(CASE WHEN m.passed AND m.outcome IS NOT NULL THEN 1 ELSE 0 END)
    ELSE NULL
  END AS passed_win_rate,
  SUM(CASE WHEN NOT m.passed THEN m.pnl ELSE 0 END) AS blocked_pnl,
  h.hourly_stats
FROM public.meta_filter_decisions m
LEFT JOIN hourly_json h ON h.strategy = m.strategy
GROUP BY m.strategy, h.hourly_stats;

COMMENT ON VIEW public.strategy_filter_analysis IS
  'Per-strategy meta-filter decision analytics with hourly breakdown (repaired 2026-09-10: no nested aggregates; security_invoker).';

-- Desk rule (20260910175414_security_hardening): public analytics views carry
-- security_invoker and no anon access. Nothing reads this view as anon today.
REVOKE ALL ON TABLE public.strategy_filter_analysis FROM anon;
