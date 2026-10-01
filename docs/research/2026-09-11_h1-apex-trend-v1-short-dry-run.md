# H1 Apex Trend v1 — SHORT DRY-RUN (Creator open), daily TRAIN 2017-01 → 2025-02, BTC + ETH

**H1 SHORT DRY-RUN — NOT GO · NOT SEALED · NOT RESEARCH-PASS.** NOT research-pass · NOT GO · NOT a sealed-holdout release · NO `CONFIRM_LIVE` · no DSR/PBO GO packaging · no ≤12 grid (one default variant only) · never `--allow-synthetic`. Every counted number in this pack is **DRY-RUN DRAFT** (in-sample TRAIN) and **UNVERIFIED** (the cited fee sheet is not on the box, §5). Nothing here is evidence for a desk decision; it is a harness dry-run to show the design runs end-to-end on the locked TRAIN path with the required prints.

**Date:** 2026-09-11 (delivered 11:40 CDT; well inside the 21:30 CDT PARK line) · **Card:** H1 Apex Trend v1 — SoT `apex-research/hypotheses/H1_apex-trend-v1.md` is **not on the box** (`/workspace/apex-research/` does not exist; no `hypotheses/` or `H1_*` file in `origin/main` or any remote branch). The design below is taken from the run brief; the interpretation register in §3 lists every choice the brief left open and needs Creator confirmation against the card. · **Data:** #59 `fixtures/bars/1d/tune-2017-01_2025-03` (TRAIN, `DATA: REAL`, native `ONE_DAY`, BTC + ETH, 2981 bars each, ends 2025-02-28) · **Code:** this PR — research harness only (`src/research/apex-trend-v1*.ts`, `src/cli/research-apex-trend-v1.ts`, `pnpm research:h1`, 24 vitest cases). Nothing under `atlas/config/**`, `fixtures/**`, the strategy registry, `guardrails.yaml` paper GO lists or any paper/live path changed (`pnpm check:config` OK; full suite passes on the same tree, Appendix). · **Audience:** Eng for Algo Beta · Creator · TM.

---

## 0. Required prints (verbatim from `pnpm research:h1`, artefact `h1_apex-trend-v1_dry-run_stdout.log`)

1. **Path used:** `fixtures/bars/1d/tune-2017-01_2025-03` (TRAIN ONLY) → `BTC-USD.json sha256=0308ba0d72da…`, `ETH-USD.json sha256=eaa217768fc4…` — both match the committed table in `fixtures/bars/MULTI_TF.md`; 2981/2981 bars per symbol, 2017-01-01 → 2025-02-28, native `ONE_DAY/86400s`, no rollup, `source=coinbase-advanced-trade-public`. **Banned paths untouched:** `fixtures/bars/1d/btc-eth-2017_plus` is not present on disk and is refused by the path lock before any read; the sealed loose `fixtures/bars/1d/*.json` (HO-H1-DAILY 2025-03-01 → 2026-08-31) were never opened (refused as `SEALED HO-H1-DAILY source`); every bar read is asserted `< 2025-03-01T00:00Z`; files opened this run: exactly 2. No `--allow-synthetic` flag exists (yargs strict).
2. **Variant:** `A1/B1/C3.0/D0.25` · TF **daily** · **BTC-USD + ETH-USD** — A1 MA 20/50/100/200 (SMA on closes) · B1 plain average of sign(close − MA) votes · C 3.0 × daily ATR(14) close-based ratchet trail · D 0.25 no-trade band · exits = signal reversal OR trail · **no fixed TP** · vol-target 20 %/yr per sleeve · leverage cap **2.0×** (UI 4.1× ignored) · long + short · fills next-bar close (maker sim missing).
3. **Fee sheet:** `CFM-NANO-H1-v0.1` — **DRAFT / UNVERIFIED**. Brackets: Research v0.2 DRAFT — **sheet not on box ⇒ placeholder** 5 bps fee + 2 bps slippage per side = **7 bps/side all-in (UNVERIFIED)**, maker-first framing; never Intro-1.
4. **Train-window results — DRY-RUN DRAFT (UNVERIFIED):** eval span 2017-07-20 → 2025-02-28 (2780 d after the 200-bar warm-up) · **n = 212** closed trades (BTC 104 / ETH 108) · **after-cost Sharpe = 1.27** (√365; zero-cost 1.30) · **WR = 42.5 %** (90 W / 122 L) · **payoff = 2.47** (avg win $1,583 / avg loss $640) · **maxDD = 30.4 %** · **exit mix = reversal 127 (59.9 %) / trail 83 (39.2 %) / end_of_data 2 (0.9 %)**.
5. **H1 SHORT DRY-RUN — NOT GO · NOT SEALED · NOT RESEARCH-PASS.**

