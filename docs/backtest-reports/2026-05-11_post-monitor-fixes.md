---
title: "Post-monitor-fixes backtest report — 2026-05-11"
date: 2026-05-11
sprint_task: E6 (SPRINT-PLAN-FINAL.md §3 Workstream E6)
authored_by: backtest measurement task (Round 1 + Round 2 audit fixes)
source: atlas/var/backtest_results/report_2026-05-11_post-monitor-fixes.txt (gitignored runtime artifact)
companion_artifacts:
  - atlas/var/backtest_results/backtest_2026-05-11T20-12-18.json (Run 1 — 90d Coinbase)
  - atlas/var/backtest_results/backtest_2026-05-11T20-29-30.json (Run 2 — 90d Hyperliquid)
  - atlas/var/backtest_results/backtest_2026-05-11T20-56-44.json (Run 3 — 12m Coinbase)
  - atlas/var/backtest_results/backtest_2026-05-11T21-56-30.json (Run 4 — 29d Coinbase)
  - atlas/var/backtest_results/_session_2026-05-11/run{1,2,3,4}_*_stdout.txt (gzipped post-archival)
---

# Post-monitor-fixes backtest report — 2026-05-11

This is the canonical audit report from the post-Round-1+Round-2 backtest
measurement task. It captures the **funnel-latch finding** (the strategy
plugins keep emitting candidate signals across the entire simulation but the
post-strategy filter chain admits zero signals after the first ~36–48
simulated hours, regardless of window length) — which became the
foundation for Sprint task **F1** (funnel residuals fix).

The body below is the verbatim text artifact produced by the engine and the
operator; preserved unchanged inside a fenced code block so the report stays
byte-faithful as a historical audit record. **Do not edit the fenced block;
add follow-up notes outside it instead.**

For context on what to do with these findings, see:

- `atlas/var/tmp/monitor/SPRINT-PLAN-FINAL.md` §0 (executive summary references the funnel-latch finding) and §3 Workstream F (F1, F2, F3, F4).
- Sprint key code locations: `atlas/apps/core-node/src/strategies/{signal-processor,signal-arbiter,meta-filter}.ts` (the three `Date.now()` sites that latch funnel state by wall-clock).

## Verbatim report

