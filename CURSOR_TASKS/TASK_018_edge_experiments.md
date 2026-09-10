# TASK_018: Edge Experiments — frequency lever, exits, maker entries (2-week kill rule)

**Priority:** P1
**Status:** PENDING
**Depends on:** TASK_017
**Created:** 2026-09-10 by Cowork (Architecture AI)
**Phase:** Sprint 9 / Stage 3
**Skills:** `strategy-research` · **Subagents:** `backtest-runner` (execute), `quant-skeptic` (mandatory review)
**Kill rule:** if nothing clears the gates by **start + 14 days**, stop sub-daily Coinbase-spot strategy work at this capital and record the decision.

---

## Why

Pre-fee edge per trade today: **−9.4 to +1.7 bps** (t = −1.17 to +0.17) — statistically zero. Round-trip cost at the account's tier: 240 bps (Intro 1), 150 bps ($1K+), 80 bps ($10K+). Fee as a share of a 5×ATR target: 32% on 15m, 13% on 1H, 6% on 4H, 4% on 1D (80 bps round trip). Only lower frequency + better exits can plausibly clear costs. Expect failure; run it cleanly.

## Gates (all required, at the tier-consistent fee)

- PF ≥ 1.20 · ≥ 60 trades / 12 months · ≥ 3 of 4 quarters PF ≥ 1.0 · max DD ≤ 15% · data source 100% real · long-only spot
- Report t-stat of mean R per trade; PF 1.2 on 60 trades is a **screen**, not proof (≈ 520 trades for t = 2).

## Experiments (run in order; stop early on fail where noted)

Run from `atlas/apps/core-node`. **Never put `--` after `pnpm backtest`** (yargs drops flags).

| ID | Question | Command (after TASK_017 flags exist) | Continue if |
|---|---|---|---|
| E1 | Parity baseline | `pnpm backtest --start-date 2025-03-05 --end-date 2026-03-05 --products BTC-USD ETH-USD SOL-USD --initial-capital 1000 --strategy all --venue spot --fee-tier t10k --ev-gate shadow` | always (baseline) |
| E2 | Raw signal edge | same with `--fee-tier custom:0,0 --ev-gate off`, per strategy | zero-fee PF ≥ threshold for target TF (15m 5.8 · 1H 2.25 · 4H 1.6) |
| E3 | Quarterly walk-forward | 4 × quarterly windows, `--strategy trend_follow --regime-gates --fee-tier t10k` | ≥ 3/4 quarters PF ≥ 1.0 |
| E4 | Frequency lever | `--bar-minutes 60`, `240`, `1440` on 2023-03-05 → 2026-03-05, then re-run at the tier the $1K account would actually be in (`t1k` for 1H, `intro1` for 4H/1D) | gates at tier-consistent fee |
| E5 | Exit redesign | ATR trailing stop + time stop wired (B7), no opposite-signal exits | payoff ≥ 2.2 at WR ≥ 38%; ≥ 30% exits via TP/trail |
| E6 | Maker entries (upper bound) | `--fee-tier custom:25,40` and `custom:35,75` with post-only entry assumption | informational only (no fill model) |

**E4 Eng support (2026-09-10, PRs #48 + #51 — Algo Creator Beta card):** `pnpm backtest:e4 --tf 4h --window eval --run-card <id>` (then `--tf 1d --window eval`) runs one timeframe per invocation on Dev Backtest's per-TF fixtures (#47/#49) with the card's zero knobs asserted (BTC/ETH/SOL spot long-only, trend_follow A1 2.5/6.0, true 4H, cooldown 1 × 4H bar, atr_volatility_min 0.005, EV gate on/0, GO fee book 40 bps/side; stress 25/75/120 separate). Order: **hard preflight counted E[n] (≥ 100 else RESEARCH SCREEN ONLY / EXPLORATORY) → zero-fee PF vs locked floor (4H 1.61 · 1D 1.44 · 1H 2.25; STOP below) → FeeModel 40 + Beta bars → month-block MC screen (P(PF ≥ 1.20) ≥ 0.60 is screen, not GO)**. Walk-forward locked: tune 2023-03 → 2025-03 (diagnostics), eval 2025-03 → 2026-03 (once; ledger). Holdout preflight 2026-09-10: pooled n = 42 (BTC 9 / ETH 14 / SOL 19), E[n] 42 < 100 ⇒ RESEARCH SCREEN ONLY; zero-fee PF 0.94 < 1.61 ⇒ STOP. Not a desk GO. See `docs/research/2026-09-10_e4-multi-tf-feemodel-harness.md`.

## Deliverables

- `docs/research/<date>_e1-e6-edge-experiments.md` — per-experiment table (trades, WR, PF, net, fees, max DD, t-stat, quarters), data provenance, verdict per gate.
- Decision entry in `docs/plans/SPRINT-9-LIVE-COINBASE.md` §3: Door A opened (config + profile), or kill rule invoked.
- `quant-skeptic` review appended to the research doc.

## Anti-overfitting rules (non-negotiable)

1. Parameters chosen on 2023-03 → 2025-03; evaluated once on 2025-03 → 2026-03. No re-tuning after looking at the evaluation window.
2. Max 12 parameter combinations per experiment; report all of them, not the best one.
3. Any regime/filter added must be justified ex-ante in the doc before running.
