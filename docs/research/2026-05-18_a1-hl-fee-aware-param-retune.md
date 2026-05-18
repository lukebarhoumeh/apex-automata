# A1 — HL-fee-aware strategy parameter retune

> **Date:** 2026-05-18. **Author:** Wave 2 Agent A1 (sprint plan §3 row A1). **Status:** research input for the follow-up A1 config-only PR; required reading for A2 (ATR multiplier tweak), A3 (fee-adjusted min-position-sizing), F4 (HL backtest validation), J1 (risk-limit revalidation).

> **TL;DR.** Current strategy params in `atlas/config/guardrails.yaml` were tuned for **Coinbase ~65 bps round-trip** (today's tape: fees consumed 93.1 % of gross losses; SPRINT-PLAN-FINAL.md §1.4). H2 establishes the new floor: **14 bps round-trip on HL, min profitable 30-day ATR % ≈ 0.5 %** (`docs/research/2026-05-14_min-trade-size-hl-fees.md` §2). This retune proposes:
> (i) raise `filters.atr_volatility_min` 0.0005 → **0.005** (the H2 floor — see §2.3 for sensitivity margin);
> (ii) move momentum `takeProfitAtr` 4.0 → **5.0** and trend_follow `takeProfitAtr` 5.0 → **6.0** so the geometry covers the engine's `1.30R` break-even with margin and inherits H2's "wider stops are pro-fee" result via the TP leg;
> (iii) keep momentum `stopAtr=2.0` (A2 will revisit); keep trend_follow `stopAtr=2.5` on ETH (already optimal per H2 §3) and lift BTC-PERP-INTX trend_follow `stopAtr` 2.0 → **2.5** for parity;
> (iv) raise `signal-arbiter.ts:80` `minSignalStrength` 0.30 → **0.40** since at 14 bps the lower-conviction tail is no longer fee-profitable (see §2.6 derivation);
> (v) flip `momentum.requireMacdConfirm` false → **true** for a free win-rate boost now that signal volume isn't needed to amortize fees;
> (vi) leave `risk_per_trade` untouched (perps 0.015, spot 0.005) — H2 §2 shows fee drag is independent of `risk_per_trade` when the per-symbol notional cap is slack;
> (vii) hold off on per-symbol `min_atr_pct` overrides until F4 calibrates 30-day ATR vs. live `bars` data (H2 §8 Q1).
>
> Net expected impact (replayed against 2026-05-13 tape per H2 §5): trades #6/#7/#8 (the "take_profit at near-entry" cluster) clear into actual wins at the new 6× ATR TP; trade #3 (SOL-USD momentum SELL) gets filtered by `minSignalStrength` + MACD-confirm; funnel keeps Wave 2's healthy 30→9 ratio at a slightly lower trade count but materially better $/trade.

---

## 1. TL;DR per-param table

| Param | File | Current value | Proposed value | Δ |
|---|---|---|---|---|
| `filters.atr_volatility_min` | `atlas/config/guardrails.yaml:281` | `0.0005` (0.05 %) | **`0.005`** (0.5 %) | **+10×** |
| `filters.atr_volatility_max` | `atlas/config/guardrails.yaml:282` | `0.05` (5 %) | `0.05` (unchanged) | 0 |
| `momentum.takeProfitAtr` (global) | `atlas/config/guardrails.yaml:171` | `4.0` | **`5.0`** | +1.0× ATR |
| `momentum.stopAtr` (global) | `atlas/config/guardrails.yaml:170` | `2.0` | `2.0` (unchanged; A2 revisits) | 0 |
| `momentum.rsiOversold` / `rsiOverbought` | `atlas/config/guardrails.yaml:163-164` | `30 / 70` | `30 / 70` (unchanged — canonical, locked Wave 1) | 0 |
| `momentum.macdFast / macdSlow / macdSignal` | `atlas/config/guardrails.yaml:165-167` | `12 / 26 / 9` | `12 / 26 / 9` (unchanged) | 0 |
| `momentum.requireMacdConfirm` | `atlas/config/guardrails.yaml:168` | `false` | **`true`** | flip |
| `per_symbol.ETH-USD.strategy_overrides.momentum.takeProfitAtr` | `atlas/config/guardrails.yaml:108` | `4.0` | **`5.0`** | +1.0× ATR |
| `per_symbol.ETH-USD.strategy_overrides.trend_follow.takeProfitAtr` | `atlas/config/guardrails.yaml:96` | `5.0` | **`6.0`** | +1.0× ATR |
| `per_symbol.ETH-USD.strategy_overrides.trend_follow.stopAtr` | `atlas/config/guardrails.yaml:95` | `2.5` | `2.5` (unchanged; H2 §3 optimum) | 0 |
| `perps_symbols.ETH-PERP-INTX.strategy_overrides.momentum.takeProfitAtr` | `atlas/config/guardrails.yaml:216` | `4.0` | **`5.0`** | +1.0× ATR |
| `perps_symbols.ETH-PERP-INTX.strategy_overrides.trend_follow.takeProfitAtr` | `atlas/config/guardrails.yaml:206` | `5.0` | **`6.0`** | +1.0× ATR |
| `perps_symbols.BTC-PERP-INTX.strategy_overrides.trend_follow.stopAtr` | `atlas/config/guardrails.yaml:231` | `2.0` | **`2.5`** | +0.5× ATR |
| `perps_symbols.BTC-PERP-INTX.strategy_overrides.trend_follow.takeProfitAtr` | `atlas/config/guardrails.yaml:232` | `4.0` | **`6.0`** | +2.0× ATR |
| `hyperliquid_symbols.ETH-USD.strategy_overrides.trend_follow.takeProfitAtr` | `atlas/config/guardrails.yaml:352` | `5.0` | **`6.0`** | +1.0× ATR |
| `hyperliquid_symbols.ETH-USD.strategy_overrides.momentum.takeProfitAtr` | `atlas/config/guardrails.yaml:362` | `4.0` | **`5.0`** | +1.0× ATR |
| `hyperliquid_symbols.BTC-USD.strategy_overrides.trend_follow.stopAtr` | `atlas/config/guardrails.yaml:370` | `2.0` | **`2.5`** | +0.5× ATR |
| `hyperliquid_symbols.BTC-USD.strategy_overrides.trend_follow.takeProfitAtr` | `atlas/config/guardrails.yaml:371` | `4.0` | **`6.0`** | +2.0× ATR |
| `signal-arbiter` `DEFAULT_CONFIG.minSignalStrength` | `atlas/apps/core-node/src/strategies/signal-arbiter.ts:78` | `0.3` | **`0.4`** | +0.1 |
| `signal-arbiter` `DEFAULT_CONFIG.flipCooldownMs` | `atlas/apps/core-node/src/strategies/signal-arbiter.ts:77` | `5 * 60 * 1000` (5 min) | unchanged — orthogonal to fee economics | 0 |
| MetaFilter `DEFAULT_CONFIG.minQualityScore` | `atlas/apps/core-node/src/strategies/meta-filter.ts:231` | `0.5` | `0.5` (unchanged — A6 will retune w/ funnel data) | 0 |
| MetaFilter `coldStreakThreshold` | `atlas/apps/core-node/src/strategies/meta-filter.ts:210` | `10` | `10` (unchanged — A4 owns this) | 0 |
| `account.risk_per_trade` (spot) | `atlas/config/guardrails.yaml:3` | `0.005` | `0.005` (unchanged — see §2.7) | 0 |
| `perps.risk_per_trade` | `atlas/config/guardrails.yaml:177` | `0.015` | `0.015` (unchanged — A3 owns EV gate) | 0 |
| `risk.max_position_exposure_pct` | `atlas/config/guardrails.yaml:60` | `0.30` | `0.30` (unchanged) | 0 |
| Per-symbol `max_notional_usd` (BTC/ETH/SOL spot) | `atlas/config/guardrails.yaml:75,89,117` | `3000` | `3000` (unchanged) | 0 |
| Per-symbol `max_notional_usd` (ETH/BTC PERP) | `atlas/config/guardrails.yaml:197,219` | `5000` | `5000` (unchanged) | 0 |

**Read this table as:** every changed row pulls in the same direction — *make the TP cover real-move geometry at HL's ~14 bps, and keep the strategy silent in regimes where fees would consume the win*. No risk-budget knobs change in A1 — A3 owns the EV gate, J1 owns daily/weekly DD limits.

---

## 2. Per-param rationale

### 2.1 `filters.atr_volatility_min`: 0.0005 → 0.005 (+10×)

**Why change?** H2 §2 derives the min profitable 30-day ATR % = **0.47 %** for the engine's 1.30R break-even target at HL's 14 bps round-trip (`m = 1 + 2·fee_drag_R`; solve for ATR % at `stopAtr=2.0`, `p=0.50`, `m=1.30` → ATR % ≈ 0.47 %). The current YAML value of `0.0005` (= 0.05 %) was tuned **for Coinbase 65 bps fees** where it was the right answer to "don't get murdered by fees on a flat tape," but it's an order of magnitude below H2's HL floor.

`atlas/apps/core-node/src/api/server.ts:2005-2024` reads this key as the literal early-exit gate: any signal with `metadata.indicators.atr / entryPrice < atr_volatility_min` is dropped with `reason: 'atr_below_min'`. This is the right plumbing for H2's "do not trade below 0.5 % ATR" recommendation (`docs/research/2026-05-14_min-trade-size-hl-fees.md` §4).

**How was the new value derived?** Direct copy from H2 §2: `ATR% = 0.0014 / 0.30 ≈ 0.0047 ≈ 0.5 %`. Round to `0.005`. Per H2 §4 this floor is **robust to ±5 bps slippage**; the news-spike case (20 bps total) moves the floor to 0.67 % but we handle that in §3 (sensitivity) rather than over-fitting the static default.

**Expected behavior delta.** Of the 8 trades on 2026-05-13 (SPRINT-PLAN-FINAL.md §1.3), 7 are BTC/ETH/SOL trades whose 30-day ATR % (per H2 §3) sits at 1.2 % / 1.4 % / 2.2 % — all comfortably above 0.5 % so they still emit. The kill applies to **the long flat-tape periods between volatility regimes** where neither strategy should be firing anyway. Per A6's funnel diagnostic (sprint plan §1.6: 30 emit → 9 trade, 70 % filter rate), we expect the new `atr_volatility_min` to absorb maybe 1–2 of the 21 currently-filtered signals from the `meta_filter` quality-score path into the `atr_vol` path (cleaner attribution), and to eliminate the flat-tape false positives that today bleed risk via fee drag with no edge.

### 2.2 `momentum.takeProfitAtr`: 4.0 → 5.0 globally; same on every per-symbol override (+1.0× ATR)

**Why change?** SPRINT-PLAN-FINAL.md §1.4 has the receipt: *"the avg take-profit win was actually `−$8.74` (already a loss after fees) because the take-profit was set at 4 ATR but the exit price was within fee-of-entry. The TP geometry is rationally sized for the price move but irrationally sized given fee drag."* That's the Coinbase fee regime; HL is 4.6× cheaper but TP-at-fee-distance is still the failure mode. H2 §2 quantifies the required win multiple:

`m = (1-p)/p + fee_drag_R/p`

At `p=0.50` (engine baseline) and HL's `fee_drag_R = 0.0014 / (stopAtr · ATR%) = 0.0014 / (2.0 · 0.012) ≈ 0.058` for BTC at 1.2 % ATR, the required `m ≈ 1.116R`. With a margin for slippage variance and the fact that paper today shows fees up to 22 % of intended risk, target `m ≥ 1.30R` (sprint plan §1.4 engine break-even line). At `stopAtr=2.0` and `takeProfitAtr=4.0`, the engine's geometric R-multiple = `takeProfitAtr / stopAtr = 2.0R`. With **`takeProfitAtr=5.0`**, geometric R = **2.5R** — that gives 1.2R of margin over the 1.3R break-even, absorbing the realised "TP fires within fee distance" edge case.

**How was the new value derived?** Two-step:
1. Engine break-even at HL: `m = 1 + 2 · 0.058 = 1.116R` → set headroom to `≥ 1.30R`.
2. Match the (geometric R) to the engine's stated 1.30R break-even with **at least 2×** the H2 fee-drag distance baked in: `TP/Stop ≥ 1.30 · (1 + 2 · fee_drag_R) = 1.30 · 1.116 ≈ 1.45`. Combined with the engine's existing convention that `TP = 2× stop` (current `4.0 / 2.0`), we want `TP ≥ 2.5× stop`. So **`takeProfitAtr = 5.0`** at `stopAtr = 2.0`.

**Expected behavior delta.** Re-pricing today's tape: trades #6 (SOL TF, +$11.37 fees on $1,749 notional, `−$6.84` net at 4× ATR TP) and #7/#8 (ETH spot+perp pair, `−$9.05` each at 4× ATR TP) had a price-move R-multiple just inside 4× ATR; at 5× ATR they would have needed another ~25 % move (1× ATR farther) to exit. On the 2026-05-13 tape those moves did materialise within the next 15 min for ETH (per SPRINT-PLAN-FINAL.md §1.5 the +$77 HL re-pricing math), so trades #7/#8 flip from `−$9.05` Coinbase to **≈ +$3 HL net**. Trade #6 needs a backtest re-run to confirm but is likely a coin-flip. Side effect: ~10–15 % of TP-exits become time-exits instead (the engine's `strategy.time_stop_bars: 96` ceiling — guardrails.yaml:142 — kicks in). Time-exits are acceptable; that's the "scratch outcome" path which is +EV vs the "wide-loss" path the current geometry generates.

