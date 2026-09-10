# Live-Readiness Audit and Trading Analysis — 2026-09-10

**Author:** Cowork Claude (architecture) · **Requested by:** Luke · **Status:** final
**Question:** Can Apex Automata trade live on Coinbase now with $500–1,000, skipping further paper trading — and what does it take?
**Short answer:** Not today. The live path cannot authenticate (§3). Once fixed, the current strategies have no measurable edge and lose to fees at the account's actual tier (§2, §4). The plan to get live safely, and to look for edge honestly, is `docs/plans/SPRINT-9-LIVE-COINBASE.md`.

---

## 1. Method and evidence base

| Source | What |
|---|---|
| Repo on lukepc | branch `feat/a6-regime-conditional-gates` (origin/main + 1), 163 backend TS files, 54K LOC; `pnpm test` 48 files / 625 tests pass |
| Live Coinbase account | `pnpm cb:preflight` (new read-only CLI): auth, permissions, balances, fee tier, product specs |
| Supabase `gdrdaajvutmewgxbjurk` | schema, 53 applied migrations, advisors, paper trade history (read-only SQL) |
| 26 backtest reports | `atlas/var/backtest_results/report_*.txt` (2026-05-11 → 05-29), re-parsed and cross-checked against trade logs |
| Research docs | Phase 3 verdict (Mar), F3/F4/F4-follow-up (May 18–19), H6 (May 29), A6 (May 29) |
| Coinbase / Kraken / eToro docs | auth spec, order configs, WS endpoints, fee schedules (Sep 2026) |

Run labels R01–R26 are defined in Appendix A.

---

## 2. Strategy evidence

### 2.1 Loss decomposition (real-data spot runs, $10K scale)

| Run | Window | n | Net @4.5 bps | Fees | **Pre-fee net** | Pre-fee per trade | t (mean) | Pre-fee PF |
|---|---|---|---|---|---|---|---|---|
| A = R21 | 90d | 246 | −$521 | $641 | **+$119** | +1.7 bps | +0.17 | 1.03 |
| B = R23 | 12m | 544 | −$2,816 | $1,378 | **−$1,438** | −9.4 bps | −1.17 | 0.87 |
| C = R25 (regime-gated) | 12m | 214 | −$745 | $550 | **−$195** | −3.2 bps | — | 0.96 |

Average notional ≈ $2,893 per trade (fees / (n × 2 × 4.5 bps)); cross-checked against trade-log PnL$/PnL% (median $2,937). The binding cap is 30% exposure × 0.98.

**Verdict: signal problem and fee problem.** Pre-fee edge is statistically indistinguishable from zero. Even at 4.5 bps, every real-data spot run with n ≥ 90 has PF 0.70–0.88.

### 2.2 Fee sensitivity (exact for net; PF modeled from the 111-trade distribution, validated R08→R07: predicted 0.28 vs actual 0.25)

| bps/side | A net / PF | B net / PF | C net / PF |
|---|---|---|---|
| 0 | +$119 / 1.03 | −$1,438 / 0.87 | −$195 / 0.96 |
| 4.5 | −$521 / 0.88 | −$2,816 / 0.77 | −$745 / 0.86 |
| 25 | −$3,439 / 0.45 | −$9,092 / 0.45 | −$3,251 / 0.53 |
| 40 | −$5,574 / 0.29 | −$13,685 / 0.31 | −$5,084 / 0.38 |
| 75 | −$10,556 / 0.13 | −$24,400 / 0.15 | −$9,362 / 0.20 |
| 120 (account today) | −$16,962 / 0.04 | −$38,178 / 0.06 | −$14,862 / 0.10 |

### 2.3 By strategy

| Book | Evidence | Read |
|---|---|---|
| Momentum (spot) | 90d +$133 (n=101, t≈+0.30); 12m −$1,149 (n=123), −$1,186 (n=187, t≈−1.39) | The 90-day gain is noise; 12m is negative |
| Trend follow (spot) | 90d −$655 (n=145); 12m −$1,667 (n=421); gated 12m +$441 (n=27, WR 48%, t≈1.36) | Only candidate: breakeven ≈ 33 bps/side on n=27, not significant |
| SOL-USD momentum | +$360 (n=31) 90d; −$489 (n=43) 12m | Window artifact |
| Regime edges (A6) | trend_follow PF 1.41 strong_trend (n=16) vs 0.78 weak (n=143); momentum strong_trend PF 3.73 (90d) vs 0.46 (12m) | Non-stationary / tiny n |

