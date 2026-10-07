# H6 — Drawdown / consecutive-loss research (empirical follow-up)

**Date:** 2026-05-29
**HEAD:** `8fea8b1` (`feat(strategies): per-symbol disable support + disable momentum on PERP-INTX`) · working tree clean · 604/604 backend tests green
**Author:** H6 research pass (Cursor)
**Status:** RESEARCH ONLY — input for **A4** (consec-loss kill 8→10) and **J1** (risk-limit revalidation). No config/code/risk changes made.
**Supersedes/extends:** `docs/research/2026-05-14_consecutive-loss-circuit-breaker.md` (the theoretical i.i.d. analysis). This pass adds the empirical streak/drawdown distributions the 2026-05-14 doc explicitly deferred to "after the first 7-day run measures actual `p`."

---

## 1. TL;DR — A4 recommendation

**Recommendation: MODIFY — do NOT blanket-loosen the live consec-loss kill 8→10 right now.** Instead:

1. **Keep the LIVE default at 8.** The empirical premise for loosening does not hold at current edge. On the faithful current-config backtest (all 5 symbols, HL 90d) the 8-kill would trip only **~3×/90d (≈1/month)**, not the "54%/200-trade-month" the 2026-05-14 i.i.d. analysis predicted at the *assumed* 50% win rate. The real blended win rate is **39.5%** — below the **0.45–0.50 floor** the 2026-05-14 doc itself set as the precondition for loosening (it said: at `p < 0.40` "don't loosen — fix the strategy"; at `0.40 ≤ p < 0.50` prefer N=12, not N=10).
2. **If uninterrupted PAPER data-collection is the actual goal** (the original A4 motivation), set `CONSECUTIVE_LOSS_LIMIT=10` (or higher) in the **paper deployment env only** — the override already exists at `trading-engine.ts:841` and is currently unset in `ecosystem.config.cjs`. Zero code/config change, and **live capital protection stays at 8**.
3. **Revisit a global 8→10** only after a real run demonstrates blended WR ≥ ~45%. At that point 8→10 is cheap (the empirical false-positive cost of staying at 8 is small) and well-supported by the 2026-05-14 i.i.d. math.

**Why the headline number matters:** loosening 8→10 buys ≈ **1 fewer halt per quarter** (3→2 trips/90d) at a cost of **+$168.56 of extra loss exposure over 90d** (5 additional losing trades, concentrated in genuinely bad streaks of length 9/10/15). That is a poor trade while the book is net-negative (combined net **-$563 / 90d**, PF **0.88**, WR **39.5%**).

**Implementation gotcha for A4 (important):** the live threshold lives **only** in code/env at `trading-engine.ts:841` (`parseInt(process.env.CONSECUTIVE_LOSS_LIMIT || '8', 10)`). Editing `guardrails.yaml` is a **no-op** for the live kill: the `circuit_breakers` zod schema (`loadGuardrails.ts:195-202`) has **no `max_consecutive_losses` field** (so the key would be stripped on load), and the only code that reads such a key — `evaluate-risk.ts:486` — is **not wired into the live engine** (see §2.4). So A4 must change the code default and/or set the env var, and update the tests in §2.5 — not just add a YAML key.

---

## 2. Current state — config + enforcement (file:line)

### 2.1 Risk limits in `atlas/config/guardrails.yaml`

| Limit | Key | Value | USD @ $10k equity |
|---|---|---:|---:|
| Daily loss stop | `risk.daily_loss_limit` (`:57`) | `-0.02` | **-$200** |
| Weekly loss stop | `risk.weekly_loss_limit` (`:58`) | `-0.05` | -$500 |
| Max drawdown | `risk.max_drawdown_limit` (`:59`) | `-0.15` | **-$1,500** |
| Max position exposure | `risk.max_position_exposure_pct` (`:60`) | `0.30` | $3,000 |
| Pre-trade EV gate | `risk.min_ev_threshold` (`:70`) | `0` | reject EV<0 |
| Rapid-loss breaker | `circuit_breakers.rapid_loss_trigger` (`:285`) | `-0.02` | -$200 in <10m |
| Account | `account.equity_usd / risk_per_trade / max_open_positions` (`:1-6`) | `10000 / 0.005 / 4` | risk unit ≈ $50/trade |
| Per-symbol (spot) | `per_symbol.*` (`:81-138`) | `max_notional 3000`, `max_daily_loss 200` | per BTC/ETH/SOL-USD |
| Per-symbol (perps) | `perps_symbols.*` (`:206-270`) | `max_notional 5000`, `max_daily_loss 300` | + `disabled_strategies: [momentum]` |