## 1. Run card (exact commands; from `atlas/apps/core-node`, no variant knobs exist)

```bash
# the dry-run (defaults ARE the card: TRAIN dir, BTC-USD ETH-USD, placeholder 5 + 2 bps/side, ladder on)
pnpm research:h1
# = pnpm exec tsx src/cli/research-apex-trend-v1.ts --fixture-dir fixtures/bars/1d/tune-2017-01_2025-03 \
#     --products BTC-USD ETH-USD --fee-bps 5 --slippage-bps 2 --fee-ladder --initial-capital 10000

# when the real CFM-NANO-H1-v0.1 brackets exist: pass them; they are still printed as UNVERIFIED
pnpm research:h1 --fee-bps <maker+exchange+NFA bps> --slippage-bps <allowance bps>
```

Artefacts (`--results-path`, default `atlas/var/backtest_results/h1/`, gitignored): `h1_apex-trend-v1_<ts>.json` (variant, fee sheet, path lock, provenance incl. sha256, metrics, zero-cost metrics, ladder, every trade, equity curve) and `h1_apex-trend-v1_<ts>.txt` (the stdout). Runtime ≈ 1 s.

Refusals demonstrated (artefact `h1_apex-trend-v1_path-lock-refusals.log`):

| command | result |
|---|---|
| `--fixture-dir fixtures/bars/1d` (sealed loose HO-H1-DAILY files) | exit 2 · `H1_PATH_LOCK: … got fixtures/bars/1d = SEALED HO-H1-DAILY source — refused, nothing read` |
| `--fixture-dir fixtures/bars/1d/btc-eth-2017_plus` (BANNED) | exit 2 · `H1_PATH_LOCK: BANNED fixture path (seal contamination) … refused, nothing read` |
| `--allow-synthetic` | exit 1 · `Unknown arguments: allow-synthetic` (no such flag) |
| `--products BTC-USD ETH-USD SOL-USD` | exit 2 · `H1_DATA_UNAVAILABLE: SOL-USD is not in the H1 universe` |

Also refused by the loader (unit-tested): any bar at/after 2025-03-01 (`SEAL BREACH`), a daily gap, a `rollup` block, a synthetic `source`, a non-`ONE_DAY` granularity, any other 4h/15m directory.

## 2. Data stamp

`DATA: REAL` on line 2 of stdout and of the saved report; `source=coinbase-advanced-trade-public` for both symbols; declared and inferred spacing 86400 s (`spacing=1440m` equivalent), contiguous 2981/2981 (the TRAIN set has no upstream gaps, `fixtures/bars/MULTI_TF.md`). The tune candles are byte-identical to the sealed set on their 181 overlapping days (asserted by the existing fixture suite), so this run saw the same prices the holdout will see for 2024-09-01 → 2025-02-28 — and nothing after.

## 3. Design as implemented — interpretation register (confirm against the card)

The brief fixes the skeleton; every row below is a choice it left open. Each is frozen in `H1_VARIANT` (`src/research/apex-trend-v1.ts`) and printed in the run header. **None is exposed as a CLI knob** — the card is one variant, not a grid.

