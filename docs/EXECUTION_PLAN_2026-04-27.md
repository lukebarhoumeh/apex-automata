# Execution Plan — 2026-04-27 (post kill-switch hygiene fix)

Goal hierarchy (from user): **continuous paper trading for days** → **profitable** → **ML layer is the most important part**.

This plan is sequenced so each phase unblocks the next. The pivot point is Phase 1: until ML training data persists, multi-day runs produce nothing of long-term value.

---

## How close are we to continuous paper trading without kill-switch interference?

**Honest answer: ~80% there for hours, ~50% there for days.**

| Risk vector                                  | Status   | Notes |
| -------------------------------------------- | -------- | ----- |
| Stale weekly-loss kill switch on session start | ✅ Fixed | Commit `4eb1ca7`. Verified live for 12 min clean. |
| Stale persisted killSwitchActive flag        | ✅ Fixed | Same commit; reset block clears it. |
| Daily-loss kill switch (organic)             | ⚠️ Real  | If strategies bleed >2% in a day, kill switch trips legitimately. Goal of #3 (edge measurement) is to know if this happens. |
| 5-consecutive-loss kill switch               | ⚠️ Real  | Saw 4 consecutive losses in startup-burst window. With current strategy mix this *will* trip. Worth tuning the threshold or making it advisory. |
| Coinbase WS disconnect / rate-limit storms   | ⚠️ Untested for >1 hour | Pre-existing flaky tests in this area. Real-world resilience unknown over multi-day. |
| Engine supervisor restart loops              | ⚠️ Configured but untested | `engine-supervisor.ts` exists with `maxConsecutiveRestarts: 5` / 5-min window. Need a stress test. |
| Database connection drops                    | 🟡 Unknown | Supabase has been reliable but no fallback if it drops. |
| Memory leak / process crash                  | 🟡 Unknown | No OOM monitoring; no PM2/systemd wrapper. |

**Net:** the kill-switch hygiene that was blocking us is gone. The remaining risks are mostly *organic* (real losses, real outages) — those we can't engineer away, only monitor and recover from. **Phase 2 is what closes the gap from "8 hours" to "8 days".**

---

## Phase 1 — Fix `trade_outcomes` persistence (the ML data foundation)

**Why this is #1:** every other phase produces no long-term value if ML data isn't landing. Days of paper running produce 0 training rows in the table that was *purpose-built* for ML meta-labeling. Right now we are flying blind on the most important part of the project.

### What's actually broken (traced from code)

The pipeline is wired but fails silently at the matching step:

1. `signalProcessor` emits `signal:generated` with `signal.id`.
2. `server.ts:1629` calls `tradeOutcomeCollector.captureSignalContext(signal, regime, indicators, extras)` — context stored in `pendingSignals` Map keyed by `signal.id`.
3. Order placement persists `signal_id` to `orders` table (✅ fixed in commit `612958e`).
4. Position opens via fill. **Question: does `position.signalId` get set on the in-memory `Position` object?**
5. `position:update` fires with `position.side === 'flat'` (close) → `recordOutcome(position)`.
6. `recordOutcome` calls `getContextForPosition(position)` which reads `position.signalId`.
7. If `position.signalId` is undefined, falls back to symbol lookup — but that returns `undefined` if `pendingSignals` has more than 1 entry for that symbol (see `trade-outcome-collector.ts:502-508`).

**Most likely root cause:** `position.signalId` is not propagating from order metadata to the Position object at fill time. Need to verify by adding a one-shot diagnostic log in `recordOutcome` that prints `position.signalId`, `pendingSignals.size`, and the symbol-set size when the lookup fails.

### Tasks

