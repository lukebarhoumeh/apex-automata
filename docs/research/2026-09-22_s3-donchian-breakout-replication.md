> Repo copy of the desk deliverable `artifacts/apex-s3-breakout-replication-2026-09-22.md` (identical content). Supporting files (simulator port, fetched candles with sha256, machine-generated tables, per-trade JSON) are attached to the Cloud Agent run as artifacts and are reproducible from Appendix B.

# APEX-S3-BRK-REPL — Independent replication of Claude's S3 D-BRK (daily Donchian in20/out10) — arithmetic **VERIFIED** · pooled full-sample **clears** the desk bar · recency **FAILS** · per-product **1/6**

**Date:** 2026-09-22 · **Repo:** `main @ 2d1bbe4` · **Requested by:** Apex desk (hand-off from Claude, Robinhood Agentic desk) · **Audience:** TM + Algo + Risk
**Authority:** read-only research. No orders, no API keys, no `CONFIRM_LIVE`; live stays locked. Nothing in `guardrails.yaml`, `strategies/**` or `trading/**` was touched. This note does not make this rule a strategy, a paper line or a GO.
**Inputs:** `prereg-crypto-2026-09-22.md` (pre-registration), `crypto_bt.py` (Claude's harness; `sim_brk` ported line-for-line), `results-crypto-2026-09-22.txt` (Claude's raw output).
**Fee-book SoT:** Book A = `atlas/config/guardrails.yaml` desk cite **`SPOT-INTRO-50-90`** (comment block, desk cite rule 2026-09-21: 50 bps maker / 90 bps taker) + the `backtest:` realism pins (`entry_slippage_bps: 5`, `stop_overshoot_bar_range_pct: 0.20`, `stop_overshoot_min_bps: 5`). The yaml `fees.coinbase.spot` bucket (25/40, `PAPER-FeeModel-SPOT-25-40`) is the PAPER book and is **not** used here. Book B = Claude's T1 header (0.95 % taker + 0.10 % slip per side). The two books are never averaged or mixed in one number.

---

## 0. Verdict

