# GitHub Actions workflows

## `config-drift.yml` — single-source guardrails gate

**Triggers on PRs that touch any of:** `**/guardrails.yaml`, `**/guardrails.yml`, `**/strategies.json`, `atlas/config/**`, `atlas/apps/core-node/config/**`, `atlas/apps/core-node/src/config/**`, `atlas/apps/core-node/src/cli/check-config-drift.ts`, or the workflow itself. Also runnable via `workflow_dispatch`.

**What it does.** Installs the workspace and runs `pnpm check:config` (`atlas/apps/core-node/src/cli/check-config-drift.ts` -> `src/config/config-drift.ts`). No secrets, no backtest, no native binaries; wall-clock is dominated by `pnpm install`. The gate **fails** if:

1. `atlas/config/guardrails.yaml` is missing or fails `GuardrailsSchema` validation.
2. Any other `guardrails.yaml` / `.yml` in the tree (outside `node_modules`, `dist`, `var`, `.git`) is not a `DO_NOT_EDIT: true` pointer stub. `atlas/apps/core-node/config/guardrails.yaml` used to be a real, divergent copy; it is now a stub and `loadGuardrails()` throws if pointed anywhere but the canonical file.
3. `atlas/apps/core-node/config/strategies.json` (deprecated, not read by the runtime) claims `enabled` for a strategy in guardrails `disabled_strategies` (or vice versa), is missing a built-in strategy, or carries any key other than `enabled`.
4. A desk-pinned value moved. Pins live in `SCALAR_PINS`, `LIST_PINS`, `TREND_FOLLOW_PIN`, `SPOT_MOMENTUM_TAKE_PROFIT_ATR` and `TRADE_COOLDOWN_FLOOR_EXCLUSIVE` in `config-drift.ts`. Changing a pin is intentionally a two-file diff (YAML + that list) so it shows up in review.

The same check runs inside `pnpm test` (`src/__tests__/config-drift.test.ts`), so a red gate here reproduces locally with `cd atlas/apps/core-node && pnpm check:config`.

## `backtest-gate.yml` — backtest CI gate (I3)

**Triggers on PRs that touch any of:**

- `atlas/apps/core-node/src/strategies/**`
- `atlas/apps/core-node/src/trading/**`
- `atlas/apps/core-node/src/backtesting/**`
- `atlas/config/guardrails.yaml`
- `.github/workflows/backtest-gate.yml` (so changes to the gate itself are exercised before merge)

**What it does.** Spins up Node 20, installs all deps, restores the `@rollup/rollup-linux-x64-gnu` native binary that `core-node/.npmrc optional=false` blocks, verifies the committed real-candle fixtures exist, then runs:

```bash
pnpm exec tsx src/cli/backtest.ts \
  --start-date 2026-09-03 --end-date 2026-09-10 \
  --products BTC-USD ETH-USD --fixture-dir fixtures/bars \
  --commission 0.00045 --slippage 0.0005 --strategy all
```

The window is the committed fixture window (`atlas/apps/core-node/fixtures/bars/*.json` — Coinbase Advanced Trade public 15m candles; see that folder's README to regenerate). Hyperliquid taker fees, 5 bps slippage. The gate **fails** if:

1. The backtest CLI exits non-zero (a missing/short fixture is `DATA_UNAVAILABLE`, exit 2 — the loader is fail-closed since TASK_017 and never falls back to synthetic candles without `--allow-synthetic`), OR
2. Stdout does not carry the `DATA: REAL` stamp, or carries `DATA: SYNTHETIC`, or either symbol did not load from the `fixture` source, OR
3. The reported `Total Trades` count is < 5 over the 7-day window (structural smoke threshold; the committed fixtures produced 15 at the time of TASK_017), OR
4. Any short entry was opened (spot is long-only by venue capability).

Wall-clock target: < 3 minutes per run (the backtest itself takes ~3 s; install dominates).

### GitHub Actions secrets

None are required any more — the gate runs entirely on committed fixtures. `ENCRYPTION_KEY` is optional (some modules read it at import-time; the workflow falls back to a deterministic dummy 64-hex-char value). `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` are only needed for local runs against `public.bars`.

### How the gate is enforced

Branch protection on `main` is intentionally **OFF** per the locked sprint decision (this gate replaces I4). That means **the gate is enforcement-by-convention only.** Reviewers must verify the green checkmark on `backtest-gate` before merging any PR that touched the listed paths.

If/when branch protection is re-introduced (Wave 3+), make this check `Required` on `main`.

### When to update the gate

- **Add a path filter** when a new directory becomes strategy-affecting (e.g. `atlas/apps/core-node/src/ml/` if a real ML model lands).
- **Increase the trade-count threshold** once F1 (funnel-latch fix) lands — at that point a 7-day window across two products should produce 50+ trades, and the smoke threshold should rise accordingly.
- **Add HL fee verification** once F4 (HL backtest run) is integrated; the gate already passes `--commission 0.00045` so this is largely future-proof.
- **Drop the Rollup binary restore step** once `@rollup/rollup-linux-x64-gnu` ships installed (likely after pnpm 10 + Rollup 5).

### Local reproduction

To run the same check locally before pushing (never put `--` after `pnpm backtest` — yargs drops the flags):

```bash
cd atlas/apps/core-node
pnpm exec tsx src/cli/backtest.ts \
  --start-date 2026-09-03 --end-date 2026-09-10 \
  --products BTC-USD ETH-USD --fixture-dir fixtures/bars \
  --commission 0.00045 --slippage 0.0005 --strategy all
```

Line 1 of the summary is the data stamp (`DATA: REAL`); `atlas/var/backtest_results/report_*.txt` carries the same stamp on its first line plus per-symbol provenance.
