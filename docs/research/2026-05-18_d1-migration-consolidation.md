# D1 — Supabase migration consolidation (BLOCKED)

**Date**: 2026-05-18
**Worker**: W2 D1-migration-consolidation subagent
**Status**: BLOCKED — Supabase MCP authenticated to wrong account
**Outcome**: 51 historical migrations left intact. No baselines authored. No
files moved or deleted. Documentation-only commit.

---

## 1. TL;DR

Dispatched per `docs/plans/HANDOFF-2026-05-18.md` §6.3 ("Dispatch D1 — MCP-driven").
Per Step 0 of the dispatch recipe, verified the Supabase MCP connection — and
discovered the MCP is authenticated to a completely different Supabase account.

It can see two projects (`ChromeEnterpriseProject`, `KalshiTradingBot`) under
org `GoogleChrome`, but has **zero access** to `gdrdaajvutmewgxbjurk` (the
apex-automata project). All MCP calls against `gdrdaajvutmewgxbjurk` return
`MCP error -32600: You do not have permission to perform this action`.

Per the task's explicit Stop condition — "If MCP connection fails or token is
invalid: STOP. Do not proceed." — I stopped. The 51 historical migrations
under `supabase/migrations/*.sql` remain untouched.

---

## 2. Diagnostic evidence

### 2.1 What `list_projects` returned

```json
{
  "projects": [
    {
      "id": "lvdkocljbchdgjbaarqu",
      "name": "ChromeEnterpriseProject",
      "organization_id": "mebtqtsxzdydeprfwlxs",
      "organization_slug": "mebtqtsxzdydeprfwlxs"
    },
    {
      "id": "xsurdpegrpxnwdficlay",
      "name": "KalshiTradingBot",
      "organization_id": "mebtqtsxzdydeprfwlxs",
      "organization_slug": "mebtqtsxzdydeprfwlxs"
    }
  ]
}
```

`list_organizations` returned a single org: `{ "id": "mebtqtsxzdydeprfwlxs", "name": "GoogleChrome" }`.

### 2.2 What direct calls against `gdrdaajvutmewgxbjurk` returned

| Tool | Args | Result |
|---|---|---|
| `get_project` | `{"id":"gdrdaajvutmewgxbjurk"}` | `MCP error -32600: You do not have permission to perform this action` |
| `execute_sql` | `{"project_id":"gdrdaajvutmewgxbjurk", "query":"SELECT 1;"}` | same permission error |
| `list_migrations` | `{"project_id":"gdrdaajvutmewgxbjurk"}` | same permission error |
| `list_extensions` | `{"project_id":"gdrdaajvutmewgxbjurk"}` | same permission error |
| `list_tables` | `{"project_id":"gdrdaajvutmewgxbjurk", "schemas":["public"]}` | same permission error |

### 2.3 What `.env` contains

`.env` at the repo root (gitignored, verified present) has:

```
SUPABASE_URL="https://gdrdaajvutmewgxbjurk.supabase.co"
SUPABASE_ACCESS_TOKEN=sbp_fd96052d...                       # redacted suffix
SUPABASE_SERVICE_KEY=eyJ...                                  # JWT, ref=gdrdaajvutmewgxbjurk
VITE_SUPABASE_PROJECT_ID="gdrdaajvutmewgxbjurk"
```

The token in `.env` is non-empty and looks structurally valid (Supabase PAT
format: `sbp_` + 40 hex chars). **The MCP is not using it.** The MCP was
configured at some prior point with a token for a different account and that
config is still in force.

### 2.4 Where the MCP config lives (best guess)

- `~/.cursor/mcp.json` exists but is 0 bytes — not the source.
- No `.cursor/mcp.json` in the apex-automata workspace.
- The `plugin-supabase-supabase` MCP server is installed via the Cursor plugin
  store (see `C:/Users/lukeb/.cursor/projects/c-Users-lukeb-apex-automata/mcps/plugin-supabase-supabase/`).
- Plugin-installed MCP servers receive their PAT through Cursor's plugin
  settings UI (per-plugin secret store), not from any project file.

---

## 3. Unblock procedure (what the user needs to do)

### Option A — Repoint the Supabase plugin (recommended)

1. Open Cursor Settings → Plugins → Supabase (or wherever `plugin-supabase-supabase`
   is listed).
2. Find the field for "Personal Access Token" / "SUPABASE_ACCESS_TOKEN".
3. Replace the current token with the one in `.env` line 15:
   `sbp_fd96052d324e1cde1edcda703c46c036643d561d`.
4. Restart Cursor (or reload the MCP server from the plugin UI).
5. In a fresh agent session, verify:
   ```
   CallMcpTool plugin-supabase-supabase list_projects {}
   ```
   should return apex-automata's project list, including `gdrdaajvutmewgxbjurk`.