**The consecutive-loss kill threshold (expected 8) is NOT in `guardrails.yaml`.** `circuit_breakers` (`:284-290`) contains only `rapid_loss_trigger, fill_rate_collapse, adverse_selection_spike, correlation_spike, vol_spike_atr, data_gap_sec`. The threshold lives in code (§2.2).

### 2.2 The hard kill switch (the A4 target) — `risk-engine.ts`

- **Threshold / source:** `trading-engine.ts:835-844` builds `killSwitches.consecutiveLossLimit: parseInt(process.env.CONSECUTIVE_LOSS_LIMIT || '8', 10)`. The inline comment records it was **bumped 5→8 in Phase 2.7**. `ecosystem.config.cjs` does **not** set the env for either `env` (live) or `env_paper` → **both paper and live currently run at 8.**
- **How losses are counted** — `RiskEngine.handleClosedPosition` (`risk-engine.ts:355-368`), driven by `positionTracker.on('position:closed')` (`:279-281`):

```355:368:atlas/apps/core-node/src/trading/risk-engine.ts
  private handleClosedPosition(position: Position): void {
    const realized = Number(position.realizedPnL ?? 0);
    if (!Number.isFinite(realized)) {
      return;
    }
    // Consecutive losses are based on CLOSED trade outcomes (not order placement success).
    if (realized < 0) {
      this.metrics.consecutiveLosses += 1;
      this.recordSymbolLoss(position.symbol, Math.abs(realized));
    } else {
      this.metrics.consecutiveLosses = 0;
    }
  }
```

  - **GLOBAL**, not per-symbol/per-strategy: one `metrics.consecutiveLosses` counter across every closed position.
  - A win **or** breakeven resets it (`realized < 0` increments; `realized >= 0`, incl. exact 0, resets). `realizedPnL` is **net of fees** in the simulator/tracker, so a fee-induced near-scratch counts as a loss.
  - Counter also resets to 0 on day rollover (`resetDailyMetrics` `:1454-1468`) and on a previous-day or clean paper start (`loadRiskState` `:398-409`, `:431-444`).
- **Trip check** — `checkKillSwitches` (`:1159-1213`), run every 5s by `updateMetrics`/`startMetricsUpdate` (`:575-578`, `:1150`):

```1186:1194:atlas/apps/core-node/src/trading/risk-engine.ts
    // Check consecutive losses
    if (this.metrics.consecutiveLosses >= this.config.killSwitches.consecutiveLossLimit) {
      const halt = createConsecutiveLossesHalt(
        this.metrics.consecutiveLosses,
        this.config.killSwitches.consecutiveLossLimit
      );
      this.triggerKillSwitch(halt.reasonText, halt.reasonCode);
      return;
    }
```

- **What it DOES when it trips** — `triggerKillSwitch` (`:1215-1242`) sets `killSwitchActive`, calls `riskStateMachine.halt('consecutive_losses', …, daily=false)`. `trading-engine.ts:1263-1271` catches `risk:killswitch:triggered` and transitions the engine to **`halted`** (runtime stays alive; entries stop). New entries are blocked in `checkOrder` (`:756-762`, "Kill switch is active (entries disabled)"), but **reduce-only exits are still allowed** (stops/TP/trailing keep working). Positions are **not** auto-flattened.
- **Recovery is MANUAL.** `consecutive_losses` is a **non-daily** halt (`risk-state.ts:569-581`, `daily: false`), so it does **not** auto-clear on day rollover (`risk-state.ts:360-372` only resumes daily halts). `deactivateKillSwitch` (`:1475-1485`) → `riskStateMachine.resume(force)` requires **`force=true`** for a halt (`risk-state.ts:291-300`). The day rollover zeroes the *counter* but the engine stays `HALTED` until a human force-resumes. (Matches the 2026-05-13 incident: auto-halt at CONSEC_LOSS, ~45 min before the operator manually stopped — `atlas/var/tmp/monitor/final-snapshot/02_kill-switch-context.txt`.)