### 2.4 Measurement defects that invalidate prior conclusions

1. **Synthetic perps data.** `backtesting/data-loader.ts:102-145` falls back Supabase → exchange → `generateSyntheticData` with a warning only. BTC-PERP-INTX printed 52,437–53,136 in Mar-2025 while BTC-USD was 89,583–92,485; ETH-PERP 3,254 vs ETH-USD 2,247. These match the generator's seeds (50,000 / 3,000) plus drift. **R14, R18, R19, R20, R26 are void. R22 and R24 are contaminated.** F4-follow-up perps decisions and the perps share of H6/A6 rest on random walks.
2. **Shorts in spot backtests.** 44 of 111 sampled spot trades are SELL entries. Live spot can't short (and `allow_short: true` would try).
3. **Sizing on initial capital** (`backtest-engine.ts:869`). R09 shows 112% max DD.
4. **EV gate absent from backtests.** R07/R08 have identical trade sets despite an 8.9× fee change.
5. Hold-time metric broken (R22 negative); `--slippage` flag unused; no timeframe flag; unsupported Coinbase granularities silently map to ONE_MINUTE (`advanced-trade-client.ts:551-558`).
6. Dead config: `strategy.stop_trail_atr`, `time_stop_bars` have no consumer.

### 2.5 Paper trading history (Supabase `trade_log`, Feb–May 2026)

95 trades; **0 net-positive after fees**; 22 positive before fees. Total net −$10,204, fees $7,754. Perps rows were charged spot-rate fees (65–95 bps round trip vs configured 5 bps taker); fixed 2026-05-14, after the last trade. Take-profit exits (n=20) lost even before fees. Conclusion matches §2.1: no gross edge.

---

## 3. Live execution path

### 3.1 Account (preflight, 2026-09-10)

| Check | Result |
|---|---|
| Key | CDP key, ECDSA P-256; JWT accepted (HTTP 200) |
| Permissions | `can_view` ✅ `can_trade` ✅ `can_transfer` ❌ (correct for a bot) |
| Clock skew | 0.51 s |
| Balances | **$2.90 USD+USDC available**; GALA 400.83 |
| Fee tier | **Intro 1: 60 bps maker / 120 bps taker**, 30-day volume $0 |
| Products | BTC-USD 77,379.99 · ETH-USD 2,469.55 · SOL-USD 100.155; base_increment 1e-8; min ≈ $1 |
| Repo `AdvancedTradeRestClient` | authenticates (`getAccounts` OK, not paginated) |

### 3.2 Defects (ranked)

| # | Severity | Defect | Location |
|---|---|---|---|
| L1 | Critical | Live adapter uses legacy Exchange HMAC + passphrase and legacy paths; CDP key can't authenticate | `rest-client.ts:131-150`, `adapter-factory.ts:94-108` |
| L2 | Critical | Preflight hard-codes `https://api.exchange.coinbase.com`, whatever `COINBASE_API_VERSION` is | `server.ts:2527-2537` |
| L3 | Critical | No exchange-side stops; protection is in-process only on a Windows PC | `position-monitor.ts` |
| L4 | Critical | `allow_short: true` ⇒ spot SELL = short entry (or sells pre-existing holdings) | `server.ts:1914-1915`, `risk-engine.ts:746` |
| L5 | High | Live equity: USD-only; if undeterminable stays $10,000 (fail-open); 0.5–2× clamp | `server.ts:2542-2553`, `risk-engine.ts:991` |
| L6 | High | FeeModel static 25/40 bps vs real 60/120; EV gate allows all trades without history | `core/fee-model.ts`, `trading/risk/ev-gate.ts` |
| L7 | High | AT client: ignores `success:false`, synthesizes order state, hard-codes product specs, no stop/bracket | `advanced-trade-client.ts:277-362` |
| L8 | High | Perps adapter initialized and INTX risk monitor started in live; INTX is non-US and deprecated | `server.ts:1204-1245` |
| L9 | Medium | Legacy CLI configs (`live.local.yaml`) still enable breakout/vwap_mr; misleading | `atlas/config/*.local.yaml` |