6. Then re-dispatch this D1 task from a fresh subagent. The recipe in
   `docs/plans/HANDOFF-2026-05-18.md` §6.3 is correct as written — only Step 0
   was blocked.

### Option B — Add a second Supabase plugin instance

If Cursor supports multiple instances of the Supabase MCP plugin
(one per token), install a second one bound to the apex-automata PAT. Then
disambiguate at call time. This is messier than Option A and only worth doing
if the user actively needs both accounts available simultaneously.

### Option C — Drive D1 from the main session, not a subagent

Per handoff §5.2, `supabase` CLI is blocked in subagent sandboxes — but Step 5
of the task confirms the CLI **does work on the user's local Windows machine**.
Verified during this session: `npx supabase@latest --version` returned `2.100.0`.

If MCP repointing (Option A) is too friction-y, the alternative is:

1. From the main Cursor session (not a subagent), run:
   ```bash
   cd C:/Users/lukeb/apex-automata
   export SUPABASE_ACCESS_TOKEN=$(grep ^SUPABASE_ACCESS_TOKEN= .env | cut -d= -f2)
   npx supabase@latest login --token $SUPABASE_ACCESS_TOKEN   # may be unnecessary if env is honored
   npx supabase@latest link --project-ref gdrdaajvutmewgxbjurk
   npx supabase@latest db dump --schema public --schema-only --file /tmp/prod-schema.sql
   ```
2. Use `prod-schema.sql` as the source of truth instead of MCP `execute_sql`
   introspection. Author the 5 baselines from it.
3. Still need a way to verify against a Supabase branch. Easiest path is to
   create a branch via the Supabase dashboard UI (rather than `create_branch`
   MCP, which is gated by the same PAT) and use the CLI to push baselines via
   `npx supabase db push --linked --db-url <branch-url>`.

This bypasses MCP entirely. Slightly heavier but works around the wrong-token
problem without touching Cursor's plugin config.

---

## 4. What was NOT done (explicit invariant)

The point of this doc is preserving the failure-safe state:

- **51 historical migrations** under `supabase/migrations/*.sql` —
  **NOT TOUCHED**. Full list captured in `git ls-files supabase/migrations/`
  immediately after this session; HEAD is `bffba3b` (`docs(plans): add 2026-05-18 Wave 2 mid-sprint handoff`).
- **No baseline files were authored.** `supabase/migrations/_baseline/` does
  not exist. No `20260518_phase00_001_extensions.sql` or siblings.
- **No `supabase_migrations.schema_migrations` SQL** was generated for prod
  (no `schema_migrations_update.sql`).
- **No Supabase branch was created** (`create_branch` would have failed with
  permission error anyway, and would have charged the wrong org's billing if
  it had succeeded).
- `.env` was **read** (per user permission in the rules) but **not modified**
  and **not committed**. The token sit at line 15 unchanged.

The repo is in the same shape it was at the start of this session, plus this
single research doc.

---

## 5. Cost of NOT doing D1 (so the user can prioritize)

D1 is collapsing 51 → 5 idempotent baselines. Reasons to do it:

- New onboarding `supabase db reset --local` takes 51 migrations through
  rebuild instead of 5. Mostly a one-time hit.
- The 51-file history has duplicated `*_remote_reconciliation.sql` files
  (8 of them by filename pattern in the listing). They're noise.
- Future migration audits / RLS reviews are easier against a clean baseline
  than against 51 deltas.

Reasons it can wait per handoff §3.2:

- D1 is explicitly lower-priority than the F4/A2/A3/J1 critical path.
- All 548 tests pass. RLS is functioning. Prod schema is correct. D1 is
  pure infra cleanup, not user-facing.
- The 51 historical migrations are idempotent enough that they re-apply
  cleanly (they were already audited in W2 D11 — see commit `9b02470`
  which standardized the policy pattern).

**Recommendation**: fix MCP config (Option A, ~5 min user time), then
re-dispatch D1 in a future session. Do not block the W2 critical-path
work on this.

---

## 6. What the parent / next session should do

1. User: fix MCP plugin PAT per §3 Option A above.
2. User: verify by asking a fresh agent to run `list_projects` and confirm
   `gdrdaajvutmewgxbjurk` appears.
3. User: re-dispatch the D1 worker with the same prompt as this session.
   The recipe in handoff §6.3 is unchanged. Step 0 will now pass and the
   rest of the recipe (Steps 1-6) can proceed as written.
4. Worker: at completion, this research doc can be moved to `docs/research/
   _archived/` or deleted in the same commit that lands the baselines.

---

## 7. Related references

- `docs/plans/HANDOFF-2026-05-18.md` §1.4, §3.2, §5.2, §5.4, §6.3
- `CLAUDE.md` → "Database" section (idempotency rules, naming convention)
- `AGENTS.md` §5 (subagent sandbox constraints, irrelevant on local Windows)
- The 51 historical migrations: `git ls-files supabase/migrations/*.sql`

---

*End of D1 blocker report.*
