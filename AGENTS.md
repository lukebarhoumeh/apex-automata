# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

AtlasBot v2 is a professional algorithmic crypto trading system with:
- **Frontend**: React + Vite + shadcn/ui dashboard on port `8080` (root `pnpm dev`)
- **Backend**: Node.js Express + WebSocket runtime on port `3001` (`atlas/apps/core-node`, run with `pnpm api`)
- **Persistence**: Supabase (cloud-hosted Postgres + Realtime)
- **Exchange**: Coinbase Advanced Trade API (paper mode uses production market data)

See `README.md` for full architecture, API endpoints, and configuration details.

### Running services

**Frontend (Vite dev server)**:
```bash
cd /workspace && pnpm dev
```

**Backend API (tsx, no type-checking)**:
```bash
cd /workspace/atlas/apps/core-node && pnpm api
```

The backend uses `tsx` to run TypeScript directly (no compilation step needed for dev). The `pnpm build` (tsc) has pre-existing type errors; these do not affect runtime execution via tsx.

### Important gotchas

1. **Rollup native binary**: The backend's `atlas/apps/core-node/.npmrc` sets `optional=false`, which prevents `@rollup/rollup-linux-x64-gnu` (required by vitest) from being installed. After `pnpm install`, manually install it. Since W2-D12, the unified workspace install hoists rollup to the repo-root `node_modules/.pnpm/` (not `atlas/node_modules/`), and rollup is currently pinned to `4.52.4` in the root lockfile:
   ```bash
   cd /tmp && npm pack @rollup/rollup-linux-x64-gnu@4.52.4 && tar xzf rollup-rollup-linux-x64-gnu-*.tgz
   mkdir -p /workspace/node_modules/.pnpm/rollup@4.52.4/node_modules/@rollup/rollup-linux-x64-gnu
   cp -r package/* /workspace/node_modules/.pnpm/rollup@4.52.4/node_modules/@rollup/rollup-linux-x64-gnu/
   rm -rf package rollup-rollup-linux-x64-gnu-*.tgz
   ```

2. **Environment variables**: The backend requires a `.env` file at the workspace root (not in atlas/). Required vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (100+ chars), `ENCRYPTION_KEY` (64 hex chars). See `README.md` "Environment Variables" section for the full template.

3. **Backend env loading**: `atlas/apps/core-node/src/core/env.ts` loads `.env` from `path.resolve(cwd, '../../../.env')` relative to core-node — this maps to `/workspace/.env` when CWD is core-node.

4. **Supabase service key**: Without a real `SUPABASE_SERVICE_KEY`, the backend starts but Supabase operations (DB reads/writes) will fail with fetch errors. The API endpoints and trading engine still function for paper mode. Note: the Cloud Agent VM cannot resolve external DNS (e.g. `gdrdaajvutmewgxbjurk.supabase.co`), so even with a valid key, Supabase calls will fail with "fetch failed" errors in this environment. This does not affect local engine/API functionality.

5. **Backend tests**: Run with `cd atlas/apps/core-node && pnpm test`. **38 test files / 529 tests**, all pass under Vitest in ~7s (verified 2026-05-14 on Windows). Vitest migration complete as of 2026-05-11; all tests pass under Vitest's `vi.*` API.

6. **Frontend lint**: `pnpm lint` at root runs ESLint across the entire repo (including backend). Pre-existing `@typescript-eslint/no-explicit-any` errors exist in both frontend and backend code.

### Commands reference

| Task | Command |
|------|---------|
| Install all deps | `pnpm install && cd atlas/apps/core-node && pnpm install` |
| Frontend dev | `pnpm dev` (port 8080) |
| Backend dev | `cd atlas/apps/core-node && pnpm api` (port 3001) |
| Frontend build | `pnpm build` |
| Frontend lint | `pnpm lint` |
| Backend tests | `cd atlas/apps/core-node && pnpm test` |
| Start engine | `curl -X POST localhost:3001/api/engine/start -H 'Content-Type: application/json' -d '{"mode":"paper"}'` |
| Engine status | `curl localhost:3001/api/status` |
| Health check | `curl localhost:3001/health` |
