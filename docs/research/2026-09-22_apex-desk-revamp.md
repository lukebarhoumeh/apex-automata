> Repo copy of the desk deliverable `artifacts/apex-desk-revamp-2026-09-22.md` (identical content below). READ-ONLY research package: no code, config, fixture or strategy change accompanies this document; no GO is granted by it.

# APEX DESK REVAMP — post-soak autopsy, paper candidates, venue map, fee reality, 48h / 2-week plan

**Date:** 2026-09-22 · **Repo:** `main @ 44e66d4` · **Requested by:** Luke (mandate ~4pm CT, 2026-09-22) · **Audience:** TM + Algo + Risk + Eng
**Authority:** READ-ONLY research package. No orders, no API keys, no `CONFIRM_LIVE`, no live unlock, no chat-agent order routing. Nothing under `atlas/config/**`, `strategies/**`, `trading/**` or `fixtures/**` was touched. This memo makes no strategy a GO; every "candidate" below is a *paper* candidate gated by the bars written next to it.
**Trigger:** ~20 h paper soak ending with session `sess_1790091200890_9q7egp` (session id decodes to 2026-09-22T15:33:20Z, i.e. the soak spanned at least one engine restart): ≈ −$94 on $10,000 paper equity, `trend_follow`-only book (`disabled_strategies: [vwap_mr, breakout, momentum]`), choppy tape, stopped by the consecutive-loss kill at 8. Session already killed by TM.
**Evidence base:** repo code + config at `44e66d4`; `docs/research/*` (2026-05 → 2026-09-22); `PHASE3_BACKTEST_VERDICT.md`; public Coinbase / CDE / CFTC / Kraken documents fetched 2026-09-22 (Appendix B). Live Supabase was **not** queried (Cloud Agent VM cannot reach it); per-fill soak numbers are therefore stated as ranges with explicit assumptions and flagged for TM to pull from the `fills` / `orders` tables (§6, 48h item 1).

---

## 0. Executive summary (read this if nothing else)