### 2.3 The cold-streak cooldown (distinct, softer) — `meta-filter.ts`

This is the mechanism CLAUDE.md describes as "cold-streak cooldown after 10 losses → 5 min pause." It is **separate from and looser than** the hard kill.

- **Config defaults** (`meta-filter.ts:206-216`, `DEFAULT_CONFIG`; `guardrails.yaml.meta_filter` only carries `coindesk_sentiment`, so these apply): `coldStreakEnabled: true`, `coldStreakThreshold: 10`, `coldStreakCooldownMs: 5*60*1000` (5 min), `coldStreakRecoveryWins: 1`.
- **Scope: PER-STRATEGY**, keyed by `signal.strategy` only — `filter()` → `getOrCreatePerformance(signal.strategy)` (`:377`, `:1083-1108`); counting in `recordTradeOutcome` (`:918-950`). It is **not** per-symbol. (Note: `docs/research/2026-05-19_f4-followup-perps-action.md` §8.8 describes the cooldown as "symbol-scoped" — that is imprecise; the code aggregates a strategy's losses across **all** symbols. See §6 J1 note.)
- **What it does:** on the 10th consecutive loss *for that strategy* it hard-blocks that strategy's signals (`:385-419`) and starts a 5-min cooldown (`evaluateColdStreak` `:540-571`); a single win clears it (`:934-939`). It pauses **signals**, it does not halt the engine, and it requires no manual reset.

**Hard kill (8) vs cold-streak (10):** different scope (global vs per-strategy), different severity (engine halt + manual reset vs 5-min signal pause), different threshold. Because the hard kill is global it can trip on a mixed-strategy streak well before any single strategy reaches the cold-streak's 10.

### 2.4 A second, UNWIRED consecutive-loss path (relevant to A4/J1)

There is a fully-tested but **not-yet-wired** "risk parity" layer:

- `evaluate-risk.ts` `checkConsecutiveLosses` (`:219-235`) halts when `snapshot.consecutiveLosses >= thresholds.maxConsecutiveLosses`, where the threshold comes from `buildThresholdsFromGuardrails` → `guardrails.circuit_breakers.max_consecutive_losses` (`:486`).
- `risk-controller.ts` `checkStrategyLimits` (`:371-409`) blocks **per-strategy** at `limits.maxConsecutiveLosses` with a cooldown auto-unblock.

**Neither is called in production.** A repo search for `evaluateRisk(`, `buildThresholdsFromGuardrails`, and `RiskController(` finds **only their definitions and test files** (`risk/__tests__/parity.test.ts`, `__tests__/risk-parity.test.ts`, `__tests__/risk-controller.test.ts`) — no production caller. And the key they read (`circuit_breakers.max_consecutive_losses`) does not exist in the schema (`loadGuardrails.ts:195-202`). So the live consec-loss kill is **solely** the legacy `RiskEngine` path of §2.2.

### 2.5 Where it's unit-tested (so A4 knows what to update)

| Test file:line | What it asserts | A4 impact |
|---|---|---|
| `risk-engine.test.ts:148-152` | test config sets `consecutiveLossLimit: 5` | update if asserting the default |
| `risk-engine.test.ts:322-353` | counting on closed-position P&L + **win resets** | behavior unchanged by 8→10; keep |
| `risk-system.test.ts:351-357` | `createConsecutiveLossesHalt(5,5)` → `consecutive_losses`, `daily:false` | unchanged |
| `risk-parity.test.ts:136-148, 327, 372` | parity HALT at `consecutiveLosses` vs `circuit_breakers.max_consecutive_losses: 5` | **the (unwired) path A4 would touch if it adds a YAML key** |
| `risk-controller.test.ts:208-234` | per-strategy block after N consecutive losses + reset-after-win (unwired) | only if RiskController is wired |
| `meta-filter.test.ts:86-99, 141-182` | cold-streak threshold default **10**, block/clear | **do NOT touch** for A4 (separate mechanism) |
| `funnel-residuals-bar-time.test.ts:140-207` | cold-streak fires on bar-time in backtest | unchanged |
| `backtest-trade-outcomes.test.ts:24-28` | backtest records consecutiveLosses + cold-streak | unchanged |

---

## 3. Data & method

### 3.1 Data sources used

- **Backtest result JSONs** under `atlas/var/backtest_results/` (gitignored). Each carries full per-trade rows (`product, strategy, signal.strategy, pnl, entryFee, exitFee, exitReason, timestamp, exitTimestamp`) plus a `metrics` block and `equityCurve`. `pnl` is **net of fees** (verified: `metrics.netProfit == Σ pnl`).
- **Primary dataset (faithful current config):** a single combined run I executed at HEAD `8fea8b1` — `pnpm backtest --start-date 2025-12-05 --end-date 2026-03-05 --commission 0.00045 --products BTC-USD ETH-USD SOL-USD ETH-PERP-INTX BTC-PERP-INTX`. Output: `backtest_2026-05-29T16-24-25.json` (gitignored). This is the only dataset that reproduces the live global stream: all 5 symbols at once, `max_open_positions=4`, the signal arbiter, and the per-strategy cold-streak aggregating across symbols. (Non-destructive: backtest only, paper data, no live orders.)
- **Sensitivity bound:** the two post-disable single-venue runs from 2026-05-19 (`…16-16-08` perps, `…16-18-24` spot), merged into one chronological stream — represents a hypothetical where venues traded independently (no shared cold-streak/position limits). It is an **upper bound** on streaks.
- **Live datapoint:** `atlas/var/tmp/monitor/final-snapshot/02_kill-switch-context.txt` (2026-05-13 paper run: 8 trades, 0 wins → CONSEC_LOSS auto-halt).
- **Reproducible scripts (gitignored):** `atlas/var/backtest_results/_session_2026-05-29/{inspect.mjs,streaks.mjs}`.

### 3.2 Method

The hard kill counts **global** consecutive losses on position **close**, so I ordered every trade by `exitTimestamp`, walked maximal loss-runs (`loss = pnl < 0`, mirroring `realized < 0`), and computed: the loss-run length histogram, counts of runs reaching each threshold k∈{5..12}, trip counts for N∈{8,10,12}, and the **8→10 marginal exposure** (the extra losing trades at run positions 9–10 that N=10 permits before tripping, summed in $). Per-strategy and per-symbol breakdowns use the same walk on filtered sub-streams.

### 3.3 Limitations (stated plainly)

- **Live Supabase `trades`/`positions` NOT queried.** Per AGENTS.md the environment cannot resolve the Supabase host, and this is read-only research — so all numbers are from **backtests on Coinbase candles with HL fees simulated**, not live fills. Live streak behavior may differ (real slippage, funding, partial fills).
- **Backtests do not enforce the hard kill or the DD kill.** Confirmed: `backtest-engine.ts` has no `killSwitch`/`consecutiveLosses` enforcement. This is *desirable* here — it yields the **uncensored** streak distribution the kill would act on. (The backtest *does* apply the per-strategy cold-streak via bar-time, so streaks are already post-cold-streak.)
- **The faithful combined run under-trades the back ~10 weeks.** Funnel diagnostics show `trend_follow` last admitted at bar 3634 (2025-12-07) — its cold-streak aggregates losses across 4 symbols and suppresses it early. So the combined run likely **under**-states late-window streaks, while the 2-run merge **over**-states them. Truth is bracketed; I report both.
- **90-day, two-venue, momentum-on-perps-disabled window only.** Not a multi-regime / multi-year sample.

---

## 4. Findings — streak & drawdown distributions

### 4.1 Global loss-streak distribution (current config)

**Primary — faithful single combined 5-symbol run** (276 trades, WR 39.49%, 167 losses):

| Run length k | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | …15 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| # loss-runs of exactly k | 17 | 11 | 7 | 5 | 4 | 2 | 3 | 0 | 1 | 1 | 0 | 0 | 1 |
| # runs reaching ≥ k | — | — | — | — | 12 | 8 | 6 | **3** | **3** | **2** | 1 | 1 | — |

**Sensitivity upper bound — 2-run merge** (611 trades, WR 31.1%, 421 losses): runs reaching ≥8 = **14**, ≥9 = 13, ≥10 = **10**, ≥12 = 6.

So over a 90-day window, the number of streaks that reach the 8-kill is **between ~3 (faithful) and ~14 (independent-venue upper bound)** — most plausibly near the low end, because in the live engine all symbols share the cold-streak and position budget.

### 4.2 8-vs-10 trip frequency and exposure delta

| Metric (90-day window) | Faithful combined run | 2-run merge (upper bound) |
|---|--:|--:|
| Trips at **N=8** | **3** | 14 |
| Trips at **N=10** | **2** | 10 |
| Trips at N=12 | 1 | 6 |
| Δ trips (8→10) | **−1** (≈1 fewer halt/quarter) | −4 |
| **Extra loss exposure 8→10** | **+$168.56** (5 trades) | +$470.75 (23 trades) |
| Longest observed loss run | **15** ($326.79) | 14 ($263.08) |

The +$168.56 in the faithful run is concentrated in three streaks (lengths 9, 10, 15). Loosening to 10 mostly just lets the long bleeds (esp. the 15-run) run two trades longer before the net catches them.

**Comparison to the 2026-05-14 i.i.d. prediction:** that doc assumed `p=0.50` and predicted N=8 trips ~54% of a 200-trade month. Empirically, at the realized blended WR (39.5% faithful / 31% merge), the trip count is **higher per-trade** than the 50% baseline but **lower in absolute terms** than the headline fear (≈3/90d faithful). The 39.5% faithful rate (~3 trips per 276 trades ≈ 1 per 92 trades) is broadly consistent with the doc's own `p=0.40` row ("1 trip per ~60 trades"), confirming the math — and confirming we are operating in the doc's **"weak / don't-loosen-to-10"** regime, not its 50% baseline.

### 4.3 Drawdown — and whether the kill caps it

| Book (current config, HL 90d) | maxDD | net | PF | source |
|---|--:|--:|--:|---|
| **Combined (live-equivalent)** | **11.56%** | -$563 | 0.88 | `…16-24-25.json` |
| Spot only (BTC/ETH/SOL-USD) | 10.86% | -$521 | 0.88 | `…16-18-24.json` |
| Perps only (trend_follow) | **24.25%** | -$2,359 | 0.44 | `…16-16-08.json` |
| Perps only WITH momentum (pre-disable, historical) | **58.77%** | -$5,871 | 0.37 | `…19-09-37.json` (F4 baseline) |

- The **combined book stays under the 15% portfolio DD limit (11.56%)** — but only because the per-strategy cold-streak throttles perps `trend_follow` early (perps trade just 29 of 276 trades in the combined run). The **standalone perps book breaches 15% (24.25%)**, and pre-disable it was a catastrophic **58.77%**.
- **Does the consec-loss kill cap drawdown? Mostly no — the daily stop does.** With empirical **avg loss $28.58**, a pure 8-loss streak ≈ **$229** and a 10-loss streak ≈ **$286**, both **above the $200 daily-loss stop**. So intraday the **daily $200 stop trips before either consec threshold**; the consec-loss kill is effectively a **multi-day** circuit-breaker (it only bites when losses are spread across days so the daily stop resets between them). This is the single most important reframing for A4: at the current loss size, 8 vs 10 changes little intraday because the daily stop already binds.

### 4.4 By strategy and venue (current config, combined run)

| Sub-stream | Trades | WR | Net | Longest loss run | Runs ≥8 |
|---|--:|--:|--:|--:|--:|
| momentum (spot only now) | 101 | **40.6%** | **+$133** | 10 | 1 |
| trend_follow (all symbols) | 175 | 38.9% | **-$697** | 13 | 3 |
| SOL-USD | 76 | **47.4%** | **+$262** | 6 | 0 |
| BTC-USD | 85 | 36.5% | -$281 | 11 | 1 |
| ETH-USD | 86 | 36.1% | -$549 | 7 | 0 |
| ETH-PERP-INTX | 18 | 38.9% | +$27 | 6 | 0 |
| BTC-PERP-INTX | 11 | 36.4% | -$22 | 4 | 0 |

- **Every streak that reaches the kill threshold is a `trend_follow` or cross-symbol cluster.** `trend_follow` (29–39% WR, 12–16-loss runs in the standalone data) is now the dominant bleeder since momentum-on-perps was disabled in `8fea8b1`.
- **momentum (spot) is net-positive (+$133, 40.6% WR)** and **SOL-USD is the bright spot (+$262, 47.4% WR)** — consistent with the F4 follow-up's SOL outlier. These books never reach the kill on their own.
- **Venue:** in the live-equivalent combined run, perps barely trades (cold-streak suppression) and is ~break-even; the loss is a spot-`trend_follow` / cross-symbol phenomenon, not a perps phenomenon, under current config.

---

## 5. So should A4 proceed? (decision logic)

Applying the 2026-05-14 doc's **own** conditional rule to the empirical WR:

| 2026-05-14 rule | Empirical reading (2026-05-29) | Verdict |
|---|---|---|
| `p ≥ 0.50` → N=10 is right | blended 39.5% (faithful), 31% (merge) — **not met** | — |
| `0.40 ≤ p < 0.50` → prefer **N=12**, not 10 | spot 39.8%, momentum 40.6% — borderline | leans *don't* 10 |
| `p < 0.40` → **don't loosen, fix the strategy** | perps `trend_follow` 25–29%, ETH-USD 36% | **fix strategy** |

Combined with §4.3 (the daily $200 stop already binds intraday at current loss size) and §4.2 (8→10 buys ~1 fewer halt/quarter for +$169), the disciplined call is **MODIFY/HOLD** as stated in §1. The original A4 premise — "8 trips on ordinary variance and interrupts data-collection" — is a **50%-WR-era** argument; at today's edge the 8-kill trips ~3×/90d in the faithful backtest and is mostly catching real low-edge clusters. The 2026-05-13 "interruption" was a **0%-WR degenerate day**, exactly what the kill *should* catch.

If the team still wants looser data-collection runs immediately, the **paper-env override** (§1 item 2) delivers that with zero risk to live.

---

## 6. J1 notes — other risk limits worth revalidating

1. **`max_drawdown_limit: 0.15` is mis-calibrated per-venue.** It holds for the combined book (11.56%) only because perps is incidentally throttled; the standalone perps book is 24.25% (and was 58.77% pre-disable). **Recommend J1 split spot vs perps DD limits** (spot ~10–12%, perps tighter) rather than one portfolio number — same conclusion the F4 follow-up §5.2/§8.10 reached, now confirmed on current config.
2. **Daily stop vs consec-kill overlap.** With avg loss $28.58, `daily_loss_limit -$200` ≈ a **7-loss** day, so it trips *before* the 8-consec-kill intraday. The two limits are near-coincident; J1 should decide which is the intended intraday primary and treat consec-loss explicitly as the **multi-day** net (and possibly switch consec-loss to a $-magnitude or R-based breaker, as the 2026-05-14 doc §8 open-question #2 suggested). The 2026-05-14 doc's "10 losses × ~$12 = ~$120 < $200" claim is **stale** — real avg loss is ~$20–29, so 10 losses ≈ $206–286, **over** the daily limit.
3. **Cold-streak scope is per-strategy and aggregates across all symbols.** A `trend_follow` cold streak driven by ETH-USD/perps **also pauses `trend_follow` on the profitable SOL-USD** (`meta-filter.ts:377`). This both (a) protects against perp bleed (good, incidental) and (b) suppresses a profitable book (bad). J1/A6 should decide whether cold-streak should be per-(strategy,symbol) instead of per-strategy.
4. **Half-built "risk parity" layer (`evaluate-risk.ts` + `risk-controller.ts`) is unwired and reads a non-existent guardrails key** (`circuit_breakers.max_consecutive_losses`, absent from the schema). This is latent drift: if Step 5/6 wires it in, the consec-loss threshold source silently changes. J1 should either wire it (and add the schema key + default) or mark it explicitly deferred, and ensure A4's chosen threshold lives in exactly one place.
5. **`perps.maker_fee/taker_fee` (`:200-201`) and `hyperliquid.maker_fee/taker_fee` (`:380-381`) are dead/deprecated** (superseded by `fees.*`) — cosmetic, but J1's audit should confirm they're truly unread before relying on `fees.*` as the single source (the B4 audit already flagged these).
6. **DD kill uses static-equity, not high-water-mark.** `enforceLossGuardrails` (`:1072-1080`) trips when equity is $1,500 below the **$10k start**, whereas `metrics.maxDrawdown` (`:1110-1118`) is measured from the intraday **high**. Two DD definitions coexist; J1 should pick one for the enforced limit.

---

## 7. Open questions & exact next steps to close them

1. **Biggest gap: no live streak data.** The faithful backtest under-trades the back 10 weeks (cold-streak suppression of `trend_follow`). **Next step:** capture the global consecutive-loss histogram from the live/paper `trades` table once reachable:
   ```sql
   -- order by close, walk realized_pnl < 0 runs (mirrors RiskEngine global counter)
   select id, symbol, strategy, realized_pnl, closed_at
   from trades where status = 'closed' order by closed_at;
   ```
   (Supabase was unreachable this pass — do this from an environment with DB connectivity, or via the Supabase MCP `execute_sql`.)
2. **Confirm the faithful-vs-merge bracket.** The combined run's early `trend_follow` shutdown may be the funnel-latch family resurfacing under cross-symbol cold-streak aggregation. **Next step:** re-run the combined backtest with `coldStreakThreshold` raised (e.g. 20) to see the uncensored global streaks, and/or instrument the per-strategy cold-streak by symbol. Command is identical to §3.1 with a meta-filter override.
3. **A4 gate.** Re-evaluate 8→10 after a run shows blended WR ≥ ~45%. Until then, if data-collection interruptions are the pain, set `CONSECUTIVE_LOSS_LIMIT=10` in `ecosystem.config.cjs` `env_paper` only.
4. **Feed A6.** The streaks that reach the kill are `trend_follow` clusters at 29–39% WR; A6 regime-gating (or a `trend_follow`-on-perps disable mirroring the momentum decision) is the higher-leverage fix than loosening the breaker.

---

## 8. Artifacts (all gitignored under `atlas/var/`)

- Faithful combined run: `backtest_results/backtest_2026-05-29T16-24-25.json` + `report_2026-05-29T16-24-25.txt` + stdout `_session_2026-05-29/run_combined_5sym_hl_90d.txt`
- Analysis scripts: `_session_2026-05-29/inspect.mjs`, `_session_2026-05-29/streaks.mjs` (reproduce: `node _session_2026-05-29/streaks.mjs` from `atlas/var/backtest_results/`)
- Single-venue current-config runs: `backtest_2026-05-19T16-16-08.json` (perps), `…16-18-24.json` (spot)
- Live datapoint: `var/tmp/monitor/final-snapshot/02_kill-switch-context.txt`

---

*End of H6 (2026-05-29). Research only — no risk limits, config, or strategy code changed. Reproducible from the artifacts above.*