| # | Rule | Implemented as | Brief said | Confirm? |
|---|---|---|---|---|
| A1 | MA speeds | SMA(20/50/100/200) on daily closes | "MA 20/50/100/200" | SMA vs EMA |
| B1 | vote | per speed `sign(close − MA)` ∈ {−1,0,+1} (0 only on exact equality); plain unweighted average | "each speed votes −1/0/+1; plain average" | price-vs-MA (implemented) vs MA-slope vote |
| D | no-trade band 0.25 | `avg > +0.25 ⇒ long`, `avg < −0.25 ⇒ short`, else no new direction. With 4 speeds this is "≥ 3 of 4 agree". **Open positions are held through the band** (the band suppresses entries, not exits; exits are only reversal or trail, as the brief lists) | "no-trade band" | hold-through-band vs flat-in-band |
| C | trail 3.0 | Wilder ATR(14) on daily bars (codebase default period, value-identical to `ValidatedIndicators.ATR`); long level = max(prev, HWM − 3·ATR) where HWM is the highest **close** since fill (fill price seeds it); ratchets only tighter; hit when `close ≤ level` (short symmetric). Checked on the same bar that updates it | "daily ATR trail 3.0" | ATR period 14 (vs 20); close-based HWM/trigger (vs highs / intrabar) |
| — | exit precedence | reversal first (flip at one fill: exit + opposite entry, both legs pay costs), else trail (→ flat) | "exits = signal reversal OR trail" | — |
| — | re-entry | after a trail exit the sleeve re-enters on the next decision bar whose direction is non-zero — no cooldown, no "signal must refresh" rule. 58 such same-direction re-entries occurred (§4.2) | not stated | keep / add a refresh rule |
| — | vol target | 20 %/yr **per sleeve**, realised = sample std of 30 daily log returns × √365; leverage = min(2.0, 0.20/σ) applied to a **1/2-equity sleeve**; size **set at entry, not rebalanced** | "vol-target ~20 %, leverage cap ≤2×" | per-sleeve vs portfolio-level target; lookback 30 d; set-at-entry vs daily rebalance |
| — | fills | decision on close[t], fill at close[t+1] ± slippage (lag-1). Reversal and trail exits fill at the same next close (no intrabar stop fill) | "maker-first … dry-run may use next-bar close if maker sim missing — say so" | **maker sim is missing; this IS next-bar close** |
| — | costs | `fee bps × traded notional` per side + `slippage bps` adverse on every fill; both legs of every trade, both legs of a reversal | "fee book DRAFT/UNVERIFIED" | brackets (§5) |
| — | warm-up | 200 bars (MA200) ⇒ first decision 2017-07-19, first fill 2017-07-20; Sharpe/DD measured from the first fill bar | — | — |
| — | annualisation | 365 (24/7 venue) for vol target and Sharpe | — | 365 vs 252 (252 would print Sharpe 1.06 for the same series) |
| — | end of data | open positions closed at the last close, labelled `end_of_data`, costs applied | — | — |
| — | accounting | float P&L on a shared equity pool, units-based (qty fixed at decision from `0.5 × equity × lev / close[t]`), like `backtest-engine.ts`; research estimate, not a ledger | — | — |

Not implemented anywhere (by the brief): fixed TP, MTF alignment, regime detector, meta-filter, EV gate, min-hold, funding/basis/roll, contract rounding, maker fill model.

## 4. Results — DRY-RUN DRAFT (in-sample TRAIN · every number UNVERIFIED · not evidence)

### 4.1 Headline (placeholder bracket 7 bps/side all-in)

| | value | note |
|---|---|---|
| window / eval span | 2017-01-01 → 2025-02-28 / **2017-07-20 → 2025-02-28** (2780 d, 7.62 y) | 200-bar warm-up |
| n closed trades | **212** (BTC 104 / ETH 108) | 27.8 trades / yr pooled |
| after-cost Sharpe (√365) | **1.27** | zero-cost 1.30 · Sortino 1.91 |
| WR | **42.5 %** | 90 W / 122 L |
| payoff (avg win / avg loss, after-cost $) | **2.47** | $1,583 / $640 · PF 1.82 · expectancy $304 / trade |
| maxDD (daily marks) | **30.4 %** | peak 2022-06-18 → trough 2023-08-29 (14 months) |
| CAGR / net / final equity | 30.1 % / +644 % / $74,401 on $10,000 | 2022-01 → 2025-02 alone: +16.6 % with the full 30.4 % DD inside it |
| ann. vol (realised) | 22.8 % | target 20 % per sleeve; Calmar 0.99 |
| exposure | 99.4 % of eval days ≥ 1 sleeve on; BTC 95.3 % / ETH 96.2 % in market | the band suppresses entries only ~14–15 % of bars and positions are held through it |
| leverage per sleeve | mean 0.32× · max 0.73× · **cap 2.0× never bound** (0 of 212 entries) | 0.20 / realised 30-d vol of 60–90 % |
| turnover / cost drag | 10.1× gross / yr · 71 bps / yr (fees $1,710 + slippage $684) | at 7 bps/side; ladder §4.5 |
| hold days | p10 2 · p25 5 · **p50 16** · p75 39 · p90 59 · max 140 (mean 25.1) | |

