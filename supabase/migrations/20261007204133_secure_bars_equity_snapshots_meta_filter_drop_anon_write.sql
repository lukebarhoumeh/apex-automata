-- Security fix (advisor C1, 2026-10-07 audit): three tables carried a misnamed
-- "Service role full access" policy with roles={public}, cmd=ALL, qual=true.
-- service_role bypasses RLS entirely, so these policies only granted the public
-- anon/authenticated keys full write access. Replace with read-only SELECT
-- policies matching the *_read_public pattern used by sibling trading tables.
-- All backend writers use the service key (trading-engine/paper-test/backtest
-- CLI pass serviceKey), so writes are unaffected.
-- Applied to prod (gdrdaajvutmewgxbjurk) via MCP on 2026-10-07 as version 20261007204133.

drop policy "Service role full access" on public.bars;
drop policy "Service role full access on equity_snapshots" on public.equity_snapshots;
drop policy "Service role full access on meta_filter_decisions" on public.meta_filter_decisions;

create policy bars_read_public
  on public.bars for select
  to anon, authenticated
  using (true);

create policy equity_snapshots_read_public
  on public.equity_snapshots for select
  to anon, authenticated
  using (true);

create policy meta_filter_decisions_read_public
  on public.meta_filter_decisions for select
  to anon, authenticated
  using (true);
