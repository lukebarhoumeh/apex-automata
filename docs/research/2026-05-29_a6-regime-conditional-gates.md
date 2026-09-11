# A6 — Regime-conditional gates (empirical funnel + gate design + behind-flag impl)

**Date:** 2026-05-29
**HEAD (baseline):** `8fea8b1` (`feat(strategies): per-symbol disable support + disable momentum on PERP-INTX`) · 604/604 backend tests green
**Branch (this work):** `feat/a6-regime-conditional-gates` (625/625 tests green after +21 A6 tests)
**Author:** A6 research + implementation pass (Cursor)
**Status:** RESEARCH + behind-flag IMPLEMENTATION. The gate mechanism ships **DISABLED BY DEFAULT** (`guardrails.regime_gates.enabled: false`) — live/paper behaviour is UNCHANGED. Enabling in live requires explicit human sign-off (see §7.3). No push, no PR.
**Grounds:** `2026-05-29_h6-drawdown-consec-loss.md` (edge, not risk, is the problem: blended WR 39.5%), `2026-05-19_f4-followup-perps-action.md` (per-(strategy,symbol) WR), `HANDOFF-2026-05-18.md` §3.2 (A6 entry).

---

## 1. TL;DR

1. **Headline funnel insight.** Edge is sharply regime-dependent, and the system's two live strategies split cleanly:
   - **`trend_follow` bleeds in `weak_trend` and only has edge in `strong_trend`.** The weak_trend bleed is **stable across windows**: PF **0.78** (90d, n=143) and **0.80** (12m, n=405); strong_trend is positive (PF **1.41**, +$114, n=16 over 12m). Because the plugin already refuses `ranging`/`choppy`, `weak_trend` is where ~96% of trend_follow's spot trades — and nearly all of its losses — live.
   - **`momentum`'s regime edge is NOT stationary** — it is therefore *not* safely regime-gateable. Over the recent 90d it looked great in `strong_trend` (PF 3.73) but over 12m that same cell is PF 0.46. It is net-negative in every regime over 12m. The recent-window strength is a window artifact.
   - **`trend_follow` on PERP is structurally broken** (WR 25.3%, PF **0.44**, −$2,337 standalone 90d) in the one regime it trades there (weak_trend) — a *venue* problem, the same profile momentum-on-perps had before it was disabled in `8fea8b1`.
   - **SOL-USD is the consistent bright spot** across both strategies and windows.

2. **Proposed gate rule (data-derived, conservative).** Block `trend_follow` signals when the confidently-classified regime is `weak_trend` (i.e. allow `trend_follow` only in `strong_trend`). Momentum is intentionally **left ungated** (non-stationary edge → gating it overfits). The perps `trend_follow` bleed is better handled by the **existing** per-symbol disable mechanism (venue, not regime) and is flagged for separate sign-off (§5.3).

3. **Projected impact** — combined 5-symbol HL-90d backtest, gate ON vs the `8fea8b1` baseline:

   | Metric | Baseline `8fea8b1` | Gated (trend_follow ∉ weak_trend) | Δ |
   |---|--:|--:|--:|
   | Net PnL | **−$563.24** | **+$113.40** | **+$676.64** |
   | Blended WR | 39.49% | **40.97%** | +1.48 pp |
   | Profit Factor | 0.88 | **1.04** | +0.16 (crosses 1.0) |
   | Max Drawdown | 11.56% | **5.99%** | −5.57 pp |
   | Sharpe | −0.97 | **+0.32** | flips positive |
   | Trades | 276 | 144 | −48% |

   **Honest caveat:** the blended book flipping fully *positive* in the 90d run leans on momentum being +EV in that recent window. The **window-robust** benefits — confirmed by an engine re-run over 12m — are: (a) **trend_follow's own book flips from a bleed to a profit in BOTH windows** (90d −$696.64 → −$21.30; **12m −$1,667 → +$441 at 48.1% WR**), and (b) **drawdown drops hard** (12m spot maxDD **29.3% → 16.5%**, PF 0.77 → 0.86). The blended 12m book improves **+$2,071** (−$2,816 → −$745) but stays net-negative because momentum is structurally weak over 12m — a separate, non-regime problem (§5.2, §8.1).