| Question | Answer |
|---|---|
| Does Claude's arithmetic reproduce? | **YES.** A same-source (Bitstamp) run of the ported simulator reproduces all six per-coin rows to the decimal and re-derives the 12-coin headline exactly: **n = 556, avg +7.35 %, median −5.52 %, win 35 %, PF 2.14**; month-clustered CI **[+1.19 %, +14.57 %]** vs their [+1.15 %, +14.28 %] (difference = bootstrap PRNG only). |
| Same shape on the desk venue (Coinbase)? | **YES.** Six products, Coinbase daily, **Book B:** n = 298, avg **+10.89 %**, median **−3.31 %**, win 41 %, PF 3.00, CI [+4.05 %, +19.36 %]. **Book A (SPOT-INTRO-50-90):** n = 298, avg **+11.12 %**, median −3.11 %, win 41 %, PF 3.08, CI [+4.26 %, +19.60 %]. Right-tail-driven; the majority of trades lose. |
| Apex bar (both halves > 0, PF ≥ 1.2, month-clustered CI excludes 0) — pooled, full sample | **PASS** under Book A, Book B, and the Intro-1 120 bps sensitivity. Also PASS with the 2017 bull run removed (pooled from 2018: +7.13 %, PF 2.26, CI [+1.02 %, +13.88 %]). |
| Apex bar — last 3 years (entries ≥ 2023-09-21) | **FAIL.** CI includes zero (B: [−1.11 %, +21.92 %]; A: [−0.91 %, +22.17 %]) and the most recent half (2025-03 → 2026-09) is **+0.06 % (B) / +0.27 % (A)** — flat. 2025 full year +0.50 %, 2026 YTD −2.56 %. |
| Apex bar — per product | **1 of 6 passes** (BTC, and only with H2 = +0.71 %). ETH fails halves (H2 −1.11 %), DOGE fails halves (H1 −1.44 %), XRP / SOL / XLM fail the CI. No product reaches the prereg's own n ≥ 100. Without 2017, BTC fails too (CI [−1.13 %, +6.26 %]). |
| 15 % fixed stop (entry × 0.85) | Does **not** help: pooled B +8.93 % (from +10.89 %), PF 2.66; pooled A +8.59 %, PF 2.48. Under the Apex stop-overshoot model it also exposes the flash-crash tail of a venue-side stop-market on Coinbase spot (ETH 2017-06-21 GDAX print, low $0.10 → **−99.8 %**; BTC 2017-04-15 → −36 %). |
| Would this clear the desk evidence bar for a **paper candidate**? | **On the letter of the pooled bar, yes; on recency and per-product, no.** Honest read: the expectancy is a bull-regime trend premium (2017, 2020–21, 2023–24), flat-to-negative in 2018–19, 2022, 2025–26; the six-product pooled figure is inflated ~4 pts by selection (these are 6 of Claude's 12 coins, four of them their own "PASS" companions; Bitstamp 6-coin +11.34 % vs 12-coin +7.35 % on the same data) and by the 2017 history on Coinbase (+10.89 % → +7.13 % from 2018). Recommendation in §7: **HOLD — paper candidate only with the conditions listed; not live evidence.** |

---

## 1. What was replicated

### 1.1 Rule (exact, no parameter search)

Long-only, daily bars (UTC), one position per product:

- **ENTER** on the first daily close **above the prior 20-day closing high** (rolling max of the previous 20 closes, current bar excluded) → buy at the **next bar's open**, taker.
- **EXIT** on the first daily close **below the prior 10-day closing low** (rolling min of the previous 10 closes, current bar excluded) → sell at the **next bar's open**, taker.
- **Primary report: no trail, no stop.** Sensitivity: **fixed stop at entry × 0.85**, venue-side, checked intrabar (`low ≤ stop`), not trailing. Prereg S3 trail 3×ATR(14) reported once, pooled, as a variant — not the primary.

### 1.2 Mechanics — line-for-line port of `sim_brk` (crypto_bt.py)

- Net return per trade: `net = (exit / entry) × (1 − fee)² − 1` with `entry = open[j] × (1 + slip)`, rule exit `= open[j+1] × (1 − slip)` (fee = taker rate of the book, slip = the book's per-side slippage).
- After a rule exit at `open[j+1]`, the earliest re-entry signal is the close of `j+1` (entry at `open[j+2]`) — identical to Claude's `i += 2`.
- The entry bar itself is not checked for an exit (Claude's mechanics); positions open at the end of a series are **not counted** as trades (Claude's mechanics) — listed separately in §5.4.
- Stop fills: **Book B** at `stop × (1 − slip)` (Claude). **Book A** with the Apex realism model `fill = stop − max(0.20 × (high − low), 5 bps × stop)`, **floored at the bar's low** (a fill below the traded range is impossible; the engine's `computeStopOvershoot` has no such floor — see §8).
- Series are split at gaps > 5 days so no rolling window straddles a delisting (only Coinbase XRP is affected: 2021-01-19 → 2023-07-13). Indicators warm up per segment.
- Stats: n, win %, arithmetic mean and median net, PF = Σwins / |Σlosses|, halves by **entry date at the midpoint of that series' own date range** (pooled: midpoint of the union range, 2021-11-11), **month-clustered bootstrap 95 % CI** of the mean (clusters = calendar month of entry across all products in the pool, 2 000 resamples, seeded; quarter-clustered CI as a robustness check), sequential full-sizing total / max-DD per product, median hold, top-3-trade share of Σlog(1+net).

Verification of the port: on Claude's own data source the six per-coin rows and the 12-coin pooled row match theirs to the reported precision (§3).

### 1.3 Fee books (never mixed)

| Book | Fee / side | Slippage / side (market fills) | Stop-fill model | Source |
|---|---|---|---|---|
| **B — Claude T1** (apples-to-apples) | 0.95 % taker | 0.10 % | `stop × (1 − 0.10 %)` | `results-crypto-2026-09-22.txt` header: "fee T1 (taker in/out 0.95 % + 0.1 % slip each)" |
| **A — Apex SPOT-INTRO-50-90** (desk SoT, primary) | 0.90 % taker (taker in and out — breakout entries/exits are marketable) | 5 bps (`guardrails.backtest.entry_slippage_bps`, applied symmetrically to market exits as the engine does) | Apex overshoot `max(0.20 × bar range, 5 bps)`, floored at bar low | `guardrails.yaml` fee block comment (desk cite rule 2026-09-21); `backtest:` pins |
| **A-pre — live preflight tier** (sensitivity) | 1.20 % taker | 5 bps | as A | `docs/research/2026-09-10_live-readiness-audit.md`: Intro 1 = 60 / 120 bps at $0 30-day volume (`cb:preflight`, 2026-09-10) |
| GROSS (reference) | 0 | 0 | — | shape only, never a decision number |

Which Intro tier: the task says SPOT-INTRO-50-90 "if present in guardrails" — it is present as the desk cite for the live Intro tier, so Book A uses 90 bps. The last recorded live preflight (2026-09-10) reported Intro 1 = 60/120; that is reported as the A-pre sensitivity, never averaged into A. Round-trip cost: B 2.10 %, A 1.90 %, A-pre 2.50 %. Fee sensitivity is modest at this frequency (median hold 13–15 days): pooled gross +13.26 % → B +10.89 % → A +11.12 % → A-pre +10.45 %.

### 1.4 Why not the in-repo `BacktestEngine`

`pnpm backtest` / `backtest-e4` run the strategy-plugin stack: risk-based sizing (`risk_per_trade`), max-position and exposure caps, the ATR volatility pre-filter, the A3 EV gate, kill lists (`disabled_strategies` includes `breakout` — the 15-minute ATR/volume breakout plugin, a different rule), regime gates and ATR-trail / time-stop exit parity. All of that would change the trade list and make the numbers non-comparable to Claude's. The repo harness **was** used for what it is good at: `pnpm backtest:backfill` fetched the Coinbase candles into `BarFixtureFile` documents with provenance, the committed REAL 1d fixtures were used as the data base for BTC/ETH/SOL, and the fee/slippage pins were read from `loadGuardrails()` (single source of truth). The rule itself is a ~60-line port (Appendix A) run under `tsx` with zero new dependencies.

---

## 2. Data provenance (deliverable 5)

### 2.1 Coinbase (desk venue) — primary, grade REAL

All native `ONE_DAY` candles from the Coinbase Advanced Trade public endpoint `GET /api/v3/brokerage/market/products/{id}/candles` (the same endpoint and format as the committed fixtures). Bar timestamps = bar start UTC. Window: 2017-01-01 → **2026-09-21** (last completed UTC day; the partial 2026-09-22 bar is excluded — Claude's data note runs to 2026-09-22).

| Product | Bars | Window | Source segments (priority: committed fixture > same-endpoint fetch) | Fixture-vs-fetch overlap |
|---|---|---|---|---|
| BTC-USD | 3 551 | 2017-01-01 → 2026-09-21 | `fixtures/bars/1d/tune-2017-01_2025-03/BTC-USD.json` (2 981 bars, sha256 `0308ba0d72da994d…c4a039`) · `fixtures/bars/1d/BTC-USD.json` SEALED (730 bars, sha256 `06461bafd9b1c41a…a988aa`, locked per `1d/README.md`) · public fetch 2026-09-01 → 09-21 (21 bars) | 3 711 candles compared, **0 mismatches** |
| ETH-USD | 3 551 | 2017-01-01 → 2026-09-21 | `tune-2017-01_2025-03/ETH-USD.json` (2 981, `eaa217768fc4f738…6d9e3`) · `1d/ETH-USD.json` SEALED (730, `a3f0bb3db6c59ee7…e36d823ca`) · fetch 2026-09-01 → 09-21 (21) | 3 711 compared, **0 mismatches** |
| SOL-USD | 1 923 | 2021-06-17 → 2026-09-21 | fetch 2021-06-17 → 2024-08-31 (1 172) · `1d/SOL-USD.json` SEALED (730, `2ac85db5d421cfe1…c08c45c2`) · fetch 2026-09-01 → 09-21 (21) | 730 compared, **0 mismatches** |
| XRP-USD | 1 861 | 2019-02-26 → 2021-01-19 (694) **gap** 2023-07-13 → 2026-09-21 (1 167) | fetch only (no committed fixture); sha256 `645df1386e887216…e43a5d`. Gap = Coinbase XRP suspension; treated as two independent segments | — |
| XLM-USD | 2 749 | 2019-03-14 → 2026-09-21 | fetch only; `7d94c1c7c2c49659…1ebb5` | — |
| DOGE-USD | 1 937 | 2021-06-03 → 2026-09-21 | fetch only; `d23b2efb2ab91ddc…87f837` | — |

Grade: **REAL** for all six (real venue candles, no rollup, no synthetic). BTC/ETH/SOL have the committed sha256-locked fixtures as their base and the fetched extension is byte-equivalent on every overlapping candle. XRP/XLM/DOGE are REAL but **not committed fixtures** (fetched 2026-09-22, files under `/tmp/apex-s3/data/coinbase/`, attached to this note's artifact set). Fixture rules honoured: nothing under `fixtures/bars/1d/` was regenerated or edited.

### 2.2 Bitstamp — secondary, same source as Claude's cross-coin table

Bitstamp public OHLC v2 (`/api/v2/ohlc/{pair}/?step=86400`), 2017-01-01 → 2026-09-21. Bar counts equal Claude's data note minus the partial 2026-09-22 bar: XRP 3 551, BTC 3 551, ETH 3 324 (from 2017-08-16), XLM 2 308 (2020-05-28), SOL 1 496 (2022-08-18), DOGE 1 371 (2022-12-21); plus ADA 1 770, HBAR 1 811, LINK 2 164, AVAX 1 659, LTC 3 385, SUI 1 236 for the 12-coin headline only. Used solely to verify Claude's arithmetic; the desk-venue answer is §4.

---

## 3. Same-source verification of Claude's numbers (Bitstamp, Book B, no stop)

| Coin | Apex port: n / avg / PF / H1 / H2 | Claude: n / avg / PF / H1 / H2 | Match |
|---|---|---|---|---|
| XRP | 65 / +25.22 % / 5.09 / +40.03 / +7.95 | 65 / +25.2 % / 5.09 / +40.0 / +7.9 | exact |
| ETH | 67 / +6.81 % / 2.28 / +16.09 / −0.72 | 67 / +6.8 % / 2.28 / +16.1 / −0.7 | exact |
| DOGE | 25 / +7.44 % / 2.43 / +13.74 / −2.01 | 25 / +7.4 % / 2.43 / +13.7 / −2.0 | exact |
| BTC | 74 / +5.87 % / 2.32 / +10.73 / +1.01 | 74 / +5.9 % / 2.32 / +10.7 / +1.0 | exact |
| SOL | 30 / +12.90 % / 3.99 / +26.08 / +1.36 | 30 / +12.9 % / 3.99 / +26.1 / +1.4 | exact |
| XLM | 44 / +8.09 % / 2.20 / +4.64 / +12.23 | 44 / +8.1 % / 2.20 / +4.6 / +12.2 | exact |
| **12-coin pooled** | **556 / +7.35 % / med −5.52 % / win 35 % / PF 2.14 / CI [+1.19 %, +14.57 %]** | 556 / +7.35 % / −5.52 % / 35 % / 2.14 / CI [+1.15 %, +14.28 %] | exact; CI = PRNG noise |
| 12-coin pooled, last 3 y | 276 / +6.19 % / PF 2.00 / CI [−3.52 %, +18.54 %] | 274 / +6.24 % / 2.00 / CI [−3.64 %, +19.02 %] | ≈ (their cut is one day later) |
| 12-coin pooled, 15 % fixed stop | 565 / +7.04 % / PF 2.08 / CI [+1.11 %, +14.37 %] | 566 / +6.99 % / CI [+0.95 %, +14.44 %], worst −17 % | ≈ (one trade; their fixed-stop code is not in `crypto_bt.py`) |

Their own 12-coin table also reproduces coin-by-coin (ADA −1.27 % PF 0.86; HBAR +9.40 % 2.06; LINK −0.34 % 0.95; AVAX +6.67 % 1.93; LTC +1.68 % 1.22; SUI +1.59 % 1.22 — all equal to their rows at the reported precision). **Conclusion: the cited headline is a correct computation of the stated rule on the stated data.** Whether it is *evidence* is §6–§7.

---

## 4. Coinbase (desk venue) — per-product tables (deliverable 1)

Columns: n · avg net · median · win · PF · H1 avg (n) · H2 avg (n) · month-clustered 95 % CI · sequential full-sizing total / max-DD (per product only) · median hold. Per-product halves split at each product's own range midpoint; pooled halves at 2021-11-11.

### 4.1 Book B — Claude T1 (0.95 % + 0.10 % per side), NO stop — apples-to-apples

| Product | n | avg net | median | win | PF | H1 avg (n) | H2 avg (n) | month-clustered 95% CI | total / maxDD (seq.) | med hold |
|---|---|---|---|---|---|---|---|---|---|---|
| XRP-USD | 34 | +10.30% | -4.76% | 35% | 2.83 | +4.10% (15) | +15.19% (19) | [-3.52%, +32.30%] | +296% / -45% | 13d |
| SOL-USD | 36 | +20.35% | -0.19% | 50% | 5.00 | +38.17% (17) | +4.41% (19) | [-0.68%, +49.38%] | +2176% / -54% | 14d |
| XLM-USD | 53 | +4.76% | -5.88% | 28% | 1.62 | +1.38% (26) | +8.02% (27) | [-4.71%, +18.00%] | -10% / -77% | 13d |
| BTC-USD | 73 | +6.16% | -2.78% | 41% | 2.38 | +12.08% (35) | +0.71% (38) | [+1.41%, +11.84%] | +1833% / -63% | 14d |
| ETH-USD | 71 | +17.92% | -0.68% | 48% | 4.58 | +39.84% (33) | -1.11% (38) | [+3.93%, +37.85%] | +37568% / -54% | 15d |
| DOGE-USD | 31 | +6.10% | -2.20% | 39% | 2.19 | -1.44% (14) | +12.31% (17) | [-4.30%, +22.06%] | +98% / -33% | 13d |
| **POOLED (6)** | **298** | **+10.89%** | **-3.31%** | **41%** | **3.00** | **+20.83% (108)** | **+5.25% (190)** | **[+4.05%, +19.36%]** | n/a (multi-product) | 14d |
| POOLED last 3y (entries ≥ 2023-09-21) | 129 | +9.14% | -3.64% | 36% | 2.89 | +18.08% (65) | +0.06% (64) | [-1.11%, +21.92%] | n/a | 13d |

Pooled: 95 entry-month clusters; quarter-clustered CI [+3.01 %, +20.11 %]; 6/6 products avg > 0; 298 rule exits / 0 stops; top-3 trades = 34 % of Σlog(1+net).

XRP note: H1 (n = 15, +4.10 %, PF 1.63) is exactly the 2019-04 → 2020-11 pre-suspension segment and H2 (n = 19, +15.19 %, win 37 %, PF 4.10) the post-relisting segment (entries 2023-09-21 → 2026-08-20) — the latter matches Claude's Coinbase XRP row (`in20/out10 … n=19 win=37% T1 +15.19% PF=4.10`) to the decimal.

### 4.2 Book A — Apex SPOT-INTRO-50-90 (0.90 % + 5 bps per side), NO stop — desk SoT

| Product | n | avg net | median | win | PF | H1 avg (n) | H2 avg (n) | month-clustered 95% CI | total / maxDD (seq.) | med hold |
|---|---|---|---|---|---|---|---|---|---|---|
| XRP-USD | 34 | +10.52% | -4.57% | 35% | 2.91 | +4.31% (15) | +15.42% (19) | [-3.33%, +32.56%] | +324% / -44% | 13d |
| SOL-USD | 36 | +20.60% | +0.01% | 50% | 5.12 | +38.45% (17) | +4.62% (19) | [-0.48%, +49.68%] | +2346% / -53% | 14d |
| XLM-USD | 53 | +4.97% | -5.69% | 28% | 1.66 | +1.59% (26) | +8.23% (27) | [-4.52%, +18.24%] | -0% / -76% | 13d |
| BTC-USD | 73 | +6.37% | -2.59% | 42% | 2.46 | +12.31% (35) | +0.91% (38) | [+1.62%, +12.07%] | +2138% / -62% | 14d |
| ETH-USD | 71 | +18.16% | -0.48% | 49% | 4.70 | +40.12% (33) | -0.91% (38) | [+4.14%, +38.12%] | +43344% / -51% | 15d |
| DOGE-USD | 31 | +6.32% | -2.00% | 39% | 2.26 | -1.24% (14) | +12.54% (17) | [-4.11%, +22.31%] | +111% / -33% | 13d |
| **POOLED (6)** | **298** | **+11.12%** | **-3.11%** | **41%** | **3.08** | **+21.07% (108)** | **+5.46% (190)** | **[+4.26%, +19.60%]** | n/a (multi-product) | 14d |
| POOLED last 3y (entries ≥ 2023-09-21) | 129 | +9.36% | -3.44% | 36% | 2.99 | +18.31% (65) | +0.27% (64) | [-0.91%, +22.17%] | n/a | 13d |

Pooled: 95 entry-month clusters; quarter-clustered CI [+3.22 %, +20.35 %]; 6/6 products avg > 0; top-3 trades = 33 % of Σlog(1+net). Book A is 20 bps/round-trip cheaper than Book B, hence marginally higher everywhere; the trade list is identical (same signals, no stops).

### 4.3 Sensitivity — live preflight tier Intro 1 (1.20 % + 5 bps per side), NO stop

| Product | n | avg net | median | win | PF | H1 avg (n) | H2 avg (n) | month-clustered 95% CI | total / maxDD (seq.) | med hold |
|---|---|---|---|---|---|---|---|---|---|---|
| XRP-USD | 34 | +9.85% | -5.14% | 35% | 2.68 | +3.67% (15) | +14.73% (19) | [-3.91%, +31.76%] | +245% / -46% | 13d |
| SOL-USD | 36 | +19.87% | -0.59% | 44% | 4.76 | +37.61% (17) | +3.99% (19) | [-1.08%, +48.78%] | +1867% / -57% | 14d |
| XLM-USD | 53 | +4.34% | -6.26% | 28% | 1.55 | +0.97% (26) | +7.58% (27) | [-5.10%, +17.52%] | -28% / -79% | 13d |
| BTC-USD | 73 | +5.73% | -3.18% | 41% | 2.22 | +11.63% (35) | +0.30% (38) | [+1.00%, +11.39%] | +1338% / -66% | 14d |
| ETH-USD | 71 | +17.45% | -1.09% | 46% | 4.36 | +39.28% (33) | -1.51% (38) | [+3.51%, +37.29%] | +28146% / -61% | 15d |
| DOGE-USD | 31 | +5.67% | -2.60% | 39% | 2.06 | -1.84% (14) | +11.86% (17) | [-4.69%, +21.57%] | +75% / -35% | 13d |
| **POOLED (6)** | 298 | +10.45% | -3.70% | 40% | 2.84 | +20.34% (108) | +4.82% (190) | [+3.63%, +18.88%] | n/a | 14d |
| POOLED last 3y | 129 | +8.70% | -4.03% | 34% | 2.72 | +17.60% (65) | **-0.34% (64)** | [-1.51%, +21.43%] | n/a | 13d |

GROSS reference (0 fee, 0 slip), pooled: n = 298, +13.26 %, median −1.25 %, win 48 %, PF 4.03, CI [+6.27 %, +21.91 %]; last 3 y +11.47 %, H2 +2.20 %. Even at zero cost the recent half is ~2 %.

### 4.4 Sensitivity — fixed stop at entry × 0.85 (15 %), not trailing

**Book B (stop fill = stop × (1 − 0.10 %)):**

| Product | n | avg net | median | win | PF | H1 avg (n) | H2 avg (n) | month-clustered 95% CI | total / maxDD (seq.) | med hold |
|---|---|---|---|---|---|---|---|---|---|---|
| XRP-USD | 34 | +10.55% | -4.76% | 35% | 2.96 | +3.86% (15) | +15.83% (19) | [-3.17%, +33.08%] | +345% / -47% | 13d |
| SOL-USD | 36 | +20.49% | -0.19% | 50% | 5.14 | +38.47% (17) | +4.41% (19) | [-0.45%, +49.42%] | +2319% / -52% | 14d |
| XLM-USD | 54 | +5.57% | -6.09% | 28% | 1.84 | +3.45% (26) | +7.55% (28) | [-3.66%, +18.46%] | +76% / -75% | 12d |
| BTC-USD | 75 | +5.14% | -3.64% | 40% | 2.05 | +9.98% (37) | +0.43% (38) | [+0.67%, +10.00%] | +962% / -65% | 14d |
| ETH-USD | 71 | +10.11% | -1.55% | 46% | 2.94 | +23.05% (33) | -1.13% (38) | [+1.88%, +21.78%] | +4925% / -54% | 15d |
| DOGE-USD | 31 | +6.04% | -2.20% | 39% | 2.16 | -1.62% (14) | +12.35% (17) | [-4.24%, +21.93%] | +94% / -35% | 13d |
| **POOLED (6)** | 301 | +8.93% | -3.49% | 40% | 2.66 | +15.39% (110) | +5.21% (191) | [+3.11%, +15.65%] | n/a | 14d |
| POOLED last 3y | 129 | +9.31% | -3.64% | 36% | 3.00 | +18.27% (65) | +0.21% (64) | [-0.95%, +22.04%] | n/a | 13d |

35 stop exits / 266 rule exits. The stop lowers the pooled mean by ~2 pts: it mostly converts eventual winners into −17 % whipsaws (ETH: +17.92 % → +10.11 %).

**Book A (Apex overshoot model, floored at bar low):**

| Product | n | avg net | median | win | PF | H1 avg (n) | H2 avg (n) | month-clustered 95% CI | total / maxDD (seq.) | med hold |
|---|---|---|---|---|---|---|---|---|---|---|
| XRP-USD | 34 | +10.46% | -4.57% | 35% | 2.88 | +3.50% (15) | +15.95% (19) | [-3.48%, +32.89%] | +319% / -52% | 13d |
| SOL-USD | 36 | +20.65% | +0.01% | 50% | 5.17 | +38.56% (17) | +4.62% (19) | [-0.41%, +49.70%] | +2402% / -52% | 14d |
| XLM-USD | 54 | +5.31% | -5.90% | 28% | 1.76 | +2.97% (26) | +7.49% (28) | [-4.01%, +18.16%] | +43% / -78% | 12d |
| BTC-USD | 75 | +4.97% | -3.44% | 41% | 1.96 | +9.46% (37) | +0.59% (38) | [+0.55%, +9.59%] | +745% / -66% | 14d |
| ETH-USD | 71 | +8.96% | -1.35% | 48% | 2.38 | +20.52% (33) | -1.07% (38) | [+0.02%, +20.84%] | **-89% / -100%** | 15d |
| DOGE-USD | 31 | +6.15% | -2.00% | 39% | 2.19 | -1.53% (14) | +12.48% (17) | [-4.17%, +22.08%] | +99% / -36% | 13d |
| **POOLED (6)** | 301 | +8.59% | -3.30% | 41% | 2.48 | +14.32% (110) | +5.29% (191) | [+2.69%, +15.34%] | n/a | 14d |
| POOLED last 3y | 129 | +9.41% | -3.44% | 36% | 3.02 | +18.40% (65) | +0.27% (64) | [-0.89%, +22.14%] | n/a | 13d |

**Flash-crash tail (real venue prints, GDAX = Coinbase's exchange in 2017):** ETH 2017-04-25 → 2017-06-21, stop at ~$42.6, bar low **$0.10** (the 2017-06-21 GDAX ETH flash crash) → fill floored at $0.10 → **−99.8 %**; BTC 2017-04-07 → 2017-04-15, bar low $0.06 → **−36.1 %**. Claude's model fills both at `stop × 0.999` (−16.7 %). Excluding those two trades: pooled n = 299, +9.10 %, PF 2.68, CI [+3.23 %, +15.86 %]; ETH n = 70, +10.52 %, PF 3.04, H1 +24.28 % / H2 −1.07 %. The point stands regardless of the model: a **venue-side stop-market on Coinbase spot carries flash-crash tail risk** that a close-evaluated exit does not; the stop does not improve expectancy in any book. Intro-1 sensitivity with the stop: pooled +7.93 %, PF 2.29, CI [+2.07 %, +14.64 %].

### 4.5 Prereg S3 variant — 3×ATR(14) trail (pooled only; NOT the primary rule)

Book B: n = 356, +4.96 %, median −3.66 %, win 41 %, PF 1.91, CI [+1.00 %, +9.49 %], last 3 y +3.23 % (CI [−2.90 %, +9.97 %]). Book A: n = 356, +2.88 %, PF 1.47, CI **[−0.75 %, +7.02 %]** → fails the desk bar; 5/6 products avg > 0. Consistent with Claude's finding (12-coin pooled +1.48 %, PF 1.24): the trail cuts the right tail the rule lives on.

---

## 5. Pooled across products and dependence (deliverable 2)

### 5.1 Pooled figures

| Pool | n | avg net | median | win | PF | H1 / H2 | month-clustered CI | quarter-clustered CI |
|---|---|---|---|---|---|---|---|---|
| Coinbase 6, Book B | 298 | +10.89 % | −3.31 % | 41 % | 3.00 | +20.83 % / +5.25 % | [+4.05 %, +19.36 %] | [+3.01 %, +20.11 %] |
| Coinbase 6, Book A | 298 | +11.12 % | −3.11 % | 41 % | 3.08 | +21.07 % / +5.46 % | [+4.26 %, +19.60 %] | [+3.22 %, +20.35 %] |
| Coinbase 6, Book B, entries ≥ 2018-01-01 | 286 | +7.13 % | −3.81 % | 38 % | 2.26 | +9.27 % / +5.87 % | [+1.02 %, +13.88 %] | [+0.38 %, +15.62 %] |
| Coinbase 6, Book B, last 3 y | 129 | +9.14 % | −3.64 % | 36 % | 2.89 | +18.08 % / **+0.06 %** | **[−1.11 %, +21.92 %]** | — |
| Bitstamp 6, Book B (Claude's source) | 305 | +11.34 % | −3.49 % | 40 % | 3.11 | +21.04 % / +5.55 % | [+4.26 %, +19.28 %] | [+3.50 %, +20.40 %] |
| Bitstamp 12, Book B (Claude's headline) | 556 | +7.35 % | −5.52 % | 35 % | 2.14 | +17.64 % / +3.26 % | [+1.19 %, +14.57 %] | [+0.41 %, +15.76 %] |

### 5.2 Dependence — why n = 298 is not 298 independent observations

- **76 % of entries (225 / 298) occur within ±3 days of another product's entry.** Crypto breakouts are one beta event traded six times; the six-product pool has **95 distinct entry months**, not 298 independent trades. That is why the month-clustered CI is the right interval (and why the quarter-clustered CI is reported as a check: its lower bound is 1 pt lower).
- **Concentration.** Pooled, the best 3 trades are 34 % of Σlog(1+net). Per product it is worse: top-3 share XRP 169 %, SOL 111 %, DOGE 267 % — i.e. excluding the best three trades, the remaining trades of those products are net **negative** in log terms. BTC 60 %, ETH 70 %. XLM's compounded full-size result is −10 % (B) / 0 % (A) despite a positive arithmetic mean. This is the shape Claude also reported ("best 3 trades = 81 % of XRP total log return").
- **Regime, not stationarity.** Year-by-year, Coinbase Book B pooled (entry year):

| Year | n | avg net | win | PF | Σlog(1+net) |
|---|---|---|---|---|---|
| 2017 | 12 | +100.73% | 92% | 217.36 | 6.12 |
| 2018 | 11 | -2.31% | 45% | 0.67 | -0.36 |
| 2019 | 25 | -1.67% | 36% | 0.77 | -0.75 |
| 2020 | 35 | +19.20% | 60% | 6.64 | 4.88 |
| 2021 | 27 | +15.16% | 44% | 2.82 | 1.41 |
| 2022 | 31 | -6.92% | 16% | 0.18 | -2.36 |
| 2023 | 44 | +9.11% | 43% | 3.25 | 1.91 |
| 2024 | 42 | +21.58% | 38% | 6.05 | 4.48 |
| 2025 | 37 | +0.50% | 38% | 1.08 | -0.36 |
| 2026 (to 09-21) | 34 | -2.56% | 26% | 0.47 | -0.99 |

Five profitable years are the bull years; five are flat-to-negative, including the two most recent. Twelve 2017 entries carry Σlog 6.12 of the pooled total. The **from-2018** row in §5.1 is the honest long-run estimate on this venue: +7.13 %, PF 2.26 — essentially Claude's 12-coin headline.

### 5.3 Venue cross-check on common windows (Book B, no stop)

| Product | common window | Coinbase n / avg / PF | Bitstamp n / avg / PF |
|---|---|---|---|
| XRP-USD | 2019-02-26 → 2026-09-21 | 34 / +10.30% / 2.83 | 51 / +9.12% / 2.48 |
| SOL-USD | 2022-08-18 → 2026-09-21 | 29 / +13.95% / 4.23 | 30 / +12.90% / 3.99 |
| XLM-USD | 2020-05-28 → 2026-09-21 | 45 / +5.21% / 1.69 | 44 / +8.09% / 2.20 |
| BTC-USD | 2017-01-01 → 2026-09-21 | 73 / +6.16% / 2.38 | 74 / +5.87% / 2.32 |
| ETH-USD | 2017-08-16 → 2026-09-21 | 68 / +6.10% / 2.17 | 67 / +6.81% / 2.28 |
| DOGE-USD | 2022-12-21 → 2026-09-21 | 23 / +9.15% / 2.91 | 25 / +7.44% / 2.43 |

Venue data differences are ≤ 3 pts per product (XRP's 34 vs 51 trades is the Coinbase suspension gap). The large per-coin gaps between §4.1 and §3 (ETH +17.9 % vs +6.8 %, SOL +20.4 % vs +12.9 %) are **history windows**: Coinbase's ETH series starts 2017-01-01 at $8 and contains two 2017 trades (+540 %, +295 %) that pre-date Bitstamp's ETH listing; Coinbase SOL contains the 2021-07-31 +360 % trade that pre-dates Bitstamp's SOL listing.

### 5.4 Open positions and current state (not counted in any table)

At the 2026-09-21 close (Book B marks): SOL-USD IN since 2026-09-19 @ 112.81 (+3.3 %); XLM-USD IN since 2026-09-20 @ 0.19628 (+7.5 %); ETH-USD IN since 2026-09-19 @ 2 613.99 (+4.1 %). XRP-USD (close 1.5359 > prior-20d high 1.4513), BTC-USD (86 594.94 > 81 263.99) and DOGE-USD (0.0998 > 0.09092) fired the entry signal on the 2026-09-21 close → buy at the 2026-09-22 open, outside the completed-bar window. Net: the rule is long or entering on all six products today — the same state Claude reported ("in20/out10 state: IN" on all twelve). Informational only.

---

## 6. PASS / FAIL vs Claude's cited headline (deliverable 3)

Claude's headline (Bitstamp, 12 coins, T1): n = 556, avg +7.35 %, median −5.5 %, win 35 %, PF 2.14, CI [+1.15 %, +14.28 %]. Not treated as SoT; compared on shape.

| Metric | Claude 12-coin (Bitstamp) | Apex re-derivation, same source | Apex 6-coin Coinbase, Book B | Apex 6-coin Coinbase, Book A | Apex 6-coin Coinbase B, from 2018 |
|---|---|---|---|---|---|
| n | 556 | 556 | 298 | 298 | 286 |
| avg net | +7.35 % | +7.35 % | +10.89 % | +11.12 % | +7.13 % |
| median | −5.5 % | −5.52 % | −3.31 % | −3.11 % | −3.81 % |
| win | 35 % | 35 % | 41 % | 41 % | 38 % |
| PF | 2.14 | 2.14 | 3.00 | 3.08 | 2.26 |
| CI (month-clustered) | [+1.15, +14.28] | [+1.19, +14.57] | [+4.05, +19.36] | [+4.26, +19.60] | [+1.02, +13.88] |
| Shape | minority of trades win; negative median; mean carried by the right tail; CI lower bound small positive | identical | same shape, richer (selected coins + 2017) | same | same shape, same magnitude as the headline |

- **Arithmetic: PASS.** The headline is reproduced exactly on its own source with an independent implementation.
- **Shape on the desk venue: PASS.** Coinbase data produce the same low-win / negative-median / fat-right-tail / PF 2–3 profile with a CI lower bound just above zero.
- **Magnitude: the 6-coin numbers are not "better than Claude's".** They are higher because (i) the six requested products are 6 of Claude's 12 — four are the coins that passed *their* companion screen (XRP, BTC, SOL, XLM) — a selection worth roughly +4 pts on the pooled mean (Bitstamp 6-coin +11.34 % vs 12-coin +7.35 % on the same data), and (ii) Coinbase carries 2017 history for ETH that Bitstamp lacks. Remove 2017 and the desk-venue pooled figure (+7.13 %, PF 2.26, CI [+1.02 %, +13.88 %]) is Claude's headline to within noise. The 12-coin number is the less-selected estimate and should be the one quoted.
- **Recency: FAIL in both data sets.** Claude's own last-3y row already had CI [−3.64 %, +19.02 %]; on Coinbase the last-3y CI is [−1.11 %, +21.92 %] and the 2025-03 → 2026-09 half is +0.06 %.

---

## 7. Verdict vs the Apex live bar — paper candidate? (deliverable 4)

Bar: both halves > 0, PF ≥ 1.2, month-clustered 95 % CI excludes 0 (prereg adds n ≥ 100). Scorecards for the primary rule (no trail, no stop):

**Book A — SPOT-INTRO-50-90:**

| Row | n (≥100?) | H1 / H2 (both > 0?) | PF (≥ 1.2?) | month-clustered CI (excludes 0?) | Apex bar |
|---|---|---|---|---|---|
| XRP-USD | 34 (fail) | +4.31% / +15.42% → PASS | 2.91 → PASS | [-3.33%, +32.56%] → fail | **FAIL** |
| SOL-USD | 36 (fail) | +38.45% / +4.62% → PASS | 5.12 → PASS | [-0.48%, +49.68%] → fail | **FAIL** |
| XLM-USD | 53 (fail) | +1.59% / +8.23% → PASS | 1.66 → PASS | [-4.52%, +18.24%] → fail | **FAIL** |
| BTC-USD | 73 (fail) | +12.31% / +0.91% → PASS | 2.46 → PASS | [+1.62%, +12.07%] → PASS | **PASS** |
| ETH-USD | 71 (fail) | +40.12% / -0.91% → fail | 4.70 → PASS | [+4.14%, +38.12%] → PASS | **FAIL** |
| DOGE-USD | 31 (fail) | -1.24% / +12.54% → fail | 2.26 → PASS | [-4.11%, +22.31%] → fail | **FAIL** |
| POOLED (6) | 298 (PASS) | +21.07% / +5.46% → PASS | 3.08 → PASS | [+4.26%, +19.60%] → PASS | **PASS** |
| POOLED last 3y | 129 (PASS) | +18.31% / +0.27% → PASS | 2.99 → PASS | [-0.91%, +22.17%] → fail | **FAIL** |

**Book B — Claude T1:**

| Row | n (≥100?) | H1 / H2 (both > 0?) | PF (≥ 1.2?) | month-clustered CI (excludes 0?) | Apex bar |
|---|---|---|---|---|---|
| XRP-USD | 34 (fail) | +4.10% / +15.19% → PASS | 2.83 → PASS | [-3.52%, +32.30%] → fail | **FAIL** |
| SOL-USD | 36 (fail) | +38.17% / +4.41% → PASS | 5.00 → PASS | [-0.68%, +49.38%] → fail | **FAIL** |
| XLM-USD | 53 (fail) | +1.38% / +8.02% → PASS | 1.62 → PASS | [-4.71%, +18.00%] → fail | **FAIL** |
| BTC-USD | 73 (fail) | +12.08% / +0.71% → PASS | 2.38 → PASS | [+1.41%, +11.84%] → PASS | **PASS** |
| ETH-USD | 71 (fail) | +39.84% / -1.11% → fail | 4.58 → PASS | [+3.93%, +37.85%] → PASS | **FAIL** |
| DOGE-USD | 31 (fail) | -1.44% / +12.31% → fail | 2.19 → PASS | [-4.30%, +22.06%] → fail | **FAIL** |
| POOLED (6) | 298 (PASS) | +20.83% / +5.25% → PASS | 3.00 → PASS | [+4.05%, +19.36%] → PASS | **PASS** |
| POOLED last 3y | 129 (PASS) | +18.08% / +0.06% → PASS | 2.89 → PASS | [-1.11%, +21.92%] → fail | **FAIL** |

Under the Intro-1 sensitivity (120 bps) the pooled full-sample still passes (CI [+3.63 %, +18.88 %]) but the last-3y half turns negative (−0.34 %) and BTC's per-product pass is marginal (H2 +0.30 %).

**Verdict.**

1. **Pooled, full sample: PASS** on all three desk criteria, in both books, with and without 2017. This is a genuine pass, not a rounding one (CI lower bound +4.0 % / +1.0 % ex-2017; PF 3.0 / 2.3).
2. **Per product: FAIL** (1/6; BTC only, marginal; none reach n ≥ 100). The rule is not evidence for *any single product*, XRP included (Coinbase XRP CI [−3.5 %, +32.6 %], n = 34). The XRP-led framing of the prereg does not survive on the desk venue.
3. **Recency: FAIL.** No net expectancy since 2025-03 in any book, gross included. The pooled pass is carried by 2017, 2020–21 and 2023–24.
4. **Selection: flagged.** The six products are a favourable subset; quote the 12-coin +7.35 % (or the ex-2017 +7.13 %) rather than +10.9 %.

**Would it clear the desk evidence bar for a paper candidate?** On the pooled bar as written — yes. On the honest reading — it is a bull-regime trend premium with a flat last 18 months, and the paper line would be the *first* out-of-sample evidence, not a confirmation. Recommended label: **HOLD — eligible as a paper candidate only under these conditions, not a live candidate:**

- Paper the **whole pre-specified basket** (all six, or Claude's twelve), no per-product cherry-picking; a product cannot be promoted individually until it passes the bar on its own.
- **Close-evaluated exits only** (the rule's own exit); no venue-side stop-market (flash-crash tail, §4.4). If a protective stop is wanted, pre-register it as a software stop evaluated on close.
- Pre-register the paper evaluation window and the bar *before* the line starts (per the prereg standard), including the fee book to be charged (Book A for spot; Intro 1 until the account's tier moves).
- Expectation setting: ~6–8 trades / year / product, median hold ~2 weeks, ~60 % of trades lose, median trade −3 to −6 %; paper evidence at n ≥ 100 pooled needs roughly 2–3 years at six products — so the paper line's job is drift detection (are 2025–26 conditions the new normal?), not fast confirmation.
- Engineering note: `disabled_strategies: [breakout]` refers to the 15-minute ATR/volume breakout plugin (Phase 3 KILL); this daily Donchian rule is a different strategy and would need its own plugin, EV-gate wiring and guardrails entry. Not built here; out of scope.

---

## 8. Caveats and things this note did not do

- **No parameter search.** Only in20/out10 was run as the rule; the 15 % stop and the 3×ATR trail are the sensitivities the task and the prereg named. No other cell was tried.
- **Long-only, one position per product, full sizing per product** (as in Claude's harness). No portfolio sizing, no cash yield, no slot limits; pooled "total/maxDD" is therefore not reported.
- **Survivorship.** The products are those listed today; delisted coins are absent. XRP's Coinbase suspension is handled by segmentation; a real book long XRP on 2021-01-19 would have been force-flattened — not modelled (no open position at that segment end in this run).
- **Open positions excluded** (§5.4), as in Claude's harness. All six products are long or entering today, so the next weeks will add trades to the recent half.
- **Slippage pins are the yaml values** (5 bps) — plausible for the desk's notional at daily frequency; Claude's 10 bps is the conservative sensitivity. Neither models Coinbase market-order spread beyond the pin.
- **Bootstrap.** Same estimator as Claude's `month_cluster_ci` (2 000 resamples, cluster = calendar month of entry); different seeded PRNG, so CI bounds differ by ≲ 0.3 pt. The quarter-clustered CI is a robustness check, not a replacement.
- **Engine quirk (for the harness owners, not changed here):** `BacktestEngine.computeStopOvershoot` has no floor at the bar's low; on a flash-crash bar it would produce a fill below the traded range (ETH 2017-06-21: `$42.6 − 0.20 × $352 < 0` → clamped to $0). The port floors at the bar low. Worth a one-line fix and a test when someone next touches `backtest-engine.ts`; not in this note's scope.

---

## Appendix A — simulator core (TypeScript port of `sim_brk`, as run)

```ts
// bars: contiguous daily OHLC (split at gaps > 5 days). fee = taker rate, slip = per-side slippage.
const hh = c.map((_, i) => (i >= nIn ? Math.max(...c.slice(i - nIn, i)) : NaN));   // prior 20-day closing high
const ll = c.map((_, i) => (i >= nOut ? Math.min(...c.slice(i - nOut, i)) : NaN)); // prior 10-day closing low
const sig = c.map((x, i) => x > hh[i]);
const netOf = (exitPx: number, ent: number) => (exitPx / ent) * (1 - fee) * (1 - fee) - 1;
const stopFillPx = (stop: number, j: number) =>
  stopFill === 'claude'
    ? stop * (1 - slip)
    : Math.max(l[j], stop - Math.max((h[j] - l[j]) * 0.20, stop * (5 / 10_000)));   // Apex pins, floored at bar low
let i = 0, pos = null;
while (i < N - 1) {
  const j = i + 1;
  if (pos) {
    if (pos.stop !== null && l[j] <= pos.stop) {                    // venue-side stop, intrabar
      trades.push({ ...ids, exitPx: stopFillPx(pos.stop, j), net: netOf(stopFillPx(pos.stop, j), pos.entry), kind: 'stop' });
      pos = null; i += 1; continue;
    }
    if (c[j] < ll[j] && j + 1 < N) {                                 // rule exit → sell next open
      const exitPx = o[j + 1] * (1 - slip);
      trades.push({ ...ids, exitPx, net: netOf(exitPx, pos.entry), kind: 'rule' });
      pos = null; i += 2; continue;
    }
    i += 1; continue;
  }
  if (sig[i]) {                                                      // breakout close → buy next open
    const ent = o[j] * (1 + slip);
    pos = { entry: ent, entryI: j, stop: fixedStopPct !== null ? ent * (1 - fixedStopPct) : null };
  }
  i += 1;
}
// month-clustered bootstrap CI: group trade nets by YYYY-MM of entry; 2 000 × resample groups with
// replacement (same count), mean of the concatenation; report the 2.5th / 97.5th percentiles.
```

## Appendix B — files, hashes, reproduction

Artifact set (attached with this note): `replicate.ts` (full script, ~330 lines), `fetch-bitstamp.mjs`, `replication-tables.md` (every table in this note, machine-generated), `replication-results.json` (all trades, per-row stats, scorecards), `run.log`, and the fetched data files.

Coinbase fetched files (sha256): BTC `0274d26c…5a68a7`, ETH `36d905a4…61ba70`, SOL `0dab2589…896ebe`, XRP `645df138…e43a5d`, XLM `7d94c1c7…1ebb5`, DOGE `d23b2efb…87f837`. Bitstamp: XRP `f77ac757…fd317`, BTC `b9e9781d…9de7c5`, ETH `938038ad…17ca0d`, SOL `6ab0017f…16e64a`, XLM `e27b479e…2baa21`, DOGE `30607d13…8c91e2`, ADA `119c4b50…c15a19`, HBAR `b52d7434…f61d1a7`, LINK `74dafce3…277f951`, AVAX `54fa27ac…3188f2`, LTC `bd8034ee…9ed9b22c2`, SUI `ae2f7354…dd14ae`.

Reproduce (from `atlas/apps/core-node`; nothing is written into the repo):

```bash
pnpm backtest:backfill --products XRP-USD,SOL-USD,XLM-USD,BTC-USD,ETH-USD,DOGE-USD \
  --since 2017-01-01 --until 2026-09-21 --granularity ONE_DAY --out-dir /tmp/apex-s3/data/coinbase
node /tmp/apex-s3/fetch-bitstamp.mjs /tmp/apex-s3/data/bitstamp
pnpm exec tsx /tmp/apex-s3/replicate.ts        # writes /tmp/apex-s3/out/replication-tables.md + replication-results.json
```

## Appendix C — Claude's reference rows used for comparison (from `results-crypto-2026-09-22.txt`)

- 12-coin pooled in20/out10 T1: `n=556 avg=+7.35% median=-5.52% win=35% PF=2.14 month-clustered CI=[+1.15,+14.28]% coins with avg>0: 10/12`; last 3 y `n=274 avg=+6.24% … PF=2.00 CI=[-3.64,+19.02]%`.
- Fixed-stop verification: `0.15: n=566 +6.99% CI [+0.95,+14.44] worst -17%`.
- Per coin (Bitstamp): XRP `n=65 avg=+25.2% PF=5.09 H1=+40.0 H2=+7.9`; ETH `67 / +6.8% / 2.28 / +16.1 / -0.7`; DOGE `25 / +7.4% / 2.43 / +13.7 / -2.0`; BTC `74 / +5.9% / 2.32 / +10.7 / +1.0`; SOL `30 / +12.9% / 3.99 / +26.1 / +1.4`; XLM `44 / +8.1% / 2.20 / +4.6 / +12.2`.
- Coinbase XRP (post-relisting 2023-07-13 →): `in20/out10 trail=nan trend=nan: n=19 win=37% … T1 +15.19% PF=4.10 CI[-4.66,+49.87] H1 +32.99 H2 -0.83`.
