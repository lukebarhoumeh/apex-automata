# DB verify scripts — 2026-09-10 handoff

Read-only `SELECT` scripts that check the end state of each migration group in
`docs/db/HANDOFF_2026-09-10.md`. They live under `docs/`, not
`supabase/migrations/`, on purpose: **they are documentation, never migrations.**
Do not copy them into the migrations folder and do not apply them with
`supabase db push` / `apply_migration`.

Nothing here applies anything. Applying the migrations themselves is gated on
Trading Master go; see the handoff doc.

| Script | Verifies | Run when | Key expectation |
|---|---|---|---|
| `00_stub_agentic_heartbeats.sql` | stub `20260902202325` (+ informational `security_hardening_stamp_recorded` for stub `20260910175414`) | after merge, **before #3** | `version_recorded = t`, `public_table_exists = t`, `pass = t` |
| `01_security_invoker_and_revoke.sql` | #1 (`20260910180000`, `20260910180100`) | after #1 | `security_invoker = t` ×3; `anon_exec = f` ×6; `auth_exec = t` only for `has_role` + `upsert_account_metrics`; `pass = t` |
| `02_execution_mode_backfill.sql` | #2 (`20260910180200`) | immediately after #2 | `null_execution_mode_account_metrics = 0`, `null_execution_mode_trading_sessions = 0`, `pass = t` |
| `03_quarantine_agentic_heartbeats.sql` | #3 (`20260910180300`) | after #3 (writers already retargeted) | `in_equity_only = t`, `policies_present = t`, `anon_no_access = t`, `row_count` ≈ 43 (informational), `pass = t` |
| `04_repair_strategy_filter_analysis.sql` | #4 (`20260910180400`) | after #4 | `view_exists = t`, `security_invoker = t`, `fixed_definition = t`, `anon_select = f`, `pass = t` |

## How to run

Each script ends with a one-row summary whose last column is `pass`. Earlier
statements print supporting detail.

- **psql** (shows every result set):
  `psql "$SUPABASE_DB_URL" -X -f docs/db/verify/01_security_invoker_and_revoke.sql`
- **Supabase SQL editor** (shows only the last statement, i.e. the summary):
  paste the file as-is.
- Run as `postgres` (the role the CLI uses). `00_*` reads
  `supabase_migrations.schema_migrations`, which other roles cannot see.

## Reading the results

- `pass = f` on `01`/`02` before the corresponding migration is applied is the
  expected baseline (rehearsed: both report `f` on the pre-apply state and `t`
  afterwards). `03` errors before #3 (`schema "equity" does not exist`) —
  also expected; it only makes sense after #3.
- `00_*` reports `public_table_exists = f` once #3 has moved the table into
  `equity`; `quarantined_to_equity` then reads `t` and `pass` stays `t`. Use
  `03_*` for the full post-quarantine check.
- `02_*`: `null_session_id_account_metrics > 0` is allowed (days with no
  session); only the two `null_execution_mode_*` counts must be 0.
- `03_*`: `last_heartbeat_ts` must advance after the next writer cycle. If it
  stays at the pre-apply value, the equity writer is still targeting
  `public.agentic_heartbeats` — see handoff risk R1. `row_count` is
  informational (~43 on prod, 0 on a Preview branch) and not part of `pass`.
- `04_*` on prod today reports `view_exists = f` (the view was never created
  there); on a Preview branch it reports `anon_select = t` until #4 runs in the
  same chain. Both are expected pre-#4 baselines.
- `01_*` on prod today reports `pass = f` because remote already applied
  `20260910175414_security_hardening` (full file in the repo since Sprint 9), which revoked
  authenticated EXECUTE on `upsert_account_metrics`. Desk lock keeps that grant
  (needed for paper), so `pass` flips to `t` once `20260910180100` or
  `20260910180200` is applied. See handoff R9.
- `03_*` detail matrix: `authenticated` may still show `ins/upd/del = t` until
  handoff gap G1 (revoke the stub's `GRANT ALL ... TO authenticated`) is
  addressed; RLS blocks those writes regardless, and the summary does not
  depend on it.
