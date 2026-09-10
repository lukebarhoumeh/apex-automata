# TASK_015: Control-Plane Security — API token, CORS, localhost bind, edge-function auth

**Priority:** P0 — with `CONFIRM_LIVE=YES`, any web page in your browser can POST to the engine today
**Status:** PENDING
**Depends on:** none
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 0
**Skills:** `supabase-migration` (edge functions) · **Review subagent:** `risk-guardian`

---

## Context

- `app.use(cors())` with no origin restriction and **no auth middleware** (`api/server.ts:142`, `:167-170`). The live confirm phrase is a public constant (`DEFAULT_LIVE_CONFIRM_PHRASE = 'ENABLE LIVE'`, `:284`). A malicious page can issue `POST http://localhost:3001/api/engine/start {"mode":"live","confirm":"ENABLE LIVE"}` or `/api/control/close-all`.
- Server listens on all interfaces.
- Edge functions `journal-entry`, `risk-settings-update`, `strategy-signal-upsert` are deployed with `verify_jwt=false`, use the service role, and trust `body.user_id` → anyone with the URL can write/delete any user's rows (`supabase/functions/journal-entry/index.ts:50,78,94`, `risk-settings-update/index.ts:43-60`).
- RLS grants `anon` `SELECT USING (true)` on `positions, orders, fills, signals, daily_equity` (`20260204214950_proxy_only_writes.sql`). The publishable key is also hard-coded as a fallback in `src/integrations/supabase/client.ts:5-20`.

## IMPORTANT CONSTRAINTS

1. Fail closed: backend refuses to boot without `CONTROL_API_TOKEN` (≥ 32 chars) unless `NODE_ENV=test`.
2. GET/HEAD/OPTIONS stay open to the configured dashboard origin only; every mutating `/api/*` route requires `Authorization: Bearer <token>`.
3. No new deps (use `crypto.timingSafeEqual`).
4. Dashboard is a local tool: token delivered via `VITE_RUNTIME_API_TOKEN` in `.env` (documented as local-only).

---

## Steps

1. **Middleware** (`api/server.ts`, before routes):
   ```ts
   const CONTROL_TOKEN = process.env.CONTROL_API_TOKEN ?? '';
   if (process.env.NODE_ENV !== 'test' && CONTROL_TOKEN.length < 32) throw new Error('CONTROL_API_TOKEN (>=32 chars) required');
   const allowedOrigin = process.env.DASHBOARD_ORIGIN ?? 'http://localhost:8080';
   app.use(cors({ origin: allowedOrigin, credentials: false }));
   app.use('/api', (req, res, next) => {
     if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
     const presented = Buffer.from((req.get('authorization') ?? '').replace(/^Bearer\s+/i, ''));
     const expected = Buffer.from(CONTROL_TOKEN);
     const ok = presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
     return ok ? next() : res.status(401).json({ error: 'unauthorized' });
   });
   ```
2. **Bind**: `server.listen(PORT, process.env.API_BIND_HOST ?? '127.0.0.1')`; WS upgrade checks `Origin` against `allowedOrigin`.
3. **Live phrase**: per-boot nonce — `GET /api/engine/live-challenge` returns `ENABLE LIVE <6-char nonce>` (auth required); start must echo it.
4. **Frontend**: single `controlApi` client adds the bearer header (see TASK_016).
5. **Edge functions**: redeploy the three write functions with `verify_jwt=true`; derive user via `supabase.auth.getUser(bearer)`; ignore `body.user_id`; scope every update/delete with `.eq('user_id', user.id)`. If the dashboard has no auth yet, **undeploy** `strategy-signal-upsert` and `risk-settings-update` (engine never reads their tables) and keep `journal-entry` disabled until auth exists.
6. **RLS read exposure** (P1 inside this task, do after TASK_016 moves reads to the backend): drop `anon SELECT USING (true)` on trading tables; dashboard reads via backend `GET /api/...` routes. Remove hard-coded Supabase fallback in `client.ts`.
7. `env.example`: add `CONTROL_API_TOKEN`, `DASHBOARD_ORIGIN`, `API_BIND_HOST`, `VITE_RUNTIME_API_TOKEN`, `LIVE_USER_ID`, `GUARDRAILS_FILE`.

## Tests

1. POST `/api/engine/stop` without token ⇒ 401; with token ⇒ passes to handler.
2. CORS preflight from `http://evil.test` ⇒ no `Access-Control-Allow-Origin`.
3. Boot without token (NODE_ENV≠test) throws.
4. Live start with stale nonce ⇒ 400.

## Acceptance Criteria

- [ ] Tests green; `node CURSOR_TASKS/verify/verify_sprint9.cjs --task 015` PASS
- [ ] `list_edge_functions` shows no `verify_jwt=false` write functions
- [ ] `risk-guardian` review clean
