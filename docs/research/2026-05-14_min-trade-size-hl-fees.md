# H2 — Fee-adjusted minimum profitable trade size at Hyperliquid fees

> **Date:** 2026-05-14. **Author:** Wave 1 Agent E (sprint plan §3 H2). **Status:** research input for Wave 2 task A1 (param retune) and A3 (fee-adjusted min-position-sizing).

> **TL;DR.** At HL perps fees + 5 bps slippage = **14 bps round-trip total cost** and current `risk_per_trade=0.015` ($150 on $10k equity), every symbol with **30-day rolling ATR ≥ ~0.5%** clears the break-even bar at the engine's stated 1.30R-per-win target (§1.4 of SPRINT-PLAN-FINAL.md). At today's 2× ATR stop / 4–5× ATR TP geometry that means: **trade if and only if symbol ATR > 0.5%**. BTC, ETH, SOL all clear; thin altcoins (e.g. AVAX/LINK if added later) need a per-symbol ATR floor check at signal-emission time.

---

## 1. Inputs

All values are operator-facing assumptions; cite when they change.

| Quantity | Value | Source |
|---|---|---|
| HL perps taker fee, single-side | 4.5 bps | `atlas/config/guardrails.yaml` `fees.hyperliquid.perps.taker_bps: 4.5` |
| HL perps taker fee, round-trip | **9 bps** | 4.5 × 2 |
| Slippage estimate, round-trip | **5 bps** (assumed flat) | Sprint plan H2 brief; conservative vs. `risk.slippage_estimate_bps: 3` (single-side) in guardrails.yaml |
| **Total cost per round-trip** | **14 bps = 0.0014** | sum |
| Risk per trade (perps) | 1.5% of $10k = **$150** | `guardrails.perps.risk_per_trade: 0.015` × `account.equity_usd: 10000` |
| Risk per trade (spot, for comparison) | 0.5% of $10k = **$50** | `guardrails.account.risk_per_trade: 0.005` × `account.equity_usd: 10000` |
| Default stop multiple | `stopAtr = 2.0` | `momentum.stopAtr: 2.0`; `trend_follow` per-symbol overrides set 2.0–2.5 |
| Engine break-even win multiple | **~1.30R per win** | SPRINT-PLAN-FINAL.md §1.4 |
| Per-symbol max notional (perps) | $5,000 | `perps_symbols.{ETH,BTC}-PERP-INTX.max_notional_usd` |

**Note on slippage source.** The sprint plan brief uses a flat 5 bps round-trip; the YAML's `slippage_estimate_bps: 3` is per-side (so 6 bps round-trip). The 5 bps value used here is between the two and matches H2's inputs in §3 of SPRINT-PLAN-FINAL.md. Sensitivity to this choice is small at HL fees — see §6.

---

## 2. Math

Position sizing (risk-based):

$$\text{notional} = \min\left(\frac{\text{risk\_per\_trade}}{\text{stopAtr} \cdot \text{ATR\%}},\ \text{max\_notional\_usd}\right)$$

Fee cost in dollars per round-trip:

$$\text{fees}\$ = \text{notional} \cdot 0.0014$$

Fee drag in R-units (R = the risk dollar amount):

$$\text{fee\_drag}_R = \frac{\text{fees}\$}{\text{risk\_per\_trade}\$} = \frac{0.0014 \cdot \text{notional}}{\text{risk\_per\_trade}}$$

When the per-symbol cap does **not** bind (`notional = risk / (stopAtr · ATR%)`), substituting:

$$\text{fee\_drag}_R = \frac{0.0014}{\text{stopAtr} \cdot \text{ATR\%}}$$

i.e. fee drag is **independent of `risk_per_trade`** when the notional cap is slack — it's purely a function of stop geometry and ATR.

Break-even win multiple at win rate `p` (in R-units, ignoring slippage in the win-multiple — slippage is in `fee_drag_R`):