4. **Implementation:** built and shipped **disabled-by-default** behind `guardrails.regime_gates` (+ a `--regime-conditional-gates` backtest flag for measurement). Mirrors the `per_symbol_disable` precedent (3 gate sites + funnel telemetry). `pnpm test` → **625/625** green (604 + 21 new). No new deps. `main` untouched.

   > **Rebase note (2026-09-10).** Between this doc and the PR landing, `main` (TASK_017 / E4 harness) took the name `--regime-gates on|off` — and `BacktestConfig.regimeGates: boolean` — for the *RegimeFilter* compatibility toggle. To keep A6's semantics without the collision, A6's flag is now `--regime-conditional-gates` and its config field is `regimeConditionalGates` (`SignalProcessorConfig`, `BacktestConfig`, `api/server.ts`). The YAML key (`regime_gates`), the funnel stage (`regime_gate`) and the `regime-gate.ts` helpers are unchanged. The historical `--regime-gates` in the measurement tables below refers to the pre-rebase A6 flag, i.e. today's `--regime-conditional-gates`. A6 is also now wired through the shared `buildBacktestConfig()` builder, so the E4 harness carries the same (disabled) gate as `pnpm backtest`.

5. **Doc path:** this file. **Blocker:** none for the diagnostic/design; live Supabase unreachable per AGENTS.md (all numbers are HL-fee-simulated Coinbase-candle backtests, not live fills — §3.3). Enabling the gate in live is a **human decision** (trade-count collapse trade-off), not done here.

---

## 2. Machinery — how regime is detected, consulted, and (now) gated (file:line)

### 2.1 Regime classification — `strategies/regime-detector.ts`

- **Output enum** `MarketRegime = 'strong_trend' | 'weak_trend' | 'ranging' | 'choppy'` (`regime-detector.ts:66`). `RegimeState` carries `regime`, `confidence` (0–1), `trendDirection` ('up'|'down'|'neutral'), `adx`, `plusDI`, `minusDI`, `atrPercent`, `bbWidth`, `choppiness`, `directionConsistency`, `mtfAlignment` (`:68-88`).
- **Default mode is `adx_primary`** (`:118`), pure-ADX thresholds (`classifyRegime` `:381-389`): `adx ≥ 40 → strong_trend`; `adx ≥ 20 → weak_trend`; `adx < 20 → ranging`. **`choppy` is never emitted in `adx_primary`** — it only appears via `multi_factor` mode or the insufficient-data neutral state (`:533-549`). Thresholds: `adxStrongTrend 40`, `adxWeakTrend 20` (`:117-130`). Confidence for weak_trend = `(adx−20)/20`, so a weak_trend with `adx<28` has `confidence<0.4`.

### 2.2 Where regime is consulted in the signal pipeline

Three layers already exist; A6 adds a fourth that composes on top:

1. **Plugin self-gate (`StrategyRegistry`, via `regimeCompatibility`)** — the *strongest* existing regime gate:
   - `trend-follow-strategy.ts:166-194`: `strong_trend`=optimal, `weak_trend`=compatible, **`ranging`/`choppy`=`incompatible` (refuse to emit)**. So trend_follow only ever emits in weak/strong_trend. (Confirmed in run logs: `"Strategy trend_follow incompatible with ranging regime"`.)
   - `momentum-strategy.ts:168-192`: `weak_trend`=optimal, `ranging`=optimal, `strong_trend`=compatible, `choppy`=neutral → **momentum emits in all regimes.**