### 4.2 Exit mix — reversal vs trail (required print)

| reason | n | share | WR | net (after cost) | mean hold | reading |
|---|---|---|---|---|---|---|
| **reversal** (ensemble flipped) | **127** | **59.9 %** | 26.0 % | **−$55,354** | 10.9 d | 56 of 127 closed within ≤ 5 days — whipsaw cost of flipping on a 3-of-4 majority |
| **trail** (3 × ATR from HWM) | **83** | **39.2 %** | 66.3 % | **+$114,846** | 47.1 d | the trail is the profit-taking exit; carries all of the net |
| end_of_data | 2 | 0.9 % | 100 % | +$4,909 | 16.0 d | both sleeves long at 2025-02-28 |

Same-direction re-entries after a trail exit: **58** (net +$18,556, WR 41 %, mean hold 29.9 d) — re-entering into a still-standing majority is net positive here; not a rule change, just the count the Creator asked to see.

### 4.3 Per symbol · per side

| | n | WR | payoff | PF | net | exp / trade | hold p50 | exits R / T / E | in-market |
|---|---|---|---|---|---|---|---|---|---|
| BTC-USD | 104 | 47.1 % | 2.37 | 2.11 | +$42,335 | $407 | 18 d | 60 / 43 / 1 | 95.3 % |
| ETH-USD | 108 | 38.0 % | 2.54 | 1.55 | +$22,066 | $204 | 14 d | 67 / 40 / 1 | 96.2 % |
| **long** | 111 | 39.6 % | **4.05** | **2.66** | **+$65,620** | $591 | 15 d | 67 / 44 / 0 | — |
| **short** | 101 | 45.5 % | 1.16 | **0.97** | **−$1,219** | −$12 | 16 d | 60 / 39 / 2 | — |

Shorts by symbol: BTC 49 trades, +$1,477 (WR 49 %); ETH 52 trades, −$2,696 (WR 42 %). In-sample the short book is a wash (PF 0.97) while paying half the costs; the long book is the whole result.

### 4.4 Per year and halves (in-sample diagnostics; calendar UTC)

| year | days | net return | Sharpe | maxDD | trades closed |
|---|---|---|---|---|---|
| 2017 (from 07-20) | 165 | +42.7 % | 3.15 | 10.9 % | 18 |
| 2018 | 365 | +21.3 % | 1.06 | 19.1 % | 24 |
| 2019 | 365 | +32.4 % | 1.35 | 18.2 % | 23 |
| 2020 | 366 | +83.9 % | 2.74 | 9.2 % | 21 |
| 2021 | 365 | +51.4 % | 1.59 | 14.9 % | 28 |
| 2022 | 365 | −2.1 % | −0.02 | 22.8 % | 23 |
| 2023 | 365 | +5.1 % | 0.33 | 23.6 % | 28 |
| 2024 | 366 | +7.5 % | 0.44 | 21.4 % | 35 |
| 2025 (to 02-28) | 59 | +5.4 % | 2.16 | 4.2 % | 12 |

| span | strategy Sharpe | strategy vol | 50/50 BTC+ETH buy-and-hold Sharpe (same days) |
|---|---|---|---|
| 2017-07-20 → 2021-12-31 (1626 d) | **1.85** | 24 % | 1.28 |
| 2022-01-01 → 2025-02-28 (1155 d) | **0.34** | 21 % | 0.35 |
| full eval span | 1.27 | 22.8 % | 0.96 (vol 76 %, maxDD 88 %) |

