# Atlas Monorepo

This monorepo contains:
- apps/core-node: Node.js (TypeScript) runtime for paper/live trading
- apps/research-py: Python research/backtest code
- apps/ui-svelte: Optional local-only SvelteKit dashboard (empty scaffold)

Local persistence lives under ./var (logs, bars, state, models). Environment variables are read from .env.local at the monorepo root.

Quickstart
- Copy .env.local.example to .env.local and fill in secrets
- Install Node deps in core-node with pnpm (see below)
- Run the CLI in paper mode