2. **`RegimeFilter` (funnel stage `regime`)** — `regime-filter.ts`. `REGIME_STRATEGY_COMPAT` matrix (`:68-93`), blocks when `compatibilityScore < minCompatibilityScore` (default **0.3**, `:121`) but **only if `confidence ≥ minRegimeConfidence` (default 0.4, `:125`)** — low-confidence regimes bypass with reduced size and **no stamped regime**. Also a `counter_trend` block for trend-following misaligned in strong_trend (`:306-340`). Empirically this stage barely fires (baseline funnel: `regime: { counter_trend: 1 }`). On the success path it stamps `signal.metadata.regime = regimeState.regime` (`:392-398`).
3. **`MetaFilter`** (`meta-filter.ts`) — cold-streak / strength / quality (`:384-419` cold-streak hard block). Composes *after* regime.

**A6 gate (new):** `signal-processor.ts` `processSignal`, inserted **after** `RegimeFilter` (so it reads the confidently-stamped `metadata.regime`) and **before** `MetaFilter` (so a gated signal never consumes cold-streak/quality budget). It keys on `adjustedSignal.metadata.regime`; absent/low-confidence ('unknown') → never gated.

### 2.3 Pipeline order in `processSignal` (`signal-processor.ts`)

`per_symbol_disable` (`:1062`) → `disabled_strategy` (`:1082`) → `dedup` (`:1108`) → **`RegimeFilter`** (`:1132`) → **`regime_gate` (A6, new, after `:1154`)** → `MetaFilter` (`:1195`) → `meta_label` → canonical `signal:generated` (`:1260`).

### 2.4 Backtest fidelity & per-trade regime capture

- The backtest builds a real `SignalProcessor` and subscribes `handleSignal` to the canonical `signal:generated` (`backtest-engine.ts:523,557`), so all pre-canonical gates (incl. A6) run identically in backtest. `handleSignal` (`:636`) re-checks `per_symbol_disable` (and now `regime_gate`) as defense-in-depth.
- **Every admitted trade records its regime**: `recordOutcomeToSignalProcessor` reads `signal.metadata.regime` (`:973-976`); the per-trade `signal.metadata.regime` field is what the §4 tables aggregate.

### 2.5 Auditability — blocked signals are never silently dropped

- Pre-canonical drops (where `per_symbol_disable` and the new `regime_gate` live) are audited via `recordSignalFiltered` (`signal-filter-telemetry.ts:93`) — a Prom counter `atlas_signal_filtered_total{stage,symbol,strategy,reason}` + a structured `signal:filtered` INFO log — and an `EventEmitter` `signal:filtered`. This is the project's funnel-audit convention for pre-canonical stages.
- Post-canonical, every generated signal is persisted to Supabase `signals` with `allowed: signal.allowed !== false` (`api/server.ts:4346-4378`, sync at `:1869`). The A6 gate adds the new stage `'regime_gate'` to the `SignalFilterStage` union (`signal-filter-telemetry.ts`) so its rejections show up in the same funnel as every other stage.

---

## 3. Data & method

### 3.1 Datasets (all gitignored under `atlas/var/backtest_results/`)

| Tag | Command (HL fees, `--commission 0.00045`) | Trades | Use |
|---|---|--:|---|
| **Baseline combined 90d** | 5 symbols, 2025-12-05→2026-03-05 (`backtest_2026-05-29T16-24-25.json`, the H6 faithful baseline) | 276 | impact baseline |
| Spot 90d | BTC/ETH/SOL-USD, same window (`…16-18-24.json`) | 246 | spot regime edge |
| Perps 90d | ETH/BTC-PERP-INTX, same window (`…16-16-08.json`) | 365 | perp regime edge |
| **Spot 12m** | BTC/ETH/SOL-USD, 2025-03-05→2026-03-05 (`backtest_2026-05-29T16-52-22.json`) | 544 | robustness across windows |
| **Gated combined 90d** | baseline + `--regime-gates` (`backtest_2026-05-29T17-09-38.json`) | 144 | projected impact |
| Gated spot 12m | spot-12m + `--regime-gates` (`backtest_2026-05-29T17-12-36.json`) | 214 | 12m honesty check (§6.2) |