Concentration: the **top 10 trades carry 122 % of the net** (+$78,421 of +$64,401); the three largest are BTC long 2020-10-06 → 2021-01-22 (trail, +60 % of equity at entry), ETH long 2020-10-10 → 2021-02-26 (trail, +41 %) and BTC long 2024-10-13 → 2024-12-28 (trail, +13 %). Worst: BTC long 2022-11-05 → 11-09 (reversal, −8.0 %), ETH long 2022-10-27 → 11-09 (reversal, −5.4 %). Daily correlation to the 50/50 buy-and-hold is 0.29 (beta 0.09 at 0.32× sleeve leverage).

### 4.5 Fee sensitivity — same variant, all-in bps per side (informational · every row UNVERIFIED · never graded · not a variant sweep)

| all-in bps / side | n | Sharpe | net return | CAGR | maxDD | PF | cost drag bps / yr |
|---|---|---|---|---|---|---|---|
| 0 (zero-cost reference) | 212 | 1.30 | +681 % | 31.0 % | 29.5 % | 1.86 | 0 |
| 5 | 212 | 1.28 | +654 % | 30.4 % | 30.1 % | 1.84 | 51 |
| **7 (placeholder applied)** | 212 | **1.27** | +644 % | 30.1 % | 30.4 % | 1.82 | 71 |
| 10 | 212 | 1.26 | +629 % | 29.8 % | 30.7 % | 1.81 | 101 |
| 15 | 212 | 1.24 | +604 % | 29.2 % | 31.3 % | 1.78 | 151 |
| 25 | 212 | 1.20 | +557 % | 28.0 % | 32.6 % | 1.73 | 250 |

At 10× gross turnover per year the book pays ≈ 10 bps of equity per year per bps of all-in cost; the daily cadence makes it fee-insensitive in the range a nano-futures sheet could plausibly land (Sharpe 1.30 → 1.20 from 0 to 25 bps/side). Whatever bracket the real sheet gives can be read off this row set or re-run with `--fee-bps/--slippage-bps`. Not in the ladder: basis/roll/funding (§5).

## 5. Fee sheet status — CFM-NANO-H1-v0.1 (DRAFT / UNVERIFIED)

- The sheet is **not on the box**: no `CFM-NANO-H1-v0.1`, no "Research v0.2" brackets anywhere in `/workspace`, `origin/main` or any remote branch (searched docs/, atlas/, CURSOR_TASKS/, COWORK_HANDOFF.md, root *.md). The harness therefore runs a **placeholder** bracket and prints it as UNVERIFIED; the real brackets are CLI inputs, not code.
- Placeholder rationale (public schedule glance only — **not** the desk sheet, still UNVERIFIED): Coinbase's public CFM futures pages quote an introductory 0.05 % per contract per side incl. exchange and NFA fees with a $0.20/contract minimum, and the Coinbase Derivatives exchange schedule lists $0.10/side/contract (non-professional, electronic) on nano BTC (BIT). 5 bps commission + 2 bps adverse-fill allowance = 7 bps/side is a mid placeholder under maker-first framing; the 0/5/10/15/25 ladder brackets it either way. Never Intro-1 (60/120 bps spot) — that book is not this venue and appears nowhere in this pack.
- **Not modelled** (all would move the number, none is in the ladder): futures basis and monthly roll on dated nano contracts; funding on perp-style contracts; the per-contract minimum fee at low notional (a $0.20 minimum on a 0.01 BTC lot is 2 bps at $100k BTC but 10 bps at $20k); contract-size rounding (0.01 BTC / 0.1 ETH lots — a $10,000 book at 0.32× sleeve leverage is ≈ 1.6 BTC nano lots at $100k BTC, so rounding is material at this capital); maker fill probability / queue position (fills are next-bar close, so "maker-first" is only the fee-rate label).

## 6. Reading (diagnostic, not verdict)

