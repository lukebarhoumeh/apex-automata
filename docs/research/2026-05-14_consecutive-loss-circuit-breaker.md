# H6 — Consecutive-loss circuit-breaker quantification

> **Date:** 2026-05-14. **Author:** Wave 1 Agent E (sprint plan §3 H6). **Status:** research input for Wave 2 task A4 (loosen consec-loss kill 8 → 10 with progressive cooldown).

> **TL;DR.** At the engine's planning baseline of 50% win rate, the current `CONSECUTIVE_LOSS_LIMIT=8` (per `trading-engine.ts:841`) trips ~**54% of any 200-trade month** — too tight. Raising to **N = 10** drops the false-positive rate to **~18% per 200-trade month** (≈ 2 trips/year), which matches the sprint plan A4 recommendation. Keep the 2× cooldown ramp on losses 6 + 8 as an early-warning system, not a replacement for the kill.

---

## 1. Why this matters

Yesterday's run tripped on the 8th consecutive loss with WR = 0% across the 8 trades. That's the **degenerate case** — at 0% WR, `(1-p)^N = 1.0` for any N. The kill switch did its job: it pulled the engine off a clearly broken state.

The interesting question is the **non-degenerate** case: with a strategy that has positive long-run EV but is suffering through a bad streak, how often will the kill switch fire purely from sequence variance? That's the false-positive rate.

A false positive forces a manual reset (per Wave 0 task W0.3 `J5`) and pauses paper data collection. Too tight = constant interruptions; too loose = real strategy degradation runs longer before being caught.

---

## 2. Math

Probability of an N-loss streak occurring at least once in a 200-trade month, assuming i.i.d. Bernoulli trades with per-trade win probability `p`:

- **Single-trade-of-streak probability:** `q^N` where `q = 1 - p`. (Probability that any specific trade is the last of an N-streak; the previous N−1 trades must also be losses.)
- **Trades-between-trips, expected:** `1 / q^N` (geometric).
- **Probability of at least one trip in 200 trades:** `1 − (1 − q^N)^200`.

This is a first-order approximation: it assumes per-trade outcomes are independent. In practice WR clusters by regime (a bad regime means several losses in a row are correlated). Real false-positive rates are therefore **somewhat higher than the table** below at the low-WR / low-N corners. Use the numbers as a lower bound on tripping frequency.

---

## 3. Probability table

**P(at least one N-loss streak in a 200-trade month):**

| Win rate `p` | N = 8 | N = 10 | N = 12 |
|---|---|---|---|
| 0.30 (broken strategy) | **>99.9%** | 99.7% | 93.8% |
| 0.40 (poor) | **96.6%** | 70.3% | 35.3% |
| **0.50 (planning baseline)** | **54.3%** | **17.8%** | 4.8% |
| 0.60 (strong) | 12.3% | 2.1% | 0.34% |

**Single-streak probability and expected trades between trips:**

| Win rate `p` | `q^N` at N=8 (Pr/trade) | trades/trip at N=8 | `q^N` at N=10 | trades/trip at N=10 | `q^N` at N=12 | trades/trip at N=12 |
|---|---|---|---|---|---|---|
| 0.30 | 5.77% | 17 | 2.83% | 35 | 1.38% | 72 |
| 0.40 | 1.68% | 60 | 0.60% | 165 | 0.22% | 459 |
| **0.50** | **0.39%** | **256** | **0.10%** | **1,024** | 0.024% | 4,096 |
| 0.60 | 0.066% | 1,525 | 0.011% | 9,536 | 0.0017% | 59,604 |

**Read as:** at 50% WR, N=8 trips on average **once every 256 trades** ≈ once every 1.3 trading months at 200 trades/month. N=10 trips once every 5 months. N=12 once every 21 months.

---

## 4. Yesterday's data point — degenerate case

Per SPRINT-PLAN-FINAL.md §1.2 + §1.3:

| Trade # | Outcome |
|---|---|
| 1 | loss (`-$8.03`) |
| 2 | loss (`-$12.35`) |
| 3 | loss (`-$24.37`) |
| 4 | loss (`-$14.31`) |
| 5 | loss (`-$12.29`) |
| 6 | loss (`-$6.84`) |
| 7 | loss (`-$9.05`) |
| 8 | loss (`-$9.05`) → kill switch trips |