1. **The soak did not fail on plumbing. It failed on edge × regime, exactly as the desk's own research predicted.** The Tier-A P0 fixes of 2026-09-21 (#67–#74: kill-switch reason code, router verdict stamping, fill→position sync, session-scoped blotters, restamp on restart) held. The kill fired with the right reason at the configured threshold (`CONSECUTIVE_LOSS_LIMIT` default 8, `trading-engine.ts:1013`). What it stopped was a strategy that has **no measurable pre-fee edge on 15m Coinbase spot** (audit §2.1: −9.4 to +1.7 bps/trade, t ≈ 0) and a stable **PF 0.78–0.80 in `weak_trend`**, the one regime it actually trades (A6 §4.1). In an ADX-20–40 chop the plugin's `ranging/choppy` refusal does not fire, so it keeps trading its worst cell. An 8-loss streak at WR 25–35 % has a 26–39 % chance inside 20 trades and 51–68 % inside 40 (§1.5). Twenty hours of loss followed by a kill is the *modal* outcome of that book, not an incident.
2. **Fee math is not a detail; it is the whole game at this account's tier.** Live tier observed 2026-09-10: **Intro 1 = 60 bps maker / 120 bps taker** at $0 30-day volume (`cb:preflight`). A 15m trade with a 5×ATR target (ATR ≈ 0.5 %) needs **WR ≈ 97 %** to break even at 240 bps round-trip taker, 65 % at maker-maker 120 bps, 55 % even at the $10K+ tier's 80 bps (§4). The paper book charges 25/40 (`PAPER-FeeModel-SPOT-25-40`), so the −$94 understates the fee drag the same trades would have paid live by roughly 3× (§1.4). Nothing sub-15m is viable at any Coinbase spot tier a < $50K account can reach; 1H is marginal only at zero-fee PF ≥ 2.25; 4H/1D are the only frequencies where fees are < 20 % of the target (§4).
3. **The one rule in the repo that clears the desk's pooled bar is a daily rule, not a 15m one.** Claude's S3 daily Donchian (in20/out10, long-only, next-open fills) was independently replicated on 2026-09-22 (`docs/research/2026-09-22_s3-donchian-breakout-replication.md`): arithmetic verified to the decimal; Coinbase 6-product pooled under the desk fee book **n = 298, +11.12 %, PF 3.08, month-clustered CI [+4.26 %, +19.60 %] → PASS**; **recency FAIL** (2025-03 → 2026-09 half ≈ +0.3 %, CI includes 0); **per-product 1/6**. Verdict there: **HOLD — paper candidate only, with conditions**. It is the #1 paper candidate here for the same reason it is not a live candidate: it is a bull-regime trend premium with a flat last 18 months, and paper is the only honest way to find out whether 2025–26 is the new normal. Median hold ~14 days ⇒ round-trip fee 1.9 % on a ~+11 % mean trade; fee sensitivity is second-order for the first time in this project.
4. **Venue reality has moved under the repo since it was written.** (a) INTX perps endpoints were **retired 2026-09-09** (hard cutover to the Deribit-powered gateway `drb.coinbase.com`, non-US only) — `CoinbasePerpsAdapter` and every `*-PERP-INTX` symbol are now legacy code with no live counterpart. (b) CDE announced the **retirement of the weekly Friday 17:00–18:00 ET break** (notice 26-25 → 26-33: final production Friday window Fri 2026-09-11 16:00–16:50 CT, then TRUE_24X7 for all crypto futures + gold + silver; 26-33.1 revised dates "to Oct 2026") — `trading/cfm/cde-hours.ts` and `guardrails.cfm.hours_gap` encode a break that may no longer exist; the guard fails safe (it only stops CFM entries 30 min early on Fridays) but the venue fact must be re-verified before any CFM paper line is graded. (c) Coinbase now offers **US equities** (Coinbase Capital Markets, Apex clearing, zero commission, API-tradable via `product_type=EQUITY`) and CDE lists **equity-index perp-style futures** (AI10 / China10 / Defense10 / Tech100 since 2026-06, **US500 since 2026-08-17**) and **Mag7+Crypto** quarterly index futures — all real, all with traps (§3).
5. **CFM (Coinbase Financial Markets, the US FCM) is the only derivatives venue open to us**, and the repo already carries the paper infra for it (card SH-QMAKER-CFM-PAPER-v0, #70). Two hard facts bound what a CFM line can be: (i) **US futures must live in the Primary/default portfolio** — the "isolated bot portfolio" pattern is not available for futures, so a futures-capable key sees the whole Primary spot balance (§3.2); (ii) at the desk-cited futures fee (9.5/10 bps commission + $0.10/contract exchange floor, reconciled to Luke's 10-contract preview at ~11.5 bps one-way) a **BIP round trip costs ≈ 21–22 bps while one tick is 0.58 bps** ⇒ a spread-capture "Q-maker" needs ~37–39 ticks of edge per round trip. Pure market-making on BIP at this fee tier is structurally negative; the CFM infra is worth keeping for **directional, hours-to-days** holding periods, not for quoting (§2.2, §4.3).
6. **Ranked paper candidates for the next two weeks:** #1 daily Donchian basket plugin (new `donchian_daily` plugin, spot, long-only, close-evaluated exits, Book A fees, pre-registered basket); #2 SH-QMAKER-CFM-PAPER-v0 *re-scoped* to a 48 h read-only quote-capture on BIP + venue-fact re-verification, with an explicit spread go/no-go; #3 regime sleeve switcher as a **shadow (log-only) sleeve**, using the A6 gate infra that already exists disabled, on a daily ADX classifier — not on 15m. Go/no-go bars in §2.
7. **Do not this week:** re-enable 15m breakout/momentum (killed on evidence, twice); route orders from a chat agent (no pre-registration, non-reproducible, and the control plane is the last thing that should be widened); migrate to AWS (zero P&L impact; the Docker image already exists; host is a P1 ops item after Stage 1); flip A6 on in paper as "the fix" (it silences TF to ~26 trades/yr at zf PF 1.18 — E3 HOLD); retune TF on the holdout; fund Intro-1 spot (§5).
8. **Live stays locked by construction:** `LIVE_STAGE0_COMPLETE = false` (code constant, `live-stage0-gate.ts`), `CONFIRM_LIVE !== 'YES'` refusal (`server.ts:1300`), `COINBASE_API_VERSION=advanced` + credentials. Nothing in this memo touches any of the three.

---

## 1. Post-soak autopsy — plumbing vs edge × regime

### 1.1 What actually ran (config SoT at `44e66d4`)

| Knob | Value | Where | Consequence for the soak |
|---|---|---|---|
| Active strategies | `trend_follow` only | `guardrails.yaml disabled_strategies: [vwap_mr, breakout, momentum]` (LIST_PIN, `pnpm check:config`) | Single-strategy book ⇒ no cross-strategy cold-streak cross-talk; the whole P&L is TF's |
| TF regime gate | `strong_trend` optimal ×1.0 · `weak_trend` compatible ×0.7 · `ranging` / `choppy` **incompatible (refuse)** | `trend-follow-strategy.ts:166-194` | Refuses ADX < 20 only; **ADX 20–40 chop is `weak_trend` and is traded** |
| Regime classifier | `adx_primary`, ADX(14) on the 15m series; ≥ 40 strong, ≥ 20 weak, < 20 ranging; `choppy` never emitted | `regime-detector.ts:117-130, 381-390` | "Chop" as a trader sees it (whipsaw, ADX 20–35) is classified `weak_trend` |
| A6 regime-conditional gate (block TF in `weak_trend`) | `regime_gates.enabled: false` | `guardrails.yaml` | Off ⇒ TF traded its PF 0.78–0.80 cell all night |
| Entry geometry | EMA 12/15 cross on the cross bar only (`crossoverLookback 0`), stop 2.5 ATR, TP 6.0 ATR (per-symbol pins) | plugin + `per_symbol.*.strategy_overrides.trend_follow` | Realized payoff on REAL 15m data ≈ 1.35–2.2, stop-heavy (E3 §1.3, E5 §4) |
| Fees charged in paper | spot 25 / 40 bps (`PAPER-FeeModel-SPOT-25-40`) | `guardrails.yaml fees.coinbase.spot` | Live tier is 60 / 120 ⇒ paper fee drag understated ~3× on taker fills |
| Execution | `marketable_limit`, +2 bps offset | `guardrails.yaml execution` | Crosses the spread ⇒ taker on both legs |
| Kill switches | consecutive losses **8** (`CONSECUTIVE_LOSS_LIMIT`, default 8); daily loss −2 % (= −$200 on $10K); DD −15 % | `trading-engine.ts:1013`, `guardrails.yaml risk` | The 8-streak fired first; −$94 never reached the daily limit |
| Meta-filter cold streak | threshold 10, in-memory, reset only by a recorded win | `meta-filter.ts:209-210, 545` | Deadlock documented in E5 §5; a restart clears it silently |
| Cooldown | `trade_cooldown_min: 15` | `guardrails.yaml strategy` | One 15m bar |

### 1.2 Plumbing verdict — behaved; residual defects are not P&L drivers

What the 2026-09-21 Tier-A fixes were for, and what the soak showed:

| Fix (PR) | What it guarantees | Soak evidence |
|---|---|---|
| #67 kill switch `reasonCode` | Halt carries `RiskHaltReasonCode` instead of `unknown` | The kill was attributable ("consec 8") — the reason code path worked |
| #68 signal→order routing | `signals.routed_exchange` stamped, router verdict persisted, cold-start EV gate unblocked | Orders were produced from TF signals; the funnel is auditable (`signal-route.ts`) |
| #69 / #74 fill→position sync, restamp on restart | Paper fills upsert positions on `id`; hydrated open positions restamped to the new `session_id` | The session id (15:33Z) vs a ~20 h soak implies at least one engine restart mid-soak; whether hydrated positions restamped cleanly is the first thing the archive query (§6.1 item 1) should confirm |
| #71–#73 session-scoped blotters, FE honesty | UI reads the ACTIVE session only | The −$94 is the session's number, not a cross-session artefact |

Residual plumbing items — **documented, none of them changes the sign of the soak**:

1. **MetaFilter cold-streak deadlock** (E5 §5): `consecutiveLosses >= 10` blocks the strategy until a *win* is recorded, but a blocked strategy cannot win ⇒ permanent block until restart; a restart clears in-memory state and hides it. On a TF-only book with WR 24–35 % this trips in weeks in backtests. In the soak the RiskEngine kill at 8 fires *before* the meta-filter's 10, so the deadlock was not the stopping mechanism, but any longer paper line will hit it. Eng decision needed: intended semantics (time-based cooldown) vs shipped.
2. **`atr_vol` filter is blind to `trend_follow`** (E3 §5, E5 §8): plugin stamps `metadata.atr`; filter reads `metadata.indicators.atr` ⇒ the H2 fee-floor filter (`atr_volatility_min 0.005`) never acts on TF. 40–55 % of TF entries on REAL 15m data had ATR% < 0.5 %, i.e. sub-fee-floor trades were admitted. Parity holds (backtest and live both blind), which is why it never showed up as a backtest/live divergence.
3. **Live trail ≠ harness trail** (E5 §0 G3): `PositionMonitor` trails at HWM × (1 − `stop_trail_atr` × 0.01); harness at HWM − `stop_trail_atr` × ATR. Not exercised in the soak (trail is off in paper by default) but must be settled before any exit redesign.
4. **`BacktestEngine.computeStopOvershoot` has no floor at the bar low** (S3 §8) — cosmetic for 15m, material for daily flash-crash bars.
5. **Venue-fact drift (new, this memo):** INTX endpoints retired 2026-09-09 (`CoinbasePerpsAdapter`, `rest-client.getPerpsProducts`, `*-PERP-INTX` symbols are dead code for live; harmless in paper because perps candles are mirrored spot candles); CDE Friday break retirement (`cde-hours.ts`); the `BIP-20DEC30-CDE` `GET /products/{id}` HTTP 400 noted in `guardrails.yaml` (the id is still Coinbase's live id per its own product page — the 400 is a client/endpoint issue, not a stale symbol).

None of these produced the −$94. They are Eng hygiene for the *next* paper line.

### 1.3 Edge × regime verdict — TF on 15m spot has no edge to protect

The repo has measured this four separate ways on REAL Coinbase candles; they agree.

| Evidence | Window / data | Finding |
|---|---|---|
| Live-readiness audit §2.1 (2026-09-10) | Spot BTC/ETH/SOL, 90d n=246 · 12m n=544, fees 4.5 bps | Pre-fee net +1.7 bps/trade (t +0.17) and −9.4 bps/trade (t −1.17). **Signal edge indistinguishable from zero before any fee.** Every real-data spot run with n ≥ 90 has PF 0.70–0.88 at 4.5 bps |
| A6 regime funnel (2026-05-29) | Spot 90d + 12m | `trend_follow × weak_trend`: PF **0.78** (n=143) and **0.80** (n=405) — the bleed is *stable across windows*. `strong_trend`: PF 1.41 but n=16 in 12 months (~4 % of TF trades) |
| E3 strong-trend screen (2026-09-11) | 15m REAL holdout 2025-03 → 2026-03, A6 ON, TF only | n=26/yr, **zero-fee PF 1.18** vs the 15m floor 5.8; WR 34.6 %, payoff 2.22, exits 62 % stop / 35 % TP; `strong_trend` = 3.1 % of TF candidate flow. **HOLD / SCREEN FAIL** |
| E5 exit diagnostics (2026-09-11) | Same holdout, latch-off sensitivity | Full-year TF-only zf PF **0.83** (n=1,039) with signal-geometry exits, **0.47** with the shipped 1×ATR trail; 97–100 % of entries `weak_trend` |
| Phase 3 verdict (2026-03) | 15m, 12 months | TF ETH positive only at ≤ 0.05–0.10 % fees (+$1,024 at HL 4.5 bps) and does not transfer to BTC |

Reading for the soak: a `trend_follow`-only book in an ADX-20–40 tape *is* the `weak_trend` cell. The plugin's refusal list (`ranging`, `choppy`) is correct for what it names and irrelevant for what happened — `choppy` is never emitted in `adx_primary`, and ADX rarely drops below 20 on 15m BTC/ETH for long. A6 would have blocked those entries (2,097 of 2,164 candidates in the E3 holdout) and left ~26 trades/yr with zf PF 1.18 — a smaller loss, not a profit. **There is no configuration of this plugin on 15m Coinbase spot that the desk's own bars accept.** That is the autopsy.

### 1.4 Fee book: what the −$94 would have been at the account's tier

The soak charged `PAPER-FeeModel-SPOT-25-40`. The account's live tier (preflight 2026-09-10) is Intro 1 = 60/120; the desk's live cite is `SPOT-INTRO-50-90` (comment block in `guardrails.yaml`, cite rule 2026-09-21). Note the discrepancy: 50/90 is not a published Coinbase tier (Intro 1 = 60/120 < $1K, Intro 2 = 35/75 ≥ $1K, Advanced 1 = 25/40 ≥ $10K; Appendix B-1); the preflight-observed 60/120 is the binding number until `/transaction_summary` says otherwise. Books are never averaged, per the desk rule.

Fee drag per round trip at the audit's typical notional (~$2,900/trade on $10K equity, audit §2.1), with `marketable_limit` ⇒ taker both legs:

| Trades in soak (assumption) | Paper book 40 bps taker (charged) | Intro 1 taker 120 bps | Intro 1 maker-maker 60 bps (best case, post-only both legs) |
|---|---|---|---|
| 8 | $186 | $557 | $278 |
| 10 | $232 | $696 | $348 |
| 15 | $348 | $1,044 | $522 |

TM action (48 h): pull `count(*)`, Σ`fee`, Σ`realized_pnl` for `session_id = 'sess_1790091200890_9q7egp'` (and the earlier session(s) of the same soak) from `fills` / `orders` and replace the row above with the real n. The qualitative point does not depend on it: **live, the same 20 hours would have cost 2.5–3× the fees the paper book showed**, and the pre-fee P&L was already negative.

### 1.5 Why "kill consec 8" in 20 h is the expected stopping time

P(at least one run of ≥ 8 consecutive losses within n trades), i.i.d. approximation (regime clustering makes the real numbers *higher* — H6 §6):

| WR | q⁸ per trade | n = 12 | n = 20 | n = 30 | n = 40 | n = 60 |
|---|---|---|---|---|---|---|
| 25 % (E5 15m TF-only realized) | 10.0 % | 20 % | 39 % | 56 % | 68 % | 84 % |
| 30 % | 5.8 % | 13 % | 26 % | 40 % | 51 % | 68 % |
| 35 % (E3 holdout) | 3.2 % | 8 % | 16 % | 26 % | 35 % | 49 % |
| 40 % | 1.7 % | 4 % | 10 % | 16 % | 22 % | 32 % |
| 50 % (planning baseline, H6) | 0.4 % | 1 % | 3 % | 5 % | 7 % | 10 % |

At the WR this book actually realizes (25–35 %), a kill within the first few dozen trades is a coin flip or better. The breaker is doing its job (H6 §4: "the kill caught a real signal of degradation"). Loosening it to 10 (H6's A4 recommendation) is only defensible for a book with WR ≥ 50 %; for this one it would have added 2–4 more losses. **Do not touch the breaker to make TF survive longer.**

### 1.6 The counter-example that matters: S3 daily Donchian (HOLD)

Replication note `docs/research/2026-09-22_s3-donchian-breakout-replication.md` (repo `main @ 2d1bbe4`, 2026-09-22):

- Rule: long-only, daily UTC bars, enter next open after a close above the prior 20-day closing high, exit next open after a close below the prior 10-day closing low; no stop, no trail; one position per product.
- **Arithmetic: PASS** — Claude's 12-coin Bitstamp headline (n=556, +7.35 %, PF 2.14, CI [+1.19, +14.57]) reproduced to the decimal by an independent port.
- **Desk venue, desk book (Book A = SPOT-INTRO-50-90 + 5 bps slip):** 6 Coinbase products, n=298, **+11.12 % mean, −3.11 % median, win 41 %, PF 3.08, month-clustered CI [+4.26 %, +19.60 %]**; from-2018 (ex-2017) +7.13 %, PF 2.26, CI [+1.02 %, +13.88 %]. **Pooled bar PASS** in every book incl. Intro-1 120 bps sensitivity.
- **Recency FAIL:** last-3y CI [−0.91 %, +22.17 %]; 2025-03 → 2026-09 half +0.27 %; 2025 +0.50 %; 2026 YTD −2.56 %. Five profitable years are bull years; the two most recent are flat/negative.
- **Per product 1/6** (BTC only, marginal); no product reaches n ≥ 100.
- **Fee sensitivity is finally second-order:** median hold 13–15 days; round trip 1.9 % (Book A) on a +11 % mean / −3 % median trade; pooled gross +13.26 % → Book A +11.12 % → Intro-1 +10.45 %.
- **Stops hurt:** a 15 % venue-side stop lowers PF (3.08 → 2.48) and exposes the Coinbase flash-crash tail (ETH 2017-06-21 low $0.10 → −99.8 % on a stop-market). Close-evaluated exits only.
- Verdict there: **HOLD — eligible as a paper candidate only under conditions** (whole pre-specified basket, close-evaluated exits, pre-registered window + bar + fee book before start, expectation ~6–8 trades/yr/product, paper's job is drift detection). Explicit engineering note: `disabled_strategies: [breakout]` is the 15m ATR/volume plugin (Phase 3 KILL); the daily Donchian is a *different* strategy needing its own plugin, EV-gate wiring and guardrails entry.

**Autopsy conclusion.** Plumbing: fixed and behaving. Edge: absent on 15m spot at any reachable tier. Regime: 15m trend-following in `weak_trend` is the loss engine, and the classifier calls almost everything `weak_trend`. The desk has one rule with a pooled pass, and it trades ~monthly, not ~hourly. The revamp is a frequency change, not a parameter change.

---

## 2. Ranked paper candidates — next two weeks — with go/no-go bars

Ranking criterion: (evidence already in hand) × (fee-viability at the account's real tier) × (infra distance to a truthful paper line) × (what the paper line can *prove* in 14 days). Nothing here is a live candidate; "GO" below means "paper line may start / continue", never `CONFIRM_LIVE`.

### 2.1 #1 — Daily Donchian basket plugin (`donchian_daily`) — spot, long-only, Book A

**Why first.** It is the only rule in the repo with a pooled desk-bar pass on REAL Coinbase data, its fee share is 1.9 % per ~+11 % trade, and its failure mode (bull-regime dependence, flat recency) is exactly what a paper line measures well: drift, not fast confirmation. It also exercises the engine at a cadence (one decision per UTC day per product) where the repo's plumbing has never been soaked — restarts, session restamps, daily-bar aggregation, fee attribution on multi-day holds.

**What must exist before paper starts (Eng, pre-registered; ~1 plugin + 1 candle path + tests):**

| Item | Detail | Repo anchor |
|---|---|---|
| New plugin `donchian_daily` | `BaseStrategy` subclass (`id`, `configSchema` {`entryLookback` 20, `exitLookback` 10}, `requiredIndicators` none beyond closes, `regimeCompatibility` **all regimes `compatible` ×1.0** — the rule is its own regime detector; it must not be silenced by the 15m ADX classifier), `generateSignals` emits BUY on close > prior-20 high, SELL(exit) on close < prior-10 low, on **completed 1D bars only** | `strategies/plugins/base-strategy.ts`, `builtin/index.ts` registration, `strategy-policy.ts` |
| 1D candle path in the runtime | `SignalProcessor` buckets bars into 5m/15m/1h groups today; a 1D bucket (UTC day close) or a daily `ONE_DAY` candle poll is required so the rule sees exactly one completed bar per day | `signal-processor.ts` candle buckets; `--bar-minutes 1440` rollup exists in the backtest CLI (#48) |
| Exit semantics | Close-evaluated exits only; **no venue-side stop-market**; if a protective stop is wanted it is a software stop evaluated on the daily close and pre-registered | S3 §4.4, §7 |
| Fee book | Book A (`SPOT-INTRO-50-90`) for the paper line's *evidence* numbers; the paper engine charges `PAPER-FeeModel-SPOT-25-40` — record both, never average; when the account tier is re-read, log Intro-1 (60/120) as the sensitivity | `guardrails.yaml fees` cite rule; `FeeModel.withRuntimeOverride` |
| Basket | The pre-specified 6 (BTC, ETH, SOL, XRP, XLM, DOGE) or Claude's 12; **no per-product cherry-picking**; per-symbol notional caps via `per_symbol` | S3 §7 conditions |
| Parity test | Run the plugin through `pnpm backtest --bar-minutes 1440` (or a 1D fixture dir) on `fixtures/bars/1d/tune-2017-01_2025-03` + sealed `1d/*.json`; must reproduce the S3 trade list for BTC/ETH (n, entries, exits) and pooled stats within slippage-model tolerance before the paper line is *counted* | `fixtures/bars/1d/README.md`; S3 Appendix A/B |
| Guardrails | New strategy is enabled only on the basket symbols; `check:config` pins updated in the same reviewed PR; TF-15m paper line **parked** (see 2.4) | `config-drift.ts` LIST_PINS |
| Pre-registration doc | Window, bar, fee book, basket, exits, expected n written *before* start (`docs/research/<date>_donchian-daily-prereg.md`) | prereg standard cited in S3 |

**Go/no-go bars.**

| Gate | Bar | Decision |
|---|---|---|
| Paper START (day ≤ 5) | Plugin + 1D path + tests green (`pnpm test` zero new failures); parity test reproduces S3 BTC/ETH trade lists; prereg doc merged; `check:config` OK | GO ⇒ start paper on the basket. NO-GO ⇒ do not start a "manual" version; wait |
| Paper CONTINUE (day 14) | Zero plumbing incidents at daily cadence (restart with open position preserved + restamped; fee attributed per fill; no duplicate daily signals; funnel closes); trade count 0–3 is *expected* and is not a fail | GO ⇒ continue to the 6-month drift window. NO-GO (any plumbing incident) ⇒ fix, restart the paper clock |
| Promotion to live *candidate* (not in these two weeks) | Recency half must clear: rolling 18-month pooled CI excludes 0 **or** the pre-registered drift test says 2025–26 conditions have ended; per-product promotion only when that product passes on its own; account tier ≥ Intro 2 or Book A re-cited | Desk decision, separate memo |

**Expectation setting (write it on the card):** ~6–8 trades/yr/product; ~60 % of trades lose; median trade −3 to −6 %; n ≥ 100 pooled takes 2–3 years at six products. The paper line proves *plumbing at daily cadence* in two weeks and *drift* over quarters. Anyone who expects P&L evidence in 14 days is reading the wrong instrument.

### 2.2 #2 — SH-QMAKER-CFM-PAPER-v0 — re-scoped to venue verification + 48 h quote capture

**What exists (#70, Tier-A Eng infra, PAPER ONLY, explicitly "NOT strategy GO"):** per-symbol execution policy (`*-CDE` ⇒ true post-only, no chase, `resolveEntryExecution`), edit-over-cancel with 429 budget (`OrderOpsThrottle`, `max_requotes_per_sec 4`), `fee_side` attribution on fills (migration `20260921180000_fills_fee_side.sql`), CFM cost-plus fee bucket (`fees.coinbase.cfm_nano` 9.5/10 bps + $0.10/ct, `FeeModel.computeFillFeeUsd` stacks, never blends), `CfmGuard` (Charter ≤ 2× leverage kill + flatten, Friday-break flatten), spot-proxy quote mirror onto `BIP-20DEC30-CDE`, all built-in strategies disabled on the CFM symbol, live `*-CDE` dropped at engine start.

**What the desk must accept before any QMAKER paper number is graded:**

1. **The paper quote path is a spot proxy, not the CDE book.** `BTC-USD` ticks/candles are mirrored onto `BIP-20DEC30-CDE` ("desk seal (a)"). A post-only quoting strategy "filled" against a spot proxy measures nothing about queue position, spread, or adverse selection on CDE. A QMAKER paper P&L produced this way is fiction by construction. Directional CFM paper (enter/exit hours apart) tolerates the proxy; quoting does not.
2. **Fee wall.** Desk-cited futures fee: 9.5 bps maker / 10 bps taker commission + $0.10/contract/side exchange floor (CDE Non-Professional Electronic; Fee Schedule eff. 2026-01-26, Appendix B-4), reconciled to Luke's 10-ct limit-long preview at ~11.5 bps one-way. At BTC ≈ $86.6K one BIP contract is ≈ $866 notional ⇒ **10.65 bps/side maker, 11.15 taker; round trip 21.3–22.3 bps; one tick ($5 index = $0.05/ct) is 0.58 bps ⇒ 37–39 ticks of captured spread per round trip just to break even.** Coinbase's public "as low as 0.02 % per contract, min $0.15" (blog 2025-07-21) would be 2 bps/side (7 ticks RT) — the account is not on that rate; the CLI print (`product_type==FUTURE`, tier label `Intro`) is the SoT until `/transaction_summary` says otherwise. **Conclusion: spread capture on BIP at the Intro futures tier is structurally negative unless the BIP book is routinely ≥ 40 ticks wide — measure it, do not assume it.**
3. **Venue facts that changed since the card was written** (all re-verify, read-only): (a) Friday 17:00–18:00 ET break retired per CDE 26-25 / 26-33 (final production window Fri 2026-09-11 16:00–16:50 CT; 26-33.1 "updated dates … to Oct 2026"); Coinbase help pages still say "1 hr break Fridays 5–6 ET" — check `status.cde.coinbase.com` and the notice text; (b) quarterly Saturday maintenance (Q4: **Sat 2026-10-24**, order entry/cancel refused during CLOSE) is not modelled by `cde-hours.ts`; (c) `GET /products/BIP-20DEC30-CDE` HTTP 400 on the research box while `BIP-20DEC30-CDE` is Coinbase's live id — likely the client is hitting the authenticated `/products` route without futures entitlement or needs `/market/products/{id}`; use `GET /api/v3/brokerage/market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL` to enumerate; (d) US500 / equity-index perp-style contracts are **not** 24/7 (Sun 20:00 → Fri 17:00 ET) — a `twenty_four_by_seven` flag exists on the product record; (e) `perps.max_leverage: 10` and `cfm.max_leverage: 2` — CFM intraday leverage is an opt-in window (18:00–17:00 ET); Charter cap 2× binds regardless.
4. **Default-portfolio isolation conflict** — see §3.2. It does not block *paper*, but it shapes what "live-shaped" means for CFM and must be in the card.

**Re-scoped steps (48 h + week 1), all read-only against the venue:**

| Step | What | Output |
|---|---|---|
| Q1 | Venue-fact re-verification: CDE hours (26-33 / 26-33.1 / status page), product enumeration via `market/products?product_type=FUTURE`, `/transaction_summary` futures tier, two 1-contract order *previews* (buy/sell, limit, not submitted) to reconcile the all-in per-contract cost | `docs/research/<date>_cfm-venue-facts.md`; patch list for `cde-hours.ts` / guardrails comments (no code change in this memo) |
| Q2 | 48 h top-of-book capture of `BIP-20DEC30-CDE` (public market data only: `market/product_book`, or the `level2` WS channel if it serves `-CDE`) at ≤ 1 s, plus the mirrored `BTC-USD` book for basis | Spread distribution (ticks), time-at-spread, depth at L1–L3, basis vs spot, hour-of-day profile |
| Q3 | Economics memo: median/p25/p75 spread in ticks vs the 37–39-tick break-even; expected fills/hour at L1; adverse-selection proxy (mid move 10 s after touch) | GO/NO-GO for QMAKER as a *quoting* strategy |

**Go/no-go bars.**

| Gate | Bar | Decision |
|---|---|---|
| QMAKER as quoting strategy | Median BIP spread ≥ 40 ticks for ≥ 30 % of the 48 h **and** L1 fills/hour ≥ 4 at 1-ct size (from book turnover) | GO ⇒ design a *real* CDE-book paper harness (not spot-proxy) as a separate card. NO-GO (expected) ⇒ retire the quoting idea; keep `cfm_post_only` as the *entry policy* for directional CFM |
| CFM directional paper line | Q1 complete; guard updated for TRUE_24X7 + quarterly windows; a strategy with its own GO (e.g. the daily Donchian applied to BIP with 1-ct sizing, fee book `cfm_nano`) | Only after 2.1's plugin exists; not in these two weeks |

### 2.3 #3 — Regime sleeve switcher — shadow (log-only) sleeve on a daily classifier

**What the repo already has:** `RegimeDetector` (ADX-primary, 15m), plugin `regimeCompatibility` self-gates, `RegimeFilter`, the **A6 regime-conditional gate** (`regime-gate.ts`, `guardrails.regime_gates` with per-rule `venues` / `symbols` scoping, funnel stage `regime_gate`, 21 tests, shipped `enabled: false`), and `per_symbol_disable`. A "sleeve switcher" is a generalization of A6: *sleeve s is enabled in regime set R_s*. Three of four pieces exist. The missing piece is the right **clock**: every regime number in this repo is ADX(14) on 15m bars, where `strong_trend` (ADX ≥ 40) is 3–4 % of the time and flips with smoothing of 2-of-3 classifications — useless as a sleeve switch (E3: A6-on TF = 26 trades/yr, zf PF 1.18).

**Honest read on the evidence:** the only sleeve with a pooled pass (daily Donchian) does not want a switch — it *is* the switch (a 20-day closing-high breakout is a regime detector with a position attached). TF on 15m in `strong_trend` is a screen-fail sleeve. Momentum's regime edge is non-stationary (A6 §4.2: strong_trend PF 3.73 → 0.46 across windows) and must not be gated by regime at all. So a switcher today would route between one sleeve that passed and two that failed.

**What is worth doing (shadow only, no orders):**

| Step | What | Output |
|---|---|---|
| R1 | Define sleeves and the daily classifier ex-ante: `ADX(14)` on **daily** bars, thresholds pre-registered (do not peek); sleeves = {`donchian_daily` (always on), `tf_4h_strong` (TF on 4H bars, on only in daily strong_trend — a screen, since E4 4H zf PF 0.94 < 1.61), `cash`} | `docs/research/<date>_sleeve-switcher-prereg.md` |
| R2 | Implement as **A6 rules in shadow**: log `regime_gate` decisions per sleeve without blocking (the gate today either blocks or is off — a `shadow` mode mirrors `live.ev_gate_mode: shadow`); run alongside the Donchian paper line | Funnel counts per (sleeve, regime, day) |
| R3 | Backtest the switcher on the 4H/1D fixtures with the E4 harness discipline (tune 2023-03 → 2025-03 once, eval 2025-03 → 2026-03 once, ledgered) | Verdict vocabulary of E4 (`RESEARCH SCREEN ONLY` … `BETA BARS PASS`) |

**Go/no-go bars.** Shadow sleeve may start when R1 is merged (no code risk: log-only). Promotion of any switched sleeve to a *paper order path* requires the E4 bars at the tier-consistent fee (zf PF ≥ floor for its TF: 4H 1.61 / 1D 1.44; fee-book PF ≥ 1.2; ≥ 3/4 quarters PF ≥ 1.0; max DD ≤ 15 %; E[n] ≥ 100 or `EXPLORATORY` label). Nothing on 15m qualifies for a sleeve.

### 2.4 Not candidates (and what to do with the TF-15m line)

- **`trend_follow` on 15m spot:** park the paper order path. The evidence (§1.3) is complete for this TF; more paper hours add loss, not information. Keep the plugin (research use on 4H/1D via the E4 harness). Mechanism: add `trend_follow` to `disabled_strategies` in a reviewed PR that also updates the `check:config` LIST_PIN — or leave the engine stopped, which TM has already done.
- **Momentum 15m** (E2-MOM-ISO KILL 2026-09-11; F4 perps bleed; A6 non-stationary), **15m breakout** (Phase 3: negative at zero fees), **VWAP-MR** (Phase 3: 1 trade/yr): killed on evidence; see §5.
- **INTX perps** (`ETH-PERP-INTX`, `BTC-PERP-INTX`): non-US and the endpoints are gone (2026-09-09). Paper "perps" are mirrored spot candles priced at a 0/5 bps book that no longer exists for us — they inflate nothing useful. Recommend removing `perps_symbols` from the paper run in the same reviewed PR (separate from this memo).
- **Anything sub-15m / HFT:** §4.

### 2.5 How this becomes "profitable, scalable, multi-avenue" — and what the honest constraint is

- **Capital scalability is not the problem at daily frequency.** Coinbase BTC/ETH daily spot volume is in the billions; a $10K → $1M basket at next-open fills is invisible, and the 5 bps slippage pin is conservative at that cadence. Every 15m line the desk ran had the opposite profile: scalable in trade count, unscalable in edge.
- **Bet-count scalability is the problem.** S3 §5.2: 76 % of Donchian entries occur within ±3 days of another product's entry; six products are one beta event traded six times (95 distinct entry-months in 298 trades). Adding more crypto products adds exposure, not independence. Paper evidence at n ≥ 100 pooled is a 2–3-year clock at six products — the plan must be judged on plumbing and drift, not on P&L, for a long time.
- **The multi-avenue path that is actually open** (research-only until the spot line has two clean weeks): the *same pre-registered rule* on venues whose returns are less correlated with crypto beta — CDE gold / silver futures (24/7 since 2026), US500 / Tech100 perp-style (Sun-20:00 → Fri-17:00 ET), and, for shorts, BIP/ETP where the venue allows them. Each is a new fee book (cost-plus, per contract), a new hours model, and — for equity-index perps — a new microstructure (auctions, macro prints). None of that exists in the repo. The sequence is spot basket → CFM directional on BIP with 1-ct sizing → non-crypto CDE contracts, each with its own pre-registration and its own paper clock. "Multi-avenue" is a 2026-Q4/2027 shape, not a two-week one.
- **What would make it profitable rather than merely positive-expectancy:** the account's fee tier and the 2025–26 regime question that only the paper line can answer. On tier: a six-product daily basket at 1/6-of-equity sizing produces ~7 fills/month on average (≈ 1.2× equity in 30-day volume), but entries cluster (76 % within ±3 days), so a $10K account will oscillate between Advanced 1 in active months and Intro 2 / Intro 1 in quiet ones — budget the evidence at Book A / Intro 2, not at 25/40. Neither lever is in Eng's hands.

---

## 3. Venue / product map — what Coinbase actually offers us now vs fantasy

### 3.1 The map

| Product / venue | Legal entity · regulator | API surface | US retail eligibility | Fees (this account) | Repo status | Traps / notes |
|---|---|---|---|---|---|---|
| **Coinbase Advanced spot** (`BTC-USD` …) | Coinbase Inc. (CBI) · state MTLs; no CFTC/SIPC protections | Advanced Trade REST `api.coinbase.com/api/v3/brokerage` + WS `advanced-trade-ws(-user)`; CDP key, ES256 JWT | Yes | **Intro 1: 60 / 120 bps** (< $1K 30d vol); Intro 2 35 / 75 (≥ $1K); Advanced 1 25 / 40 (≥ $10K); … Advanced 8 0 / 5 (≥ $250M). Tiers reworked Jan 2026 (secondary source) | Only venue with a live-shaped path (TASK_010/011 landed: JWT adapter, LiveAccountTruth, preflight); live locked by `LIVE_STAGE0_COMPLETE=false` | Tier trap (buying a cheaper tier with losses, audit §4); no shorting; long-only enforced in code for spot; bracket / attached TP-SL available |
| **CFM US futures & perp-style futures** (`BIP-20DEC30-CDE`, `ETP-…`, `SLP-…`, `XPP-…` + ~20 more crypto perps; gold, silver, copper, platinum, nano crude, natgas) | Coinbase Financial Markets (FCM, CFTC/NFA) on Coinbase Derivatives Exchange (DCM), cleared at Nodal | Same Advanced Trade REST/WS; `/cfm/balance_summary`, `/cfm/positions`, `/cfm/sweeps`, intraday margin endpoints; product records carry `future_product_details` (`contract_expiry_type PERPETUAL`, `funding_rate`, `twenty_four_by_seven`) | Yes, separate futures account application | CDE exchange fee $0.10/ct/side (nano, Non-Pro Electronic; $0.75 for full-size BTI/ETI) **+** CFM commission (desk cite 9.5 / 10 bps; tier `Intro`); public "as low as 0.02 %, min $0.15" not the account's rate; liquidation fee 80 bps per transaction (Coinbase Advanced fee-upgrade blog footnote; date of that disclosure not verified) | Paper infra only (#70): post-only policy, cost-plus FeeModel, CfmGuard; **no live `*-CDE` path** | **Primary-portfolio only** (§3.2); hourly funding settled twice daily; intraday leverage window; 60/40 tax treatment; Friday break retired → TRUE_24X7 (verify); quarterly Saturday closes; contracts are cash-settled with a far-dated expiry (2030-12-20) and a funding rate — "perpetual-style", not perpetual |
| **CDE equity-index perp-style futures** (AI10, China10, Defense10, Tech100 `TEK`, **US500 `US5-19DEC30-CDE`**) and **Mag7+Crypto** quarterly futures (`MC-17SEP26-CDE`) | Same CFM/CDE | Same | Yes (US + EU for MAG7C); Coin50 perp is **not** US-eligible | Per-contract CDE fee (MC listed in the schedule) + CFM commission | Not modelled; `isCfmSymbol` would classify them `cfm` by suffix | **Not 24/7** (US500: Sun 20:00 → Fri 17:00 ET; closed market holidays); $1 × index notional (US500 ≈ index level in $); equity-market microstructure (open/close auctions, macro prints); the repo has no equity calendar; funding on an equity index is a new risk surface |
| **US equities & ETFs** (Coinbase Capital Markets, 8,000+ symbols, 24/5 on eligible names) | Coinbase Capital Markets Corp (FINRA/SIPC broker-dealer); execution/clearing/custody Apex Clearing | Advanced Trade REST: `product_type=EQUITY`, `equity_order_metadata` (session + TIF), `market_market_ioc` + `MARKET_GFD` (RTH only), `limit_limit_gtc` + `LIMIT_GFD`/`LIMIT_GTC`; **no attached orders**; whole shares outside RTH | US residents, separate CCM account | **$0 commission**, no regulatory fees passed today | None | **Cash account, T+1 settlement** ⇒ good-faith / freeriding violations if you recycle unsettled proceeds (industry standard: 3 GFVs in 12 months ⇒ 90-day settled-cash restriction — confirm Apex/CCM's exact policy; the CCM agreement §10.1 already forbids paying for a purchase with its own sale proceeds); no shorting; no brackets; fractional only in RTH; 24/5 liquidity is thin ⇒ spread *is* the fee; wash-sale rules apply (crypto: none today); PDT rule is margin-only so it does not bite, but settlement throttles frequency to ~1 turn/day of capital; SIPC covers securities, not the crypto side |
| **Tokenized stocks on Base** (AAPLc, NVDAc, METAc, GOOGLc …) | Coinbase Bermuda / ADGM, custody Alpaca | On-chain (Aerodrome, Uniswap) | **No — non-US only** | DEX fees + gas | None | Fantasy for a US desk; VPN access is a compliance breach, not a venue |
| **Coinbase International (INTX) perps** (`BTC-PERP-INTX` → `BTC_USDC-PERPETUAL`) | Coinbase International Exchange (Bermuda) → Deribit-powered gateway `drb.coinbase.com` (JSON-RPC 2.0) | Old REST retired **2026-09-09**; new gateway non-US | **No** | 0 / 5 bps (paper book) — irrelevant | `CoinbasePerpsAdapter`, `PerpsRiskMonitor`, `perps_symbols` = legacy | Remove from paper; never cite perps backtests (audit §2.4: R14/18/19/20/26 synthetic) |
| **Coinbase prediction markets** | Coinbase (via partner) | — | Yes | — | None | Out of scope; different asset class, no research |
| **Kraken Pro spot** | Payward · US MTLs | Kraken REST/WS (different auth, different symbols) | Yes | Tier 1 **40 / 80** bps (Jul 2026 unified tiers; $2.5K+ 30 / 60; $10K+ 22 / 38; AoP counts) | `TASK_009` CCXT evaluation only; no adapter | Cheaper than Coinbase Intro 1 by ~1.5× at $0 volume (40/80 vs 60/120), equal at $10K (22/38 vs 25/40); a second unvalidated live path; research-only |
| **Kraken Derivatives US** (CME micro futures via NinjaTrader Clearing; Bitnomial perps) | NinjaTrader Clearing LLC d/b/a Kraken Derivatives US (FCM) | NinjaTrader / Kraken Pro | Yes | MES/MNQ **$0.39/ct** commission + exchange/NFA/clearing pass-through; Bitnomial BTC perps **$0.15/ct/side all-in** | None | The only *fee-cheap directional futures* alternative for a US retail account; a second FCM relationship and a new adapter; research-only this quarter |
| **Hyperliquid** | Offshore DEX | HL API (adapter skeleton exists, inert) | **No — terms exclude US persons** | −1.5 / 4.5 bps | `hyperliquid.enabled: false` + `HYPERLIQUID_ENABLED` two-lock | Keep dark; Phase 3's "HL is the answer" is moot for a US desk |
| **eToro** | broker | — | Yes (crypto) | ~1 % per trade | None | No |

### 3.2 The CFM default-portfolio isolation conflict (spelled out)

- Coinbase Advanced supports up to 25 **portfolios** with per-portfolio API keys — the standard way to give a bot an isolated slice of capital (key scoped to portfolio X sees/trades only X). The repo's live preflight already reports `key.portfolio` type/uuid (`live-preflight.ts:214`).
- Coinbase Help ("Multiple portfolios"): **"US Futures positions aren't currently supported in Portfolios and must stay in your Primary portfolio. You can't use USD held in portfolios for futures trading."** Futures margin is held at CFM in the separate futures account; sweeps are one-way CBI spot → CFM and only from the Primary portfolio. Third-party integration guides say the same thing operationally: create the trading key with portfolio = `default`.
- Consequence: **a bot key that can trade CFM must be scoped to the Primary/default portfolio, which is also where every dollar that is not deliberately parked elsewhere lives.** Isolation and futures are mutually exclusive on one Coinbase account.
- Mitigations available without violating anything: keep `can_transfer` off (already ❌ on the live key); park non-bot capital in a *non-default* portfolio (the default-scoped key cannot see it — but then it cannot be swept to CFM either, so CFM margin must be pre-funded in Primary); per-symbol notional caps + Charter 2× + daily loss caps in guardrails; exchange-side protection; reconcile on boot. Put this trade-off in the CFM card. It is a governance decision for Luke, not an Eng ticket.

### 3.3 Fantasy vs reality, one line each

- "Perps like offshore, in the US": partly true via CFM perp-style futures (24/7 crypto, funding, up to 10× intraday) — with FCM fees per contract, a Primary-portfolio-only account, and no API path in the repo yet.
- "Trade the S&P/Nasdaq 24/7 on Coinbase": US500/Tech100 perp-style exist but trade Sun 20:00 → Fri 17:00 ET; equities are 24/5 for eligible symbols with thin overnight books.
- "Zero-fee stocks = free HFT": zero commission, cash account, T+1, no shorts, no brackets, spread pays the bill.
- "Kraken/HL are the cheap escape": Kraken spot is ~1.5× cheaper at $0 volume and equal at $10K; HL is closed to US persons; Kraken US futures are the only genuinely cheap directional venue and are a quarter of adapter work away.

---

## 4. HFT vs fee reality at the Intro tier — which frequencies are viable

### 4.1 Definitions the desk should use

| Band | Holding period | Decisions/day/symbol | Where the repo is |
|---|---|---|---|
| HFT | sub-second to seconds | 10³–10⁵ | Nowhere; not a design goal |
| Scalping | seconds to minutes (1m–5m bars) | 10–100 | `strategy.mode: momentum_futures` legacy block; nothing live |
| Intraday swing | 15m–1H bars | 1–10 | Where every killed strategy lived |
| Position / trend | 4H–1D bars | 0.1–1 | E4 harness screens; S3 Donchian |

### 4.2 Coinbase spot: break-even WR by timeframe and round-trip fee (TP 5×ATR / SL 2.5×ATR, the desk's A1 geometry)

Round trips: 240 bps = Intro 1 taker both legs; 190 = Book A (90 + 5 slip, ×2); 150 = Intro 2 taker; 120 = Intro 1 maker-maker (perfect post-only fills, no adverse selection); 80 = Advanced 1 taker ($10K+); 22 = CFM BIP all-in (desk cite). "n/a" = fee ≥ target: negative EV at 100 % WR.

| TF | typical ATR % | fee share of 5×ATR @ 240 / 80 bps | 240 | 190 | 150 | 120 | 80 | 22 |
|---|---|---|---|---|---|---|---|---|
| 1m | 0.08 | 600 % / 200 % | n/a | n/a | n/a | n/a | n/a | 70 % |
| 5m | 0.20 | 240 % / 80 % | n/a | n/a | n/a | n/a | 87 % | 48 % |
| 15m | 0.50 | 96 % / 32 % | **97 %** | 84 % | 73 % | 65 % | 55 % | 39 % |
| 1H | 1.20 | 40 % / 13 % | 60 % | 54 % | 50 % | 47 % | 42 % | 36 % |
| 4H | 2.50 | 19 % / 6 % | 46 % | 44 % | 41 % | 40 % | 38 % | 35 % |
| 1D | 4.00 | 12 % / 4 % | 41 % | 40 % | 38 % | 37 % | 36 % | 34 % |

Realized WR of the repo's strategies on REAL data: 24–44 %. Realized payoff 1.35–2.2, not the 2.0–2.4 the geometry assumes (audit §3.3: 51 % of exits at stop, 13 % at TP). Cross those two facts with the table: **at Intro 1 nothing above the 4H row is even theoretically viable, and 4H/1D need WR ≥ 41–46 % against a 24–44 % history.** The desk's zero-fee PF floors (15m 5.8 · 1H 2.25 · 4H 1.61 · 1D 1.44, `e4-harness.ts`) are the same statement in PF units.

### 4.3 The structural reasons HFT is off the table regardless of tier

- **Rate limits:** Advanced Trade REST limits are in the tens of requests per second (the official AT rate-limit page was not retrieved in this pass; the sibling Coinbase Exchange API documents 15 req/s private / 10 req/s public with bursts to 30 / 15); AT WebSocket unauthenticated messages are capped at 8/s per IP (official). Order entry over WebSocket arrives only with the Deribit gateway (non-US). That is a swing-trading API, not a matching-engine co-location.
- **Maker fee is 60 bps at Intro 1 and 25 bps at Advanced 1.** HFT market making works at ≤ 0–2 bps maker (or rebates). Coinbase's 0 % maker starts at Advanced 7 (≥ $100M/30d). Kraken's 0 % maker starts at Tier 12 ($10M spot or $10M AoP). Neither is a retail path.
- **Host:** a Windows PC (audit §6/§L3) with in-process stops. Latency and uptime are not HFT-grade; exchange-side protection is a P0 for *any* live line.
- **Volume tier trap:** the only way to buy a cheaper tier is volume; at the repo's realized edge, the volume that reaches Advanced 1 (~$48K/30d at backtested frequency) costs ~$575–600/month in fees on a $1K account (Sprint 9 §5).
- **CFM:** ≈ 21–22 bps round trip per BIP contract at the desk-cited tier vs 0.58 bps/tick ⇒ 37–39 ticks. Even at the public "as low as" 2 bps/side, 7 ticks. Quoting is not viable at retail; directional with hours-to-days holds is (fee share of a 4H/1D target: 1–2 %).
- **Kraken Derivatives US** ($0.15/ct all-in on Bitnomial BTC perps; MES $0.39/ct + pass-through): genuinely cheap directional futures for a US retail account, and the only place where a 1H band could be re-examined. Research-only; no adapter.

### 4.4 Viable frequency verdict

| Band | Coinbase spot (Intro 1 → Adv 1) | CFM perp-style (Intro futures tier) | Kraken US futures (research-only) |
|---|---|---|---|
| HFT / scalping | **Dead** (fee ≥ target) | Dead (37 ticks/RT) | Not examined; fee floor $0.15–$0.39/ct + pass-through |
| 15m intraday swing | **Dead at every tier** (WR 55–97 % needed) | Marginal (39 %) and unproven | Possible on paper only |
| 1H | Marginal only at Advanced 1 with zf PF ≥ 2.25 (never observed) | Possible if a signal exists | Possible |
| 4H | Screen-fail so far (E4 zf PF 0.94 < 1.61) | Fee share ~1 % | — |
| 1D | **The only band with a pooled pass in hand** (S3) | Fee share < 1 %; Donchian-on-BIP is the natural CFM directional line later | — |

---

## 5. What NOT to do this week

1. **Do not re-enable 15m `breakout` or `momentum`.** `breakout` (the 15m ATR/volume plugin) loses at *zero* fees (Phase 3: −$326 / −$119 at 0 bps; "signal has no edge"). `momentum`: E2-MOM-ISO KILL 2026-09-11 (`guardrails.yaml` comment, #55); perps momentum bled −$1,782 / −$2,082 on 251 / 238 trades (F4 follow-up); regime edge flips sign across windows (A6 §4.2). The `disabled_strategies` LIST_PIN and `pnpm check:config` exist precisely to make this a reviewed decision, not a hot flip. The daily Donchian is **not** "re-enabling breakout" — it is a different rule at a different frequency with its own plugin (S3 §7 engineering note).
2. **Do not route orders from a chat agent ("Agents chat live" / scrap-to-autotrade).** A conversational agent is not a strategy: no pre-registration, no backtest, no reproducible trade list, no funnel stage, no `check:config` pin, no kill-switch semantics. It would also require widening the control plane the audit flagged (§6: unauthenticated API, `cors()` any origin, public confirm phrase) at the exact moment the desk is tightening it (TASK_015). Agents write research, task specs and code under review; humans flip locks; the engine trades. `CONFIRM_LIVE` stays locked; `LIVE_STAGE0_COMPLETE` stays `false`.
3. **Do not migrate to AWS (or any cloud) for its own sake.** Host choice has zero effect on a book whose problem is edge. `deploy/docker/Dockerfile.api` and `deploy/k8s/` exist; Sprint 9 §6 already scopes "always-on host" as P1 *after* Stage 1 (wire canary). A $5–10/month VPS or the existing image on any always-on box is sufficient when a paper line needs 24/7 uptime (the Donchian line does not: one decision per day survives a laptop sleeping). Spend the week on §6, not on IAM.
4. **Do not flip A6 on in paper as "the fix" for TF.** E3 measured it: 26 trades/yr, zf PF 1.18, HOLD. It reduces the bleed; it does not create edge. Enabling it also changes the `check:config` state and the paper/live parity story.
5. **Do not retune `trend_follow` (EMA / ATR / ADX cut) on the holdout** or run "just one more" 15m grid. The anti-overfitting rules in TASK_018 (tune 2023-03 → 2025-03, eval once, ≤ 12 combinations, ex-ante justification) exist because the last three 15m passes all failed the same way.
6. **Do not loosen the consecutive-loss kill** to keep a PF < 1 book alive (§1.5).
7. **Do not fund Intro-1 spot live** ("Door B"): Sprint 9 §5 prices it at −$350 to −$600/month in fees alone at $1K.
8. **Do not average fee books** (25/40 paper vs 50/90 desk cite vs 60/120 observed vs CFM cost-plus). Report each; the drift gate enforces the pins.
9. **Do not cite anything INTX**: endpoints are gone (2026-09-09) and every perps backtest in the inventory is synthetic or contaminated (audit §2.4).
10. **Do not build on the Friday-break assumption** in `cde-hours.ts` without re-verifying CDE 26-33 / 26-33.1; do model the quarterly Saturday windows (next: 2026-10-24).

---

## 6. 48-hour / 2-week execution plan (TM desk)

Roles: **TM** (desk decisions, decision log), **Algo** (pre-registration, research notes), **Eng** (plugin, candle path, tests, venue verification), **Risk** (caps, kill semantics, governance memo on §3.2). All items read-only against venues unless marked *paper*.

### 6.1 Next 48 hours (2026-09-23 → 09-24)

| # | Owner | Item | Done when |
|---|---|---|---|
| 1 | TM + Eng | **Soak archive.** Read-only SQL on `orders` / `fills` / `signals` / `risk_events` for `session_id = 'sess_1790091200890_9q7egp'` and the earlier session(s) of the same soak: n, WR, exit mix, Σfees (paper book) and the Intro-1 restatement (§1.4), regime stamp per entry, kill event row (`reasonCode`). Attach to the decision log | `docs/research/2026-09-2x_tf15m-soak-autopsy.md` with the real n; §1.4 table replaced |
| 2 | TM | **Decision log entry:** TF-15m paper line **PARKED** (not "paused"); INTX `perps_symbols` slated for removal from paper; 15m spot strategy work closed under the TASK_018 kill rule | Entry in `docs/plans/SPRINT-9-LIVE-COINBASE.md` §3 |
| 3 | Eng | **Venue-fact tickets** (no code change yet): (a) CDE hours — 26-25 / 26-33 / 26-33.1 + `status.cde.coinbase.com`; (b) `BIP-20DEC30-CDE` product fetch via `market/products?product_type=FUTURE&contract_expiry_type=PERPETUAL`; (c) futures fee reconcile — `/transaction_summary` (futures) + two 1-ct limit previews (buy / sell), never submitted; (d) INTX retirement note on `CoinbasePerpsAdapter` | One `docs/research/<date>_cfm-venue-facts.md`; patch list for `cde-hours.ts`, guardrails comments, `symbol-utils` doc |
| 4 | Algo | **Donchian paper pre-registration** draft: basket (6 or 12), fee books (Book A evidence / paper 25-40 charged / Intro-1 sensitivity), exits (close-evaluated, no venue stop), evaluation window (rolling 18-month recency half), bars (pooled CI excludes 0; per-product promotion rule), expected n, drift test definition | Draft PR under `docs/research/`; TM sign-off before Eng starts the plugin |
| 5 | Eng | **`donchian_daily` plugin spec card** (interface per `BaseStrategy`; `regimeCompatibility` all-compatible; completed-1D-bar semantics; 1D bucket in `SignalProcessor` or daily candle poll; parity test against S3 trade lists on the 1d fixtures; `check:config` pin updates; TF parked in the same PR) | Card reviewed by Algo + Risk; estimate in components, not days |
| 6 | Risk | **Governance memo on §3.2** (Primary-portfolio-only futures): recommended key scoping, capital parking, caps; what "isolated" means for a CFM line | One page in `docs/risk.md` or a new `docs/research/` note; Luke decides |

### 6.2 Week 1 (2026-09-25 → 10-01)

| # | Owner | Item | Gate |
|---|---|---|---|
| 7 | Eng | Build `donchian_daily` + 1D candle path + tests; `pnpm test` zero new failures; `pnpm check:config` OK | Parity test reproduces S3 BTC/ETH trade lists (n, entry/exit dates) and pooled Book-A stats within slippage tolerance |
| 8 | Eng + Algo | **Start the Donchian paper line** (*paper*): basket symbols, long-only, `min_ev_threshold 0` (EV gate logs), per-symbol caps, TF parked, INTX symbols removed | §2.1 START bar |
| 9 | Eng | **48 h BIP top-of-book capture** (public market data only) + the mirrored `BTC-USD` book; write spread/depth/turnover stats | Q2 output in §2.2 |
| 10 | Algo | **QMAKER economics memo** from #9 vs the 37–39-tick break-even; GO/NO-GO for quoting | §2.2 bar |
| 11 | Algo | **Sleeve-switcher pre-registration** (daily ADX classifier, sleeves, thresholds ex-ante) | R1 in §2.3 |
| 12 | Eng | A6 **shadow mode** (log-only) spec — mirrors `ev_gate_mode: shadow`; no default change | Spec only; implementation after #7 lands |
| 13 | Eng | Hygiene backlog, each its own small PR after #7: MetaFilter cold-streak semantics decision; `atr_vol` reading `metadata.atr`; live-vs-harness trail definition; `computeStopOvershoot` floor at bar low; `cde-hours` TRUE_24X7 + quarterly windows | Zero new test failures each |

### 6.3 Week 2 (2026-10-02 → 10-08)

| # | Owner | Item | Gate |
|---|---|---|---|
| 14 | TM | **Donchian paper soak review at day 14:** restart drill with an open position (restamp), fee attribution per fill, one signal per product per day, funnel closes, Supabase rows session-scoped | §2.1 CONTINUE bar. 0–3 trades is expected; P&L is not a criterion |
| 15 | TM + Algo | **CFM decision:** QMAKER quoting GO/NO-GO from #10; if NO-GO, re-label the card "CFM directional infra" and queue Donchian-on-BIP as the first CFM paper strategy *after* the spot line has 2 clean weeks | Decision log |
| 16 | Algo | **Sleeve switcher backtest** on 4H/1D fixtures with the E4 discipline (tune once, eval once, ledgered) | E4 verdict vocabulary; nothing on 15m |
| 17 | Eng | Shadow sleeve logging live alongside the Donchian line (no orders) | Funnel counts visible in `/metrics` |
| 18 | Risk + TM | **Two-week gate review** (2026-10-08): Donchian paper CONTINUE/STOP; QMAKER GO/NO-GO; TF-15m stays parked; live: **nothing** — `LIVE_STAGE0_COMPLETE` unchanged, `CONFIRM_LIVE` unset; next research question chosen (Kraken US futures venue note vs CFM directional) | Memo v2 |

### 6.4 Go/no-go summary (one table for the desk wall)

| Line | Two-week outcome that is a GO | Outcome that is a NO-GO / STOP |
|---|---|---|
| Donchian daily basket (paper) | Plugin parity with S3; line running; zero plumbing incidents at daily cadence | Any unrecovered restart / fee misattribution / duplicate daily signal ⇒ fix, reset paper clock |
| SH-QMAKER-CFM (quoting) | Median BIP spread ≥ 40 ticks ≥ 30 % of time **and** ≥ 4 L1 fills/h at 1 ct | Anything less (expected) ⇒ quoting retired; infra kept for directional |
| Regime sleeve switcher | Pre-registered; shadow logging; E4-graded backtest | Any 15m sleeve; any live gate flip |
| TF 15m spot | — (parked) | Any re-enable without a new TF-band screen pass |
| Live | — | Any change to the three locks |

---

## Appendix A — Repo evidence index (all at `main @ 44e66d4`)

| Path | What it shows |
|---|---|
| `atlas/config/guardrails.yaml` | `disabled_strategies: [vwap_mr, breakout, momentum]`; fee books `coinbase.spot` 25/40 (paper), `perps_intx` 0/5, `cfm_nano` 9.5/10 + $0.10/ct; desk cites `SPOT-INTRO-50-90`, `CFM-NANO-COSTPLUS-ADV1`, Luke 10-ct preview ~11.5 bps; `regime_gates.enabled: false`; `cfm` block (max_leverage 2, post_only/no_chase, hours_gap 30/10); `cfm_symbols.BIP-20DEC30-CDE` (contract 0.01 BTC, tick $5, spot proxy, all strategies disabled, GET 400 note); `perps_symbols` INTX; `backtest` realism pins |
| `atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts:31-55, 166-194` | Bug-A history (3.6 signals/min in ranging with fake MTF), `crossoverLookback 0`, `regimeCompatibility` (ranging/choppy refuse; weak_trend ×0.7) |
| `src/strategies/regime-detector.ts:117-130, 381-390` (cited via E3) | `adx_primary` thresholds 40/20/20; `choppy` never emitted |
| `src/trading/trading-engine.ts:1013` | `CONSECUTIVE_LOSS_LIMIT` default 8 |
| `src/strategies/meta-filter.ts:209-210, 545` | cold-streak threshold 10; block condition |
| `src/trading/cfm/cde-hours.ts`, `cfm-guard.ts` | Friday 17:00–18:00 ET break model; Charter 2× kill + flatten |
| `src/trading/execution/execution-policy.ts` | `*-CDE` ⇒ `cfm_post_only`, no chase |
| `src/core/fee-model.ts`, `src/core/symbol-utils.ts` | cost-plus stacking; `-CDE` / `-PERP-` classification |
| `src/exchanges/signal-route.ts` | routed-exchange vocabulary (`coinbase`, `coinbase-perps`, `coinbase-cfm`) |
| `src/trading/execution/live-stage0-gate.ts`, `adapter-factory.ts`, `api/server.ts:1300` | Three live locks |
| `src/cli/coinbase-preflight.ts:90-349` | `/transaction_summary` fee tier print (`pricing_tier`, maker/taker) |
| `src/api/server.ts:677-700, 1330-1360, 2673-2730` | CFM paper wiring: spot-proxy mirror, live drop, guard arming |
| `fixtures/bars/1d/README.md`, `fixtures/bars/{15m,4h}/` | Sealed 1d (BTC/ETH/SOL 2024-09 → 2026-08), tune 2017-01 → 2025-03; 15m/4h holdout + tune |
| `docs/research/2026-09-22_s3-donchian-breakout-replication.md` | S3 replication: pooled PASS, recency FAIL, 1/6, HOLD |
| `docs/research/2026-09-10_live-readiness-audit.md` | Pre-fee edge ≈ 0; Intro 1 60/120; EV-gate math; fee sensitivity; venue table; defects L1–L9 |
| `docs/plans/SPRINT-9-LIVE-COINBASE.md` | Stages 0–3; economics at $1K; Door A/B; venue verdicts |
| `docs/research/2026-05-29_a6-regime-conditional-gates.md` | TF weak_trend PF 0.78/0.80; strong_trend PF 1.41 n=16; momentum non-stationary; gate design |
| `docs/research/2026-09-11_e3-strong-tf-screen.md` | A6-on TF: n=26, zf PF 1.18, HOLD |
| `docs/research/2026-09-11_e5-harness-diag-exit-parity.md` | Cold-streak deadlock; trail dominance; zf PF 0.83 / 0.47; `atr_vol` blind spot |
| `docs/research/2026-09-10_e4-multi-tf-feemodel-harness.md` | 4H eval zf PF 0.94 < 1.61 STOP; 1D EXPLORATORY; floors 1.61/1.44/2.25 |
| `docs/research/2026-05-14_consecutive-loss-circuit-breaker.md` | Streak math; "the kill caught a real signal" |
| `PHASE3_BACKTEST_VERDICT.md` | Fee matrix; breakout negative at zero fees; VWAP-MR 1 trade/yr |
| `CURSOR_TASKS/TASK_018_edge_experiments.md` | Gates, anti-overfitting rules, 2-week kill rule |
| `atlas/config/paper.local.yaml`, `live.local.yaml` | Legacy CLI configs still enabling breakout/vwap_mr (audit L9) — misleading, unused by `pnpm api` |
| `git log` #67–#74 (2026-09-21/22) | Tier-A P0 plumbing fixes that held during the soak |

## Appendix B — Public sources consulted (2026-09-22)

1. Coinbase Advanced fee tiers (help.coinbase.com/…/advanced-trade-fees; secondary tables at cryptofeediscount.com/academy/coinbase-fees-2026 and bitbo.io): Intro 1 < $1K 0.60 / 1.20 %; Intro 2 ≥ $1K 0.35 / 0.75 %; Advanced 1 ≥ $10K 0.25 / 0.40 %; … Advanced 8 ≥ $250M 0 / 0.05 %; tiers update hourly; Jan-2026 tier rework (secondary).
2. Coinbase Help — Multiple portfolios: up to 25 portfolios, per-portfolio API keys; "US Futures positions … must stay in your Primary portfolio. You can't use USD held in portfolios for futures trading."
3. Coinbase Developer Docs — Advanced Trade Futures guide; REST endpoint table (`/cfm/balance_summary`, `/cfm/positions`, `/cfm/sweeps`, `/portfolios`, `/key_permissions`); List Products (`product_type=FUTURE`, `contract_expiry_type=PERPETUAL`, `future_product_details` incl. `twenty_four_by_seven`, `funding_rate`); Create Order equities notes (`equity_order_metadata`, `MARKET_GFD` RTH-only, whole shares off-hours, no attached orders); Advanced Trade WebSocket rate limit (8 unauthenticated msgs/s per IP; 750 connections/s per IP). Coinbase *Exchange* API rate limits (REST private 15/s burst 30, public 10/s burst 15) — a sibling product, cited only as an order-of-magnitude reference; the Advanced Trade REST rate-limit page was not retrieved.
4. Coinbase Derivatives fee schedule effective 2026-01-26 (assets.ctfassets.net … Fee_Schedule_1.26.2026.pdf) and CFTC filings 2025-25 / 2025-58 / 2025-75: per side per contract; nano contracts (BIT, BIP, ETP, SLP, XPP, …) Non-Professional Electronic $0.10; full-size BTI/ETI $0.75; column set Market Maker / Non-Professional / Professional × Electronic / Block. R2026-46 "Modifications to the Fee Schedule" filed 2026-08-03, effective 2026-08-17 (contents not retrieved — verify).
5. CDE market notices (coinbase.com/derivatives/market-notices): 26-25 (2026-05-20, eff. 2026-07-24) Removal of Weekly 1-Hour Friday Maintenance Window; 26-33 (2026-07-13) final Production Friday window Fri 2026-09-11 16:00–16:50 CT → TRUE_24X7 for crypto futures + gold + silver; 26-33.1 (2026-08-05) Updated Dates on 24x7 Transition, "08/14/2026 to Oct 2026"; 26-11 Q4 quarterly maintenance Sat 2026-10-24; 26-28 / R2026-42 Perp Style Futures Expiry Change (2026-06-17); 26-26 / R2026-34…37 AI10, China10, Defense10, Tech100 Index Perp Style Futures (trade date 2026-06-08 → 06-14/15); 26-35 / R2026-44 US500 Index Perp Style Futures (2026-08-16/17); 25-31 / R2025-46 Mag7 + Crypto Equity Index Futures (2025-09); 26-24 BNB & HYPE; 26-06 Coin50 perp; 26-04 PAX Gold, Zcash + 5 perps; R2026-15 nano Platinum.
6. Coinbase Help — US perpetual-style futures overview and contract specs: BIP 0.01 BTC, tick $5 = $0.05; ETP 0.10 ETH; SLP 5 SOL; XPP 500 XRP; hourly funding settled twice daily; intraday leverage window 18:00–17:00 ET; current contracts expire 2030-12-20 (help) / "no expiration date" (spec page) — reconcile; "1 hr break Fridays 5–6 ET" still printed on help/product pages.
7. Coinbase product pages: `coinbase.com/futures/BIP-20DEC30-CDE` (live id, funding 0.0003 %/h, expiry Dec 2030), `US5-19DEC30-CDE` (US500, hours Sun 8 PM → Fri 5 PM ET), `mc-17sep26-cde` (MAG7C quarterly, $1 × index).
8. Coinbase Developer Docs — Global Derivatives migration: INTX endpoints retired 2026-09-09 (hard cutover) → `drb.coinbase.com/api/v2` JSON-RPC (Deribit-powered, Starbase); `BTC-PERP-INTX` → `BTC_USDC-PERPETUAL`; US access is via CFM only.
9. Coinbase — stocks (coinbase.com/stocks; Coinbase Help stock order types / glossary; CCM Customer Agreement Mar 2026): CCM brokerage, Apex clearing, $0 commission, US residents, 24/5 on eligible symbols, T+1, market orders RTH only (Advanced), fractional RTH only, cash-account payment-by-settlement terms; tokenized stocks on Base (2026-08-24) non-US only (CoinDesk, Galaxy).
10. Coinbase blog 2025-07-21 "Perpetual futures have arrived in the U.S." (fees "as low as 0.02 % per contract", min $0.15, inclusive of exchange/clearing/NFA); 2024 fee-upgrade blog (intro 0.05 %/contract, min $0.20, liquidation 80 bps).
11. Kraken — Cross-platform fee tier changes (July 2026) and Kraken Pro fee schedule: Tier 1 spot 0.40 / 0.80 %; Tier 2 ($2.5K) 0.30 / 0.60; Tier 3 ($10K or $20K AoP) 0.22 / 0.38; futures Tier 1 0.02 / 0.05 %; US futures volume does not count toward tiers. Kraken Support — US Futures Fees: MNQ/MES $0.39/ct, NQ/ES $1.29/ct + exchange/NFA/clearing; Bitnomial perps $0.15/ct/side all-in (NinjaTrader Clearing d/b/a Kraken Derivatives US).
12. Coinbase Derivatives docs — market hours (24x7 since 2025-05-09; weekly 50-min Friday window 16:00–16:50 CT pre-retirement; quarterly weekend windows).

## Appendix C — Arithmetic used in this memo

- Break-even WR with TP = 5·ATR, SL = 2.5·ATR, round-trip fee f (all in %): p = (2.5·ATR + f) / (7.5·ATR); undefined when f ≥ 5·ATR. Example 15m, ATR 0.5 %, f 2.4 %: (1.25 + 2.4) / 3.75 = 97.3 %.
- P(run ≥ 8 losses in n trades): Markov chain on streak length 0…7, absorbing at 8, per-trade loss probability q = 1 − WR; values in §1.5 are exact under i.i.d.
- CFM BIP per-side cost at BTC 86,594.94 (2026-09-21 close): notional 865.95; commission 9.5 bps = 0.8227 (maker) / 10 bps = 0.8659 (taker); exchange 0.10; total 0.9227 / 0.9659 = 10.65 / 11.15 bps; round trip 21.3 / 22.3 bps; tick 5 / 86,594.94 = 0.58 bps ⇒ 37 / 39 ticks.
- Soak fee restatement: notional 2,900 × 2 legs × (fee bps / 10⁴) × n; paper 40 → 0.8 % RT; Intro 1 taker 120 → 2.4 % RT; Intro 1 maker-maker 60 → 1.2 % RT.
- Session id: `1790091200890` ms since epoch = 2026-09-22T15:33:20.890Z.

*End of memo. Read-only. No GO is granted by this document.*