### 3.3 EV gate math at the account's tier

EV (in R) = p·k − (1−p) − 2f/stop%, with k = TP/stop. The gate passes when stop% ≥ 2f / (p(k+1) − 1).

| Geometry | k | Min stop% @40 / 75 / 120 bps | Min 15m ATR% |
|---|---|---|---|
| Momentum TP5/SL2 | 2.5 | 2.00 / 3.75 / 6.00 | 1.00 / 1.88 / 3.00 |
| Trend BTC/SOL TP5/SL2.5 | 2.0 | 4.00 / 7.50 / 12.0 | 1.60 / 3.00 / 4.80 |
| Trend ETH TP6/SL2.5 | 2.4 | 2.22 / 4.17 / 6.67 | 0.89 / 1.67 / 2.67 |

Typical 15m ATR% is 0.4–1.0%. Across 12 setups: **0 pass at 120 and 75 bps, 2 marginal at 40 bps**. Using realized geometry (payoff 1.35 vs assumed 2.0–2.5; 51% of exits at stop, 13% at TP): 0.395 × 1.35 − 0.605 = **−0.07R before fees**. A correctly configured gate blocks nearly every trade, which is the right answer.

---

## 4. Economics at $1,000

Risk unit $5 (0.5%); position cap $294 (30% × 0.98); fee per round trip at $294 notional: $7.06 (120 bps) / $4.41 (75) / $2.35 (40), i.e. **141% / 88% / 47% of the risk unit**.

| Scenario | Trades/mo | 30d volume | Fees 40 / 75 / 120 bps | Net 40 / 75 / 120 bps |
|---|---|---|---|---|
| Backtested frequency (R21) | 83 | $48K | $193 / $361 / $578 | −$189…−215 / −$357…−384 / −$574…−600 |
| Long-only (×0.60) | 50 | $29K | $116 / $218 / $349 | −$114…−130 / −$216…−232 / −$347…−363 |
| Regime-gated (R25 freq) | 18 | $10K | $41 / $76 / $122 | −$40…−46 / −$76…−81 / −$121…−127 |

1σ monthly noise ≈ ±$41 (backtested frequency). **Tier trap:** frequency that lifts the account into a cheaper tier does so by paying the losses above. Lower frequency keeps it in an expensive tier.

### 4.1 Frequency lever (why Stage 3 targets 1H–1D)

| TF | ATR% | 80 bps round trip as % of 5×ATR | Break-even WR (TP5/SL2.5) | Zero-fee PF needed for PF 1.2 @40 bps |
|---|---|---|---|---|
| 15m | 0.5 | 32% | 54.7% | 5.8 |
| 1H | 1.2 | 13.3% | 42.2% | 2.25 |
| 4H | 2.5 | 6.4% | 37.6% | 1.61 |
| 1D | 4.0 | 4.0% | 36.0% | 1.44 |

Today's zero-fee PF is 0.87–1.03. Even 4H needs a large improvement in signal quality, so expect failure and keep the 2-week kill rule.

---

## 5. Persistence (Supabase)

| # | Defect | Impact |
|---|---|---|
| P1 | Positions upsert `onConflict (user_id, symbol)` vs a partial unique index ⇒ every write fails; table has 0 rows | No crash recovery from DB |
| P2 | `fills.order_id` receives the exchange id (FK → `orders.id` client UUID) | Every live fill dropped |
| P3 | Paper trade ids are a per-process counter ⇒ upserts overwrite prior sessions (28 fills for 220 filled orders) | Corrupt history |
| P4 | Order `created`/`filled` handlers race; status can regress; boot hydrates `new` rows with no mode filter | Phantom open orders |
| P5 | No paper/live discriminator; same `USER_ID`; risk state (kill switch, consecutive losses) restored without mode filter | Paper state bleeds into live |
| P6 | `SupabaseWriter` (queue/retry/spool) is used only by its test | DB blip = lost facts |
| P7 | Three edge functions write with the service role, `verify_jwt=false`, and trust `body.user_id` | Anyone can write/delete rows |
| P8 | `anon SELECT USING (true)` on positions/orders/fills/signals/daily_equity | Trading data readable with the publishable key |

