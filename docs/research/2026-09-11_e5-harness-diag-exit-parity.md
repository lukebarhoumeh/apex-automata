# E5-HARNESS-DIAG — `--exit-parity` harness diagnostics, 15m TF-only REAL (Algo Alpha card)

**DIAGNOSTICS ONLY — NOT E5 GO.** No `CONFIRM_LIVE`. No ≤12 exit grid. No A1 retune. No ADX peek. E3 HOLD SoT unchanged; A6 prod stays off. `--exit-parity` default stays `off`. This PR is docs-only: nothing under `atlas/config/**`, `fixtures/**` or `atlas/apps/core-node/src/**` changed (`pnpm check:config` OK; `pnpm test` 65 files / 964 tests pass on the same tree).

**Date:** 2026-09-11 · **Card:** Algo Alpha E5-HARNESS diagnostics · **Infra under test:** #54 (`--exit-parity`, G1/G3/G5 infra, merged) · **Data:** #53 (`fixtures/bars/15m/*`, REAL, native 15m) · **Config SoT:** `atlas/config/guardrails.yaml` at `47157f9` (#55 momentum KILL; `strategy.stop_trail_atr 1.0`, `time_stop_bars 96`, per-symbol trend_follow `stopAtr 2.5 / takeProfitAtr 6.0`) · **Audience:** Algo Beta · Creator · TM · Eng.

**Null reference (card):** realized payoff ≈ 1.35, stop-heavy. Everything below is diagnostics vs that null, not a GO bar. Every counted number in this pack is **DIAG / UNDERPOWERED** and additionally **window-truncated** (§5) — still not GO.

---

## 0. STOP gate — G1 / G3 / G5 (checked before any table)

Checked on the shipped code + guardrails with a throw-away script (`/tmp`, not committed; output in `g1-g3-g5-gate-check.log`) and the merged suite `src/__tests__/backtest-engine-exit-parity.test.ts` (20/20 pass).

| ID | Requirement | Evidence | Result |
|---|---|---|---|
| **G1** | Backtest consumes `stop_trail_atr` + `time_stop_bars` | `buildBacktestConfig({applyExitParity:true})` → `execution = {trailAtrMultiplier: 1, timeStopBars: 96}` (read from `guardrails.strategy.*`, `backtest-cli-config.ts buildExecutionBlock`); `applyExitParity:false` → `execution = undefined`. Engine echoes them: run header prints `Exit rules: … ATR trail 1 × entry ATR; time stop 96 bars` (on) vs `ATR trail off; time stop off` (off). Consumers: `checkExitConditions` step 1 (trail) and step 3 (time stop), `ratchetTrailingStop`. | **GREEN** |
| **G3** | Trail is ATR-based (`stop_trail_atr` × entry ATR) | `ratchetTrailingStop`: `distance = this.trailAtrMultiplier * position.entryAtr`; no `highWaterMark × 0.01` term in the engine. Probe: entryAtr 4, HWM → 110, `stop_trail_atr 1` ⇒ trail 106 (= HWM − 1 × ATR); the HWM × 0.01 approximation would give 108.9. Entry ATR read from trend_follow's `metadata.atr` (`resolveEntryAtr`); `trailUnavailableNoAtr = 0` on every run (104/104, 23/23, 57/57, 935/935, 1039/1039 entries carried ATR). | **GREEN** (harness) |
| **G5** | Exit labels stop / trail / TP / time-stop distinct | `BACKTEST_EXIT_REASONS = [stop_loss, take_profit, trailing_stop, time_stop, signal, end_of_data]`, type-locked to live `PositionExitCondition['type']`; engine stamps all five monitor/signal labels via `closePosition(…, 'trailing_stop' \| 'stop_loss' \| 'take_profit' \| 'time_stop' \| 'signal')`; report zero-fills every label. Trail exits are reported as `trailing_stop`, never folded into `signal` or `stop_loss`. Fill model: `trailing_stop`/`stop_loss` carry the overshoot model, `take_profit` fills at level, `time_stop`/`signal`/`end_of_data` are market exits with symmetric slippage. | **GREEN** |

No red ⇒ diagnostics proceed.

**Gate caveats (not red, but E5 pre-reads):**