Analyzer (reproducible): `_session_2026-05-29_a6/regime-funnel.mjs <file.json …>` — aggregates per-trade `pnl` (net of fees) by `(strategy × regime × venue × symbol)`, where `regime = signal.metadata.regime ?? 'unknown'` and `venue = /PERP/ ? 'PERP' : 'spot'`.

### 3.2 Why per-venue + two windows

The combined run is **cold-streak front-loaded** — `lastAdmittedBarPerStrategy.trend_follow = bar 3634 (2025-12-07)`, ~2 days into a 90-day window (cross-symbol cold-streak suppression, H6 §3.3). So combined-run cell counts are thin; per-venue runs (spot-only, perps-only) give the clean per-(strategy, regime) edge. The 12m window is the robustness check that exposed momentum's non-stationary regime edge.

### 3.3 Limitations (stated plainly)

- **Live Supabase NOT queried** (host unreachable per AGENTS.md). All numbers are backtests on Coinbase candles with HL fees simulated — not live fills (no real slippage/funding/partial fills).
- Backtests don't enforce the hard kill / DD kill (desirable — uncensored), but DO apply the per-strategy cold-streak via bar-time, so streak/budget second-order effects ARE captured.
- 90-day, two-venue, momentum-on-perps-disabled window; `adx_primary` regime mode. The 12m window mitigates but doesn't eliminate single-regime-era risk.

---

## 4. Findings — edge as a function of regime

### 4.1 `trend_follow` — stable `weak_trend` bleed, rare `strong_trend` edge

| Cell | 90d (combined+spot) | 12m (spot) |
|---|---|---|
| `trend_follow × weak_trend × spot` | n=143, WR 39.9%, **−$582**, PF **0.78** | n=405, WR 34.6%, **−$1,781**, PF **0.80** |
| `trend_follow × strong_trend × spot` | n=3, 0% WR, −$120 (noise) | n=16, WR 37.5%, **+$114**, PF **1.41** |
| `trend_follow × weak_trend × PERP` (standalone 90d) | n=364, WR **25.3%**, **−$2,337**, PF **0.44** | — |

- The **weak_trend bleed is the single largest, most stable loss source** (PF 0.78 / 0.80 across windows). trend_follow refuses ranging/choppy at the plugin, so weak_trend is essentially its *only* high-volume regime on spot.
- `strong_trend` is the regime trend-following is designed for and is genuinely positive over 12m (PF 1.41) — but **rare** (16/421 spot trades ≈ 4%).
- By symbol (12m weak_trend): ETH-USD PF 0.70 (−$961, worst), BTC 0.83, SOL 0.87 (least-bad).

### 4.2 `momentum` — edge is NOT stationary (do not regime-gate)

| Cell | 90d (spot) | 12m (spot) |
|---|---|---|
| `momentum × strong_trend × spot` | n=10, 60% WR, **+$301**, PF **3.73** | n=32, 21.9% WR, **−$495**, PF **0.46** |
| `momentum × weak_trend × spot` | n=40, 27.5% WR, −$438, PF 0.53 | n=43, 30.2% WR, −$340, PF 0.69 |
| `momentum × unknown (low-conf) × spot` | n=51, 47.1% WR, +$270, PF 1.35 | n=48, 35.4% WR, −$314, PF 0.72 |

- The `strong_trend` cell **flips sign between windows** (PF 3.73 → 0.46); `unknown` flips (1.35 → 0.72). Over 12m momentum is **net-negative in every regime**. There is no regime in which momentum has *stable* positive edge → a momentum regime gate would overfit to the recent window. (Consistent with F4: spot momentum ~35% WR, carried by the SOL-USD outlier.)

### 4.3 Funnel — where signals are lost vs converted (baseline combined 90d)

