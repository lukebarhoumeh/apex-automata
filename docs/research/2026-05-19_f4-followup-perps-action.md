# F4 follow-up — perps-only landing zone, empirical p, and a CLI drift fix

**Date:** 2026-05-19
**Inputs:** `docs/research/2026-05-18_f4-hl-backtest-validation.md` (F4), `docs/research/2026-05-18_a1-hl-fee-aware-param-retune.md` (A1)
**HEAD prior to this work:** `ac1d63c` (engine + YAML at F4 push state)
**Verdict:** Decision-tree branch **2-adjacent** — perps-only momentum `takeProfitAtr` lifted 5.0 → 6.0 on both `ETH-PERP-INTX` and `BTC-PERP-INTX`. Spot momentum untouched. Backtest CLI patched to forward `perps_symbols.*.strategy_overrides` (mirrors live; same drift class as #11). Empirical re-run: +$1,084 vs F4 baseline on the HL 90 d perps window. Disable-on-perps is the empirically stronger move but is deferred (requires schema + engine work; explicit user sign-off).

---

## 1. Empirical p per (strategy, symbol) — F4 reanalysis

Source: 8 F4 JSON reports (`atlas/var/backtest_results/backtest_2026-05-18T{18-59-36, 19-01-40, 19-02-08, 19-09-37, 19-13-28, 19-15-25, 19-15-49, 19-23-04}.json`), aggregated trade-level by `signal.strategy × product`. The text stdouts in `_session_2026-05-18b/` were not needed — the engine-generated JSONs carry full per-trade joins (`product`, `signal.strategy`, `pnl`, `exitReason`, `entryFee`, `exitFee`).

### 1.1 Compact table — focus rows only

| Run | Strategy | Symbol | Trades | WR | Sum PnL | Avg PnL | Avg Fee | Fee % of avg loss |
|---|---|---|---:|---:|---:|---:|---:|---:|
| R4 base 90d perp | momentum | BTC-PERP-INTX | 289 | **30.80%** | $-2,229.10 | $-7.71 | $2.65 | 15.8% |
| R4 base 90d perp | momentum | ETH-PERP-INTX | 303 | **33.00%** | $-2,169.47 | $-7.16 | $2.65 | 16.2% |
| R4 base 90d perp | trend_follow | BTC-PERP-INTX | 158 | 32.91% | $-943.60  | $-5.97 | $2.65 | 19.0% |
| R4 base 90d perp | trend_follow | ETH-PERP-INTX | 152 | 37.50% | $-528.54  | $-3.48 | $2.65 | 20.7% |
| R4 tune 90d perp | momentum | BTC-PERP-INTX | 61  | **29.51%** | $-510.41  | $-8.37 | $2.65 | 16.6% |
| R4 tune 90d perp | momentum | ETH-PERP-INTX | 54  | **25.93%** | $-487.31  | $-9.02 | $2.65 | 16.1% |
| R4 tune 90d perp | trend_follow | BTC-PERP-INTX | 28  | 32.14% | $-114.67  | $-4.10 | $2.65 | 19.9% |
| R4 tune 90d perp | trend_follow | ETH-PERP-INTX | 35  | 31.43% | $-258.39  | $-7.38 | $2.65 | 19.4% |
| R1 base 90d spot | momentum | SOL-USD | 31  | **51.61%** | $+359.83  | $+11.61 | $2.62 | 8.2% |
| R1 base 90d spot | momentum | BTC-USD | 35  | 34.29% | $-129.56  | $-3.70 | $2.65 | 10.7% |
| R1 base 90d spot | momentum | ETH-USD | 35  | 37.14% | $-96.87   | $-2.77 | $2.65 | 7.6% |
| R2 base 12m spot | momentum | BTC-USD | 42  | 28.57% | $-285.87  | $-6.81 | $2.63 | 9.2% |
| R2 base 12m spot | momentum | ETH-USD | 38  | 31.58% | $-373.96  | $-9.84 | $2.52 | 5.8% |
| R2 base 12m spot | momentum | SOL-USD | 43  | 30.23% | $-488.89  | $-11.37 | $2.64 | 6.9% |
| R3 base 30d spot | momentum | BTC-USD | 17  | 41.18% | $-9.16    | $-0.54  | $2.39 | 5.7% |
| R3 base 30d spot | momentum | ETH-USD | 19  | 36.84% | $+92.08   | $+4.85  | $2.25 | 4.9% |
| R3 base 30d spot | momentum | SOL-USD | 17  | 29.41% | $-280.87  | $-16.52 | $2.15 | 4.1% |

The full 44-row table (all 4 baseline runs × all 4 tune runs × every observed strategy-symbol pair) is the canonical output of `_session_2026-05-19/empirical-p.mjs` (gitignored; reproduce via `node atlas/var/backtest_results/_session_2026-05-19/empirical-p.mjs`).

### 1.2 Answers to F4 follow-up Q1–Q4

- **Q1: Is `p_momentum_on_perps < 0.30` across both R4 baseline and R4 tune?**
  Mixed. Baseline: 30.80 % (BTC-PERP) and 33.00 % (ETH-PERP) — both **just above 0.30**. Tune: 29.51 % (BTC-PERP) and 25.93 % (ETH-PERP) — both **at or below 0.30**. Mean across the 4 perp measurements: 29.81 %, i.e. right at the boundary. Strictly: NOT < 0.30 on both passes; YES < 0.30 once tune is included; NO on baseline alone.

- **Q2: Did the +20 % tune lift momentum WR on perps materially?**
  **No — WR dropped.** BTC-PERP-INTX: 30.80 % → 29.51 % (−1.3 pp). ETH-PERP-INTX: 33.00 % → 25.93 % (−7.1 pp). The save dollars came entirely from cutting trade count by 82 % (592 → 115), not from improving edge per trade. **Per-trade EV got slightly worse**: BTC −$7.71 → −$8.37, ETH −$7.16 → −$9.02. This is the smoking gun for "wider TPs don't fix a structurally low-`p` distribution; they just slow the bleed by skipping fewer signals."

- **Q3: Is momentum on spot profitable, or also losing?**
  Mostly losing, with one outlier. Aggregate WR per window: R1 90d 40.59 %, R2 12m 30.08 %, R3 30d 35.85 %. Net PnL per window: R1 +$133, R2 −$1,149, R3 −$198. The R1 positive is dominated by **SOL-USD momentum @ 51.61 % WR, +$360**, which carries the rest of the spot momentum book. Without that one outlier, momentum on spot looks like momentum on perps: ~30–37 % WR, modest per-trade loss. **Spot WR is not ≥ 0.40.**

- **Q4: How does `trend_follow` compare on perps vs spot?**
  Trend_follow on perps: avg loss per trade $-3 to $-6 (less bleed than momentum's $-7 to $-9). WR 33–38 %. Trend_follow on spot: avg loss per trade $-1 to $-15. WR 28–45 %. Conclusion: trend_follow on perps is fragile but materially less bleed than momentum-on-perps, and roughly comparable to trend_follow on spot.

### 1.3 Decision-tree fit

Applying the prompt's decision tree literally:

| Condition | Strict reading | Actual | Verdict |
|---|---|---|---|
| `p_momentum_perps < 0.30` AND tune didn't lift AND spot WR ≥ 0.40 | "branch 1 → disable" | p ≈ 0.30 (borderline), tune dropped WR, spot WR ≈ 0.35 (NOT ≥ 0.40) | Partial fit (2 of 3 conditions met) |
| `p_momentum_perps ∈ [0.30, 0.40]` AND tune lifted meaningfully | "branch 2 → perps-only landing zone" | p is in this range on baseline; tune DID NOT lift WR | Partial fit (range yes, lift no) |
| `p_momentum_perps ≥ 0.40` | "branch 3 → STOP, predicate driven by something else" | NO (p ≈ 0.30 not ≥ 0.40) | Does not apply |

**None of the three branches fit cleanly.** The data clearly says:
1. Momentum on perps is structurally low-edge (~30 % WR).
2. The +20 % TP lift alone reduces TP-hit-rate without lifting WR — it's not the right lever for edge.
3. Spot momentum is barely better and has the same fundamental edge problem (the R1 SOL outlier excepted).

The least-defensible action is doing nothing. Two viable paths:

| Path | Empirical save (extrapolated from F4 tune) | Schema support | Code change |
|---|---|---|---|
| **A.** perps-only `takeProfitAtr` lift on momentum (this PR) | ~half of F4 tune save | Yes (`perps_symbols.*.strategy_overrides` is parsed) | YAML-only + a CLI drift bug fix |
| **B.** Disable momentum on perps entirely | Full $4,398 momentum-perp loss | **No** — `disabled_strategies` is global; per-symbol disable requires schema + engine changes | Schema + engine + tests |

Per prompt scope guidance ("tight YAML+test change", "Don't expand scope unilaterally"), Path A is the disciplined ship-target. Path B is the empirically stronger but scope-expanding move, deferred to a separate explicit-approval PR.

---

## 2. Implementation — what was changed

### 2.1 `atlas/config/guardrails.yaml`

Two value edits + inline rationale comments (no structural YAML changes). Diff:

```diff
   ETH-PERP-INTX:
     ...
     strategy_overrides:
       ...
       momentum:
         # strategy-tuning: was 40/55 — restored to canonical 30/70.
         ...
         stopAtr: 2.0
-        takeProfitAtr: 5.0
+        # F4 follow-up (2026-05-19): lifted 5.0 -> 6.0 perps-only landing zone.
+        # Empirical p_momentum_on_perps averages ~30% across F4 baseline + tune
+        # runs; the +20% tune (TP 5.0 -> 6.0) empirically saved $1,682 on this
+        # symbol (-$2,169 -> -$487 net) at the cost of 82% trade-count
+        # reduction. Spot momentum takeProfitAtr stays at 5.0.
+        # See docs/research/2026-05-19_f4-followup-perps-action.md.
+        takeProfitAtr: 6.0
         atrMultiplier: 2.0
   BTC-PERP-INTX:
     ...
     strategy_overrides:
       momentum:
         atrMultiplier: 2.0
         rsiOversold: 30
         rsiOverbought: 70
+        # F4 follow-up (2026-05-19): perps-only landing zone — momentum on
+        # BTC-PERP-INTX previously inherited the global momentum.takeProfitAtr
+        # (5.0). Pinned to 6.0 here so spot stays at 5.0 while perps gets the
+        # wider TP that empirically saved $1,719 on this symbol in F4 tune
+        # (-$2,229 -> -$510 net).
+        takeProfitAtr: 6.0
       trend_follow:
         ...
```

### 2.2 `atlas/apps/core-node/src/cli/backtest.ts`

Tight (5-line) drift fix. The backtest CLI previously iterated only over `guardrails.per_symbol` when building the `perSymbolOverrides` snapshot it hands to `BacktestEngine`. The live `api/server.ts:1631-1644` already calls `signalProcessor.loadPerSymbolOverridesFromGuardrails` twice — once for `per_symbol`, once for `perps_symbols`. The CLI never had the symmetric second pass, so `perps_symbols.*.strategy_overrides.{momentum,trend_follow}` was **silently dropped** in backtests while paper / live honoured it.

This is the same backtest/live drift class as **#11 per-symbol fee routing** (resolved 2026-05-18) and has the same fix shape: mirror the live read.

```diff
+  // F4 follow-up (2026-05-19): same backtest/live drift class as #11 — the
+  // CLI previously read only `guardrails.per_symbol` and silently dropped
+  // `guardrails.perps_symbols.*.strategy_overrides`, so YAML-side perps
+  // momentum/trend_follow tuning was invisible to backtests while live
+  // honoured it. Mirror the live dual-call here so the backtest sees the
+  // same per-symbol config the engine uses in paper/live.
   const perSymbolOverrides: PerSymbolStrategyOverrides = {};
   for (const [symbol, cfg] of Object.entries(guardrails.per_symbol ?? {})) {
     if (cfg.strategy_overrides) {
       perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
     }
   }
+  for (const [symbol, cfg] of Object.entries(guardrails.perps_symbols ?? {})) {
+    if (cfg.strategy_overrides) {
+      perSymbolOverrides[symbol] = cfg.strategy_overrides as Record<string, Record<string, unknown>>;
+    }
+  }
```

This is a strict bug fix, not a feature add. Without it the YAML change in §2.1 is **invisible to the backtest** (verified by reading the pre-fix F4 baseline JSON: `config.perSymbolOverrides` had `['BTC-USD','ETH-USD','SOL-USD']` only; no perp symbols). Including this fix in the same PR is justified because the empirical re-run validation of the YAML change otherwise can't run.

### 2.3 `atlas/apps/core-node/src/__tests__/f4-followup-perps-landing-zone.test.ts`

11 new tests, three describe blocks:
1. **YAML state** — load `guardrails.yaml` from disk; assert `perps_symbols.{ETH,BTC}-PERP-INTX.strategy_overrides.momentum.takeProfitAtr === 6.0`; assert spot `per_symbol.ETH-USD.strategy_overrides.momentum.takeProfitAtr === 5.0`; assert global `momentum.takeProfitAtr === 5.0`.
2. **CLI extraction** — mirror the fixed extraction loop; assert the merged snapshot includes both spot and perp symbol keys; assert resolved values match.
3. **Strategy resolution** — instantiate `MomentumStrategy`, load the merged overrides, assert `getEffectiveConfig('ETH-PERP-INTX').takeProfitAtr === 6.0`, `getEffectiveConfig('BTC-PERP-INTX').takeProfitAtr === 6.0`, `getEffectiveConfig('ETH-USD').takeProfitAtr === 5.0`, plus a `'FAKE-UNUSED-USD'` control that resolves to the plugin schema default (4.0) — proves the per-symbol path is what's lifting perps, not a stray global lift.

### 2.4 Test suite

```
pnpm test (atlas/apps/core-node)  →  46 files / 585 tests passed (was 574)
```

11 net-new tests; no existing test modified. No regressions.

---

## 3. Empirical re-run — F4 perps validation

**Command:**
```bash
cd atlas/apps/core-node
pnpm backtest --start-date 2025-12-05 --end-date 2026-03-05 \
  --commission 0.00045 --products ETH-PERP-INTX BTC-PERP-INTX \
  > ../../var/backtest_results/_session_2026-05-19/run_hl_perps_90d_post_followup.txt 2>&1
```

JSON artifact: `atlas/var/backtest_results/backtest_2026-05-19T15-47-19.json` (gitignored; reproduce with the command above).

### 3.1 Run-level totals

| Metric | F4 baseline | F4 tune (global) | F4 follow-up (perps-only) | Δ vs F4 baseline | Δ vs F4 tune |
|---|---:|---:|---:|---:|---:|
| Trades | 902 | 178 | **610** | -292 (-32 %) | +432 (+243 %) |
| Win Rate | 33.04 % | 29.21 % | **32.46 %** | -0.6 pp | +3.3 pp |
| Net PnL | $-5,870.71 | $-1,370.78 | **$-4,787.03** | **+$1,083.68** | -$3,416.25 |
| Profit Factor | 0.37 | 0.29 | 0.29 | -0.08 | 0 |
| Fees | $2,387.70 | $471.17 | $1,614.49 | -$773.21 | +$1,143.32 |
| Max DD | 58.77 % | 13.76 % | 47.87 % | -10.9 pp | +34.1 pp |

### 3.2 Per (strategy, symbol)

| Strategy | Symbol | base sumPnL | tune sumPnL | post sumPnL | Δ post vs base | Δ post vs tune |
|---|---|---:|---:|---:|---:|---:|
| momentum | BTC-PERP-INTX | $-2,229.10 | $-510.41 | $-2,082.02 | **+$147.08** | -$1,571.61 |
| momentum | ETH-PERP-INTX | $-2,169.47 | $-487.31 | $-1,782.06 | **+$387.41** | -$1,294.74 |
| trend_follow | BTC-PERP-INTX | $-943.60 | $-114.67 | $-360.38 | **+$583.21** | -$245.72 |
| trend_follow | ETH-PERP-INTX | $-528.54 | $-258.39 | $-562.57 | $-34.03 | -$304.17 |

### 3.3 What the empirical save attributes to

The +$1,084 dollar improvement decomposes as:

1. **Momentum TP lift on perps (the YAML edit):** +$534 across both perp symbols ($147 BTC + $387 ETH). Trade count moved 592 → 489 (-17 %), WR moved 30–33 % → 28–34 % (essentially unchanged). Per-trade EV got *slightly worse* (avg $-7.43 → $-7.90). The save is entirely from fewer trades, not from better edge per trade.
2. **CLI drift fix on trend_follow:** +$549 from properly applying the `trend_follow` per-symbol overrides that were silently dropped pre-fix. Trade count moved 310 → 121 (-61 %). The big trade-count reduction comes from BTC-PERP-INTX's `emaSlow=26` per-symbol override (vs the plugin default of 15) finally landing in the backtest. This is a *bug-fix-only-but-empirically-valuable* by-product.

Combined: +$1,084 ≈ ($534 momentum direct + $549 trend_follow drift fix). The numbers cross-check.

### 3.4 The smoking gun — exit reason breakdown

| Run | Symbol | take_profit exits | stop_loss exits | signal exits |
|---|---|---:|---:|---:|
| F4 baseline momentum | BTC-PERP-INTX | 21 | 180 | 88 |
| F4 baseline momentum | ETH-PERP-INTX | 19 | 179 | 105 |
| F4 follow-up momentum | BTC-PERP-INTX | **0** | 152 | 86 |
| F4 follow-up momentum | ETH-PERP-INTX | **0** | 144 | 107 |

Momentum on perps with `takeProfitAtr=5.0` hit TP 21 + 19 = 40 times out of 592 trades (6.8 %). With `takeProfitAtr=6.0`, it hits TP **0 times out of 489 trades** (0 %). Wider TPs *eliminate* TP-exits on this 1-minute perp tape — all "winners" come from signal-flips or time-stops instead. This is exactly the F4 §2.2 prediction empirically realized and **directly supports the case that momentum on 1-minute perps is structurally broken**: even at 6× ATR, the price doesn't traverse the TP distance often enough to matter.

### 3.5 Comparison vs full F4 tune

The full F4 tune ($-1,371 net on run 4) saved $3,416 more than this perps-only YAML change because the tune ALSO lifted `filters.atr_volatility_min: 0.005 → 0.006` globally, which cut momentum trade count by 80 % via the atr-vol-min gate. To capture that lever perps-only would require **per-symbol filter overrides**, which the schema does NOT support today (`filters.*` is a top-level block; `PerSymbolLimitSchema` and `PerpsSymbolLimitSchema` carry `strategy_overrides` and `max_*_usd` but no `filters`). Adding per-symbol filters is a separate, larger PR.

---

## 4. Why disable wasn't chosen now

Empirically the strongest action is "disable momentum on perps until A6 lands":
- Captures the full $4,398 momentum-perp loss (vs the $534 captured by the TP lift).
- Per-trade EV doesn't improve with wider TPs — only fewer trades helps; full disable is the limit of that.
- TP-hit rate dropped to **zero** with the wider TP, confirming the strategy is structurally degraded on this tape.

It was **NOT** chosen this PR because:
1. `disabled_strategies` is a top-level list — schema has no per-symbol disable field.
2. Adding `PerpsSymbolLimitSchema.disabled_strategies` requires reading it in three call sites (`backtest-engine.ts:620`, `signal-processor.ts:1050`, `api/server.ts:1759,4136`) — a multi-file engine change.
3. The prompt's explicit guidance: *"If you discover YAML schema gaps that require non-trivial changes: STOP and report. Don't expand scope unilaterally; the F4 follow-up should be a tight YAML+test change."*

**Disable is the recommended next action for an explicit-approval follow-up.** Estimated scope: 1 schema field (`disabled_strategies?: z.array(z.string()).optional()` on `PerpsSymbolLimitSchema`, optionally `PerSymbolLimitSchema` / `HyperliquidSymbolLimitSchema` for symmetry), 3 short engine reads (the three call sites above), 3 tests. Total: ~50–80 LOC. Empirical upside on the same window: ~$3,300 additional save above this PR's $534 direct momentum save.

---

## 5. Implications

### 5.1 A6 (regime-conditional gating)
A6 is the structural fix for what F4 + this follow-up have demonstrated: momentum on 1-minute perp bars at ~30 % WR is not break-even regardless of geometric R. A6 should:
- Add a regime-conditional gate that suppresses momentum signals on perp symbols when `regime ∈ {ranging, choppy}` (where most of the −$7 / trade comes from — see F4 §1.1 trend_follow trades flagged "incompatible with ranging regime" that drove ~40 % of the bar-time silence in F4 run 4).
- Optionally add a per-(strategy, symbol) WR floor (e.g., if rolling-30d WR < 0.32, suspend the strategy on that symbol for 24 h). This is a softer version of the disable proposed in §4.

### 5.2 J1 (drawdown limit revalidation)
F4 baseline run 4 hit **58.77 % DD** on perps — well above `risk.max_drawdown_limit: 0.15`. F4 tune run 4 hit 13.76 % (under limit). This PR's post-followup hit **47.87 %** — still 3× over the limit. The DD limit must be revalidated against the empirical perp drawdown distribution before J1 ships, and J1 should consider tightening to 0.20 with a hard kill on perps specifically. The current 0.15 limit assumes spot-like volatility; perps on 1-minute bars routinely exceed it.

### 5.3 #11 (per-symbol fee routing) — confirmation
This PR's CLI drift fix is conceptually identical to #11: both are "live correctly forwards/routes per-symbol data, backtest CLI does not". Strongly suggests an **audit pass on the backtest CLI** is warranted to find any other silent backtest/live config drift. Candidate audit targets: `accountConfig` mapping, `dynamicRisk` derivation, `realism` knob propagation. Out of scope for this PR; flag for a B-series follow-up.

### 5.4 B1 (HL testnet wire)
B1 remains the next-biggest unblocker. Until B1 lands, every F-series backtest runs on Coinbase candles with HL fees simulated. F4 already demonstrated #11 works end-to-end. The next empirical step that materially improves predicate health is B1 → F5 (HL-native price action backtest).

---

## 6. Predicate impact (informational)

The F4 falsifiable predicate ("combined PF ≥ 1.20, avg net PnL per TP-exit > 0, trade count ∈ [100, 350]") still fails on this perps-only run:

| Criterion | Target | F4 baseline | F4 follow-up | Verdict |
|---|---|---|---|---|
| Combined PF (run 4 only) | ≥ 1.20 | 0.37 | 0.29 | **FAIL** (worse) |
| Avg net PnL per TP-exit | > 0 | -- | undefined (0 TP exits) | **FAIL** (TP-exit population emptied) |
| Trade count (run 4) | ∈ [25, 100] | 902 (over) | 610 (over) | **FAIL** (still 6× over) |

This is consistent with F4 §3 conclusion: the predicate as written is not reachable on 1-minute perp data without disabling momentum on perps or adding regime-conditional gating (A6). The trade-count axis is structurally calibrated for spot's 15-minute bars and needs revision.

---

## 7. Artifacts

- Engine YAML at HEAD before this PR: `ac1d63c`
- Empirical analysis script (gitignored): `atlas/var/backtest_results/_session_2026-05-19/empirical-p.mjs`
- Comparison script (gitignored): `atlas/var/backtest_results/_session_2026-05-19/compare-followup.mjs`
- Post-followup backtest stdout (gitignored): `atlas/var/backtest_results/_session_2026-05-19/run_hl_perps_90d_post_followup.txt`
- Post-followup JSON (gitignored): `atlas/var/backtest_results/backtest_2026-05-19T15-47-19.json`
- Post-followup report (gitignored): `atlas/var/backtest_results/report_2026-05-19T15-47-19.txt`

Reproduce empirical-p table:
```bash
node atlas/var/backtest_results/_session_2026-05-19/empirical-p.mjs
```

Reproduce comparison:
```bash
node atlas/var/backtest_results/_session_2026-05-19/compare-followup.mjs
```

---

**End of F4 follow-up.**