| # | Task | Output |
|---|------|--------|
| 1.1 | Add diagnostic log in `recordOutcome` when context lookup fails — print `position.signalId`, `pendingSignalIdsBySymbol.get(symbol)?.size`. Run engine for 5 min, capture logs. | Direct evidence of which lookup path is failing. |
| 1.2 | Trace `signalId` flow: signal → order metadata → fill → position. Most likely fix point: `position-tracker.ts processFill()` needs to copy `order.metadata.signalId` to the `Position` object. | Pinpoint patch location. |
| 1.3 | Implement the propagation fix. Position object carries `signalId` from open → close. | Patch + test. |
| 1.4 | Strengthen the symbol-fallback in `getContextForPosition`: when multiple pending contexts, pick the one whose direction matches the position's side AND whose timestamp is closest before `position.openedAt`. | More robust matching. |
| 1.5 | Write a vitest unit test for `recordOutcome` with a mocked Supabase that asserts the insert is called with the right shape. | Prevents regression. |
| 1.6 | Add a Prometheus counter `trade_outcomes_recorded_total{outcome}` and `trade_outcomes_dropped_total{reason}` so missing rows are observable. | Operational visibility. |
| 1.7 | Verification: 30-min paper run; assert `SELECT COUNT(*) FROM trade_outcomes WHERE created_at > now() - interval '30 minutes'` ≥ count of closed positions in the same window. | Acceptance criteria. |

**Estimate:** 2–3 hours including verification run.

**Acceptance criteria:** N closed trades in a session → N rows in `trade_outcomes`, with `outcome_label`, `regime`, `r_multiple`, and `indicators_snapshot` populated. No rows with `signal_id IS NULL`.

---

## Phase 2 — Continuous-run harness

**Why:** Phase 1 fixes data capture; Phase 2 keeps the engine *running long enough to capture meaningful data*. ML training needs hundreds to thousands of trades per regime × strategy combination to be statistically meaningful. At our current ~30 trades/day rate, that's weeks of continuous runtime.

### What needs to be true for a 7-day paper run

1. **No silent persistence gaps.** Optional tables (`equity_snapshots`, `meta_filter_decisions`) should exist or the runtime should fail loud, not silently default.
2. **Engine restarts cleanly on fatal.** `engine-supervisor.ts` exists; verify it works under induced fatal.
3. **WS resilience tested.** Pre-existing flaky tests around websocket-reconnect/websocket-unified suggest this hasn't been validated under stress. Run a connectivity-loss simulation.
4. **Daily orphan cleanup verified.** P3 cleanup ran on session start; it should also handle the "engine ran for 7 days without restart" case (positions opened on day 1 still open on day 7 — that's fine, but the equity tracker shouldn't drift).
5. **Alert routing functional.** Saw `[Alert:telegram]` and `[Alert:email]` log entries on the kill-switch trip — but the destinations are likely unconfigured. Wire real channels OR explicitly mute them so they don't fail silently.
6. **Process supervisor.** `pnpm backend` runs as a foreground tsx process with no auto-restart on Node crash. Wrap in PM2 or systemd for production-grade.

### Tasks