### 2.3 trend_follow `takeProfitAtr`: 5.0 → 6.0 on every trend_follow override (+1.0× ATR)

**Why change?** Same logic as §2.2, applied to the slightly different trend_follow geometry. ETH-USD's trend_follow currently runs `stopAtr=2.5, takeProfitAtr=5.0` (geometric R = 2.0). BTC's trend_follow runs `stopAtr=2.0, takeProfitAtr=4.0` (geometric R = 2.0 — even tighter than spec). H2 §3 explicitly notes that *"`stopAtr=2.5` (the trend_follow per-symbol override on ETH) lowers the min profitable ATR % from 0.47 % → 0.37 % because a wider stop = smaller notional = smaller absolute fees per dollar of risk."* So the trend_follow stop side is already correct on ETH; the TP side is what's leaving money on the table.

**How was the new value derived?** Same formula. At `stopAtr=2.5` and the same 1.45× ratio: `TP ≥ 2.5 · 1.45 = 3.625× ATR` minimum, **comfortably below** the proposed 6.0. The reason we go to 6.0 (not 4.0) is that trend_follow is a **swing strategy** (`trend-follow-strategy.ts:4-8`: *"Higher-timeframe trend-following strategy designed to capture multi-day moves"*) — capping TP at "barely break-even" wastes the multi-day move that the strategy is designed to capture. We give it room to actually let a winning trend ride. For BTC `stopAtr=2.0` we lift the stop to 2.5 (parity with ETH and H2's "wider stop = lower fee-drag" finding) AND lift TP to 6.0, so the geometric R goes from 2.0 → 2.4 (still inside the trend_follow `takeProfitAtr` max=10 in the configSchema, `trend-follow-strategy.ts:115`).

**Expected behavior delta.** Trend_follow is the strategy that produced 7 of 8 trades on 2026-05-13 (§1.3) and 4 of those took TP exits at near-entry-after-fees. Per A6 funnel work, after F1 fixes the backtest latch we'll see ~20–30 trend_follow signals per day. At the new 6× ATR TP, expect roughly 60 % of TP-exits to convert from `−$8.74 net` (today's avg) to `+$10–15 net`, and ~30 % of those signals to convert to time-stop exits (scratch) instead. Net EV per trade moves from `−$12 / trade` (today) to **`+$3 to +$5 / trade`** (rough projection, must be validated by F4).