$$p \cdot (m - \text{fee\_drag}_R) - (1-p)\cdot(1 + \text{fee\_drag}_R) = 0$$

$$\boxed{\,m = \frac{1-p}{p} + \frac{\text{fee\_drag}_R}{p}\,}$$

For `p = 0.50` (the engine's planning baseline):

$$m\,|_{p=0.50} = 1 + 2 \cdot \text{fee\_drag}_R$$

Solve for the ATR% that yields `m = 1.30` at `p = 0.50` and `stopAtr = 2.0`:

$$1.30 = 1 + 2 \cdot \frac{0.0014}{2 \cdot \text{ATR\%}}$$
$$0.30 = \frac{0.0014}{\text{ATR\%}}$$
$$\text{ATR\%} = \frac{0.0014}{0.30} \approx 0.0047 \approx \mathbf{0.47\%}$$

**Min profitable ATR% (uncapped notional, 50% WR, 1.30R target) = ~0.5%.**

---

## 3. Per-symbol table

ATR estimates are **30-day rolling** from public market data (May 2026 window). Flagged as **estimates** — calibrate against `bars` table when available.

| Symbol | Typical ATR% (30d est.) | Stop distance % (`2×ATR`) | Notional at $150 risk | Hit per-symbol cap? | Round-trip fee $ | Fee drag (R) | Min profitable ATR% |
|---|---|---|---|---|---|---|---|
| **BTC-PERP-INTX** | 1.2% (est.) | 2.4% | $6,250 | yes ($5,000 cap) | $7.00 | 0.047 (4.7%) | **0.47%** |
| **ETH-PERP-INTX** | 1.4% (est.) | 2.8% (avg) / 3.5% (TF override `stopAtr=2.5`) | $5,357 / $4,286 | yes / no | $7.50 / $6.00 | 0.050 / 0.040 | **0.47%** / 0.37% |
| **SOL-USD** (spot at $50 risk; no HL perp) | 2.2% (est.) | 4.4% | $1,136 | no ($3,000 cap) | $1.59 | 0.032 (3.2%) | **0.47%** |
| **BTC-USD** (spot at $50 risk) | 1.2% (est.) | 2.4% | $2,083 | no ($3,000 cap) | $2.92 | 0.058 | 0.47% |
| **ETH-USD** (spot at $50 risk; TF `stopAtr=2.5`) | 1.4% (est.) | 3.5% | $1,429 | no | $2.00 | 0.040 | 0.37% |

**Reads as:** at HL fees, all five symbols clear the break-even bar by a comfortable margin at the engine's planned 1.30R win-multiple target. The fee drag is 3–6% of risk per trade, vs. the 22% recorded on Coinbase yesterday (§1.4 of SPRINT-PLAN-FINAL.md: "fees are 22% of intended risk unit").

**`stopAtr=2.5` (the trend_follow per-symbol override on ETH) lowers the min profitable ATR%** from 0.47% → 0.37% because a wider stop = smaller notional = smaller absolute fees per dollar of risk. Counterintuitively, **wider stops at HL are pro-fee, not pro-risk**, until you hit other constraints (volatility-of-vol, news risk).

---

## 4. Where the rule "do not trade" bites

| Symbol class | If 30-day ATR% drops below | Action |
|---|---|---|
| BTC, ETH (spot or perp) | **0.5%** | suppress signals — fees > 15% of risk, breakeven needs >1.30R wins |
| SOL | **0.5%** | same |
| Hypothetical altcoin tier (AVAX, LINK, ARB if added) | **0.7%** | thinner liquidity → real slippage > 5 bps; raise the floor |
| Anything below | **0.3%** | hard ABORT — fees alone are 25%+ of risk; not even 4R TP saves it |

**Operational implication.** A1 should add a `min_atr_pct` per-symbol gate in `guardrails.yaml` (default 0.005 = 0.5%); the signal-arbiter should drop signals from symbols below that floor with `reason: 'atr_below_min_profitable'`. This is a Wave 2 task and complements A3's "fee-adjusted EV gate."

---

## 5. Worked example — 2026-05-13 paper trade #1 (BTC-USD long, trend_follow)

From SPRINT-PLAN-FINAL.md §1.3 trade book:

| Field | Coinbase actual | If routed to HL perp at HL fees |
|---|---|---|
| Notional | $1,528 | (re-priced, see below) |
| Realized PnL gross | +$1.88 | +$1.88 (price action identical) |
| Round-trip fees | $9.91 | $1.88 × (notional/notional) — for like notional, $1.528k × 0.0014 = **$2.14** |
| Net PnL | **−$8.03** (loss after fees) | **−$0.26** (effectively scratch) |

The same trade re-priced at HL fees on **like notional** flips from −$8.03 → −$0.26: a noise outcome instead of a guaranteed loss. **At HL the trade is statistically a coin-flip; at Coinbase it's a structural loser.** This re-confirms §0 of SPRINT-PLAN-FINAL.md: "HL alone is necessary but not sufficient" — the geometry has to also stop emitting "wins" that are within fee distance of entry.

If the same signal had been routed to **BTC-PERP-INTX at the perps risk budget of $150** instead, notional would have been $5,000 (cap-bound), fees $7.00, and a 1R win would have been +$120 − $7 = **+$113 net** (a real win, not a noise scratch). This is the "perps + HL" thesis in one trade.

---

## 6. Sensitivity

Vary the round-trip cost assumption to see if min profitable ATR% changes meaningfully.

| Round-trip cost | Min profitable ATR% (1.30R, 50% WR) |
|---|---|
| 9 bps (HL fees only, no slippage) | **0.30%** |
| 14 bps (this analysis) | **0.47%** |
| 20 bps (HL fees + 11 bps slippage during news) | **0.67%** |
| 65 bps (Coinbase actual) | **2.17%** ← matches today's verdict that BTC at 1.2% ATR is *unprofitable* on Coinbase |

The 0.5% floor recommendation is robust to ±5 bps slippage; if slippage spikes during news (>10 bps), the floor moves to ~0.7%. A1 should consider an adaptive floor that widens when `regime.volatilityRegime === 'high'`.

---

## 7. What this informs

- **A1 (param retune).** Use 0.5% as the per-symbol `min_atr_pct` default. Per-symbol overrides allowed in `guardrails.yaml.per_symbol.<sym>.min_atr_pct`.
- **A2 (ATR multiplier audit).** Wider stops (`stopAtr` 2.0 → 2.5) reduce fee drag (see §3 column 7). Trade-off vs. tighter stop is risk-per-trade dollar precision; at HL the reduced fee drag wins.
- **A3 (fee-adjusted min-position-sizing).** The pre-trade EV gate should compute `expected_PnL_after_fees = p_estimate · (TP_R · risk - fees) - (1-p_estimate) · (risk + fees)` and reject when ≤ 0.
- **F4 (HL backtest).** Re-run the May 11 matrix with `--commission 0.00045` and slippage 0.0005 (per `--slippage` flag). Compare expected per-trade EV against this analysis.

---

## 8. Open questions

1. **Real ATR vs. estimated.** The 30-day ATR%s in §3 are public-tape estimates. Calibrate against actual `bars` data before locking the floor.
2. **Funding rates.** Not modeled here. HL perps charge funding every 8h; sustained one-sided funding can swamp the fee win on multi-day holds. B3 (funding-rate signal integration) addresses this.
3. **Maker rebates.** HL pays −1.5 bps to makers. If we ever switch to maker-only (limit at top-of-book) the round-trip cost drops to 3 bps and the min profitable ATR% drops to ~0.1%. This is a future optimization — the current strategy uses marketable_limit which fills as taker.

---

**End of H2.**