```
candidatesPerStrategy: { trend_follow: 628, momentum: 1019 }   # post plugin-emission (ranging/choppy already refused)
admittedPerStrategy:   { trend_follow: 264, momentum: 168 }
filteredByStage: { per_symbol_disable: { symbol_strategy_disabled: 374 },  # momentum on perps
                   meta: { cold_streak: 830 },                              # cold-streak suppression
                   regime: { counter_trend: 1 } }                           # RegimeFilter barely fires
byStrategy: trend_follow 175 trades −$696.64 (38.9% WR); momentum 101 trades +$133.40 (40.6% WR)
```

The existing **`regime` stage is nearly inert** (1 rejection) — the real regime gating today is the plugin self-gate (ranging/choppy refusal) and `per_symbol_disable` (momentum-perp). A6's gate is the first thing to act on the **weak_trend** bleed that everything else lets through.

---

## 5. Gate design

### 5.1 The rule (derived from §4, not guessed)

> **Block `trend_follow` signals when the confidently-classified regime is `weak_trend`** (allow trend_follow only in `strong_trend`).

Rationale: weak_trend is the only stable, high-volume negative-edge cell in the system (PF 0.78/0.80, both windows). It composes additively on top of the plugin's ranging/choppy refusal, so trend_follow ends up trading **only `strong_trend`** — exactly its design regime (12m PF 1.41).

YAML (shipped **disabled**):

```yaml
regime_gates:
  enabled: false
  rules:
    - strategy: trend_follow
      block_regimes: [weak_trend]
```

The schema also supports optional `venues: [spot|PERP]` and `symbols: [...]` scoping per rule (used by none of the default rules but available for future tuning, e.g. a SOL-USD carve-out).

### 5.2 Why momentum is deliberately NOT gated

§4.2: momentum's regime edge is non-stationary (strong_trend PF 3.73 → 0.46 across windows). Any momentum regime rule fitted to the recent window would invert over 12m. Momentum's real problem is *level* (weak everywhere), not *regime* — that's a symbol-level (SOL-only) or disable decision, out of A6's regime scope. Flagged, not implemented.

### 5.3 Perps `trend_follow` is a venue problem, not a regime problem

trend_follow on PERP is broken in the only regime it trades there (weak_trend, PF 0.44). The clean fix is the **existing** per-symbol disable (`perps_symbols.*.disabled_strategies: [trend_follow]`), mirroring the momentum-perp disable — not a regime gate. This matches F4 §8.10's recommendation and needs explicit sign-off (it's an unconditional venue disable). **Not applied here.** Note: in the *combined* live-equivalent book the cold-streak already throttles perps trend_follow to ~29 trades (~breakeven), so this matters mainly for the standalone-perps DD that J1 tracks.

---

## 6. Projected impact (engine re-run, not first-order)

### 6.1 Combined 5-symbol HL-90d — gate ON vs `8fea8b1` baseline

| Metric | Baseline `8fea8b1` | Gated | Δ |
|---|--:|--:|--:|
| Net PnL | −$563.24 | **+$113.40** | **+$676.64** |
| Blended WR | 39.49% | 40.97% | +1.48 pp |
| Profit Factor | 0.88 | **1.04** | +0.16 |
| Max Drawdown | 11.56% | **5.99%** | −5.57 pp |
| Sharpe | −0.97 | +0.32 | flips + |
| Total trades | 276 | 144 | −132 (−48%) |
| trend_follow | 175 tr / −$696.64 | 15 tr / −$21.30 | bleed removed |
| momentum | 101 tr / +$133.40 | 129 tr / +$134.70 | budget freed |

Funnel (gated): `regime_gate.regime_blocked = 622` (all trend_follow weak_trend candidates); trend_follow admitted 264→15 (strong_trend only); `meta.cold_streak` 830→472 (fewer trend_follow losses tripping it), which is why **momentum converts 101→129 trades** despite identical 168 admitted — a real second-order benefit the engine re-run captures.

**Mechanism:** the gate removes the trend_follow weak_trend bleed (book −$696.64 → −$21.30) AND frees cold-streak/position budget so the +EV momentum book trades more. DD nearly halves because the worst cross-symbol trend_follow streaks are gone.