WR = 0/8 = 0%. At p = 0, `q^N = 1.0` for any N — kill **always** fires. The 8-vs-10-vs-12 question is irrelevant in this single sequence; raising N just delays the inevitable by 2–4 more trades and ~$25–50 more loss.

What this **does** tell us: the strategy was structurally negative-EV on Coinbase fees that day (per H2's analysis: 22% fee drag means 4 take-profits closed at near-entry). The kill caught a real signal of degradation. But that's a different problem from the breaker geometry — it's the underlying strategy/venue choice (B1 + A1).

---

## 5. Recommendation

**Adopt `N = 10` as the new default for `CONSECUTIVE_LOSS_LIMIT`.**

Rationale:

| Win rate condition | Recommended N | Trip frequency at 200 trades/mo |
|---|---|---|
| Planning baseline `p ≥ 0.50` | **10** | 17.8% (≈ 2 trips/year) |
| Strong baseline `p ≥ 0.60` | 10 (same) | 2.1% (≈ 1 trip every 4 years) |
| Weak baseline `0.40 ≤ p < 0.50` | 12 | 35.3% at N=12 vs. 70.3% at N=10 — wider gives more headroom while strategy is on probation |
| Broken `p < 0.40` | **don't loosen — fix the strategy** | the breaker is doing its job |

A stricter alternate (N = 12) trades 4× more headroom for 4× more tail loss when the strategy genuinely degrades. At 50% WR it's overkill; at 40% WR it's the right call. **Recommendation conditional on WR**: surface a sprint-end review of A4 after the first 7-day HL paper run measures actual `p`.

**Keep the 2× cooldown ramp on the 6th and 8th losses** (separate from N). The ramp is an early-warning mechanism: the engine doubles the inter-signal cooldown before tripping, giving the operator a chance to inspect. The ramp does not change `q^N` arithmetic — it just slows the rate of accumulating losses, buying review time. Cost is small (a few minutes of suppressed trading).

Implementation notes for A4:

1. Default `circuit_breakers.max_consecutive_losses: 10` in `atlas/config/guardrails.yaml` (new key).
2. Env override `CONSECUTIVE_LOSS_LIMIT` continues to work (per `trading-engine.ts:841`).
3. `circuit_breakers.cooldown_ramp: { 6: 2, 8: 4 }` (multiplier on signal-arbiter cooldown at the listed loss counts).
4. Unit-test the cooldown ramp in `risk-engine.test.ts` and the integration in `trading-engine-lifecycle.test.ts`.

---

## 6. Sensitivity to the i.i.d. assumption

The math assumes per-trade outcomes are independent. They aren't: regime-conditional clustering means a string of losses is more likely than `q^N` would suggest in a "ranging" regime. If real WR clusters (e.g., 30% in ranging, 60% in trending, 50% blended), the actual trip rate at N=10 with blended p=0.50 is closer to **25–30%** per month rather than 18%. Two more trips/year vs. the i.i.d. baseline.

**Mitigation already in plan:** A6 (signal-arbiter regime-conditional gates) suppresses signals when regime is unfavorable. With A6 in place, the conditional WR per regime is closer to what the strategy was designed for, and the i.i.d. approximation tightens.

---

## 7. What this informs

- **A4 (loosen consec-loss kill).** Use `N = 10`, keep the 6/8 cooldown ramp.
- **J1 (risk limit revalidation).** After A4, the new cap of 10 losses × ~$12 avg loss = ~$120 max trip loss. Below the daily $200 limit; consistent.
- **H6 → A6 dependency.** A6 reduces clustering, which makes the i.i.d. analysis more accurate — re-validate this analysis after A6 ships.

---

## 8. Open questions

1. **Inter-trade time.** A 10-loss streak in 30 minutes (high-frequency burst) is a different signal from a 10-loss streak across 5 days. Should the kill be N-losses-in-N-trades or N-losses-in-Δt? Today's check is the former.
2. **Loss magnitude.** All losses count equally. A 5R drawdown is materially worse than a 10× 0.5R drawdown. Wave 3 could move to a $-magnitude breaker (already exists as `dailyPnLUsd ≤ -$200`) and let consec-loss be the secondary check.
3. **Asymmetric recovery.** Once tripped, the engine resets to 0 consec-losses but inherits the venue/regime that caused the streak. A "warm-up requirement" of 3 consecutive non-loss outcomes before counter resets to 0 would prevent immediate re-trip. Not in scope for A4.

---

**End of H6.**