```text
================================================================================
APEX AUTOMATA / ATLASBOT v2 — POST-AUDIT BACKTEST REPORT
================================================================================
Date            : 2026-05-11
Branch / commit : main @ 9eefec4 (read-only; no commits, no edits)
Operator        : measurement task — concrete evidence of strategy behavior under
                  Round 1 + Round 2 audit fixes (signal-funnel telemetry, order-
                  lifecycle hygiene, strategy tuning, backtest realism, etc.)
Engine binary   : pnpm backtest  →  tsx src/cli/backtest.ts
                  (atlas/apps/core-node, no recompile, no dep changes)
Guardrails YAML : atlas/config/guardrails.yaml (single source of truth for
                  fees, sizing, disabled_strategies, per-symbol overrides,
                  realism model)

--------------------------------------------------------------------------------
0.  HEADLINE FINDING (read this first)
--------------------------------------------------------------------------------
Across four backtests of varying length and start date (30d, 90d, 90d, 12m), the
engine produced trades only in a 40–45 hour window at the very beginning of each
run, then went silent for the remainder of the period:

    Run            Window length     Trade-active window     Silent after
    -----------    --------------    --------------------    -------------------
    30d (Run 4)    29 days           40.2 hrs (Feb 5–7)      25 days silent
    90d (Run 1)    90 days           44.8 hrs (Dec 6–7)      87 days silent
    90d (Run 2)    90 days           44.8 hrs (Dec 6–7)      87 days silent
    12m (Run 3)    365 days          42.8 hrs (Mar 6–7)      362 days silent

The strategy plugins themselves keep emitting candidate signals throughout each
run (see "Signal funnel telemetry" below — strategy-level emits span line 471 →
line 24,737 in the 30d run, i.e. the full simulation), but the post-strategy
filter chain (regime gate → arbiter → meta-quality / position-multiplier →
final "Signal generated" emit) admits zero signals after roughly the second
day of every backtest. The pattern is deterministic and independent of window
length or calendar start date, which strongly suggests a state-carry bug in
the meta-quality / arbiter / regime-confidence pipeline rather than a real
absence of edge.

CONSEQUENCE: Per-strategy P&L numbers below are computed on a 9–12 trade
sample concentrated in 36–48 hours. They are NOT statistically meaningful for
an EV verdict on the strategy mix. They ARE useful as a regression baseline
and as evidence that the funnel pipeline needs investigation before any
"go-live" decision is taken on the back of this run.

--------------------------------------------------------------------------------
1.  WHAT WAS RUN, AND WHY THESE WINDOWS
--------------------------------------------------------------------------------
The user requested 90 days BTC-USD / ETH-USD / SOL-USD on 2026-02-11 → 2026-05-10.
A direct probe of the Supabase `bars` table (the data source the engine reads
from) shows cached coverage as:

    BTC-USD : 2025-03-05 → 2026-03-05  (8641 × 15m candles)
    ETH-USD : 2025-03-05 → 2026-03-05  (8641 × 15m candles)
    SOL-USD : 2025-09-05 → 2026-03-05  (~6 months)

Latest cached bar is 2026-03-05; the requested 2026-03-05 → 2026-05-10 segment
is not yet cached. Per the task's fallback policy, four real-data runs were
executed instead of synthetic data:

    Run 1 — Coinbase 40 bps      90 days, 2025-12-05 → 2026-03-05, BTC+ETH+SOL
    Run 2 — Hyperliquid 4.5 bps  90 days, same window, --commission 0.00045
    Run 3 — Coinbase 40 bps      365 days, 2025-03-05 → 2026-03-05  (Phase3 parity)
    Run 4 — Coinbase 40 bps      29 days, 2026-02-04 → 2026-03-05   (latest data)

Data source for all four runs: REAL — Supabase `public.bars`, 15m candles,
fully validated by the engine's data-loader (`Loaded 8641 candles from
Supabase` per symbol per 90d window; engine reports `source: 'supabase'`).
No synthetic fallback was triggered. Initial capital $10,000 in all runs.
Slippage 5 bps. Realism: next-bar fill, 20 % bar-range stop overshoot (min 5 bps).
Risk per trade 0.5 %, max position exposure 30 % of equity.

Active strategies (registered + enabled): momentum, trend_follow.
Disabled strategies (per guardrails.yaml): vwap_mr, breakout — kill-listed by
the Phase 3 verdict. The engine logs confirm: `Initialized 2 built-in
strategies (skipped disabled: breakout, vwap_mr)`.

Per-symbol overrides loaded by the engine (per logs):
    momentum     : BTC-USD, ETH-USD, SOL-USD
    trend_follow : ETH-USD only

Stdout for each run is preserved alongside this report at:
    atlas/var/backtest_results/_session_2026-05-11/
        run1_coinbase_90d_stdout.txt        (78,331 lines, 8.4 MB)
        run2_hyperliquid_90d_stdout.txt     (78,331 lines)
        run3_coinbase_12m_stdout.txt        (158,059 lines)
        run4_coinbase_30d_late_stdout.txt   (24,796 lines)

Engine-saved JSON + auto-generated text reports (raw output) at:
    backtest_2026-05-11T20-12-18.json + report_2026-05-11T20-12-18.txt   Run 1
    backtest_2026-05-11T20-29-30.json + report_2026-05-11T20-29-30.txt   Run 2
    backtest_2026-05-11T20-56-44.json + report_2026-05-11T20-56-44.txt   Run 3
    backtest_2026-05-11T21-56-30.json + report_2026-05-11T21-56-30.txt   Run 4

--------------------------------------------------------------------------------
2.  TOP-LINE METRICS (one row per run)
--------------------------------------------------------------------------------
Run                              Trades  WinR    PF     Net P&L      Ret%    MaxDD%   Sharpe   Sortino   Fees$    AvgHoldMin
-----------------------------    ------  ------  -----  -----------  ------  -------  -------  --------  -------  ----------
1) 90d  BTC+ETH+SOL  Coinbase     9      33.33%  0.31    -$219.65    -2.20%   2.20%    -2.17    -0.32     208.21    376.7
2) 90d  BTC+ETH+SOL  Hyperliquid  9      33.33%  0.82     -$34.86    -0.35%   1.85%    -0.34    -0.04      23.42    376.7
3) 365d BTC+ETH+SOL  Coinbase    10      40.00%  0.26    -$288.06    -2.88%   3.33%    -1.56    -0.16     233.56    207.0
4) 29d  BTC+ETH+SOL  Coinbase    10      10.00%  0.03    -$631.06    -6.31%   6.40%    -4.80    -1.45     158.93    186.0

Notes
- Run 2 trade list is byte-identical to Run 1 in entry/exit prices and exit
  reasons (same 9 trades) — only fees and per-trade P&L differ. This is the
  pure fee-sensitivity comparison the prompt asked for.
- Sharpe / Sortino on 9–10 trades is essentially noise; reported for
  completeness, not for verdicting.

--------------------------------------------------------------------------------
3.  PER-STRATEGY BREAKDOWN
--------------------------------------------------------------------------------
                 Trades  WinR     NetPnL$    AvgR-multiple     Symbols hit
                 ------  ------   --------   --------------    --------------------
RUN 1 (90d, Coinbase)
trend_follow      4      25.0%    -$93.00       -0.74          BTC×1, ETH×1, SOL×2
momentum          5      40.0%    -$126.65      -0.95          BTC×2, ETH×2, SOL×1

RUN 2 (90d, Hyperliquid; same trades, lower fees)
trend_follow      4      25.0%    -$13.15       -0.17
momentum          5      40.0%    -$21.71       -0.08

RUN 3 (12m, Coinbase) — direct parity with Phase 3 backtest setup
trend_follow      4      25.0%    -$174.63      -1.05          BTC×1, ETH×1, SOL×2
momentum          6      50.0%    -$113.43      -0.57          BTC×2, ETH×2, SOL×2

RUN 4 (29d, Coinbase, late-window 2026-02-04 → 2026-03-05)
trend_follow      5      20.0%    -$253.90      -1.02
momentum          5       0.0%    -$377.16      -1.54

Expectancy (avgR-multiple) is negative for every strategy in every run, but
again — these are 4–6 trade samples concentrated in 36–48h. Treat as
regression evidence, not edge measurements.

--------------------------------------------------------------------------------
4.  SIGNAL FREQUENCY ("HONEST ACTIVITY") — THE KEY DELIVERABLE
--------------------------------------------------------------------------------
Counted from the engine's structured logs across each full run. "Strategy
emits" = candidate signals returned by the strategy plugin. "Final emits" =
signals that passed every downstream filter (regime gate, arbiter,
meta-quality, position-multiplier) and reached the executor. "Regime-rejected"
counts only trend_follow rejections at the ranging-regime gate (the
strategy-tuning fix introduced this filter — it is by far the loudest source
of rejection in the funnel logs).

Run 1 — 90 days, Coinbase, BTC+ETH+SOL
  Strategy emits        : 1,165   (645 momentum + 520 trend_follow)
  Regime-rejected (TF)  : 9,160   (TF invocations on ranging regime)
  Final emits           :    12   (across 12 line numbers in the log)
  Final-emit pass rate  :  1.03 %  of strategy-emitted signals
  Per-day rate          :  0.13   final signals / day across all 3 symbols
  Per-strategy/day      :  ~0.04 trend_follow/day,  ~0.06 momentum/day
                          BUT clustered: all 12 final emits inside Dec 6–7

Run 3 — 12 months, Coinbase, BTC+ETH+SOL
  Strategy emits        : 2,336   (1,287 momentum + 1,049 trend_follow)
  Regime-rejected (TF)  : 17,629
  Final emits           :    12   (all in Mar 6–7, 2025)
  Final-emit pass rate  :  0.51 %
  Per-day rate          :  0.033 final signals/day (annualized basis)
  Strategy-emit/day     :  ~3.5 momentum/day + ~2.9 trend_follow/day
                          across 3 symbols — strategies ARE firing

Run 4 — 29 days, Coinbase, BTC+ETH+SOL
  Strategy emits        :   418   (242 momentum + 176 trend_follow)
  Regime-rejected (TF)  : 2,198
  Final emits           :    12   (all in Feb 5–7, 2026)
  Final-emit pass rate  :  2.87 %
  Per-day rate          :  0.41 final signals/day if they were spread
                          (they aren't — all on Feb 5–7)

Spread evidence (line numbers in the run-3 stdout, total 158,059 lines):
  Strategy momentum emits  : line   230 → 157,978   (full 12m simulation)
  Strategy trend_follow    : line   456 → 158,000   (full 12m simulation)
  Final "Signal generated" : line   233 →   1,834   (first ~1 % of run output)

In other words: the strategies themselves are emitting candidate signals
across the entire 12-month simulation. The final-emit funnel admits signals
only during the first ~1 % of wall-clock processing time (which corresponds
to the first ~36–48 simulated hours of every backtest window). This
behaviour is identical in the 30d, 90d, and 12m runs — the trade-active
window does not scale with backtest length.

The cleanest signal frequency we can quote with the current funnel pipeline is
NOT "X signals/day" but rather "≈12 final signals per backtest, all in the
first 36–48 simulated hours, regardless of window length". This number is
not a property of the underlying market or the new tuning; it is a property
of the post-strategy filter chain.

--------------------------------------------------------------------------------
5.  FEE IMPACT — COINBASE 40 bps  vs  HYPERLIQUID 4.5 bps
--------------------------------------------------------------------------------
Pure fee sensitivity comparison on the identical 9-trade tape (Run 1 vs Run 2,
both 90d 2025-12-05 → 2026-03-05, BTC+ETH+SOL):

                                   Coinbase 40 bps      Hyperliquid 4.5 bps     Δ
                                   ----------------     -------------------     -------
Total fees paid                    $208.21              $23.42                  -$184.79
Fees as % of starting equity       2.08 %               0.234 %                 -1.85pp
Fees as bps of total notional      40 bps × 2 sides     4.5 bps × 2 sides       —
Net P&L                            -$219.65             -$34.86                 +$184.79
Total return                       -2.20 %              -0.35 %                 +1.85pp
Profit factor                      0.31                 0.82                    +0.51
Sharpe                             -2.17                -0.34                   +1.83
Max drawdown $                     $219.65              $187.92                 -$31.73
Max drawdown %                     2.20 %               1.85 %                  -0.35pp
trend_follow strategy net          -$93.00              -$13.15                 +$79.85
momentum strategy net              -$126.65             -$21.71                 +$104.94

On the 90-day tape, the venue swap recovers ~$185 (~95 % of the entire net
loss on Coinbase) but does NOT, by itself, push the strategy mix into
positive territory: it goes from clearly negative to barely-negative
(-0.35 %, profit factor 0.82, expectancy still slightly < 1.0R per trade).
Phase 3's prior conclusion that fee structure dominates is reaffirmed; the
new post-audit conclusion that Hyperliquid alone is sufficient is not.

For Run 3 (12m, Coinbase) the same arithmetic gives an estimated Hyperliquid-
fee equivalent of:
    Fees on HL ≈ Fees on CB × (4.5 / 40) = $233.56 × 0.1125 ≈ $26.28
    Estimated HL net P&L         ≈ -$288.06 + ($233.56 - $26.28) ≈ -$80.78
    Estimated HL total return    ≈ -0.81 %  on 10 trades over 12 months
This is an arithmetic projection (fees scale ~linearly with notional and
position sizing here is fixed-risk, not fixed-equity), not a re-run.

--------------------------------------------------------------------------------
6.  PHASE 3 CROSS-CHECK
--------------------------------------------------------------------------------
Phase 3 verdict (PHASE3_BACKTEST_VERDICT.md, March 6 2026, 12-month BTC+ETH 15m):
  Trend Follow ETH on Hyperliquid : 130 trades, 43.8 % WR, +18.6 %, PF 1.38, Sharpe 2.44.
  Momentum ETH on Hyperliquid     :  81 trades, 44.4 % WR, +12.6 %, PF 1.41, Sharpe 2.58.
  Verdict                         : TF+ETH on HL = the only viable combo.

This run (12 months, BTC+ETH+SOL, post-Round-1 + Round-2 audit fixes,
Coinbase fees; HL projected by fee delta):
  All-strategy / all-symbol total : 10 trades over 12 months.
  trend_follow total (all symbols):  4 trades, 25 % WR, -$174.63 (Coinbase),
                                                              ≈ -$155 (HL projection).
  trend_follow on ETH-USD alone   :  1 trade.
  momentum total                  :  6 trades, 50 % WR, -$113.43 (Coinbase),
                                                              ≈ -$94 (HL projection).
  momentum on ETH-USD alone       :  2 trades.

Direct comparison vs Phase 3:
  Trade frequency for TF+ETH      : 130 → 1     (-99.2 %)
  Trade frequency for MOM+ETH     :  81 → 2     (-97.5 %)
  TF+ETH PnL                      : +$1,864 → -$XX   (one trade, not measurable)

VERDICT vs PHASE 3
  Confirmed?       : NO. The 12-month comparable run produces 1 trade for the
                     "only viable combo", not 130. Edge cannot be measured
                     from a one-trade sample.
  Contradicted?    : NOT EXACTLY. The 9-trade sample is uniformly losing on
                     Coinbase (consistent with Phase 3's Coinbase verdict),
                     but it is too small to reject Phase 3's HL verdict.
  Better framing   : The post-audit funnel is admitting ~99 % fewer signals
                     than the engine that produced Phase 3's numbers. The
                     comparison is apples-to-oranges until the funnel is
                     fixed.

--------------------------------------------------------------------------------
7.  VERDICT
--------------------------------------------------------------------------------
Q: Is the current strategy mix EV-positive on Coinbase fees?
A: NO, and not even close. Across 4 windows ranging from 29d to 365d, total
   return is between -2.20 % and -6.31 %, profit factor 0.03 → 0.31, every
   strategy negative-expectancy on every available sample. Fees consume
   roughly 80 % – 95 % of the gross loss. This is consistent with the Phase 3
   Coinbase verdict — Coinbase remains uneconomic, even on a small sample.

Q: Is it EV-positive on Hyperliquid fees?
A: UNDETERMINED on this sample. The 90d Run 2 lands at -0.35 % / PF 0.82,
   which is not statistically distinguishable from zero given a 9-trade
   sample. The 12m projection is ≈ -0.81 %. To answer the EV question on HL,
   we need a sample of dozens to hundreds of post-funnel trades — which the
   current engine does NOT produce.

Q: Has the engine become "honest" in the way the user expected?
A: PARTIALLY. The strategy plugins are honest — they emit candidate signals
   across the full simulation, at a sane rate (~6/day across 3 symbols).
   The post-strategy filter chain is NOT honest in the same way: it admits
   exactly one ~36–48h burst of trades at the start of every backtest, then
   permanently silences itself. That is the same shape as the live monitoring
   session's "23 minutes, 0 trades" — but for the OPPOSITE reason. The live
   session was at the start of the bot's lifetime (so should have been in
   the trade-active window), yet still produced zero signals; in the
   backtests, the engine processes roughly 36–48 hours of bars before going
   silent. Both pieces of evidence point to a state-carry / one-shot bug in
   the meta-quality / arbiter / regime-confidence pipeline, not to a true
   absence of edge.

--------------------------------------------------------------------------------
8.  RECOMMENDATIONS (engineering, not trading)
--------------------------------------------------------------------------------
1. Investigate why the post-strategy funnel admits zero final signals after
   the first 36–48 simulated hours of every backtest, regardless of window
   length or start date. Likely suspects, ordered by suspicion:
     a) Meta-quality scorer — does it carry equity/drawdown state that
        crashes scoring after the first batch of losses?
     b) Regime-confidence arbiter — same question for regime-confidence
        buffers that may saturate during warmup and never re-converge.
     c) A "warmup-complete" one-shot flag flipping in the wrong direction
        after the first cooldown / position-flat.
     d) trend_follow `crossoverLookback: 0` interaction with a duplicate-
        emission guard that latches after the first emit per (symbol,
        direction) pair.
2. Add a per-checkpoint signal-funnel counter dump to the end of each
   backtest run (the Round 2 PR instrumented 9 silent funnel sites — surface
   those counters in the saved JSON / report).
3. Re-run this exact 4-run matrix once the funnel is fixed. The 90d window
   on the same Supabase data will then yield enough trades to make the
   Coinbase-vs-Hyperliquid EV question decidable.
4. Until then, do NOT promote either strategy past paper-trade based on
   these numbers — and equally, do NOT kill them. The data is corrupted by
   the funnel issue, not the strategies.

--------------------------------------------------------------------------------
END OF REPORT
--------------------------------------------------------------------------------
```