- **G3 is green for the harness, not for live.** `src/trading/position-monitor.ts updateTrailingStop` still uses `trailPercent = stop_trail_atr × 0.01` of the high-water mark (a 1 % trail at `stop_trail_atr 1.0`), while the harness implements the documented `stop_trail_atr × ATR` semantics (#54 comment: "NOT the live file's `highWaterMark × 0.01` approximation"). `--exit-parity on` is therefore parity with the *documented* rule, not with the *shipped* live rule. Before E5 flips anything, Eng/TM must pick which one is the target; at 15m ATR% ≈ 0.47–0.56 % (median, §8) a 1 % HWM trail is ≈ 2× looser than 1 × ATR, so the two rules would produce different exit mixes.
- **G1 consumer is wired but `time_stop_bars 96` never binds at this geometry** (0 `time_stop` exits on the 1,096 parity-on trades of §2 A, §6 ON and §7): the 1 × ATR trail closes every position long before bar 96 (§6 ON: hold p50 2 / p90 8 / max 45 bars). Consumer proven, rule dead in practice — see §3/§8.

## 1. Run card (exact commands; from `atlas/apps/core-node`, zero knobs)

```bash
# A. HOLDOUT eval (counted path; eval once) — parity ON (research-on for this run only)
pnpm exec tsx src/cli/backtest.ts --fixture-dir fixtures/bars/15m/holdout-2025-03_2026-03 \
  --products BTC-USD ETH-USD SOL-USD --strategy trend_follow \
  --start-date 2025-03-01 --end-date 2026-03-01 --exit-parity on --commission 0 --ev-gate off

# B. HOLDOUT baseline — identical, --exit-parity off (before/after exit mix)
# C. TUNE diagnostic — fixtures/bars/15m/tune-2023-03_2025-03, 2023-03-01 → 2025-03-01, --exit-parity on (in-sample; never evidence)
```

Zero knobs verified from the run JSON/report: A1 geometry per symbol `stopAtr 2.5 / takeProfitAtr 6.0` (BTC/ETH/SOL pins; ETH `emaFast 12 / emaSlow 15`); measured fill-relative stop distance 2.52–2.87 × signal ATR and TP 5.63–5.98 × signal ATR (fill = next-bar open + 5 bps slippage, so the ratios sit around the 2.5/6.0 pins rather than on them); `stop_trail_atr 1.0`, `time_stop_bars 96` as shipped; realism `next_bar_fill true / entry_slippage 5 bps / stop overshoot 20 % of bar range, min 5 bps`; RegimeFilter on (`minCompat 0.3 / minConf 0.4`); A6 `regime_gates.enabled false`; `disabled_strategies [vwap_mr, breakout, momentum]`; sizing 0.5 % of cash equity on $10,000. Fees `--commission 0` (zf), EV gate `off` per card. Never `--allow-synthetic`. Each holdout pass ≈ 2.5 min, tune ≈ 5 min.

Data stamp on every run: `DATA: REAL`, `source=fixture`, `spacing=15m`, `Bar timeframe: 15 min (native stored bars; no aggregation)`, bars 35017 / 35015 / 35017 of 35041 (holdout) and 70147 / 70148 / 70144 of 70177 (tune), fixture sha256 prefixes `17f367b6965d` / `d0f8d5464ae5` / `ce3d1dba82b6` (holdout) and `8eeb1778c6df` / `f9b04254fbd3` / `b557cacd6667` (tune) — match the committed table in `fixtures/bars/15m/README.md`.

## 2. TF · pooled n + per-symbol · isolation proof (TF-only, long-only)

**TF = 15m native** (declared `FIFTEEN_MINUTE`, inferred spacing 15m, no rollup). Isolation proof, identical on all five runs in this pack:

| Check | Value |
|---|---|
| `metrics.activeStrategies` / `byStrategy` keys / distinct `trade.strategy` | `["trend_follow"]` / `["trend_follow"]` / `["trend_follow"]` |
| `disabledStrategies` (guardrails kill list, honoured) | `["vwap_mr", "breakout", "momentum"]` |
| Registered plugins at run start | `trend_follow` only (`Backtest active strategies … registered:["trend_follow"]`) |
| distinct `trade.side` / short entries | `["BUY"]` / 0 — spot venue, SELL = exit-only (`venue_no_shorting` counted) |
| EV gate / ATR-vol filter / min-hold | mode `off`, evaluated 0 · `atrFilterRejects 0` (see §8) · `exitsIgnoredMinHold 0` (min-hold not set on `pnpm backtest`) |

### Counted holdout run (A, parity ON) — eval ledger entry for 15m TF-only + exit parity

| | pooled | BTC-USD | ETH-USD | SOL-USD | window | printed E[n]/12m |
|---|---|---|---|---|---|---|
| closed trades | **104** | 36 | 37 | 31 | 2025-03-01 → 2026-03-01 (365.0 d) | 104.1 |
| **trading-active span** | **2025-03-01 17:00 → 2025-04-13 11:15 UTC = 42.8 d of 365** | | | | last admitted signal bar 4172 of 35016 (11.9 % of window) | naive re-annualised ≈ 888 |

### Baseline (B, parity OFF)

| | pooled | BTC-USD | ETH-USD | SOL-USD | trading-active span |
|---|---|---|---|---|---|
| closed trades | **23** | 8 | 10 | 5 | 2025-03-01 17:00 → 2025-03-10 14:00 UTC = 8.9 d of 365 (last admitted bar 919, 2.6 %) |

n is **not** signal-limited: trend_follow emitted 2,164 candidates over the 12 months in both runs; 1,942 (A) / 2,098 (B) were blocked at the `meta` stage with reason `cold_streak` after the last admitted bar. See §5 before reading any n as a rate.

## 3. Exit mix — before / after parity

The counted pair (A vs B) is **not comparable** as before/after: B latches after 8.9 days with 23 trades, A after 42.8 days with 104 (B's 23 entries are all also in A). The card's rule applies: **after-only, labelled**, for the counted run; the comparable before/after lives in §6 (research sensitivity, latch off, 881 of 935/1039 entries shared).

### After (A, parity ON, counted, latched at 42.8 d) — labelled

| reason | n | share | WR | net (zf) | mean R | hold p50 / mean (15m bars) |
|---|---|---|---|---|---|---|
| stop_loss | 5 | 4.8 % | 0 % | −$229 | −1.20 | 5 / 5.2 |
| take_profit | 2 | 1.9 % | 100 % | +$237 | +2.37 | 1 / 0.5 |
| **trailing_stop** | **94** | **90.4 %** | 24.5 % | −$416 | −0.10 | **2 / 3.8** |
| time_stop | 0 | 0 % | — | — | — | — |
| signal (opposite-direction exit) | 3 | 2.9 % | 0 % | −$41 | −0.44 | 0 / 0.0 |
| end_of_data | 0 | 0 % | — | — | — | — |

Per symbol (A): BTC 1 stop / 0 TP / 33 trail / 2 signal · ETH 3 / 1 / 33 / 0 · SOL 1 / 1 / 28 / 1.

### Before (B, parity OFF, counted, latched at 8.9 d) — labelled, not comparable to A

stop_loss 12 (52.2 %, mean R −1.22, hold p50 16 bars) · take_profit 3 (13.0 %, +2.34 R) · signal 8 (34.8 %, WR 25 %, −0.07 R, hold p50 12) · trailing_stop / time_stop / end_of_data 0.

### Reading

Under parity the **1 × ATR trail is the exit**: it arms on the first bar that improves the high-water mark at `HWM − 1 × entry ATR`, which is inside the 2.5 × ATR hard stop the moment it arms, and a 15m bar range routinely exceeds 1 ATR. Hold p50 2 bars on A (max 37) and p50 2 / p75 5 / p90 8 / max 45 on the full-window §6 ON run — same shape. Consequences: hard-stop exits fall 52 % → 5 % (B → A; 41 % → 3 % over the full window), TP exits 13 % → 2 % (19 % → 0.7 %), and the 96-bar time stop is never reached. On the §6 ON run's 838 trail exits, 41 % close within ±0.25 R (scratches); trail-exit R distribution p10 −0.43 / p50 −0.21 / p90 +0.42 / max +1.42 — the trail caps winners at ≈ 1.4 R while the TP sits at 6 R. It is a tighter stop, not a profit-protecting trail, at this TF and geometry.

## 4. Realized payoff · WR · zf PF (informational; `--commission 0`, EV off)

| | A parity ON (counted, n 104, 42.8 d) | B parity OFF (counted, n 23, 8.9 d) | null (card) |
|---|---|---|---|
| WR | 24.0 % | 21.7 % | — |
| realized payoff (avg win / avg loss) | **1.78** ($23.11 / $12.99) | 2.00 ($83.48 / $41.81) | ≈ 1.35 |
| zf PF | 0.56 | 0.55 | — |
| net (zf) / return | −$449 / −4.49 % | −$335 / −3.35 % | — |
| mean R · t | −0.115 · −2.17 | −0.357 · −1.39 | — |
| max DD | 6.58 % | 6.49 % | — |
| breakeven WR at realized payoff | 36.0 % | 33.4 % | — |
| per-symbol zf PF (BTC / ETH / SOL) | 0.32 / 0.55 / 0.88 | 0.79 / 0.36 / 0.61 | — |

Payoff on both counted runs sits **above** the 1.35 null (1.78 / 2.00) but WR (24 % / 22 %) is far below the 36 % / 33 % breakeven those payoffs need, so zf PF ≈ 0.55 either way. Exit-heavy composition differs completely (§3) yet PF barely moves: at these n the payoff/WR trade-off is a wash and the sign of expectancy is negative in both. **Underpowered (n 104 / 23, 43 / 9 trading days) ⇒ DIAG / UNDERPOWERED, not GO.** Over the full window (§6) the parity-ON payoff collapses onto the null (1.37) and PF to 0.47.

## 5. Harness-validity finding — MetaFilter cold-streak latch truncates every TF-only window

Every run in the counted path stops trading early and never resumes:

| run | window | last admitted signal | trading-active | candidates | blocked `meta.cold_streak` | trades |
|---|---|---|---|---|---|---|
| A holdout, parity on | 365 d | 2025-04-13 11:00 (bar 4172 / 35016) | 42.8 d (11.9 %) | 2,164 | **1,942** | 104 |
| B holdout, parity off | 365 d | 2025-03-10 13:45 (bar 919) | 8.9 d (2.6 %) | 2,164 | **2,098** | 23 |
| C tune, parity on | 731 d | 2023-03-19 12:00 (bar 1759 / 70147) | 17.9 d (2.5 %) | 4,501 | **4,320** | 57 |

(From the engine's end-of-run `Backtest funnel diagnostics` line: `lastAdmittedBarPerStrategy`, `filteredByStage.meta.cold_streak`.)

**Mechanism** (`src/strategies/meta-filter.ts`): `evaluateColdStreak` blocks when `perf.consecutiveLosses >= coldStreakThreshold (10) || inCooldown (5 min)`. `consecutiveLosses` is reset **only** by a recorded win (`recordTradeOutcome`, `outcome === 'win'`). A blocked strategy takes no trades, so no win can ever be recorded ⇒ once a strategy reaches 10 consecutive losses it is blocked for the rest of the process/run. The 5-minute cooldown is irrelevant because the `isColdStreak` term alone blocks. This is **not** the May-2026 wall-clock latch (F1/F2, `nowMs` threading — that fix is intact: the cooldown is evaluated on bar time); it is a logic deadlock that the wall-clock fix left in place. F3's ≥ 50-trade validation ran the mixed momentum + trend_follow book (`--strategy all` at the time; the streak counter is per strategy), so a single strategy's own latch was never exercised there. The behaviour described in `CLAUDE.md` ("cold-streak cooldown after 10 losses → 5 min pause") is the intent, not what the code does.

**Why it bites TF-only 15m now:** trend_follow's WR here is 24–32 %; P(10 straight losses in a 10-trade block) ≈ 6.4 % at WR 24 %, 2.1 % at 32 %. Over the full-window sensitivity runs (§6) the loss streak reached 10 **14 times** (parity on) / **21 times** (parity off); longest streak 18 / 17. Any TF-only run through this funnel with `coldStreakEnabled` (default `true`) latches within weeks.

**Consequences for this pack and for the TF-only REAL book:** (i) the counted n and E[n] in §2 are 43-day / 9-day numbers, not 12-month rates; (ii) the exit mix, WR, payoff and PF in §3–§4 are measured on March–April 2025 only; (iii) the same code path runs live/paper (`trading-engine` → `signalProcessor.recordTradeOutcome` → MetaFilter), so a paper TF-only book silently stops trading after its first 10-loss streak until the process restarts (MetaFilter state is in-memory; nothing calls `loadHistoricalPerformance`, so a restart clears it — and hides it). Any earlier TF-only 15m book produced through `src/cli/backtest.ts` should be re-read against its own `Backtest funnel diagnostics` line (`lastAdmittedBarPerStrategy`, `meta.cold_streak`) before its n is quoted. **Eng item, not addressed here** (diagnostics only; no code changed).

## 6. Research sensitivity — cold-streak latch OFF (NOT live parity, NOT counted)

To see the exit mix over the whole holdout, the same shared config builder and flags as A/B were run from a `/tmp` script that, after `initializeSignalProcessor()`, calls `signalProcessor.updateMetaFilterConfig({ coldStreakEnabled: false })` (existing public API; every other meta-filter rule, the RegimeFilter, the arbiter and the spot SELL handling stay as shipped). Nothing in the repo changed; the run is labelled `RESEARCH SENSITIVITY — cold-streak latch OFF — NOT live parity` in its stdout and `latch-off-parity-{on,off}` in its artefact tags. These numbers are **not** the counted path and **not** an argument for disabling the rule; they exist to make §3 interpretable.

### n (full 365 d, both runs trade all four quarters)

| | pooled | BTC | ETH | SOL | Q1 / Q2 / Q3 / Q4 n | shared (product, fill time) entries |
|---|---|---|---|---|---|---|
| parity ON | **935** | 307 | 313 | 315 | 234 / 230 / 246 / 225 | 881 of 935 / 1039 |
| parity OFF | **1,039** | 342 | 350 | 347 | 252 / 261 / 274 / 252 | (entry sets diverge only after an exit-rule difference frees the book) |

### Exit mix before / after parity (comparable pair)

| reason | OFF n | OFF share | ON n | ON share | ON WR | ON mean R | ON hold p50 / mean |
|---|---|---|---|---|---|---|---|
| stop_loss | 422 | 40.6 % | 31 | 3.3 % | 0 % | −1.16 | 4 / 5.2 |
| take_profit | 198 | 19.1 % | 7 | 0.7 % | 100 % | +2.24 | 2 / 4.3 |
| trailing_stop | 0 | 0 % | **838** | **89.6 %** | 27.6 % | −0.10 | **2 / 3.7** |
| time_stop | 0 | 0 % | 0 | 0 % | — | — | — |
| signal | 419 | 40.3 % | 59 | 6.3 % | 0 % | −0.50 | 0 / 1.1 |
| end_of_data | 0 | 0 % | 0 | 0 % | — | — | — |

OFF detail: stop_loss WR 0 % / −1.17 R / hold p50 15 bars; take_profit +2.23 R / hold p50 28; signal WR 31.7 % / −0.16 R / hold p50 14. OFF hold p50 17, p75 43, p90 71, max 461 bars; 55 of 1,039 OFF trades (5.3 %) ran ≥ 96 bars (16 TP / 29 signal / 10 stop, net +$1,108) — the population a 96-bar time stop would cut if the trail did not fire first.

### Payoff · WR · zf PF (full window)

| | parity ON (latch off) | parity OFF (latch off) | null |
|---|---|---|---|
| WR | 25.5 % | 31.9 % | — |
| realized payoff | **1.37** ($12.99 / $9.50) | 1.77 ($47.74 / $26.91) | ≈ 1.35 |
| zf PF | **0.47** | 0.83 | — |
| net (zf) / return / max DD | −$3,528 / −35.3 % / 37.2 % | −$3,252 / −32.5 % / 36.3 % | — |
| mean R · t | −0.141 · −9.24 | −0.112 · −2.81 | — |
| quarters zf PF (Q1–Q4) | 0.42 / 0.46 / 0.48 / 0.53 | 0.90 / 0.86 / 0.76 / 0.77 | — |
| per-symbol zf PF (BTC / ETH / SOL) | 0.38 / 0.53 / 0.47 | 0.78 / 0.71 / 0.98 | — |
| regime of entries | weak_trend 913 · strong_trend 22 | weak_trend 1,014 · strong_trend 25 | — |

**Reading (diagnostic, not verdict):** with the latch out of the way, `--exit-parity on` at shipped knobs is **strictly worse** on this book than the signal-geometry exits: WR −6.4 pts, payoff 1.77 → 1.37 (onto the null), zf PF 0.83 → 0.47, t(mean R) −2.8 → −9.2, every quarter and every symbol negative. It does not change the sign of expectancy — both are < 1 at zero fees, so neither is a GO candidate — but it removes the TP tail (198 → 7 TP exits) that carried the OFF book's payoff. Realized payoff ≈ 1.37 / stop-heavy (89.6 % protective-stop exits) is the null reference reproduced almost exactly.

## 7. Tune window (C, in-sample, diagnostics only — never evidence)

`tune-2023-03_2025-03`, 2023-03-01 → 2025-03-01 (731 d), parity ON: n **57** (BTC 17 / ETH 19 / SOL 21), all between 2023-03-01 and 2023-03-19 (latch, §5). Exits: trailing_stop 53 (93.0 %), signal 4, stop_loss 0, take_profit 0, time_stop 0. WR 21.1 %, realized payoff 1.11, zf PF 0.30, net −$322, mean R −0.169 (t −4.33), hold p50 2 bars. TUNE DIAGNOSTIC / UNDERPOWERED / truncated; consistent with the holdout shape (trail-dominated, TP never reached).

## 8. Other harness observations (documented, not changed)

- **`atr_vol` filter is blind to trend_follow.** `atrFilterRejects = 0` on every run although 42 of 104 counted entries (40 %) and 55 % of full-window entries had signal ATR% < `filters.atr_volatility_min 0.5 %` (holdout entry ATR% median 0.47–0.56 %). trend_follow stamps `metadata.atr`; `metadata.indicators` is `{}`; the filter (backtest `passesAtrVolatilityFilter` and live `api/server.ts` stage `atr_vol`) reads `metadata.indicators.atr`. Pre-existing and flagged in #54; live has the same blind spot, so this is parity — but it means the H2 fee-floor filter is not acting on the TF book at all.
- **`stop_trail_atr 1.0` was not calibrated for A1.** It lives in the `strategy:` block next to `mode: momentum_futures`, `stop_init_atr 1.5`, `atr_len_15m 20` — a trail sized to a 1.5 × ATR initial stop. Under A1 (2.5 / 6.0) it is 0.4 × the hard-stop distance and 1/6 of the TP distance. Whether 1.0 is right belongs to the ≤12 exit grid, which this card forbids; nothing was tuned here.
- **`time_stop_bars 96` is dead under the trail** (0 fires on 2,158 parity-on trades); only 5.3 % of parity-off trades ever reach 96 bars.
- **Regime:** 97–100 % of TF entries carry `weak_trend` (RegimeFilter stamp); `strong_trend` is 22–25 of ~1,000 in the full window — same picture as the A6 doc (A6 stays off).
- **Live trail ≠ harness trail** (G3 caveat, §0): live `PositionMonitor` trails at `HWM × (1 − stop_trail_atr × 0.01)`; the harness at `HWM − stop_trail_atr × ATR`.
- **Spot SELL handling:** 98 / 18 / 47 SELL signals dropped (`venue_no_shorting`), 3 / 8 / 4 SELLs closed a long (`signal` exits) on A / B / C. Long-only by venue holds.
- **Engine convention reminder:** trail checked against the bar as of its open, ratcheted after (pessimistic); trail trigger capped at the open on gap-through; stop-type fills carry the overshoot model. All unchanged from #54.

## 9. Not done / not in scope (per card)

- No E5 GO, no `CONFIRM_LIVE`, no live/paper start, no TM packaging. No ≤12 exit grid, no A1 retune, no ADX peek, no `stop_trail_atr` / `time_stop_bars` change, no MetaFilter change, no `--exit-parity` default flip, no A6 flip, no fee-book pass (card asked zf only), no `--allow-synthetic`, nothing written under `fixtures/**` or `atlas/var/**` that is tracked.
- The §6 sensitivity is reproducible from the description above but is not a CLI flag and is not proposed as one here.
- Eng follow-ups surfaced (decisions, not changes made): (1) cold-streak deadlock (§5) — decide intended semantics and whether a TF-only book can be counted while it is in place; (2) live-vs-harness trail definition (§0/§8); (3) `atr_vol` filter blind to `metadata.atr` (§8).

## Appendix — artefacts

Run artefacts (JSON + text report per pass) were written to `--results-path` under `/tmp/e5/` and copied to the PR walkthrough set: `report_holdout_15m_tf_parity-on.txt`, `report_holdout_15m_tf_parity-off.txt`, `report_tune_15m_tf_parity-on.txt`, `report_holdout_15m_tf_parity-{on,off}_SENSITIVITY-latch-off.txt`, `cli-stdout_*.log` (CLI summaries), `g1-g3-g5-gate-check.log`, `analyze-*.md` (per-run tables above), `pnpm-test.log`. Nothing from `atlas/var/backtest_results/` is committed (gitignored).