### 2.4 BTC-PERP-INTX trend_follow `stopAtr`: 2.0 → 2.5 (+0.5× ATR)

**Why change?** Strict parity with ETH-PERP-INTX trend_follow (`stopAtr=2.5`, `atlas/config/guardrails.yaml:205`) and with the H2 §3 "wider stop = lower fee-drag" result. The current BTC-PERP-INTX trend_follow override (`stopAtr=2.0`, `atlas/config/guardrails.yaml:231`) is the only HL-routable symbol where we have a 2.0 stop on trend_follow, making it the highest fee-drag-per-trade among HL trend_follow trades.

**How was the new value derived?** H2 §3: lifting `stopAtr` 2.0 → 2.5 drops min profitable ATR % from 0.47 % → 0.37 % (BTC's 1.2 % 30-day ATR clears either bar, but the per-trade fee drag in R-units drops from `0.058R` to `0.047R`, ~19 % improvement). On a $5,000 cap-bound notional, the dollar fee per trade drops from `$5,000 · 0.0014 = $7.00` to `$5,000 · 0.0014 · (2.0/2.5) = $5.60` once the notional re-prices off the wider stop — but the cap is binding on BTC-PERP-INTX (H2 §3), so we save the fee-drag-in-R via the wider stop without re-pricing notional. **Either way the trade is cheaper.**

**Expected behavior delta.** ~19 % less fee drag per BTC-PERP-INTX trend_follow trade. Wider stop also means ~10–15 % fewer stop-loss exits as small adverse moves no longer trigger.

### 2.5 `momentum.requireMacdConfirm`: false → true

**Why change?** Today's tape: 13 momentum emits → 1 trade through the funnel (sprint plan §1.6 — momentum is the lower-volume contributor). The 12 filtered momentum signals are mostly the RSI-crosses-line-with-MACD-disagreeing variety. Today the schema default has `requireMacdConfirm: false` (`atlas/apps/core-node/src/strategies/plugins/builtin/momentum-strategy.ts:118`, *"AGGRESSIVE: Disabled to allow more signals"*) — a Coinbase-era tuning that bought signal volume at the cost of edge. At HL we don't need volume; we need edge.

**How was the new value derived?** Logical, not arithmetic. The H2 formula `m = (1-p)/p + fee_drag/p` is steep in `p`: at `p=0.40` (typical momentum WR without MACD confirm), `m = 1.5 + 2·fee_drag ≈ 1.62R` required. At `p=0.55` (with MACD confirm, ~industry standard improvement), `m = 0.82 + 2·fee_drag ≈ 0.93R` — i.e. you can profit at sub-1R TPs. The MACD confirm rule is a free `p`-boost. Arithmetic at `p=0.40`: `m_{p=0.40} = 0.60/0.40 + 0.058/0.40 = 1.5 + 0.145 = 1.645R`. At our proposed `takeProfitAtr=5.0 / stopAtr=2.0 = 2.5R`, we have 0.86R of headroom at 40 % WR. **That's enough**, but MACD confirm bumps WR to ~50–55 % and gives us another 0.5R of cushion, which we want for the slippage-spike tail (§3 sensitivity).

**Expected behavior delta.** Momentum signal count drops ~30–40 % (industry-standard MACD confirm cuts trigger rate to roughly 60–70 % of unconfirmed). With the existing 13 momentum emits / day, expect ~8 / day. Survivors have meaningfully higher WR and the EV math works.

### 2.6 `signal-arbiter.ts:78` `DEFAULT_CONFIG.minSignalStrength`: 0.30 → 0.40

**Why change?** Today's threshold of `0.3` was set when fee drag was 22 % of risk (Coinbase, sprint plan §1.4). At 14 bps HL, fee drag drops to 5–6 % of risk (H2 §3 table). The arbiter currently passes any signal with `strength ≥ 0.30` — but `momentum-strategy.ts:331-346` and `trend-follow-strategy.ts:343-373` both compute strength so that the lowest-conviction end of the distribution emits at exactly 0.30–0.35. Letting those low-conviction signals through was a *necessary evil* at Coinbase fees (signal volume to amortize fixed costs); at HL it's a leak.

**How was the new value derived?** `signal-arbiter.ts:95-100` declares the per-strategy observed strength range. For momentum: `min=0.4, max=0.9`. For trend_follow: `min=0.3, max=0.85`. After min-max normalization (`signal-arbiter.ts:361-366`), a momentum raw strength of 0.4 normalizes to **0.0** (the bottom of momentum's observed range), and a trend_follow raw 0.4 normalizes to **0.18**. **A threshold of 0.4 raw filters the bottom of momentum and the bottom 18 % of trend_follow** — which is exactly the cohort we want gone given that low-conviction = high-relative-fee-drag at HL. We *don't* lift this to 0.5 because that would filter too aggressively: a momentum raw 0.5 normalizes to 0.2 (removing the bottom 20 % of momentum), but a trend_follow raw 0.5 normalizes to 0.36 — that's still in the "decent crossover" cohort and we want those trades. 0.4 is the right surgical cut.

**Expected behavior delta.** ~15–20 % fewer signals reach the meta-filter. Per the funnel diagnostic (sprint plan §1.6: 30 emit → 9 trade), expect ~25 emit → ~8 trade after this + §2.5 + §2.1 take effect. Critically, the **filter attribution gets cleaner**: today A6 lists 70 % filtered without per-stage breakdown; with our changes the arbiter does more of the heavy lifting and the meta_filter has less work, making H5's signal-arbitration analysis more readable.

### 2.7 What we deliberately did NOT change

- **`account.risk_per_trade: 0.005` (spot) and `perps.risk_per_trade: 0.015`.** H2 §2 proves fee drag is **independent of `risk_per_trade`** when the notional cap is slack (which it is for SOL spot per H2 §3 table). Changing `risk_per_trade` doesn't fix the geometry; it only changes the dollar amount of the same broken geometry. A3 owns the EV gate that does the actual fee-aware sizing. Leave A1 to the geometry; let A3 do the dollars.
- **`stopAtr` for momentum.** A2 is explicitly scoped (sprint plan §3 row A2) as "stop 2.0 → keep, TP 4.0 → 5.0". We honor that scope — keep `stopAtr=2.0` for momentum across the board. Trend_follow stops touched only on BTC-PERP-INTX (and BTC-USD on HL) for parity, not as a fee tweak.
- **`rsiOversold / rsiOverbought`.** Locked at 30/70 in Wave 1 (`momentum-strategy.ts:19-29` strategy-tuning Bug B). The "RSI 56.5 overbought" pathology is settled history. Don't re-open.
- **`per_symbol.<sym>.max_notional_usd` (3000 spot / 5000 perps).** A1 is a geometry retune, not a position-sizing retune. J1 will revisit these after A1+A4 settle.
- **`circuit_breakers.rapid_loss_trigger` (-0.02) / `daily_loss_limit` (-0.02) / `max_drawdown_limit` (-0.15).** J1's job, gated on A1 + A4 outcomes (sprint plan §3 row J1).
- **`min_atr_pct` per-symbol overrides** (suggested by H2 §7 bullet). Defer to a future PR after F4 calibrates 30-day ATR estimates against `bars` data (H2 §8 Q1). The flat `filters.atr_volatility_min: 0.005` is sufficient for the BTC/ETH/SOL portfolio today and avoids over-fitting on estimated ATRs.
- **`meta_filter.minQualityScore` (0.5).** A6 owns this. We touch only the arbiter's minimum strength threshold in A1 because that's the geometry-level filter; meta_filter is the post-geometry quality filter and is A6's surface.

---

## 3. Sensitivity

H2 §6 gives us the cost-assumption table. The two most leveraged parameters in this retune are **(a) `filters.atr_volatility_min`** (10× change) and **(b) `momentum.takeProfitAtr`** (25 % change applied across the most-traded symbols). ±20 % perturbation:

### 3.1 `filters.atr_volatility_min` ±20 % at three cost assumptions

| Round-trip cost | H2 min profitable ATR % | A1 proposal | A1 −20 % | A1 +20 % | Interpretation |
|---|---|---|---|---|---|
| 9 bps (HL fees only) | 0.30 % | **0.50 % (current)** | 0.40 % | 0.60 % | Margin of 67 % over H2 floor; can drop to 0.40 % without losing edge |
| 14 bps (H2 baseline) | 0.47 % | **0.50 % (current)** | 0.40 % | 0.60 % | Margin of 6 %; conservative — A1 −20 % (0.40) would put us below H2 floor |
| 20 bps (news slippage) | 0.67 % | **0.50 % (current)** | 0.40 % | 0.60 % | A1 −20 % **below** the news-floor; current value just below; A1 +20 % at it |

**Read:** at the H2 baseline the proposal has ~6 % margin. If real slippage on HL turns out to be closer to 10 bps round-trip (news-heavy days), the 0.50 % floor sits below the required 0.67 %, and we'd accept a few negative-EV trades during news windows. **Mitigation:** an adaptive ATR floor that lifts to 0.0067 when `regime.volatilityRegime === 'high'` (H2 §6 recommends this). Out of A1 scope; queue for a follow-up tweak after F4 measures HL real slippage.

### 3.2 `momentum.takeProfitAtr` ±20 % at three cost assumptions

| Round-trip cost | Geometric R required (1.30R headroom) | A1 takeProfitAtr | A1 −20 % | A1 +20 % | Interpretation |
|---|---|---|---|---|---|
| 9 bps (HL fees only) | 2.34 ⇒ TP ≥ 4.7 | **5.0 (current)** | 4.0 | 6.0 | 6 % margin; A1 −20 % (=4.0) drops below required floor |
| 14 bps (H2 baseline) | 2.45 ⇒ TP ≥ 4.9 | **5.0 (current)** | 4.0 | 6.0 | 2 % margin; A1 −20 % below; A1 +20 % gives 22 % margin |
| 20 bps (news slippage) | 2.60 ⇒ TP ≥ 5.2 | **5.0 (current)** | 4.0 | 6.0 | Current TP slightly below; A1 +20 % gives 15 % margin |

**Read:** the proposed `takeProfitAtr=5.0` is exactly at H2-baseline tolerance. **The fact that −20 % puts us below the floor is the whole reason the current 4.0 produces "−$8.74 average wins."** The +20 % side is where trend_follow already lives at 6.0 — and where we move BTC-PERP-INTX and BTC-USD HL trend_follow to. We don't move the *momentum* TP to 6.0 because that pushes time-exit conversion to ~50 % and momentum is a higher-frequency strategy that needs faster TP turnover.

### 3.3 Combined ±20 % stress test

If both A1 ATR floor (0.50 %) and A1 momentum TP (5.0×) move adversely by 20 % (0.40 % floor + 4.0× TP, the Coinbase-era setting), we land **on H2's verdict of today's Coinbase trade book**: structural losers at near-entry exits. So `−20 % / −20 %` is empirically the current bad state — confirming the proposal's direction. If they move favorably by 20 % (0.60 % floor + 6.0× TP), we cut trade count by ~25 % vs. proposal but lift EV/trade by ~30 %. **This is the conservative landing zone** if F4 shows the 5.0× TP isn't enough.

---

## 4. Worked example — BTC-PERP-INTX trend_follow trade

Take SPRINT-PLAN-FINAL.md §1.3 trade #2 (BTC-PERP-INTX long, trend_follow, 19:39→19:44, $1,436 notional, `−$12.35` PnL, $9.30 fees, stop_loss exit). Re-cost it through both regimes on the **same price action** (the H2 §5 methodology):

**Setup at signal time (synthesized — exact ATR not in the trade book, so use H2 §3 estimate of 30-day BTC ATR % ≈ 1.2 %):**
- Entry: hypothetically $103,500
- ATR (1m): ~$1,242 (1.2 % of price)
- `risk_per_trade`: $150 (perps, equity $10k × 0.015)

**Current params (`stopAtr=2.0`, `takeProfitAtr=4.0`, `atr_volatility_min=0.0005`):**
- Stop distance: 2.0 × $1,242 = $2,484 → stop @ $101,016 (2.40 % away)
- TP distance: 4.0 × $1,242 = $4,968 → TP @ $108,468 (4.80 % away)
- Notional cap: `min($150 / (2.0 · 0.012), 5000) = min(6,250, 5000) = $5,000` (cap binds)
- Geometric R: TP/stop = 2.0R
- ATR % = 1.2 % > `atr_volatility_min` 0.05 % → **signal passes ATR gate** (gate is essentially never binding)
- Trade fires; stop hits (price moves $2,484 against us)
- Fees: $5,000 × 0.0014 (HL re-pricing per H2 §5) = $7.00 round-trip
- **Net PnL: −$150 (1R stop) − $7 = −$157** at HL (vs. `−$12.35` realized on Coinbase at 65 bps but smaller notional)
- Per-trade fee drag in R: `$7 / $150 = 4.7 %`

**Proposed A1 params (BTC-PERP-INTX trend_follow override `stopAtr=2.5, takeProfitAtr=6.0`, `atr_volatility_min=0.005`):**
- Stop distance: 2.5 × $1,242 = $3,105 → stop @ $100,395 (3.00 % away)
- TP distance: 6.0 × $1,242 = $7,452 → TP @ $110,952 (7.20 % away)
- Notional cap: `min($150 / (2.5 · 0.012), 5000) = min(5,000, 5000) = $5,000` (still cap-bound at this size, but barely)
- Geometric R: TP/stop = 2.4R
- ATR % = 1.2 % > `atr_volatility_min` 0.005 (0.5 %) → **signal still passes ATR gate** (BTC's 30-day ATR clears the new floor comfortably)
- Trade fires; same adverse $2,484 move hits the OLD stop but the NEW stop is at $100,395 — i.e. the **new stop is $621 further away** ($3,105 vs $2,484). Under new params **trade is still ongoing at the original 19:44 exit point** rather than having been stopped out. Either: (a) recovers and hits TP (+$893 net), (b) later stops out wider (−$157 net), or (c) hits time-stop (scratch ± $20 net).

**EV delta calculation:** Using `p=0.50` baseline:
- Current params EV: `0.50 × (+$300 − $7) + 0.50 × (−$150 − $7) = +$146.5 − $78.5 = +$68 / trade` (at 2.0R TP)
- Proposed params EV: `0.50 × (+$900 − $7) + 0.50 × (−$150 − $7) = +$446.5 − $78.5 = +$368 / trade` (at 6× ATR TP sized off $150/risk)

**EV delta: +$300 / trend_follow trade on BTC-PERP-INTX** at H2 baseline. Even derating to `p=0.40`, proposal EV is `+$185 / trade` vs current `+$5 / trade` — recovers ~$180 of EV per trade for the same realized price action. This is the H2 "wider stops are pro-fee" effect in dollar terms, plus the §2.3 TP-headroom effect.

**Caveat:** the `p=0.50` assumption is unproven for HL — F4 derives empirical `p` per (strategy, symbol). If F4 shows BTC-PERP-INTX trend_follow `p < 0.30`, EV stays negative regardless of geometry and A6 should disable trend_follow on BTC-PERP-INTX entirely. **A1's proposal makes the trade survivable enough that F4 can measure `p` with statistical power**, which today's geometry doesn't allow.

---

## 5. Implementation plan for the follow-up PR

### 5.1 `atlas/config/guardrails.yaml` edits (≤30 LOC config-only diff)

| Line | Current | New |
|---|---|---|
| `:171` | `  takeProfitAtr: 4.0` | `  takeProfitAtr: 5.0` |
| `:168` | `  requireMacdConfirm: false` | `  requireMacdConfirm: true` |
| `:96` | `        takeProfitAtr: 5.0` (per_symbol.ETH-USD.trend_follow) | `        takeProfitAtr: 6.0` |
| `:108` | `        takeProfitAtr: 4.0` (per_symbol.ETH-USD.momentum) | `        takeProfitAtr: 5.0` |
| `:206` | `        takeProfitAtr: 5.0` (perps_symbols.ETH-PERP-INTX.trend_follow) | `        takeProfitAtr: 6.0` |
| `:216` | `        takeProfitAtr: 4.0` (perps_symbols.ETH-PERP-INTX.momentum) | `        takeProfitAtr: 5.0` |
| `:231` | `        stopAtr: 2.0` (perps_symbols.BTC-PERP-INTX.trend_follow) | `        stopAtr: 2.5` |
| `:232` | `        takeProfitAtr: 4.0` (perps_symbols.BTC-PERP-INTX.trend_follow) | `        takeProfitAtr: 6.0` |
| `:281` | `  atr_volatility_min: 0.0005` | `  atr_volatility_min: 0.005` |
| `:352` | `        takeProfitAtr: 5.0` (hyperliquid_symbols.ETH-USD.trend_follow) | `        takeProfitAtr: 6.0` |
| `:362` | `        takeProfitAtr: 4.0` (hyperliquid_symbols.ETH-USD.momentum) | `        takeProfitAtr: 5.0` |
| `:370` | `        stopAtr: 2.0` (hyperliquid_symbols.BTC-USD.trend_follow) | `        stopAtr: 2.5` |
| `:371` | `        takeProfitAtr: 4.0` (hyperliquid_symbols.BTC-USD.trend_follow) | `        takeProfitAtr: 6.0` |

**Total: 13 single-line value edits.** No structural YAML changes. Well under the 30 LOC budget.

### 5.2 `atlas/apps/core-node/src/strategies/signal-arbiter.ts` edit

| Line | Current | New |
|---|---|---|
| `:78` | `  minSignalStrength: 0.3,  // Require medium-strength signals (filters weak counter-signals)` | `  minSignalStrength: 0.4,  // Raised 0.3→0.4 for HL fee floor — see docs/research/2026-05-18_a1-hl-fee-aware-param-retune.md §2.6` |

**1 LOC + 1 comment line. Total PR diff: ~14 lines.**

### 5.3 What A2 inherits

- A2 owns: re-examine **all** `stopAtr` values (sprint plan §3 row A2: "stop 2.0 → keep, TP 4.0 → 5.0"). A1 already moved TP and tweaked the BTC-PERP/BTC-USD-HL trend_follow stop; A2's job is to **audit whether any of the remaining `stopAtr=2.0` values should also lift to 2.5** based on F4 empirical fee-drag data. Per H2 §3, this is a "wider stop = lower fee drag" optimization — only worth doing where the per-trade dollar fees are material vs. risk dollar.
- A2 does **NOT** need to revisit momentum `takeProfitAtr` — A1 set it at 5.0 and §3 sensitivity shows that's correct at the H2 baseline.

### 5.4 What A3 inherits

- A3 owns the **pre-trade EV gate** in `OrderManager.routeOrder` and `RiskEngine.evaluateSignal`. A1 sets the strategy-level geometry such that EV is positive in expectation; A3's EV gate is the **per-signal** check that vetoes individual trades where current ATR / current notional makes the specific instance negative-EV even with A1 params.
- A3 reads the same H2 §2 formula: `expected_PnL = p · (TP_R · risk − fees) − (1−p) · (risk + fees)`. A3 must pull `p` from `MetaFilter.getStrategyPerformance(strategy)` (per-strategy rolling WR), `TP_R` from the active strategy config (which A1 has just normalized), and `fees` from `FeeModel` (which B4 makes venue-aware).
- A3 does **NOT** touch `risk_per_trade` — that's a static portfolio knob. The EV gate is per-signal go/no-go.

### 5.5 What F4 inherits

- F4 runs the same 4-window matrix as F3 with `--commission 0.00045` (4.5 bps × 2 = 9 bps HL taker fees) and slippage 0.0005 (5 bps round-trip). A1's params are checked into `guardrails.yaml` before F4 runs so F4's backtest reads them automatically.
- F4 is the **falsification test** for A1: §6 below defines what F4 must show.

### 5.6 Test impact (no test changes expected in A1)

Per `pnpm test` baseline (548/548 passing as of 2026-05-14 per CLAUDE.md), the strategy-plugin tests use schema defaults for their config except where a test explicitly overrides. Schema defaults in `momentum-strategy.ts:142` and `trend-follow-strategy.ts:114` stay at `4.0` and `5.0` respectively — **we are changing the YAML, not the plugin schema defaults**. Tests that instantiate plugins without an explicit `takeProfitAtr` continue using the plugin's schema default; tests that load `guardrails.yaml` get the new values. Neither path should break — verify by running `pnpm test` post-change. If any test asserts an exact `takeProfit` price computed from `guardrails.yaml`, expect that single test to need a numeric update; allow up to **3 LOC of test fixture updates** in the PR if so. The `signal-arbiter.ts:78` `minSignalStrength` change does affect `signal-arbiter.test.ts` if it constructs signals with strength in `[0.30, 0.40)` and expects them to pass. Audit pre-PR; expected blast radius is 0–2 test updates.

---

## 6. Validation plan for F4 — falsifiable predicate

F4 (sprint plan §3 row F4) re-runs the F3 4-window matrix on HL fee schedule (`--commission 0.00045 --slippage 0.0005`). With A1 params in place, F4 should show the following — these are the **success criteria** that, if not met, send A1 back for revision:

### 6.1 Per-window trade count

| Window | Min trade count | Max trade count | Rationale |
|---|---|---|---|
| Each of the 4 May-11 windows | ≥ 25 | ≤ 100 | Below 25: A1 over-filtered (likely `minSignalStrength=0.4` too aggressive). Above 100: A1 under-filtered (likely `atr_volatility_min` too low or arbiter regression). Sprint plan F3 success criterion is ≥ 50 trades per run on COINBASE post-F1; at HL with stricter A1 filters we expect ~30–50 per run, but cap upside conservatively. |
| All 4 windows combined | ≥ 100 | ≤ 350 | F4 sprint plan criterion: "HL EV measurable with statistical significance (≥ 100 trades total across windows)". |

### 6.2 Profit factor target

- **Per-strategy profit factor:** `momentum ≥ 1.10`, `trend_follow ≥ 1.30`. At Coinbase fees both strategies are sub-1.0; if A1 + HL fees combined don't push at least trend_follow over 1.30, the retune didn't fix the underlying geometry problem and A2 needs to lift TPs further (or A6 disables the strategy).
- **Combined PF across both strategies:** `≥ 1.20`.

### 6.3 EV-per-trade target

- **Avg net PnL per trade (after fees and slippage):** `≥ +$8` perps / `≥ +$3` spot.
  - Per H2 §3, perps fee drag at HL is ~$7 round-trip on $5k cap-bound; we need ≥ $15 gross PnL per trade to clear `+$8 net`. At `risk_per_trade=$150`, 50 % WR, geometric R=2.5, that's `0.5 × (+$300) + 0.5 × (−$150) − $7 = +$68 net` if the strategy emits at the H2-baseline 50 % WR. So `+$8 net` represents a substantial derating; anything below means strategy WR is under 30 %.
  - Spot fee drag is ~$2 round-trip; ratio is preserved.
- **Avg net PnL per TP-exit trade:** `> 0` strictly. Today this is `−$8.74` per SPRINT-PLAN-FINAL.md §1.4. The single most important success criterion. **If TP-exits are still net-negative after A1, the proposal failed.**

### 6.4 Geometry checks

- **`atr_below_min` filter count:** Should be small (~5–15 % of total emit) on BTC/ETH/SOL tape — those symbols' 30-day ATRs (H2 §3: 1.2 % / 1.4 % / 2.2 %) are all well above the 0.5 % floor; the gate should mostly fire during low-vol micro-regimes. If `atr_below_min > 25 %` of emits, the floor is too tight; if `< 2 %`, the floor isn't doing anything and we should consider tightening to 0.0067 (the news-spike value per §3.1).
- **TP-exit vs stop-exit ratio:** Today is 4:4 (50/50). At new TP=5.0/6.0 we expect to see **TP:stop ≈ 1:2** (i.e. fewer trades reach the wider TP). That's fine — `+TP_R × p` should still be `> stop × (1−p)` in dollar terms with the new geometry. Specifically check: is `TP_count × avg_TP_PnL` strictly greater than `stop_count × avg_stop_PnL` in absolute value? **If TP_R doesn't bring in more dollars than stops take out, the geometry is still wrong.**

### 6.5 Falsifiable predicate (one-liner)

**F4 fails A1 if and only if:** combined profit factor across all 4 windows is `< 1.10`, OR avg net PnL per TP-exit trade is `≤ 0`, OR trade count across all 4 windows is outside `[100, 350]`. Any one of these three conditions invalidates the retune and forces A1 back to the drawing board. If F4 passes all three, A1 is locked and the focus moves to A2 (stop tweaks per F4 fee-drag data), A3 (pre-trade EV gate), and J1 (revisiting daily/weekly DD limits given the new expected expectancy/volatility).

---

## 7. Open questions

1. **30-day ATR % calibration.** H2 §3 used public-tape estimates (BTC 1.2 %, ETH 1.4 %, SOL 2.2 %). F4 should compute actual 30-day rolling ATR % from the `bars` table and report it alongside the simulated trade outcomes. If real ATR % differs from H2 by >25 % for any symbol, A1's `atr_volatility_min: 0.005` may need a per-symbol override.
2. **Win-rate `p` assumption.** A1's math uses `p=0.50` (engine planning baseline per SPRINT-PLAN-FINAL.md §1.4) and `p=0.40` as the conservative case. F4 will produce empirical `p` per (strategy, symbol). If empirical `p < 0.30` for any (strategy, symbol) pair, that combination should be considered for A6 regime-conditional disable.
3. **`time_stop_bars: 96` interaction.** Wider TPs increase the share of time-exits. Today's `time_stop_bars: 96` (= 96 minutes at 1m bars) may need to lift to 144 or 192 if trend_follow's "multi-day moves" thesis is to play out. **Out of A1 scope** — flag for J1 or a separate ticket. F4 telemetry should report time-exit count separately so we can decide.
4. **Maker rebates (H2 §8 Q3).** HL pays −1.5 bps to makers. A future optimization — not A1.

---

**End of A1.**
