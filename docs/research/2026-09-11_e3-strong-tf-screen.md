# E3-STRONG-TF-SCREEN — trend_follow × A6 strong_trend-only, 15m REAL holdout — **HOLD** (SCREEN fail; NOT GO)

**Date:** 2026-09-11 · **Commit:** `main @ 47157f9` (`config(guardrails): disable spot momentum after E2-MOM-ISO KILL (#55)`) · **Card:** Algo Alpha E3 run card (SCREEN/HOLD only, never GO) · **Audience:** Algo Beta + TM + Eng
**Authority:** Eng screen output only. **Not a desk GO.** No `CONFIRM_LIVE`, no E5, no 1D, no GO packaging (no MC, no fee stress), never `--allow-synthetic`.
**SoT:** `atlas/config/guardrails.yaml` — `regime_gates.enabled: false` before, during and after this burn (A6 was research-enabled for these runs only via the CLI flag; verified post-run, `pnpm check:config` OK).
**Data:** `atlas/apps/core-node/fixtures/bars/15m/holdout-2025-03_2026-03` (#53) — eval window run **once**; `15m/tune-2023-03_2025-03` for diagnostics only.

---

## 0. Verdict — **HOLD**

| Fail-fast (card) | Result | Gate | Status |
|---|---|---|---|
| Counted pooled E[n], holdout | **n = 26 → E[n] = 26.0 / 12 m** (BTC 11 · ETH 8 · SOL 7) | ≥ 100 | **FAIL ⇒ HOLD** (expected; no GO-pack) |
| Zero-fee PF, holdout | **1.18** | ≥ 5.8 (Quant floor, 15m) | **FAIL ⇒ SCREEN fail / STOP** — no ADX peek, no FeeModel 40 pass |
| Evidence grade | **REAL** (isolated native 15m · real candles, sha256-matched · A6 path verified) | — | granted |
| Label | **HOLD** | never GO | — |

Both fail-fast gates fail by wide margins. The FeeModel 40 column was **not run** (card: "FeeModel 40 only if zf clears floor"). Structural cause: at the shipped cut (ADX ≥ 40 on 15m bars) `strong_trend` supplies **3.1 %** of trend_follow's candidate flow (67 of 2 164 candidates in 12 months over three symbols); the A6 gate removes the other 96.9 %. There is no path from ~26 trades/yr and zero-fee PF ≈ 1.2 to n ≥ 100 and PF ≥ 5.8 without retuning — which this card forbids.

---

## 1. Required prints (before any fee column)

### 1.1 TF used · A6 enable method · shipped ADX/regime cut (VERBATIM)

**TF used: 15m — native stored bars, no aggregation.** CLI header (holdout run):

```
DATA: REAL
Data source BTC-USD: fixture bars=35017/35041 coverage=99.9% spacing=15m
Data source ETH-USD: fixture bars=35015/35041 coverage=99.9% spacing=15m
Data source SOL-USD: fixture bars=35017/35041 coverage=99.9% spacing=15m
Bar timeframe: 15 min (native stored bars; no aggregation)
Venue: BTC-USD=spot, ETH-USD=spot, SOL-USD=spot
Fees: tier=custom:0,0 → spot maker=0/taker=0 bps
Regime gate: enabled=true minCompat=0.3 minConf=0.4            ← RegimeFilter (compat toggle), NOT A6
Regime-conditional gates (A6): enabled=true rules=1            ← A6, research-enabled for THIS run
```

Fixture sha256 (`sha256sum` before the run) equals the committed table in `fixtures/bars/15m/README.md` byte-for-byte:

| File | sha256 |
|---|---|
| `holdout-2025-03_2026-03/BTC-USD.json` | `17f367b6965d548358ec3fcf99d752916f405e5bb96780d18e9f3e464640574d` |
| `holdout-2025-03_2026-03/ETH-USD.json` | `d0f8d5464ae5d8d87431218f83c6af675577484df828b5022250b8e239633476` |
| `holdout-2025-03_2026-03/SOL-USD.json` | `ce3d1dba82b617013fa39ca057593df958ebfae386efb0d3b179c050c4fb4494` |
| `tune-2023-03_2025-03/BTC-USD.json` | `8eeb1778c6df3ea0da6f083184b2bc505d898121741ebdab4fb05292255392b6` |
| `tune-2023-03_2025-03/ETH-USD.json` | `f9b04254fbd3b627b8dc29f3066e67197d1dd5e4a8af0855d18ed7706b2c8418` |
| `tune-2023-03_2025-03/SOL-USD.json` | `b557cacd66676d7d8ad55de0c1f9b55860b5325bc80d78bd47040a0e767ec62d` |

Real Coinbase public `FIFTEEN_MINUTE` candles, 900 s, upstream holes as documented (2025-10-25 outage on all three; 2 ETH bars 2025-04-25). Why 15m: the paper/live runtime and the A6 measurement both run on the 15m candle path (`trade_cooldown_min: 15`, `atr_len_15m`; A6 doc §3), and no paper TF-only book exists on another TF in the repo (the E4 4H/1D runs were harness screens), so 15m is both the A6 measurement TF and the evidence TF.

**A6 enable method (research flag; production default untouched):**
`pnpm exec tsx src/cli/backtest.ts … --regime-conditional-gates` (`src/cli/backtest.ts:191-199`) → `forceRegimeConditionalGates: true` → `buildBacktestConfig()` sets `regimeConditionalGates.enabled = true` on the **run copy only** (`src/backtesting/backtest-cli-config.ts:158-161`); the rules come from `guardrails.yaml regime_gates.rules`; the YAML stays `enabled: false`. The engine forwards the config into the child `SignalProcessor` (`backtest-engine.ts:883-887`), whose gate runs **after** `RegimeFilter` and **before** `MetaFilter` (`signal-processor.ts:1163-1202`), keyed on `adjustedSignal.metadata.regime`. Saved JSON confirms: `config.regimeConditionalGates = { enabled: true, rules: [{ strategy: 'trend_follow', blockRegimes: ['weak_trend'] }] }`. The E4 harness (`backtest-e4.ts`) refuses `--tf 15m` by design ("15m out" on the Beta card) and has no A6 flag, so the documented 15m path (`fixtures/bars/15m/README.md` §"How Strategies should invoke") is the one used here.

**Shipped cut — verbatim.** `atlas/config/guardrails.yaml:408-412` (the rule A6 applies; unchanged by this burn):

```yaml
regime_gates:
  enabled: false
  rules:
    - strategy: trend_follow
      block_regimes: [weak_trend]
```

`src/strategies/regime-detector.ts:117-130` (defaults in force — the backtest passes no `regimeDetector` override):

```ts
const DEFAULT_CONFIG: RegimeDetectorConfig = {
  classificationMode: 'adx_primary',
  adxStrongTrend: 40,
  adxWeakTrend: 20,
  adxRanging: 20,
  chopHighThreshold: 61.8,
  chopLowThreshold: 38.2,
  atrHighVolatility: 0.02,
  atrLowVolatility: 0.005,
  bbSqueezeThreshold: 2,
  bbExpansionThreshold: 5,
  directionLookback: 10,
  smoothingPeriod: 3,
};
```

`src/strategies/regime-detector.ts:381-390` (`classifyRegime`, `adx_primary` branch):

```ts
    if (this.config.classificationMode === 'adx_primary') {
      const { adx } = metrics;
      if (adx >= this.config.adxStrongTrend) {
        return { regime: 'strong_trend', confidence: Math.min(adx / 50, 1.0) };
      }
      if (adx >= this.config.adxWeakTrend) {
        return { regime: 'weak_trend', confidence: (adx - this.config.adxWeakTrend) / (this.config.adxStrongTrend - this.config.adxWeakTrend) };
      }
      return { regime: 'ranging', confidence: 1 - (adx / this.config.adxWeakTrend) };
    }
```

ADX input: `ValidatedIndicators.ADX(candles, 14)` on the base 15m series (`regime-detector.ts:164`, fed from `signal-processor.ts:634`). Regime transitions are smoothed: the stamped regime only changes when ≥ 2 of the last 3 classifications agree (`smoothingPeriod: 3`, `getSmoothedRegime`, `regime-detector.ts:502-527`). `choppy` is never emitted in `adx_primary`.

Layers that compose with A6 (all shipped, all in force in these runs):

- Plugin self-gate `trend-follow-strategy.ts:166-194`: `strong_trend` optimal (×1.0), `weak_trend` compatible (×0.7), `ranging` / `choppy` **incompatible** → the registry refuses to emit there. So every trend_follow candidate is `weak_trend` or `strong_trend`, and the plugin stamps `metadata.regime` on emission (`:413`, `:436`).
- `RegimeFilter` defaults `minCompatibilityScore 0.3`, `minRegimeConfidence 0.4`; `counter_trend` blocks a trend-following signal against `trendDirection` **only when the regime is `strong_trend`** (`regime-filter.ts:306-340`).
- Because the plugin self-stamps, A6 sees a regime on **every** trend_follow candidate — including low-confidence `weak_trend` (ADX 20–28) that `RegimeFilter` bypasses unstamped. Empirically below: 2 097 of 2 097 weak_trend candidates blocked, 0 weak_trend and 0 unknown entries. On spot, A6 ON therefore means **strong_trend-only, ADX(14) ≥ 40 on 15m, long-only**.

### 1.2 Counted pooled E[n] (holdout) · per-symbol n · strong_trend vs weak_trend rejections

Eval window 2025-03-01T00:00Z → 2026-03-01T00:00Z (365.0 d), zero-fee, EV gate off, A6 ON. E[n] = n × 365.25 / windowDays (same formula as the E4 harness `computeTradeFrequency`). Zero-fee / EV-off is the **upper bound** on any fee-book count, so the fee-book E[n] is ≤ 26 by construction.

| | pooled n | BTC-USD | ETH-USD | SOL-USD | E[n] (12 m) | gate |
|---|---|---|---|---|---|---|
| **zero-fee, EV off, A6 ON** | **26** | **11** | **8** | **7** | **26.0** | ≥ 100 ⇒ **HOLD** |

First entry 2025-05-06T18:45Z, last 2026-02-23T07:30Z; 2.17 trades/month pooled. Long/short entries **26/0**.

**Rejection ledger (funnel, same process-wide counters the live `/metrics` exposes):**

| Stage | Count | Regime | Notes |
|---|---|---|---|
| trend_follow candidates emitted (post plugin ranging/choppy refusal) | **2 164** | weak 2 097 · strong 67 | `candidatesPerStrategy` |
| `regime_gate` · `regime_blocked` (**A6**) | **2 097** | **weak_trend 2 097 / strong_trend 0** | ETH 732 · BTC 687 · SOL 678 — every rejection carries `regime: weak_trend`, `blockRegimes: [weak_trend]` |
| `regime` · `counter_trend` (RegimeFilter, fires before A6) | **17** | **strong_trend 17** | all 17 log lines carry `regime: strong_trend` (buy vs down-trend / sell vs up-trend) |
| admitted (canonical `signal:generated`) | **50** | strong_trend 50 | 26 BUY + 24 SELL |
| `spot_short_blocked` · `venue_no_shorting` | **23** | strong_trend 23 | SELL with no open long on a spot venue (short entries refused) |
| SELL that exited an open long (`signal` exit) | **1** | strong_trend 1 | |
| **entries (BUY) = closed trades** | **26** | **strong_trend 26 / weak_trend 0 / unknown 0** | `Entries by regime: strong_trend=26`; per-trade `signal.metadata.regime` = strong_trend 26/26, regimeConfidence 0.80–1.00 |
| `atr_vol`, `meta`, `ev_gate`, `dedup`, `per_symbol_disable`, `disabled_strategy` | 0 | — | no rejections recorded at these stages |

Ledger closes exactly: 2 164 = 2 097 + 17 + 50; 50 = 26 + 23 + 1. Strong_trend share of candidate flow = 67 / 2 164 = **3.10 %**; A6 removed **96.90 %**.

### 1.3 Zero-fee PF · WR · realized payoff · exit mix (holdout)

| Metric | Value |
|---|---|
| **Zero-fee PF** | **1.18** (gross profit $85.73 / gross loss $72.84) |
| **WR** | **34.62 %** (9 W / 17 L) |
| **Realized payoff** (avg win / avg loss) | **2.22** ($9.53 / $4.28) |
| Per-trade expectancy | +$0.50/trade (net **+$12.89** on $1 000, +1.29 %) |
| mean R / t-stat | 0.083 / **t = 0.26** (indistinguishable from zero) |
| Max drawdown | 3.26 % · Sharpe 0.29 · max consecutive losses 6 |
| **Exit mix** | **stop_loss 16 (61.5 %) · take_profit 9 (34.6 %) · signal 1 (3.8 %)** · trailing_stop 0 · time_stop 0 · end_of_data 0 |
| Hold time | mean 1 140 min (19.0 h), median 675 min |
| By symbol | BTC n=11 WR 18.2 % PF **0.41** net −$19.47 · ETH n=8 WR 50.0 % PF 2.22 net +$22.28 · SOL n=7 WR 42.9 % PF 1.46 net +$10.08 |
| Window quarters (by exit; n / PF) | Q1 1 / ∞ (+$7.31) · Q2 8 / 1.01 · Q3 5 / 2.35 · Q4 12 / **0.76** |

Exit rules in force: hard stop + take profit from signal geometry (A1 2.5 / 6.0 ATR), opposite-signal exits on, ATR trail off, time stop off (`--exit-parity` default off; E5 is out of scope).

### 1.4 Evidence grade — **REAL**

- **Isolated TF:** one window per directory, declared `FIFTEEN_MINUTE` 900 s, `spacing=15m`, `Bar timeframe: 15 min (native stored bars; no aggregation)`, no `--bar-minutes` rollup. Trend_follow's 1h MTF alignment is built from these 15m bars (no MTF collapse — that caveat is 4H-specific).
- **Real candles:** `DATA: REAL` on line 1 of stdout and of both saved reports; `source=fixture` × 3; all six fixture sha256 match the committed README table; coverage 99.9 % / 100.0 %.
- **A6 path verified:** flag → run-copy config → `SignalProcessor` funnel stage `regime_gate` fired 2 097× (holdout) / 4 301× (tune); 26/26 and 65/65 entries stamped `strong_trend`; `regime-gate.test.ts` 24/24 green on this commit.
- **Single-strategy isolation:** `Initialized 1 built-in strategies (skipped disabled: breakout, vwap_mr, momentum)`, `Active strategies: trend_follow`. Momentum is on the global shelf at `47157f9`, so there is no MIXED-book contamination and no cold-streak cross-talk. This is why the A6 doc's **R25 gated n = 27** (`--strategy all`, momentum live, HL fees, 2025-03-05 → 2026-03-05) is **not** cited here as a TF-only REAL anchor — it is MIXED; this burn's isolated count is **26**.

### 1.5 Label — **HOLD**

`n < 100` ⇒ HOLD (expected). `zf PF 1.18 < 5.8` ⇒ SCREEN fail / STOP. Not GO. Not GO-packed.

---

## 2. Fee columns — FeeModel 40 **NOT RUN**

The card's order is zero-fee first, FeeModel 40 **only if** the zero-fee PF clears the 15m floor. It did not (1.18 vs 5.8), so no fee-book pass, no MC, no stress table. Informational arithmetic from the realized zero-fee trades only (not a fee pass): mean notional $267.95 (min $154.53, max $294.00 — capped by 30 % exposure on $1 000); the GO fee book (40 bps/side, 80 bps RT) would cost ≈ $2.14/trade ≈ $55.73 over 26 trades against a zero-fee net of +$12.89 (+$0.50/trade). Break-even is ≈ 18.5 bps round-trip (≈ 9 bps/side) on that notional; every Coinbase spot tier (Intro 1 240 · $1K+ 150 · $10K+ 80 bps RT) is above it.

---

## 3. Tune window — TUNE DIAGNOSTIC only (in-sample, never evidence)

Same command on `fixtures/bars/15m/tune-2023-03_2025-03`, 2023-03-01 → 2025-03-01 (731.0 d), zero-fee, EV off, A6 ON, zero knobs (nothing was fitted; this is a second look at the same fixed rule).

| | pooled n | BTC | ETH | SOL | E[n] (12 m) | zf PF | WR | payoff | net | maxDD | t(meanR) | exits (stop/TP/signal) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tune | **65** | 22 | 28 | 15 | **32.5** | **0.93** | 30.77 % (20/45) | 2.09 ($8.08/$3.87) | −$12.48 | 4.95 % | −0.71 | 42 / 18 / 5 |

By symbol: BTC PF 0.67 (n 22) · ETH PF 0.89 (n 28) · SOL PF 1.32 (n 15). Quarters (by exit; n / PF): 22 / 0.62 · 14 / 1.63 · 18 / 1.05 · 11 / 0.74. Funnel: 4 501 candidates → **4 301 weak_trend blocked by A6** (BTC 1 477 · ETH 1 479 · SOL 1 345) → **73 strong_trend `counter_trend`** → 127 admitted = 66 BUY (65 entries + 1 BUY while already long, engine no-op) + 61 SELL (56 `venue_no_shorting` + 5 signal exits). Entries by regime: strong_trend 65/65. Strong_trend share 200 / 4 501 = 4.4 %.

Read-across (diagnostic, not a gate): the strong_trend-only book is ~26–33 trades/yr and zero-fee PF 0.93–1.18 across 36 months of real 15m data — a level problem (thin, fee-fragile edge), not a window artefact.

---

## 4. Exact commands · commit · artefacts

From `atlas/apps/core-node` at `47157f9`; `ENCRYPTION_KEY` set to any 64-hex dummy (env validation only; no Supabase, no network — fixtures are the only source). Never `pnpm backtest -- …` (yargs drops flags).

```bash
# HOLDOUT — eval window, run ONCE. Zero-fee fail-fast (FeeModel 0/0 bps, EV gate off),
# A6 research-enabled for THIS run only, trend_follow only, BTC/ETH/SOL spot long-only.
pnpm exec tsx src/cli/backtest.ts \
  --fixture-dir fixtures/bars/15m/holdout-2025-03_2026-03 \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2025-03-01 --end-date 2026-03-01 \
  --strategy trend_follow --regime-conditional-gates \
  --fee-tier custom:0,0 --ev-gate off \
  --initial-capital 1000 \
  --results-path ../../var/backtest_results/e3-strong-tf

# TUNE — diagnostics only (in-sample), same flags
pnpm exec tsx src/cli/backtest.ts \
  --fixture-dir fixtures/bars/15m/tune-2023-03_2025-03 \
  --products BTC-USD ETH-USD SOL-USD \
  --start-date 2023-03-01 --end-date 2025-03-01 \
  --strategy trend_follow --regime-conditional-gates \
  --fee-tier custom:0,0 --ev-gate off \
  --initial-capital 1000 \
  --results-path ../../var/backtest_results/e3-strong-tf

# FeeModel 40 pass: NOT RUN (zero-fee PF 1.18 < 5.8). Would be the same command with
# `--fee-tier t10k --ev-gate enforce` (guardrails spot bucket 25/40 → 40 bps/side taker).
```

Zero knobs in force (read from the saved `config`): per-symbol `trend_follow` pins BTC/ETH/SOL `stopAtr 2.5 / takeProfitAtr 6.0` (ETH also `emaFast 12 / emaSlow 15` as shipped); `filters.atr_volatility_min 0.005 / max 0.05`; `risk.min_ev_threshold 0`; `account.risk_per_trade 0.005`, `max_position_exposure_pct 0.30`; realism `next_bar_fill true`, `entry_slippage_bps 5`, stop overshoot 20 % of bar range (min 5 bps); `disabled_strategies [vwap_mr, breakout, momentum]`; exit rules stop/TP only. No ADX threshold, ATR multiple or filter was touched.

Artefacts (gitignored, `atlas/var/backtest_results/e3-strong-tf/`): `backtest_2026-09-11T14-46-31.json` + `report_2026-09-11T14-46-31.txt` + `stdout_holdout_zf_a6on.txt` (holdout); `backtest_2026-09-11T14-49-11.json` + `report_2026-09-11T14-49-11.txt` + `stdout_tune_zf_a6on.txt` (tune). Derived prints (per-symbol n, E[n], payoff, quarters, per-trade regime, rejection-by-symbol) were computed from `trades[]` in the saved JSON and the `Backtest funnel diagnostics` / `signal:filtered` lines in stdout with the E4-harness formulas (`tradeR`, `computeExpectancy`, `computeTradeFrequency`, `computeWindowQuarters` in `src/backtesting/e4-harness.ts`); the CLI's own `Profit Factor 1.18 / Win Rate 34.62% / Total Trades 26 / Max Drawdown 3.26%` agree to the printed precision.

Post-run checks on this commit: `pnpm check:config` → `config-drift: OK — single-source guardrails and desk pins intact`; `vitest run src/__tests__/regime-gate.test.ts` → 24/24; `guardrails.yaml regime_gates.enabled: false` unchanged (`git status` clean apart from this document).

---

## 5. Parity notes and Eng observations (documented, nothing changed)

- **Min-hold / cooldown.** `pnpm backtest` runs with `minHoldBars` unset (no `execution` block); the E4 harness passes 1 bar. On 15m, live `trade_cooldown_min: 15` = 1 bar. The knob only defers opposite-signal exits (`exit_position_too_young`); this book had 1 (holdout) / 5 (tune) signal exits, so the difference cannot move either gate.
- **"Zero-fee" = zero commission.** Slippage 5 bps/side and stop overshoot were applied, as in the E4 harness's zero-fee stage. EV gate off, as in that stage.
- **ATR-volatility filter is a no-op for trend_follow.** `trend_follow` stamps its ATR at `metadata.atr`, while both the backtest filter (`backtest-engine.ts:1212-1219`) and live routing (`api/server.ts:2162`) read `metadata.indicators.atr` (empty for this plugin) and pass signals without a usable ATR. Backtest/live parity holds (both no-op); `atrFilterRejects = 0` here is that, not "all entries were volatile enough". Not fixed under this card (no code change); flagged for Eng.
- **Meta-filter** recorded no rejections (no `meta` stage in the funnel): with trend_follow alone the 10-loss cold-streak trip never occurred (max streak 6).
- **RegimeFilter** (`--regime-gates on`, live default) is the source of the 17 / 73 `counter_trend` rejections — a direction check in strong_trend, distinct from A6.
- **Q1 holdout has 1 trade** (2025-03 → 05): regime/crossover silence, bars are present (35 017/35 040). Reported, not interpreted.
- **Per-symbol dispersion** (BTC PF 0.41 vs ETH 2.22 / SOL 1.46 on n = 11 / 8 / 7) is noise-level at these counts; no symbol carve-out is proposed (that would be a retune).

## 6. Not done / out of scope

No desk GO. No FeeModel 40 pass, no MC, no fee-stress packaging (fail-fast stopped the pipeline). No E5 exit redesign, no 1D, no 4H re-run, no ADX peek, no ATR / EMA / filter retune, no A6-OFF control on the eval window (eval once), no INTX/perps, nothing synthetic, nothing written under `fixtures/bars/**`, no change to `guardrails.yaml` (`regime_gates.enabled: false` stays), no strategy code change. `main` untouched by this burn; this document is the only file added.

*End of E3-STRONG-TF-SCREEN (2026-09-11). Verdict: HOLD. Eng screen; TM decides nothing from this beyond "do not GO-pack".*