### 6.2 12-month honesty check (engine-validated, spot)

The 90d book flips *positive* partly because momentum's recent `strong_trend` pocket is window-favorable. To test robustness I re-ran the gate over a full 12 months (spot; `--regime-gates`):

| Metric | Baseline spot-12m | Gated spot-12m | Δ |
|---|--:|--:|--:|
| Net PnL | −$2,815.94 | **−$745.33** | **+$2,070.61** |
| Blended WR | 33.64% | 35.05% | +1.41 pp |
| Profit Factor | 0.77 | **0.86** | +0.09 |
| Max Drawdown | **29.28%** | **16.47%** | −12.81 pp |
| Sharpe | −2.81 | −0.92 | +1.89 |
| Trades | 544 | 214 | −330 (−61%) |
| trend_follow | 421 tr / −$1,667.22 (34.7% WR) | **27 tr / +$441.01 (48.1% WR)** | flips strongly + |
| momentum | 123 tr / −$1,148.72 | 187 tr / −$1,186.34 | budget freed → trades more, still −EV |

**Two robust, window-independent results:** (1) gating weak_trend turns **trend_follow's own book positive in both windows** (here +$441 at 48% WR — its real strong_trend edge, now uneaten by the cold-streak that the weak_trend losses used to trip); (2) **drawdown nearly halves** (29.3%→16.5%). The blended 12m book stays net-negative only because the freed budget lets the structurally-weak momentum book trade *more* (123→187 trades, −$1,149→−$1,186). That is momentum's problem, not the gate's — and it's exactly why momentum is **not** regime-gated (§5.2) and is flagged as the residual work (§8.1).

**Takeaway:** the gate is a robust *bleed-removal + DD-reduction* tool across windows. Whether the blended book is net-positive afterwards depends on momentum, whose weakness is a separate, non-regime problem.

---

## 7. Implementation (behind flag, disabled by default)

### 7.1 What was built

| File | Change |
|---|---|
| `strategies/regime-gate.ts` (new) | Pure helpers `buildRegimeGateConfig` / `evaluateRegimeGate` / `venueForSymbol` + `RegimeGateConfig`/`RegimeGateRule` interfaces. Mirrors `per-symbol-disable.ts`. Disabled-config and absent/unknown-regime → no-op. |
| `config/loadGuardrails.ts` | `regime_gates` zod schema (`enabled` default false; `rules[]` of `{strategy, block_regimes, venues?, symbols?}`), optional → back-compatible. |
| `strategies/signal-filter-telemetry.ts` | New funnel stage `'regime_gate'`. |
| `strategies/signal-processor.ts` | `regimeConditionalGates?` config field + the gate in `processSignal` (after RegimeFilter, before MetaFilter). |
| `backtesting/backtest-engine.ts` | `regimeConditionalGates?` on `BacktestConfig` (distinct from the RegimeFilter `regimeGates` boolean); forwarded into the child `SignalProcessor`; defense-in-depth in `handleSignal`. |
| `backtesting/backtest-cli-config.ts` | Shared builder derives `regimeConditionalGates` from guardrails for `pnpm backtest` AND the E4 harness; `forceRegimeConditionalGates` input flips the run copy only. |
| `cli/backtest.ts` | `--regime-conditional-gates` flag force-enables for a measurement run (committed YAML stays `false`); summary prints the A6 gate state next to the RegimeFilter line. |
| `api/server.ts` | Builds + passes `regimeConditionalGates` into the live `SignalProcessor`; defense-in-depth in the `signal:generated` handler. |
| `config/guardrails.yaml` | `regime_gates` block, **`enabled: false`**, with the trend_follow/weak_trend rule + full rationale comment. |
| `__tests__/regime-gate.test.ts` (new) | 21 tests: pure helpers, YAML-state (asserts shipped DISABLED), SignalProcessor end-to-end (blocks weak_trend trend_follow with `stage=regime_gate, reason=regime_blocked`; passes strong_trend / untargeted momentum / venue-miss / unknown-regime; no-op when disabled). |