**Fixed today:** migration `20260910175414_security_hardening` (views → `security_invoker`, function `search_path` pinned, EXECUTE revoked from anon/PUBLIC, `user_roles` policies scoped to authenticated). Advisors: 0 ERROR; 1 expected WARN (`has_role` for authenticated); 1 INFO on `agentic_heartbeats` (other system, untouched).
**Prepared, not run:** `supabase/manual/20260910_archive_paper_history.sql` (archives and removes pre-live paper rows; tested on local PG16 against a mock schema; run with the engine stopped at go-live).
**Unexplained:** `risk_metrics` row `updated_at` 2026-09-10 17:22:48Z (all-zero reset; no PostgREST request in edge logs, so likely a direct SQL session). Re-check before running the archive script.

## 6. Control plane and dashboard

- API: `cors()` any origin, no auth, all interfaces; the live confirm phrase is a public constant. With `CONFIRM_LIVE=YES`, any page open in the browser can start live or close all.
- UI: Risk-page KILL ALL has no handler; ⌘K flatten is a placeholder; positions table adds `Math.random` jitter and freezes rows; no LIVE/HALTED/STALE banner (the pill defaults to "paper"); footer health hard-coded green; Model/Backtest/Journal/Alerts/Settings are seeded mock data (Settings shows a fake "LIVE · connected" key); Stop market-flattens in live with one click; likely refetch storm from status cache replacement; no error boundary.

## 7. Venues

| Venue | Fees (small account) | US | Verdict |
|---|---|---|---|
| Coinbase Advanced (spot) | 60/120 → 35/75 → 25/40 bps by 30d volume | ✅ | Proceed (only wired venue) |
| Coinbase INTX perps | — | ❌ non-US; AT INTX endpoints deprecated | Remove from live |
| Kraken Pro (Jul 2026 tiers) | Tier 1 spot 40/80 bps; tier = best of spot volume, futures volume, or assets on platform | ✅ | Not now: no structural edge vs Coinbase $1K+ tier; second unvalidated adapter |
| eToro | ~1% per crypto trade | ✅ (crypto) | No |
| Hyperliquid | 4.5 bps taker | ❌ terms exclude US persons | No (and no edge even at 4.5 bps) |

## 8. Recommendations (ranked)

1. **Build the live path correctly before any capital:** TASK_010 → 016 (auth, account truth, long-only profiles, exchange-side brackets, persistence, API security, truthful UI).
2. **Prove it with a wire canary** (ETH-USD, $25 notional, 20 round trips, about $15 total cost). Pass criteria in Sprint 9 plan §3.
3. **Don't allocate $500–1,000 to the current strategies expecting profit.** If you choose to anyway (Door B), cap the monthly loss budget and accept ≈ −$350 to −$600/month at today's tier.
4. **Fix measurement before tuning** (TASK_017): fail on synthetic data, long-only spot, EV gate parity, equity-based sizing.
5. **Spend at most two weeks looking for edge on 1H–1D with better exits** (TASK_018). Kill the sub-daily Coinbase-spot line if nothing clears the gates at the tier-consistent fee.
6. **Drop momentum on spot** unless E2 shows zero-fee PF above threshold. It's negative on every 12-month window.
7. **P1 ops:** run the live runtime on an always-on host (the Docker image exists) once Stage 1 passes.

---

## Appendix A — Backtest run inventory

`bp/side` = flat fee per side (`--commission`). All $10K initial capital. DD% is of initial capital.