- The design runs end-to-end on the locked TRAIN path and produces the required prints; that is the deliverable. The numbers are in-sample on 7.6 years that contain the two largest crypto bull runs, they are unverified on costs, and they are not a research pass.
- Shape: a classic long-biased trend book — trail exits hold the whole P&L (+$115k, WR 66 %), reversal exits are the whipsaw bill (−$55k, WR 26 %, 44 % of them ≤ 5 days). Payoff 2.47 at WR 42.5 % is well above the 1.35 breakeven that WR implies.
- Era dependence is the first thing to flag to the Creator: Sharpe 1.85 through 2021 vs **0.34 for 2022 → 2025-02**, which is statistically indistinguishable from simply holding 50/50 BTC+ETH over the same days (0.35), with a 14-month, 30 % drawdown inside it. The 2024 bull leg (+7.5 %, Sharpe 0.44) did not restore the pre-2022 profile at this variant.
- Shorts (PF 0.97, −$1.2k on 101 trades) add cost without expectancy in-sample; long-only would have shown a higher Sharpe on this window — **not tested here** (that is a second variant and the card is one).
- The 2× leverage cap is inert at a 20 % vol target on 60–90 % vol assets (mean 0.32×, max 0.73×). Realised portfolio vol 22.8 % overshoots the 20 % sleeve target because sizes are set at entry from a 30-day window and both sleeves are on 95 %+ of the time with high BTC/ETH correlation.
- Concentration (top 10 trades > 100 % of net) is inherent to the exit design; any holdout read will be dominated by whether a 2020/21-type run exists in the window.

## 7. Not done / not in scope (per card)

- No research-pass, no GO, no `CONFIRM_LIVE`, no sealed holdout release (HO-H1-DAILY never opened), no DSR/PBO GO packaging, no ≤12 grid — one default variant, no long-only / band / speed / trail sensitivity, no EMA alternative, no ATR-period alternative, no vol-lookback alternative.
- No engine integration: not a strategy plugin, not registered, no guardrails entry, no paper/live wiring, no defaults flipped, no paper GO list touched. `pnpm check:config` is unchanged.
- No maker fill simulation; no basis/roll/funding; no contract rounding; no minimum-fee model; no Intro-1 anywhere.
- No `--allow-synthetic`; nothing written under `fixtures/**` or tracked `atlas/var/**`; the banned `btc-eth-2017_plus` directory does not exist on the box and is refused by string match before any filesystem access.
- The hypothesis card file (`apex-research/hypotheses/H1_apex-trend-v1.md`) was **not** created here — it is the Creator's SoT; §3 is the list of open interpretations to reconcile against it.

## Appendix — artefacts, tests, verification

- Run artefacts (copied to the PR walkthrough set): `h1_apex-trend-v1_dry-run_stdout.log` (the five prints), `h1_apex-trend-v1_dry-run_report.txt`, `h1_apex-trend-v1_dry-run_result.json` (all 212 trades, equity curve, ladder, provenance with full sha256s), `h1_apex-trend-v1_path-lock-refusals.log`. Nothing from `atlas/var/backtest_results/` is committed (gitignored).
- Tests: `src/__tests__/apex-trend-v1-harness.test.ts` — 24 cases: SMA/ATR value-parity with `ValidatedIndicators` (1e-12), vote/band strictness (avg exactly at the band is not a direction), vol-target cap, trail ratchet never loosens, lag-1 fill, trail-vs-reversal precedence on synthetic bars (test data only), same-direction re-entry flag, end_of_data close, leverage cap binding, accounting identities (final equity = initial + Σ pnl; fees = bps × both legs; slippage adverse on both legs), cost-invariant trade timing, shared-equity sleeve sizing, timeline alignment, the hard path lock (banned / sealed / other dirs), fail-closed loader (seal breach / gap / rollup / synthetic / non-daily), the committed TRAIN pin (n 212, exits 127/83/2, BTC 104 / ETH 108, eval start 2017-07-20), report banner/stamp/prints, and the CLI exit codes (2 / 2 / 1).
- Verification on this tree: `pnpm test` **67 files / 1003 tests pass, 0 failures** (66 / 979 before this PR + the 24 new cases), `pnpm exec tsc --noEmit` shows the identical pre-existing 9-error set before and after (no new TS errors), `pnpm check:config` OK (`single-source guardrails and desk pins intact`). Runtime of the dry-run ≈ 1 s.