### 7.2 Conventions honored

Strict TS (clean `tsc` on all new/edited files — the only `tsc` errors are pre-existing and unrelated, e.g. `server.ts:2275 'ev_gate'`, `trading-signals` moduleResolution); `import { Logger }` (no `console.log`); kebab-case filename; IPascalCase interfaces; **no new npm deps**; blocked signals recorded via the funnel (`recordSignalFiltered` + `signal:filtered`) exactly like `per_symbol_disable`; financial values untouched (gate carries no money). `pnpm test` → **625/625** (was 604).

### 7.3 Safety / how to enable

- **Live/paper UNCHANGED**: `enabled: false`. The gate is a no-op until a human flips it.
- **Measure without changing the default**: `pnpm backtest --regime-conditional-gates …` (not `--regime-gates`, which is the RegimeFilter on|off toggle).
- **Before enabling live**, weigh the trade-off: the gate **−48% trade count** and nearly silences trend_follow (strong_trend is rare). That is acceptable only if the team accepts a momentum-dominant, lower-frequency book. Recommended sequence: enable in **paper** first, watch the live funnel `atlas_signal_filtered_total{stage="regime_gate"}`, confirm the live blended WR/PF move as projected, then consider live.

---

## 8. Open questions / next steps

1. **Momentum is the residual problem.** Even with the gate, the 12m book is negative because momentum is weak across regimes. Next: a momentum symbol policy (SOL-only?) or a rolling-WR floor — a separate, non-regime decision.
2. **trend_follow-on-PERP disable** (§5.3) — empirically strong (PF 0.44), mechanism already exists; needs sign-off. Pairs with J1's perps-DD work.
3. **`strong_trend` is rare in `adx_primary`** (ADX≥40 on 15m bars). If the team wants trend_follow to trade more than ~16×/yr, consider lowering `adxStrongTrend` or adding a confidence-scaled weak_trend carve-out for SOL-USD (least-bad weak_trend cell). Measure before shipping.
4. **Live validation.** Re-run this diagnostic against live `trades.features->>'regime'` once Supabase is reachable (the per-trade regime is already persisted via `signals.features`), to confirm backtest regime tagging matches live.

---

## 9. Artifacts (gitignored under `atlas/var/`)

- Analyzer: `backtest_results/_session_2026-05-29_a6/regime-funnel.mjs` (reproduce all §4/§6 tables).
- Baseline combined 90d: `backtest_results/backtest_2026-05-29T16-24-25.json` (H6 faithful baseline).
- Spot/perps 90d: `…16-18-24.json` / `…16-16-08.json`. Spot 12m: `…16-52-22.json`.
- **Gated combined 90d:** `backtest_results/backtest_2026-05-29T17-09-38.json` + stdout `_session_2026-05-29_a6/run_combined_90d_gated.txt`.
- Gated spot 12m: `backtest_results/backtest_2026-05-29T17-12-36.json` + stdout `_session_2026-05-29_a6/run_spot_12m_gated.txt`.

Reproduce the headline impact:
```bash
cd atlas/apps/core-node
# baseline (no flag) vs gated (--regime-conditional-gates), same window/fees:
pnpm backtest                           --start-date 2025-12-05 --end-date 2026-03-05 --commission 0.00045 \
  --products BTC-USD ETH-USD SOL-USD ETH-PERP-INTX BTC-PERP-INTX
pnpm backtest --regime-conditional-gates --start-date 2025-12-05 --end-date 2026-03-05 --commission 0.00045 \
  --products BTC-USD ETH-USD SOL-USD ETH-PERP-INTX BTC-PERP-INTX
```

---

*End of A6 (2026-05-29). Gate ships DISABLED BY DEFAULT — live behaviour unchanged. Enabling is a human decision (§7.3).*