| # | Report | Window | Products | bp | n | WR% | PF | Net $ | Fees $ | MaxDD % | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|
| R01 | 05-11 20:12 | 90d | BTC ETH SOL | 40 | 9 | 33.3 | 0.31 | −220 | 208 | 2.2 | early engine |
| R02 | 05-11 20:29 | 90d | BTC ETH SOL | 4.5 | 9 | 33.3 | 0.82 | −35 | 23 | 1.85 | |
| R03 | 05-11 20:56 | 365d | BTC ETH SOL | 40 | 10 | 40.0 | 0.26 | −288 | 234 | 3.33 | |
| R04 | 05-11 21:56 | 29d | BTC ETH SOL | 40 | 10 | 10.0 | 0.03 | −631 | 159 | 6.4 | |
| R05 | 05-14 20:39 | 2d | ETH | 4.5 | 36 | 33.3 | 0.34 | −214 | 95 | 2.58 | likely 1m |
| R06 | 05-14 20:41 | 2d | ETH | 4.5 | 33 | 39.4 | 0.41 | −186 | 87 | 2.34 | |
| R07 | 05-18 18:20 | 90d | BTC ETH SOL | 40 | 249 | 32.5 | 0.25 | −5,905 | 5,762 | 59.45 | F3 run 1 |
| R08 | 05-18 18:21 | 90d | BTC ETH SOL | 4.5 | 249 | 39.4 | 0.83 | −791 | 648 | 11.61 | same trades as R07 |
| R09 | 05-18 18:23 | 365d | BTC ETH SOL | 40 | 470 | 28.5 | 0.33 | −11,253 | 10,513 | 112.5 | sizing ignores losses |
| R10 | 05-18 18:23 | 29d | BTC ETH SOL | 40 | 95 | 30.5 | 0.38 | −2,465 | 1,943 | 24.72 | |
| R11 | 05-18 18:59 | 90d | BTC ETH SOL | 4.5 | 246 | 39.8 | 0.88 | −521 | 641 | 10.86 | post-A1 |
| R12 | 05-18 19:01 | 365d | BTC ETH SOL | 4.5 | 544 | 33.6 | 0.77 | −2,816 | 1,378 | 29.28 | |
| R13 | 05-18 19:02 | 29d | BTC ETH SOL | 4.5 | 95 | 32.6 | 0.74 | −719 | 220 | 7.34 | |
| R14 | 05-18 19:09 | 90d | ETH/BTC-PERP | 4.5 | 902 | 33.0 | 0.37 | −5,871 | 2,388 | 58.77 | **synthetic** |
| R15 | 05-18 19:13 | 90d | BTC ETH SOL | 4.5 | 245 | 40.0 | 0.87 | −578 | 638 | 11.4 | |
| R16 | 05-18 19:15 | 365d | BTC ETH SOL | 4.5 | 540 | 33.5 | 0.77 | −2,822 | 1,368 | 29.34 | |
| R17 | 05-18 19:15 | 29d | BTC ETH SOL | 4.5 | 93 | 31.2 | 0.70 | −838 | 215 | 8.53 | |
| R18 | 05-18 19:23 | 90d | ETH/BTC-PERP | 4.5 | 178 | 29.2 | 0.29 | −1,371 | 471 | 13.76 | **synthetic** |
| R19 | 05-19 15:47 | 90d | ETH/BTC-PERP | 4.5 | 610 | 32.5 | 0.29 | −4,787 | 1,614 | 47.87 | **synthetic** |
| R20 | 05-19 16:16 | 90d | ETH/BTC-PERP | 4.5 | 365 | 25.2 | 0.44 | −2,359 | 966 | 24.25 | **synthetic** |
| R21 | 05-19 16:18 | 90d | BTC ETH SOL | 4.5 | 246 | 39.8 | 0.88 | −521 | 641 | 10.86 | run A |
| R22 | 05-29 16:24 | 90d | spot + 2 PERP | 4.5 | 276 | 39.5 | 0.88 | −563 | 720 | 11.56 | H6; perps part synthetic |
| R23 | 05-29 16:52 | 365d | BTC ETH SOL | 4.5 | 544 | 33.6 | 0.77 | −2,816 | 1,378 | 29.28 | run B |
| R24 | 05-29 17:09 | 90d | spot + 2 PERP | 4.5 | 144 | 41.0 | 1.04 | +113 | 371 | 5.99 | gated; perps part synthetic |
| R25 | 05-29 17:12 | 365d | BTC ETH SOL | 4.5 | 214 | 35.0 | 0.86 | −745 | 550 | 16.47 | run C (gated) |
| R26 | 05-29 17:22 | 365d | ETH/BTC-PERP | 4.5 | 75 | 24.0 | 0.43 | −486 | 198 | 5.17 | **synthetic** |
