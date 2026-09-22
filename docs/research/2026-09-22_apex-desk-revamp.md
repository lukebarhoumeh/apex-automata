> Repo copy of the desk deliverable `artifacts/apex-desk-revamp-2026-09-22.md` (identical content). Docs-only; nothing under `atlas/config/**`, `strategies/**` or `trading/**` changed.

# APEX-DESK-REVAMP — 2026-09-22 — soak autopsy · fee reality · venue map · ranked paper candidates · 48 h / 2-week plan

**Date:** 2026-09-22 · **Repo:** `main @ 44e66d4` (#75 merged) · **Audience:** TM package (TM + Algo + Risk + Eng) · **Author:** Cloud Agent (finishing the survey `bc-e2e8ca08` errored on; that run's transcript is not retrievable, so every number below is re-derived from the repo, the Supabase project (read-only SQL) and public fee pages read today).
**Authority:** read-only research. No orders, no API keys used, no `CONFIRM_LIVE`, nothing under `atlas/config/**`, `strategies/**`, `trading/**` touched. This memo makes no strategy a GO and unlocks nothing.
**SoT alignment:** aligned with the Research Master interim SoT (no scratch · no agent autotrade · `CONFIRM_LIVE` locked · soak kill correct · ladder L1–L6 → TF-REGIME-GATE → SH-QMAKER paper harness → `donchian_daily_s3` default-off → INTX de-emphasize). Two evidence-backed **additions**, not contradictions: (a) a one-line `atr_vol` filter parity fix that sits next to TF-REGIME-GATE (§1.3, §6), (b) a fee-book cite reconciliation (§2.2).
**Cites:** `docs/research/2026-09-22_s3-donchian-breakout-replication.md` (S3) · `atlas/config/guardrails.yaml` (`disabled_strategies`, `fees`, `regime_gates`, `cfm`) · `docs/research/2026-09-10_live-readiness-audit.md` (L1–L9, EV-gate math) · `2026-05-29_a6-regime-conditional-gates.md` (A6) · `2026-09-11_e3-strong-tf-screen.md` (E3) · `2026-09-11_e5-harness-diag-exit-parity.md` (E5) · `2026-09-10_e4-multi-tf-feemodel-harness.md` (E4) · PR #70 (SH-QMAKER infra) · Supabase `trading_sessions` / `trade_log` / `trade_outcomes` / `fills` / `risk_events` (queries in Appendix A).

---

## 0. Decision sheet

| Question | Call | Evidence |
|---|---|---|
| Scratch Apex / rewrite? | **NO.** The engine, gates, funnel telemetry, fee books, sealed fixtures and 84-file / 1 289-test suite are the asset. The problem is edge × fees, not code. | `pnpm test` 84 / 1 289 pass, `pnpm check:config` OK at `44e66d4` (Appendix A) |
| Any agent autotrade? | **NO.** No Cloud Agent, Cowork, Claude/Robinhood-desk hand-off or agentic wallet places orders. Human-only unlock, and it stays locked. | Three independent locks: `CONFIRM_LIVE` env default `NO` (`core/env.ts:32`, refused at `api/server.ts:1300`); `LIVE_STAGE0_COMPLETE = false` (`live-stage0-gate.ts:37`); `ENGINE_LIVE_EXECUTION_WIRED = false` (`adapter-factory.ts:69`) |
| Soak −$94 kill correct? | **YES.** TF-only 15 m spot book, 5/5 stop-outs, 5/5 `weak_trend`, fees = 62 % of the loss, gross negative before fees, fee cost 2.3–3.5 R per trade. Halt fired on the designed `consecutive_losses` rule. | §1 |
| Unlock live (Door B)? | **NO.** Not offered. Stage 0 incomplete (TASK_012/013/015 pending); account $2.90; no strategy clears any bar at any fee book. | §2, §6 |
| Eng order | **As RM:** L1–L6 → TF-REGIME-GATE (+ `atr_vol` parity, same PR family) → SH-QMAKER paper harness → `donchian_daily_s3` default-off → INTX de-emphasize. | §6 |
| 2-week paper candidates | **#1** TF × A6 strong-trend-only + ATR parity (bleed-stop, telemetry) · **#2** SH-QMAKER-CFM-PAPER-v0 (needs strategy card GO) · **#3** `donchian_daily_s3` basket, default-off (drift detection only). Non-candidates: INTX perps, momentum, breakout, vwap_mr, any live. | §5 |
| Fee books | Three books, **never mixed**: `PAPER-FeeModel-SPOT-25-40` · `SPOT-INTRO-50-90` (desk cite) · CFM cost-plus 9.5/10 bps + $0.10/ct. Public schedule read today shows Intro 1 = 60/120 — reconcile the Intro cite via `pnpm cb:preflight` before it appears in any GO pack. | §2 |

---

## 1. Autopsy — paper soak 2026-09-22 (−$94.19)

### 1.1 Session facts (Supabase, read-only, 2026-09-22 ~21:35 Z)

| Field | Value |
|---|---|
| Session | `sess_1790091200890_9q7egp` · `mode=paper`, `execution_mode=paper` |
| Window | 2026-09-22 15:33:20 Z → 21:07:01 Z (5 h 34 m; trading stopped 17:30 Z) |
| Equity | $10 000.00 → $9 905.81 · `total_pnl` **−94.19** · `total_trades` 5 |
| Halt | `risk_events` 17:30:05 Z `consecutive_losses` — "8 >= 8", `dailyPnlUsd −94.19`, `dailyPnlR −1.88` (daily kill at −4 R not reached). 5 losses closed in-session; the counter reached 8 with state carried across the restart (mode-scoped risk restore, #46) — inference from the counts, not a log line. |
| Book | `trend_follow` only (momentum shelved by #55; breakout / vwap_mr Phase-3 KILL). Symbols BTC-USD, ETH-USD, SOL-USD + spot-proxy-mirrored `*-PERP-INTX` (ETH leg traded). |
| Fees charged | 10 taker fills $54.38 on $15 960.55 notional (34.1 bps blended: spot 40 bps, INTX leg 5 bps) + 1 maker fill $3.59 on $1 437.98 (25 bps). `fee_side_source = simulated` on every fill (#70 attribution works). |

### 1.2 The five trades (`trade_log` × `trade_outcomes`)

| # | Symbol | Side | Entry Z | Hold | Exit | Regime (ADX / conf) | Signal ATR % | Net P&L | Fees | Fees in R |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | SOL-USD | short | 15:39 | 3 min | stop_loss | weak_trend (26.0 / 0.30) | 0.12 % | −20.42 | 13.31 | 2.5 R |
| 2 | ETH-PERP-INTX | short | 15:57 | 93 min | stop_loss | weak_trend (20.4 / 0.02) | 0.11 % | −6.79 | 1.35 | 0.3 R |
| 3 | ETH-USD | short | 15:57 | 93 min | stop_loss | weak_trend (20.4 / 0.02) | 0.11 % | −16.26 | 10.82 | 2.7 R |
| 4 | SOL-USD | short | 15:58 | 54 min | stop_loss | weak_trend (23.2 / 0.16) | 0.12 % | −35.20 | 21.68 | 2.3 R |
| 5 | BTC-USD | short | 16:06 | 46 min | stop_loss | weak_trend (20.4 / 0.02) | 0.09 % | −15.51 | 10.81 | 3.5 R |
| **Σ** | | **5/5 short** | | | **5/5 stop_loss** | **5/5 weak_trend, conf ≤ 0.30** | **all < 0.5 % floor** | **−94.18** | **57.97 (62 %)** | |

Gross before fees **−$36.21**. R = realized P&L / `initial_risk` (`trade_outcomes.r_multiple`); a stop-out lands at −3.7 to −5.0 R because the modelled risk unit is $3–9 (2.5 × ATR on a 0.09–0.12 % ATR = a 0.23–0.32 % stop on ~$1.3–1.7 k notional) while one round trip of fees is $10.8–21.7.

### 1.3 Root causes, ranked

1. **Regime.** Every entry was `weak_trend` at ADX 20–26, confidence 0.02–0.30 — the exact cell A6 measured at PF 0.78 (90 d, n = 143) / 0.80 (12 m, n = 405). `regime_gates.enabled: false` (A6 shipped disabled, §7.3 "human decision"), so the gate that would have blocked all five was off. E5 §8: 97–100 % of TF entries carry `weak_trend`; E3: `strong_trend` is 3.1 % of TF candidates.
2. **Fee ≫ geometry.** Stop 0.23–0.32 % of price vs 80 bps round trip on the **paper** book = 2.3–3.5 R of fees per trade; under the live Intro book 1.8–2.4 % RT it is 5–10 R. The audit's EV-gate arithmetic (§3.3) needs ATR % ≥ 1.0–1.6 % on 15 m at 40 bps for EV > 0; the soak traded at 0.09–0.12 %.
3. **`atr_vol` filter is blind to `trend_follow` (parity bug, live and paper).** `api/server.ts:2408` reads `signal.metadata.indicators.atr`; TF stamps `metadata.atr` (`trend-follow-strategy.ts`, `backtest-engine.ts:1382` comment). `filters.atr_volatility_min: 0.005` (H2 fee-floor pin) should have rejected **all five** entries (ATR 0.09–0.12 %) and did nothing. Flagged in E3 §5 and E5 §8 as "not fixed under this card"; still open at `44e66d4`. One-line fix + test (§6).
4. **EV gate not binding.** `risk.min_ev_threshold: 0` + cold-start default-ALLOW without a win-rate history (`ev-gate.ts:26,91`; audit L6). Nothing at the router priced 2.3–3.5 R of fees against a 0.3 % stop.
5. **Not a live-representative book.** 4/5 trades were **shorts on spot** (`allow_short: true`, audit L4 / TASK_012 pending) — impossible on Coinbase spot live — and one leg was `ETH-PERP-INTX`, a venue this US account cannot access and whose Advanced Trade endpoints were retired 2026-09-09 (§4). The soak measured a book that cannot exist on the wire.

### 1.4 Context — the night before

`sess_1790017457369_hkub8j` (2026-09-21 19:04 Z → 09-22 03:35 Z): session row `total_trades` 6, **−$126.89**; `trade_log` 8 closed rows, 1 winner — `BTC-PERP-INTX` take-profit **+$2.26** (INTX, see above) — 7 losers incl. 3 `flatten` at the 03:35 Z stop and a BTC-USD `take_profit` that **lost −$7.48 after $11.12 fees** (gross +$3.64). All rows `weak_trend`, ADX 21.7–31.1. Two-day tally: ≈ −$221 on 13 closed trades, 1 winner (on a phantom venue).

### 1.5 Verdict

**Kill correct.** The halt fired as designed and the book has no path to positive expectancy at any fee book: gross negative, regime cell known-negative since May, fee drag 2–4 R/trade on the cheapest book. The soak is a **confirmation (n = 5)** of A6 / E3 / E5 / the audit, not new proof; do not fit anything to it (§7).

Ledger parity note (Eng housekeeping, not a trading fact): for `hkub8j` the three tables disagree on count — `trade_log` 8, `trading_sessions.total_trades` 6, `trade_outcomes` 10 (it carries ETH-USD/ETH-PERP flatten rows the log lacks) — and `trade_log` sums to −$130.15 vs the session's −$126.89. Same family as the FE-honesty fixes (#72–#74).

---

## 2. Fee reality — Intro vs paper FeeModel

### 2.1 The books (never averaged, never mixed — desk cite rule 2026-09-21, enforced by `pnpm check:config`)

| Book | Maker / taker (bps, per side) | Used for | Source |
|---|---|---|---|
| `PAPER-FeeModel-SPOT-25-40` | 25 / 40 | paper spot fills, backtest default, E4 GO fee book | `guardrails.fees.coinbase.spot` (yaml comment: "$10k–$50k tier" — that tier **no longer exists** on the public schedule) |
| `SPOT-INTRO-50-90` | 50 / 90 | desk cite for the live Intro tier; S3 Book A | `guardrails.yaml` fee-block comment; S3 §1.3 |
| Live preflight 2026-09-10 | **60 / 120** (Intro 1, 30-day volume $0) | S3 "A-pre" sensitivity; audit §3.1 | `pnpm cb:preflight` → `/transaction_summary` |
| Public schedule, read 2026-09-22 | Intro 1 **60 / 120** (≥ $0) · Intro 2 **40 / 80** ($10 K) · Advanced 1 **25 / 50** ($25 K) · Advanced 2 12.5 / 25 ($75 K) | reference only | coinbase.com/advanced-vip (fee level table) |
| CFM / CDE nano (cost-plus) | 9.5 / 10 + **$0.10 per contract per side** (≈ 1.2 bps at BTC $86 k) → ≈ 10.7 / 11.2 all-in | SH-QMAKER paper harness | `guardrails.fees.coinbase.cfm_nano`, cite CFM-NANO-H1-v0.2 (DRAFT); CDE fee schedule 2026-01-26 nano class $0.05–0.10/side |
| INTX perps | 0 / 5 | nothing (venue unreachable) | `fees.coinbase.perps_intx` |
| Hyperliquid | −1.5 / 4.5 | nothing (US excluded) | `fees.hyperliquid.perps` |

### 2.2 Reconciliation item (Research / Ops, before any GO pack)

The desk cite `SPOT-INTRO-50-90` matches **no** public tier (Intro 1 60/120, Intro 2 40/80) and disagrees with the only account read on record (60/120, 2026-09-10). Coinbase states per-user fees "may vary". Action: re-run `pnpm cb:preflight`, pin the live spot book from `/transaction_summary`, and record the cite. Until then quote **both** 50/90 and 60/120 as separate columns (S3 already does) — never a blend. Separately: the paper book 25/40 is 10 bps/side below the cheapest tier this account could plausibly reach ($25 K volume → 25/50) and 80 bps/side below today's tier; treat paper P&L as an **upper bound**.

### 2.3 The soak re-priced

| Book | Fees on the 5 trades | Net |
|---|---|---|
| Paper 25/40 (charged) | $57.97 | **−$94.19** |
| `SPOT-INTRO-50-90` (spot legs 90 bps taker / 50 maker, INTX leg unchanged) | ≈ $128 | ≈ **−$164** |
| Intro 1 60/120 | ≈ $169 | ≈ **−$205** |
| Zero fee (shape only) | $0 | −$36 |

### 2.4 Geometry that clears the fee (audit §3.3, EV in R = p·k − (1−p) − 2f/stop%)

| Setup | Min stop % @ 40 / 90 / 120 bps | Min 15 m ATR % (stop 2.5 × ATR) | Soak realized |
|---|---|---|---|
| TF TP 6 / SL 2.5 (k = 2.4) | 2.2 / 5.0 / 6.7 % | 0.9 / 2.0 / 2.7 % | **0.09–0.12 %** |
| TF TP 5 / SL 2.5 (k = 2.0) | 4.0 / 9.0 / 12.0 % | 1.6 / 3.6 / 4.8 % | — |

Typical 15 m ATR % is 0.4–1.0 %. There is no 15 m Coinbase-spot geometry that clears fees; that is the frequency lever the audit (§4.1) states and the E4 harness implements (fee as share of a 5 × ATR target: 15 m 32 %, 1 H 13 %, 4 H 6.4 %, 1 D 4.0 % at 80 bps RT) — and even 4 H failed its zero-fee floor (E4: PF 0.94 < 1.61).

---

## 3. HFT vs fee reality

| Tier | Round-trip cost floor | Infra | Who wins there |
|---|---|---|---|
| HFT / true market making | 0–2 bps, rebates, queue priority | colocated FIX, µs latency, inventory hedged across venues | firms with member fee schedules and colocation |
| Coinbase CFM nano, post-only both sides | ≈ **21–23 bps** (9.5 bps + $0.10/ct × 2, at BTC $86 k) | retail REST/WS, `max_requotes_per_sec: 4`, Fri 17:00–18:00 ET break, desk cap 2× | passive flow that is not adversely selected — **unproven**; this is exactly what SH-QMAKER-CFM-PAPER-v0 must measure (fill rate, `fee_side`, mark-out) |
| Coinbase spot, paper book | 50 bps maker/maker · 80 bps taker/taker | 15 m candle loop, `trade_cooldown_min: 15` (pin — 2–5 min round trips lost $370+ in fees) | nobody at 15 m (§2.4) |
| Coinbase spot, Intro 1 | 120 maker/maker · **240** taker/taker | same | nobody; ~$575–600/month fees at backtested frequency on $1 K (audit §4) |

Rate limits are the second wall: Advanced Trade WebSocket connections/unauthenticated messages 8 s⁻¹ per IP (docs.cdp.coinbase.com); Exchange REST private 15 s⁻¹ (burst 30). The runtime is a 15-minute candle loop on a PC / cloud VM. **Conclusion:** no HFT, no scalping, no sub-hour anything on Coinbase spot at any tier this account can reach. The only maker-side line the desk may run is CFM post-only, in paper, with the `fee_side` telemetry #70 added — and its all-in floor is still ~21 bps RT plus adverse selection.

---

## 4. Coinbase product / venue map

| Venue / product | This US account | Repo wire status @ `44e66d4` | Fee book | Shorts | Desk status |
|---|---|---|---|---|---|
| **Advanced Trade spot** (BTC-USD, ETH-USD, SOL-USD) | eligible; key `can_trade`, no transfer; **$2.90** available (09-10) | JWT `AdvancedTradeRestClient` + fail-closed factory (#39), `LiveAccountTruth` + `cb:preflight` (#45); live refused by three locks (§0) | §2.1 | **No** in live (spot long-only, TASK_012 pending); paper still shorts (`allow_short: true`) | Paper venue. Live **LOCKED** |
| **CFM → CDE nano futures / perp-style** (`BIP-20DEC30-CDE` 0.01 BTC, $0.05 tick; `ETP` 0.1 ETH unverified; nano SOL/XRP perp-style listed by CDE) | CFTC-regulated, US retail eligible; futures enablement on this account **not verified** (BIP `GET` domain-fail HTTP 400 on the research box 2026-09-21) | Paper harness infra landed (#70): true post-only / no-chase, `/orders/edit` + 429 throttle, `fee_side`, CFM FeeModel bucket, `CfmGuard` ≤ 2× kill, Fri flatten; **all builtins disabled** on the symbol; **no live `/cfm/*` path** | cost-plus 9.5/10 + $0.10/ct (DRAFT); venue marketing "as low as 0.02 %, $0.15 min/ct"; up to 10× intraday (desk 2×) | Yes | Paper harness only; **strategy GO absent** |
| **INTX perps** (`ETH-PERP-INTX`, `BTC-PERP-INTX`) | **not eligible** (non-US only) | spot-proxy candles mirrored, adapter initialised, paper trades them (soak leg #2; the only winner of 09-21) | 0/5 — irrelevant | Yes | **Dead on the wire**: Advanced Trade INTX endpoints retired 2026-09-09 (hard cutover to the Deribit-powered gateway `drb.coinbase.com`, JSON-RPC, `{BASE}_USDC-PERPETUAL`). De-emphasize (§6) |
| Coinbase Global Derivatives (Deribit gateway) | not eligible (non-US) | none | — | — | research-only |
| Coinbase Exchange / Prime (institutional) | n/a | legacy HMAC client refuses live (#39) | 40/60 bps at $0–10 K | — | out of scope |

### 4.2 Other venues — research-only, no adapter work before a strategy clears the bar on the wired venue

| Venue | Fees (small account, per side) | US retail | Read |
|---|---|---|---|
| Kraken Pro spot (tiers effective 2026-07-09) | Tier 1 40/80 (≥ $0) · Tier 2 30/60 ($2.5 K) · Tier 3 **22/38** ($10 K vol **or** $20 K assets on platform) | yes | cheaper than Coinbase at every retail tier ($10 K: 22/38 vs 40/80); still 60–76 bps RT taker; second unvalidated live path — **not now** |
| Kraken futures | Tier 1 2/5 bps | eligibility for this account **unverified** | research-only |
| Robinhood Crypto Trading API | v1 market-maker routing: 0 commission, spread includes ≈ 0.95 % rebate to RH; v2 exchange routing 0.95 % → 0.03 % by 30-day volume | yes | opaque spread cost at small size; no adapter; research-only |
| Hyperliquid perps | −1.5 / 4.5 | **no** (terms exclude US persons) | no; and no edge was found even at 4.5 bps (audit §2.1) |
| eToro | ≈ 1 % per trade | yes | no |

The binding constraint is signal quality × frequency, not venue (audit §7). The one venue that changes the arithmetic for a US account is CFM nano at ~21 bps RT maker — hence SH-QMAKER's rank in §5.

---

## 5. Ranked 2-week paper candidates

| Rank | Candidate | Venue / TF / book | Evidence today | Expected n in 2 weeks | What 2 weeks can prove | Eng prerequisite | Kill / stop rule |
|---|---|---|---|---|---|---|---|
| **1** | **TF-REGIME-GATE** — `trend_follow` × A6 `strong_trend`-only + `atr_vol` parity fix, spot long-only | Coinbase spot, 15 m, paper 25/40 (report Intro columns too) | A6: weak_trend PF 0.78/0.80 removed; TF book 12 m −$1 667 → +$441 at **HL fees** (n = 27); E3 REAL holdout: n = 26/yr, zf PF 1.18 → **HOLD** | ≈ 1 trade (26/yr); near-silence is the expected outcome | **Bleed stops** (paper P&L ≈ 0 instead of −$94/day); funnel `regime_gate` and `atr_vol` counters light up; live-parity of the two gates | flip `regime_gates.enabled: true` (TM sign-off per A6 §7.3; yaml is not drift-pinned); one-line `server.ts` `atr_vol` fallback to `metadata.atr` + test | any `weak_trend` entry or any entry with ATR % < 0.5 % = gate defect → stop and fix; not an edge test |
| **2** | **SH-QMAKER-CFM-PAPER-v0** — post-only passive line on `BIP-20DEC30-CDE` | CFM nano, paper, cost-plus book, spot-proxy quotes | Infra blockers 1–5 landed (#70); cheapest US-eligible book (~21 bps RT); **no strategy card GO, no signal routes** | fills depend on quoting cadence; even tens/day yield fill-rate / mark-out stats, not P&L evidence | fill rate, maker share (`fee_side`), adverse selection (mark-out), 429/edit counters, Fri-break behaviour, ≤ 2× cap never binds | strategy card v0 (quote/skew/inventory rules) from Algo + Research co-sign; remove `trend_follow` etc. from `cfm_symbols…disabled_strategies` **only** under that GO (drift-pinned) | any taker fill on the post-only line = policy breach → stop and fix; negative 5-min mark-out on ≥ 100 maker fills → stop; any `leverage_breach` kill → stop and review |
| **3** | **`donchian_daily_s3`** — daily Donchian in20/out10 long-only, pre-specified basket (6 or 12), default-off plugin | Coinbase spot, 1 D, Book A (SPOT-INTRO) charged in paper; close-evaluated exits only | S3: pooled Book A n = 298, +11.12 %, PF 3.08, CI [+4.26, +19.60] **PASS**; last 3 y CI [−0.91, +22.17], recent half +0.27 % **FAIL**; per-product 1/6; label **HOLD — paper only** | 0–3 pooled (6–8 trades/yr/product); note all six products were long/entering at the 09-21 close | drift detection only (are 2025–26 the new normal?); wiring parity (next-open fills, no venue stop) | new plugin (not the killed 15 m `breakout`), guardrails entry **default-off**, EV-gate wiring, fee book pinned to Book A; prereg of window + bar before start | pre-registered; no per-product promotion; any venue-side stop-market = design breach (flash-crash tail S3 §4.4) |
| — | TF on 4 H / 1 D (E4 harness) | spot | 4 H zf PF 0.94 < 1.61 floor → STOP; 1 D n = 6 → EXPLORATORY | — | nothing new | — | stays research |
| — | INTX perps (`*-PERP-INTX`) | INTX | venue retired 2026-09-09; not US-eligible | — | nothing; contaminates evidence | — | **remove from paper GO** |
| — | momentum · breakout · vwap_mr | — | E2-MOM-ISO KILL (#55) · Phase-3 KILL | — | — | — | stay killed |
| — | any live line | — | Stage 0 incomplete; $2.90 | — | — | — | locked |

Ranking rule: (evidence quality) × (what two weeks can actually measure) × (fee-book viability) × (Eng readiness). #1 is not an edge candidate; it is the cheapest way to stop the bleed and prove the two gates on the wire. #2 is the only line on a book where a maker strategy can be positive, and it is blocked on a strategy card, not on Eng. #3 is evidence-eligible on the letter of the pooled bar and fails on recency; two weeks of daily bars cannot move it — its value is in being pre-registered and default-off before anyone is tempted to size it.

---

## 6. Eng priority ladder — aligned with RM SoT, status at `44e66d4`

| # | Item | What | Status | Owner / gate |
|---|---|---|---|---|
| L1 | Live adapter uses legacy HMAC | Advanced Trade JWT adapter, fail-closed factory | **landed** #39 (TASK_010); legacy client refuses live | Eng |
| L2 | Preflight hard-codes Exchange URL | `cb:preflight` on Advanced Trade | **landed** #39/#45 | Eng |
| L3 | No exchange-side stops | bracket / stop on entry + boot reconciliation | **PENDING** TASK_013 | Eng; P0 before any live |
| L4 | `allow_short: true` ⇒ spot SELL = short | live profiles, spot long-only, perps off in live | **PENDING** TASK_012 (soak shorted spot 4/5) | Eng; P0 |
| L5 | Live equity fail-open $10 000 | `LiveAccountTruth` (equity, tier, specs) | **landed** #45 (TASK_011) | Eng |
| L6 | FeeModel static 25/40 in live | `withRuntimeOverride` from `/transaction_summary` | **landed** #45; EV-gate cold-start default-ALLOW **remains** (documented `ev-gate.ts`) | Eng; TM to decide `min_ev_threshold` after 30 paper days (pin) |
| — | Stage-0 remainder | TASK_014 persistence (partly landed #43/#46/#69/#74), TASK_015 control-plane security **PENDING**, TASK_016 dashboard (largely landed #58–#73) | `LIVE_STAGE0_COMPLETE` stays `false` until `verify_sprint9.cjs` green | Eng; TM flips in a reviewed PR |
| **7** | **TF-REGIME-GATE** | `regime_gates.enabled: true` (rule already shipped: block `trend_follow` in `weak_trend`) | code landed #52, **disabled**; A6 §7.3 requires human sign-off | **TM decision** (§10) |
| **7a (insert)** | **TF-ATR-FILTER-PARITY** | `server.ts` `atr_vol` stage reads `metadata.indicators.atr` **or** `metadata.atr` (mirror `backtest-engine.resolveEntryAtr`); test in `signal-processor`/routing suite | **open**; flagged E3 §5, E5 §8, soak §1.3 | Eng, one PR; same family as 7 |
| 8 | **SH-QMAKER paper harness** | strategy card → signal routing on `BIP-20DEC30-CDE`; keep post-only/no-chase, `fee_side`, ≤ 2×, Fri flatten | infra **landed** #70; strategy **absent** | Algo + Research card; Eng wiring under card GO |
| 9 | **`donchian_daily_s3` default-off** | new plugin + guardrails entry (disabled) + EV wiring + 1 D fixtures path; close-evaluated exits | S3 replication merged #75; plugin not built | Eng after 7/7a; Research prereg |
| 10 | **INTX de-emphasize** | stop paper-trading `*-PERP-INTX`: add `trend_follow` to `perps_symbols.*.disabled_strategies` (pin-compatible — `mustInclude: [momentum]` still holds); do **not** delete the blocks without a drift-pin PR; remove INTX rows from any evidence tables | endpoints retired 2026-09-09 | Eng one-liner; TM ack |
| 11 | Fee-book cite reconcile | `cb:preflight` → pin live spot book; record cite | open (§2.2) | Research / Ops |
| 12 | MetaFilter cold-streak latch semantics | decide intended behaviour (E5 §5); TF-only paper books silently stop after one 10-loss streak until restart | open | Eng + Risk; needed before any TF-only paper count is quoted |

---

## 7. What NOT to do

- Do not scratch or rewrite Apex; do not "start over on a new stack". The deficit is edge × fees.
- No agent autotrade. `CONFIRM_LIVE` stays `NO`; `LIVE_STAGE0_COMPLETE` and `ENGINE_LIVE_EXECUTION_WIRED` stay `false`; no Door B.
- Do not restart the TF-only 15 m spot paper book as-is (A6 off, `atr_vol` blind). It will reproduce −$94/day.
- Do not retune TF (ADX 40/20, ATR 2.5/6.0, EMA 12/15) to the soak or to any 15 m window; no ≤ 12 exit grid without pre-registration (E5 card).
- Do not average or mix fee books (25/40 · 50/90 · 60/120 · CFM cost-plus). Do not quote paper P&L as live-representative.
- Do not paper-trade `*-PERP-INTX` or count any INTX row as evidence.
- Do not re-enable momentum, breakout or vwap_mr; do not confuse the killed 15 m `breakout` plugin with `donchian_daily_s3`.
- Do not quote S3's 6-coin +10.9 / +11.1 %; quote the 12-coin +7.35 % or ex-2017 +7.13 %, and always with the recency FAIL.
- Do not attach a venue-side stop-market to a daily Donchian line on Coinbase spot (2017 flash-crash prints → −36 % / −99.8 % fills).
- Do not build Kraken / Robinhood adapters before a strategy clears the bar on the wired venue.
- Do not "buy" a fee tier with volume; the tier trap is structural (audit §4).
- Do not count a TF-only paper book's n until the cold-streak latch semantics are decided (E5 §5).

---

## 8. 48-hour plan

| # | Action | Owner | Output / gate |
|---|---|---|---|
| 1 | Keep the paper engine halted (kill switch `consecutive_losses` active); no restart of the current book | Ops / TM | no new soak rows |
| 2 | PR: `TF-ATR-FILTER-PARITY` (§6 #7a) — `server.ts` `atr_vol` fallback to `metadata.atr`, test asserting a 0.1 % ATR TF signal is rejected `atr_below_min` | Eng | `pnpm test` green, `check:config` OK |
| 3 | TM decision: flip `regime_gates.enabled: true` (paper; live is locked anyway) — yes/no | TM | one-line yaml PR with A6 §7.3 sign-off in the body |
| 4 | PR: INTX de-emphasize — `perps_symbols.{ETH,BTC}-PERP-INTX.disabled_strategies: [momentum, trend_follow]` | Eng | drift check still green; no `*-PERP-INTX` orders in paper |
| 5 | `pnpm cb:preflight` → pin the live spot fee book, record the cite (§2.2) | Research / Ops | cite line in `guardrails.yaml` comment or a research note |
| 6 | Ledger parity ticket: `trade_log` 8 / `trading_sessions` 6 / `trade_outcomes` 10 for `hkub8j` | Eng (FE honesty family) | root cause + fix scope |
| 7 | Restart paper **only after 2–4**: TF × A6 × ATR-parity, spot long-only symbols; verify `regime_gate` / `atr_vol` counters on `/metrics` within the first hour | Eng / Ops | first-hour funnel screenshot in the run log |

## 9. Two-week plan

| Week | Track | Deliverable | Kill / decision rule |
|---|---|---|---|
| 1 | Ladder | TASK_012 (long-only, perps off in live) and TASK_013 (exchange-side stops) specs → PRs; TASK_015 scoped; `verify_sprint9.cjs` status table | Stage 0 stays closed until all six verify green |
| 1 | Candidate #1 | paper TF × A6 × ATR-parity running; daily funnel readout (`regime_gate`, `atr_vol`, `ev_gate` counts; entries by regime) | any `weak_trend` or ATR < 0.5 % entry ⇒ stop, fix gate |
| 1 | Candidate #2 | Algo + Research deliver SH-QMAKER strategy card v0 (quote rules, skew, inventory cap, cadence within `max_requotes_per_sec: 4`); Eng wires signal → `BIP-20DEC30-CDE` under the card GO | no card ⇒ harness stays idle (that is fine) |
| 1 | Candidate #3 | `donchian_daily_s3` plugin skeleton, default-off, own guardrails block, EV wiring; Research pre-registers window, basket, bar, fee book | not started in paper until prereg is on file |
| 2 | Candidate #1 | 14-day readout: P&L (expect ≈ 0), n (expect ≤ 2), gate counters, zero INTX rows | P&L bleed with gates on ⇒ gate defect, not edge news |
| 2 | Candidate #2 | first fill-rate / maker-share / 5-min mark-out table; 429 and edit counters; Fri-break drill | any taker fill ⇒ policy breach; negative mark-out on ≥ 100 maker fills ⇒ stop |
| 2 | Candidate #3 | paper basket start (shadow) if prereg + plugin landed; first daily rows | drift only; no sizing decisions |
| 2 | TM package | this memo + week-2 readouts + Stage-0 status → TM; apply Sprint 9 Stage 3 kill rule (2 weeks; PF ≥ 1.2, ≥ 60 trades / 12 m, ≥ 3/4 quarters, DD ≤ 15 %, REAL, long-only) to anything claiming edge | nothing clears ⇒ record the decision, keep live locked, keep #2/#3 as paper-only telemetry lines |

## 10. Decisions requested from TM

1. Flip `regime_gates.enabled: true` for the paper book (A6 §7.3 sign-off) — recommended **yes**.
2. Accept **TF-ATR-FILTER-PARITY** as an insert next to TF-REGIME-GATE in the ladder — recommended **yes** (one line, test-backed, explains the soak).
3. INTX de-emphasize via per-symbol `disabled_strategies` now; block deletion later with a drift-pin PR — recommended **yes**.
4. Fee-book cite: which Intro book is SoT after the preflight re-read (50/90 vs 60/120); keep the paper book at 25/40 as an explicit **upper bound**, or re-pin — Research to propose.
5. SH-QMAKER: who signs the strategy card GO (Algo + Research co-sign per the 2026-09-21 desk SoT) and by when.
6. `donchian_daily_s3`: build default-off in week 1 (after 7/7a) or defer until Stage 0 closes.

---

## Appendix A — evidence and reproduction

**Repo checks (2026-09-22, `main @ 44e66d4`):** `cd atlas/apps/core-node && pnpm test` → 84 files / 1 289 tests pass (15.6 s); `pnpm check:config` → "OK — single-source guardrails and desk pins intact". Locks: `core/env.ts:32` (`CONFIRM_LIVE` default `NO`), `api/server.ts:1300`, `trading/execution/live-stage0-gate.ts:37`, `trading/execution/adapter-factory.ts:69`. ATR filter input: `api/server.ts:2408`; TF stamps `metadata.atr` (`backtest-engine.ts:1378-1392` comment, `resolveEntryAtr`). Drift pins: `config/config-drift.ts:86-112`.

**Supabase (read-only SQL via MCP, 2026-09-22 ~21:35 Z):**

```sql
-- sessions
select session_id, mode, execution_mode, started_at, ended_at, initial_equity, final_equity, total_trades, total_pnl, realized_pnl
from trading_sessions where started_at >= '2026-09-01' order by started_at desc;
-- trades + regime context
select session_id, strategy, symbol, side, entry_time, exit_time, duration_seconds, realized_pnl, fees, exit_reason
from trade_log where entry_time >= '2026-09-20' order by entry_time;
select session_id, symbol, signal_direction, entry_time, regime, regime_confidence, adx, atr_percent, choppiness, exit_reason, realized_pnl, fees, r_multiple
from trade_outcomes where entry_time >= '2026-09-20' order by entry_time;
-- fee attribution
select session_id, maker, fee_side, fee_side_source, count(*), sum(fee_amount), sum(price*quantity)
from fills where filled_at >= '2026-09-20' group by 1,2,3,4;
-- halt
select triggered_at, event_type, execution_mode, details from risk_events where triggered_at >= '2026-09-01';
```

**Public sources read 2026-09-22:** coinbase.com/advanced-vip (Advanced fee levels: Intro 1 0.600/1.200 %, Intro 2 0.400/0.800 % at $10 K, Advanced 1 0.250/0.500 % at $25 K); help.coinbase.com Advanced fees (tier at order time, 30-day USD volume); docs.cdp.coinbase.com Global Derivatives overview + INTX partner migration guide (INTX trading ends 2026-09-09, hard cutover to `drb.coinbase.com` JSON-RPC, `{BASE}-PERP-INTX` → `{BASE}_USDC-PERPETUAL`); coinbase.com blog "Perpetual futures have arrived in the U.S." (CFM, 2025-07-21, up to 10× intraday, "as low as 0.02 %", $0.15 minimum per contract); CFTC filing 2025-32 (BIP: 0.01 BTC, $0.05 tick, 5-year cash-settled); Coinbase Derivatives fee schedule effective 2026-01-26 (nano class $0.07/$0.05/$0.10/$0.05/$0.10/$0.05 per side per contract); docs.cdp.coinbase.com Advanced Trade WebSocket rate limits (8 s⁻¹ per IP); Kraken support "Cross-platform fee tier changes (July 2026)"; Robinhood Crypto Trading API help + RHC fee schedule.

**Not done here:** no backtest re-runs, no fixture changes, no config or code changes, no orders, no live preflight (needs the desk key — Ops action §8 #5). The prior run's (`bc-e2e8ca08`) partial output was not recoverable; nothing from it is quoted.
