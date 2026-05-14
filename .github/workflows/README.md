# GitHub Actions workflows

## `backtest-gate.yml` — backtest CI gate (I3)

**Triggers on PRs that touch any of:**

- `atlas/apps/core-node/src/strategies/**`
- `atlas/apps/core-node/src/trading/**`
- `atlas/apps/core-node/src/backtesting/**`
- `atlas/config/guardrails.yaml`
- `.github/workflows/backtest-gate.yml` (so changes to the gate itself are exercised before merge)

**What it does.** Spins up Node 20, installs all deps, restores the `@rollup/rollup-linux-x64-gnu` native binary that `core-node/.npmrc optional=false` blocks, then runs:

```bash
pnpm backtest -- \
  --start-date <today-7> --end-date <today> \
  --products ETH-USD ETH-PERP-INTX \
  --commission 0.00045 --slippage 0.0005 --strategy all
```

The window is rolling 7 days (Hyperliquid taker fees, 5 bps slippage). The gate **fails** if:

1. The backtest CLI exits non-zero, OR
2. The reported `Total Trades` count is < 5 over the 7-day window. Five is a structural smoke threshold; the typical signal-arbiter funnel produces 30+ signals/day across two products, so under five trades total in seven days strongly indicates a regression upstream (SPRINT-PLAN-FINAL.md F1: today's funnel-latch bug caps backtests at 12 signals total regardless of window).

Wall-clock target: < 3 minutes per run.

### Required GitHub Actions secrets (manual setup — must be added via Settings → Secrets and variables → Actions)

| Secret | Why | Where to get it |
|---|---|---|
| `SUPABASE_URL` | Backtest CLI exits 1 without it (reads candles from `public.bars`). | Supabase Dashboard → Project Settings → API → Project URL. |
| `SUPABASE_SERVICE_KEY` | Same — needed for service-role read of `bars`. | Supabase Dashboard → Project Settings → API → `service_role` secret. |
| `ENCRYPTION_KEY` *(optional)* | Some modules read it at import-time. The workflow falls back to a deterministic dummy 64-hex-char value if the secret is unset; the backtest CLI does not exercise encryption paths. | `openssl rand -hex 32` (or set to anything 64 hex chars long for CI). |

### How the gate is enforced

Branch protection on `main` is intentionally **OFF** per the locked sprint decision (this gate replaces I4). That means **the gate is enforcement-by-convention only.** Reviewers must verify the green checkmark on `backtest-gate` before merging any PR that touched the listed paths.

If/when branch protection is re-introduced (Wave 3+), make this check `Required` on `main`.

### When to update the gate

- **Add a path filter** when a new directory becomes strategy-affecting (e.g. `atlas/apps/core-node/src/ml/` if a real ML model lands).
- **Increase the trade-count threshold** once F1 (funnel-latch fix) lands — at that point a 7-day window across two products should produce 50+ trades, and the smoke threshold should rise accordingly.
- **Add HL fee verification** once F4 (HL backtest run) is integrated; the gate already passes `--commission 0.00045` so this is largely future-proof.
- **Drop the Rollup binary restore step** once `@rollup/rollup-linux-x64-gnu` ships installed (likely after pnpm 10 + Rollup 5).

### Local reproduction

To run the same check locally before pushing:

```bash
START=$(date -u -d '7 days ago' +%Y-%m-%d)
END=$(date -u +%Y-%m-%d)
cd atlas/apps/core-node
pnpm backtest -- \
  --start-date "$START" --end-date "$END" \
  --products ETH-USD ETH-PERP-INTX \
  --commission 0.00045 --slippage 0.0005 --strategy all
```

Then check `atlas/var/backtest_results/backtest_*.json` for the trade count.
