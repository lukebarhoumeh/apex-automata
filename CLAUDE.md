# Apex Automata (AtlasBot v2) — Claude Code Context

## What This Is
Professional algorithmic cryptocurrency trading system. React frontend + Node.js trading runtime + Supabase persistence. Paper and live trading on Coinbase and Hyperliquid.

## Quick Commands

### Frontend (root directory)
```bash
pnpm dev              # Start Vite dev server on port 8080
pnpm build            # Production build
pnpm lint             # ESLint across repo
pnpm preview          # Preview production build
```

### Backend (from root)
```bash
pnpm backend          # Start API server (port 3001)
pnpm backend:build    # Build backend TypeScript
pnpm install:all      # Install all dependencies (root + backend)
```

### Backend (from atlas/apps/core-node/)
```bash
pnpm api              # Start Express API + WebSocket server
pnpm dev              # Paper trading mode via CLI
pnpm build            # TypeScript compilation (rimraf dist && tsc)
pnpm test             # Run tests (vitest run) — 232/245 pass, 13 pre-existing failures
pnpm test:watch       # Watch mode
pnpm test:coverage    # Coverage report
pnpm backtest         # Run backtest analysis
pnpm diagnose         # System diagnostics
```

### Full System
```bash
pnpm start            # Cross-platform startup (node start.cjs) — runs both frontend + backend
```

## Architecture

```
Root (/)              → React + Vite + shadcn/ui frontend
atlas/apps/core-node/ → Node.js trading runtime (Express API + engine)
supabase/             → PostgreSQL migrations + 11 Edge Functions
deploy/               → Docker + Kubernetes + Prometheus/Grafana
```

**Runtime flow**: Coinbase WS → ticker → candles → SignalProcessor → RiskEngine gates → OrderManager → PositionTracker → Supabase sync → UI via WebSocket + Supabase Realtime

## Key Directories
- `src/` — Frontend React components, hooks, contexts, services
- `src/components/dashboard/` — 35+ trading dashboard panels
- `src/runtime/` — Frontend runtime integration (WebSocket, event bus, state)
- `atlas/apps/core-node/src/trading/` — Core trading engine, orders, positions, risk
- `atlas/apps/core-node/src/strategies/` — Signal processing, regime detection, strategy plugins
- `atlas/apps/core-node/src/exchanges/` — Exchange adapters (Coinbase, Hyperliquid)
- `atlas/apps/core-node/src/indicators/` — Technical indicators (EMA, RSI, MACD, ADX, ATR, BB)
- `atlas/config/guardrails.yaml` — Single source of truth for risk limits and strategy config
- `supabase/migrations/` — 40+ SQL migrations

## Critical Conventions
- **Strict TypeScript** in backend (`"strict": true`), relaxed in frontend
- **Files**: `kebab-case.ts` | **Classes**: `PascalCase` | **Interfaces**: `IPascalCase` | **Config**: `snake_case`
- **Financial values**: Always strings, NEVER floating point. DB columns: `NUMERIC(20,8)`
- **Logger**: Always `import { Logger } from '../core/logger'` — never console.log
- **Errors**: Never swallow silently — always `this.logger.error()` before re-throw
- **No new npm deps** without explicit approval
- **Path alias**: `@/*` → `./src/*` (frontend only)

## Active Strategies
Controlled by `atlas/config/guardrails.yaml`:
- **Momentum** (RSI/MACD) — enabled. Runs on spot BTC-USD/ETH-USD/SOL-USD and perps ETH-PERP-INTX/BTC-PERP-INTX. Produces most signals in current paper runs.
- **Trend Follow** (EMA crossover + MTF alignment) — enabled, but selective. Only fires when EMA12 crosses EMA15 AND price is on the correct side of both EMAs AND regime.trendDirection agrees. In weak_trend/ranging markets it can stay silent for hours — this is by design, not a bug.
- **VWAP MR, Breakout** — in `disabled_strategies: [vwap_mr, breakout]` per Phase 3 backtest verdict. Plugin files kept as `@deprecated` reference (DO NOT delete). Signals still get generated + written to Supabase with `allowed: false` for auditability; they never reach order routing.

## Meta-filter
The current meta-filter is **rule-based**, not ML: cold-streak cooldown (10 losses → 5 min pause), time-of-day filter (lo-liq 04–07 UTC, preferred 13–17 UTC), strength/volume filters available but disabled. `signals.meta_prob` column will be NULL for now — the `/model` page's ML metrics (ROC AUC, SHAP, calibration) are aspirational mocks, see its on-page banner.

## Exchange Status
- **Hyperliquid** — Target (0.05% fees)
- **Coinbase** — Proven negative-EV (0.60% fees), adapter exists for reference
- Perps symbols: `XXX-PERP-INTX` pattern

## What NOT to Do
- Do NOT modify existing Coinbase client internals (rest-client.ts, websocket.ts)
- Do NOT delete killed strategy files
- Do NOT use floating point for financial calculations
- Do NOT add new npm dependencies without explicit approval
- Do NOT hard-code exchange-specific logic in OrderManager or TradingEngine
- Do NOT change Logger or ConfigLoader patterns

## Testing
- Backend: `pnpm test` in `atlas/apps/core-node/` — 232/245 pass
- 13 pre-existing failures (Jest API compat with Vitest) — NOT regressions
- ZERO new test failures allowed
- Frontend: `pnpm test` from root (Vitest + jsdom)

## Environment
- `.env` at project root — contains Coinbase keys, Supabase credentials, encryption key
- `EXECUTION_MODE=paper` for paper trading
- `VITE_RUNTIME_API_URL=http://localhost:3001` for frontend→backend
- `VITE_RUNTIME_WS_URL=ws://localhost:3001/events` for WebSocket

## Database
- Supabase PostgreSQL with RLS enabled
- All migrations idempotent (`IF NOT EXISTS`)
- Migration naming: `YYYYMMDD_phaseXY_description.sql`
- Edge Functions in `supabase/functions/` (Deno runtime)

## Deployment
- Docker: `deploy/docker/Dockerfile.api` + `Dockerfile.web`
- Kubernetes: `deploy/k8s/` (namespace, deployments, services, ingress)
- Monitoring: Prometheus + Grafana in `deploy/monitoring/`