| # | Task | Output |
|---|------|--------|
| 2.1 | Create migration for `equity_snapshots` (intra-session equity points) and `meta_filter_decisions` (rule firings). The runtime already attempts to insert into both — currently silently fails. | Migration file + schema. |
| 2.2 | Stress-test `engine-supervisor`: kill the engine internally with a synthetic fatal; assert it restarts and resumes streaming candles. | Pass/fail report. |
| 2.3 | WS resilience: temporarily block port 443 → Coinbase to simulate disconnect. Verify reconnect happens, positions persist, signals resume. | Recovery trace. |
| 2.4 | Add a "session continuity" probe: every 5 min, query `risk_metrics` and `account_metrics` for the active session, verify counters are advancing monotonically. Alert on stalls. | Probe script. |
| 2.5 | Wrap `pnpm backend` in PM2 with `max_restarts: 10` and `min_uptime: 60s`. Add to repo as `ecosystem.config.cjs`. | PM2 config. |
| 2.6 | Configure or mute alert sinks (`telegram`, `email`). Currently the engine writes alert log lines that don't go anywhere. | `.env` keys + alert sink wiring. |
| 2.7 | Fix the 5-consecutive-loss kill switch: too tight for a churn-heavy strategy mix. Either bump to 8 or move to "advisory" (warn but don't halt). | Tune `consecutiveLossLimit` in `risk-engine.ts:751`. |

**Estimate:** 4–6 hours.

**Acceptance criteria:** Engine runs for 24 hours with a forced WS disconnect mid-run, recovers, completes the day with `trade_outcomes.count > 0`, no kill-switch trip from organic-but-fixable causes.

---

## Phase 3 — ML training pipeline (the actual ML work)

**Frame:** treat this exactly like a meta-labeling problem in the López de Prado / Marcos Lopez sense. Each `trade_outcomes` row is a sample; the strategy already decided to take the trade; the meta-label is "did it actually work?" The classifier learns *which signal contexts are worth taking* and the orchestrator multiplies position size by the meta-prob.

### Why this matters

The strategies (momentum, trend_follow, breakout, vwap_mr) generate *more signals than have edge*. We saw this in the 30d backtest: 18 allowed signals → 6 trades → mostly losses. A meta-filter trained on `(features → P(profit | signal))` lets us:
- Skip low-quality signals entirely (cuts fees on losers, the dominant cost we identified).
- Size up high-conviction signals.
- Detect regime drift (predicted P(profit) drops → meta-filter is telling us the market changed).

### Architecture

```
trade_outcomes (Supabase)
    ↓ [training script: scripts/ml/train-meta-label.py]
trained model (XGBoost or LightGBM, exported to ONNX)
    ↓
public.models table (versioned, with metrics)
    ↓ [runtime: signal-processor.ts:applyMetaLabeling]
score per signal at gen time → multiply position size by P(profit)
    ↓
trade_outcomes captures `meta_label` column → next training round is supervised by what we shipped
```

### Tasks (in dependency order)

| # | Task | Output |
|---|------|--------|
| 3.1 | Write `scripts/ml/extract-features.py` — pulls `trade_outcomes` from Supabase, flattens `indicators_snapshot` jsonb, joins to `bars` for context features (recent volatility, return distribution), produces a parquet file. | Feature extraction. |
| 3.2 | Write `scripts/ml/train-meta-label.py` — walk-forward cross-validation (no shuffle — strict time split), XGBoost classifier on `outcome_label ∈ {profitable, unprofitable}`. Hyperparam search via Optuna with TPE. | Training script + initial model. |
| 3.3 | Calibration: Platt scaling or isotonic regression on the held-out fold. Signal scores must be probabilistic, not just rankings, because position sizing multiplies by them. | Calibrated probabilities. |
| 3.4 | Evaluation: ROC AUC, PR AUC, Brier score, **per-regime breakdown** (a model that's 0.6 AUC overall but 0.8 in `weak_trend` and 0.5 in `ranging` is hugely better than the average suggests). Also: confusion matrix at the deployment threshold. | Evaluation report committed to `docs/ml/`. |
| 3.5 | Export to ONNX. Persist artifact to `public.models` table with version, training_date, metrics jsonb, file path. | Model record. |
| 3.6 | Wire `signal-processor.ts:applyMetaLabeling` to load the latest active model from `models` table at startup, run inference on each generated signal, attach `meta_label` to the signal metadata, persist to `signals.meta_prob`. | Runtime inference. |
| 3.7 | Position sizing: in `risk-engine.ts` or signal post-processing, multiply `positionMultiplier` by `meta_label` (clamped to [0.25, 1.5] to avoid extreme leverage from a single confident signal). | Active sizing. |
| 3.8 | Drift monitor: track rolling 1-day distribution of `meta_label` scores. Alert if mean shifts >2σ from training distribution → market regime changed, retrain. | Drift detection. |
| 3.9 | Retraining schedule: nightly cron, only retrain if N new labeled samples ≥ 100. Promote new model only if walk-forward AUC ≥ current production model's. | Self-updating loop. |

**Estimate:** 2–3 days of focused work, assuming Phase 1 + 2 are done and trade_outcomes has been accumulating for ~1 week (need ~500-1000 closed trades minimum before training is statistically meaningful).

**Acceptance criteria:**
- Held-out walk-forward AUC ≥ 0.6 on `outcome_label` prediction.
- Per-regime AUC reported (no model is great everywhere; we want to know *where* it works).
- Live signals carry `meta_prob` in the [0,1] range, persisted to `signals.meta_prob` (currently always NULL per the user's CLAUDE.md note).
- Position sizing actually responds to it — verify in a paper session that high-meta-prob signals get larger size.

### Quant-engineer notes (the things that bite ML projects in trading)

- **Look-ahead leakage.** `indicators_snapshot` is captured at signal time, not at close time. Verify nothing in there uses future bars.
- **Sample selection bias.** We only have outcome labels for trades the *current* strategies took. The model learns "which of *my current strategy's signals* worked", not "which signals would work in general". That's the right scope for meta-labeling, but document it.
- **Class imbalance.** Likely 30-40% profitable / 60-70% unprofitable based on backtest. Don't optimize accuracy — optimize precision at the threshold we'd trade at.
- **Regime non-stationarity.** Crypto regime shifts are abrupt. Walk-forward CV with a 30-day training window and 7-day test window > random splits. Retrain weekly minimum.
- **Multi-collinearity.** ema12/ema15/ema21 all carry similar info. Either L1 regularization or feature selection via SHAP importance.
- **Don't over-fit fees.** Fee structure can change; train on `realized_pnl` *before* fees and apply fee logic at the sizing layer.

---

## Phase 4 — Edge measurement (the original Sprint 4 ask)

This is now downstream of Phase 1+2 because the rerun should include the bug fixes from today AND the ML meta-prob feature once Phase 3 ships. Running it now without Phase 1 means the rerun produces no ML rows — wasted compute.

### Tasks

| # | Task | Output |
|---|------|--------|
| 4.1 | Loosen capital cap in `cli/backtest.ts`: `maxTotalExposure: 30000` so all 3 symbols can hold concurrently. | Wider trade count. |
| 4.2 | Honor `signal.stopLoss` / `signal.takeProfit` in `BacktestEngine.checkExitConditions` instead of fixed 2%/4%. | Faithful to live behavior. |
| 4.3 | Add per-regime / per-strategy P&L breakdown to `BacktestRunner.generateReport`. | Edge attribution. |
| 4.4 | Run 90-day backtest across multiple windows (Mar–May, Jun–Aug, Sep–Dec 2025) on BTC/ETH/SOL spot+perps. | Window-stability check. |
| 4.5 | Compare Coinbase vs Hyperliquid fee assumptions. Already directionally clear; this confirms with statistical power. | Decision input. |

**Estimate:** 4–6 hours.

**Acceptance criteria:** ≥ 50 trades per backtest window, per-strategy / per-regime tables, decision-grade report on whether to keep paper-trading on Coinbase vs migrate to Hyperliquid.

---

## Phase 5 — Iterate

Once Phase 1-4 ship:
- Daily review of `trade_outcomes` → spot regime drift before it bleeds.
- Weekly retrain of the meta-filter.
- Quarterly review of which strategies still earn their place in the ensemble.

---

## Sequencing recommendation

**This week:** Phase 1 (4h) + Phase 2.1, 2.6, 2.7 (2h) → leave engine running paper for 48 hours uninterrupted. Goal: 50-100 `trade_outcomes` rows.

**Next week:** Phase 4 + Phase 2 remainder. By end of week, edge-measurement signal is clear AND we have a week of clean live data.

**Week 3:** Phase 3 (ML pipeline). With ~500 trades, statistical power is real.

**Week 4:** Deploy meta-filter to live signal scoring. Monitor for 1 week. Iterate.

---

## What I'd do first if I had 30 minutes

1. Add the diagnostic log to `recordOutcome` (5 min).
2. Restart engine, let it run 10 min, generate a few closes (15 min).
3. Read the logs, identify the exact failing path (5 min).
4. Patch and verify (5 min).

That's 30 minutes to unlock the most valuable part of the project. Everything downstream rides on this.
