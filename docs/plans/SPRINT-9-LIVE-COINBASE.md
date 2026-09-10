# Sprint 9 — Live on Coinbase (Advanced Trade)

**Created:** 2026-09-10 · **Owner:** Luke · **Architecture:** Cowork Claude · **Execution:** Cursor
**Decision on record (2026-09-10):** go live on Coinbase spot now, skip further paper phase, $500–1,000 capital, Coinbase only.
**Evidence:** `docs/research/2026-09-10_live-readiness-audit.md` · live preflight `pnpm cb:preflight`

---

## 0. TL;DR

1. **The live path cannot place an order today.** `CoinbaseLiveExecutionAdapter → CoinbaseExchange → CoinbaseRestClient` signs with legacy Coinbase Exchange HMAC + passphrase against legacy paths (`/accounts`, `/orders`). Your key is a CDP key (ES256 JWT). `runLivePreflight` also hard-codes `api.exchange.coinbase.com`. Live start fails at preflight — fail-closed, but dead.
2. **The fix is wiring + hardening, not a rewrite.** `AdvancedTradeRestClient` (JWT, `/api/v3/brokerage`) exists, is imported by nothing, and **authenticates against your real account** (verified 2026-09-10). It has order-path defects that must be fixed before it touches money.
3. **Account reality (preflight 2026-09-10):** key `can_view ✅ can_trade ✅ can_transfer ❌ (good)`, clock skew 0.5s, **$2.90 USD+USDC available**, fee tier **Intro 1 = 60 bps maker / 120 bps taker**, 30-day volume $0.
4. **Economics are not a risk-appetite question.** Pre-fee edge per trade is statistically zero (−9.4 to +1.7 bps, t −1.17 to +0.17). At Intro 1 a round trip costs 240 bps. At backtested frequency a $1K account loses roughly **$575–600/month** in fees alone until volume moves the tier. Correctly configured, the A3 EV gate rejects ~100% of 15m setups at this tier.
5. **Plan:** Stage 0 engineering (P0 tasks 010–016) → Stage 1 wire canary (~$15 total cost, proves real-money lifecycle) → Stage 2 capital live under hard caps (strategy gated or explicit override) → Stage 3 edge work in parallel (017–018, 2-week kill rule).

---

## 1. Verified system state (2026-09-10)

| Area | State | Evidence |
|---|---|---|
| Backend tests | 48 files / 625 tests pass (12.9s) | `pnpm test` on lukepc |
| Git | `feat/a6-regime-conditional-gates` = origin/main + 1 unpushed commit (A6 gates, disabled by default); 2 cosmetic dirty files | `git rev-list origin/main...HEAD` |
| Coinbase auth (CDP JWT) | ✅ works via spec JWT and via repo `AdvancedTradeRestClient` | `pnpm cb:preflight` |
| Live execution path | ❌ legacy HMAC client; preflight hard-codes Exchange URL | `rest-client.ts:131-150`, `server.ts:2527-2537` |
| Protective stops | ❌ client-side only (`PositionMonitor`); nothing rests on the exchange | `position-monitor.ts` |
| Live equity | ⚠️ USD-only balance check; if undeterminable, stays at yaml $10,000 (fail-open) | `server.ts:2542-2553` |
| Shorts on spot | ❌ `strategy.allow_short: true` → SELL opens a short on spot | `server.ts:1914`, `risk-engine.ts:746` |
| Fees | ❌ static 25/40 bps from yaml vs real 60/120 | `core/fee-model.ts`, preflight |
| Perps (INTX) | ❌ non-US product; Advanced Trade INTX endpoints deprecated (moving to Deribit gateway) | Coinbase docs |
| Supabase security | ✅ advisor ERRORs cleared (migration `20260910175414_security_hardening`) | `get_advisors` |
| Supabase persistence | ❌ positions never persist; live fills violate FK; order status race; no paper/live discriminator | audit §4 |
| Control API | ❌ no auth, `cors()` any origin — any web page can POST to `localhost:3001` | `server.ts:142` |
| Dashboard | ❌ fake KILL ALL / flatten; positions table adds `Math.random` jitter; no LIVE/HALTED banner | audit §5 |
| Backtests | ❌ perps runs used synthetic random-walk data (silent fallback); spot runs include shorts | audit §3 |

---

## 2. Target architecture — live execution path

```
Signal → RiskEngine (sizing on LIVE equity, real fee tier, EV gate) → OrderManager
   → ExecutionAdapterFactory ── live + COINBASE_API_VERSION=advanced ──▶ CoinbaseAdvancedExecutionAdapter (NEW)
                                                                          ├─ AdvancedTradeRestClient (hardened)
                                                                          │    POST /orders (limit_limit_gtc post_only | market_market_ioc)
                                                                          │    POST /orders (trigger_bracket_gtc / stop_limit_stop_limit_gtc) ← exchange-side protection
                                                                          │    POST /orders/batch_cancel · GET /orders/historical/{id|batch|fills}
                                                                          ├─ AdvancedTradeUserStream (NEW) wss://advanced-trade-ws-user.coinbase.com  `user` channel (JWT)
                                                                          ├─ LiveAccountTruth (NEW): /accounts (paginated, USD+USDC), /transaction_summary (fee tier), /products/{id}
                                                                          └─ Reconciler: exchange is source of truth on boot, reconnect, and every N minutes
   legacy (exchange) ──▶ CoinbaseLiveExecutionAdapter — refuses to start in live (FAIL CLOSED)
```

**Invariants**
- **Exchange is the source of truth in live.** DB is a journal. On boot: pull open orders + balances + recent fills from Coinbase; reconcile; halt on unexplained divergence.
- **Every entry has exchange-side protection** (bracket or stop) before the engine considers the position open. A process crash must never leave a naked position.
- **Fail closed.** Unknown equity, unknown fee tier, unknown product spec, unauthenticated key, clock skew > 30s, or `success:false` → no order, loud log, risk event.
- **Idempotency.** `client_order_id` = engine client UUID; retries reuse it; Coinbase dedupes.
- **Spot is long-only.** A SELL signal on spot is exit-only, regardless of `allow_short`.
- **No perps in live** until a US-eligible derivatives adapter exists and passes its own gates.

---

## 3. Stages and gates

### Stage 0 — P0 engineering (Cursor)

| Task | Title | Blocks |
|---|---|---|
| 010 | Advanced Trade live execution adapter + hardened client + user stream | everything live |
| 011 | Live account truth: equity, fee tier → FeeModel, product specs, preflight on AT | 010 |
| 012 | Live guardrails profile (`GUARDRAILS_FILE`), spot long-only, perps off in live | 010 |
| 013 | Exchange-side protective orders + boot reconciliation | 010, 011 |
| 014 | Persistence fixes for live (positions, fills FK, monotonic status, mode stamping, writer) | 010 |
| 015 | Control-plane security (API token, CORS, localhost bind, edge-function auth) | — |
| 016 | Dashboard live safety (mode banner, real kill/flatten/resume, typed confirms, no fake data) | 015 |

**Gate 0 → 1:** all P0 tasks VERIFIED (`node CURSOR_TASKS/verify/verify_sprint9.cjs`), `pnpm test` green, `pnpm cb:preflight` READY, archive script run (`supabase/manual/`), account funded.

### Stage 1 — Wire canary (real money, tiny size)

Profile `atlas/config/guardrails.live-canary.yaml` (see §4). Purpose: prove the lifecycle, not make money.

| Parameter | Value |
|---|---|
| Symbols | ETH-USD only (liquid, $1 min) |
| Direction | long-only |
| Max notional / trade | $25 |
| Max open positions | 1 |
| Round trips cap | 20, then auto-halt |
| Daily loss cap | $10 hard halt + flatten |
| EV gate | `shadow` (log decision, do not block) — explicit, logged at startup |
| Protection | exchange-side bracket required |

**Expected cost:** 20 × $25 × 2 sides × 1.2% ≈ **$12 fees** + ~$2 slippage.
**Pass criteria (all required):** 100% of orders/fills reconcile (DB vs Coinbase) · recorded fees = Coinbase fees ± $0.01 · restart drill with an open position recovers position + bracket · kill drill (halt) and flatten drill (close-all) both verified on exchange · zero unhandled `success:false` · no order without `client_order_id`.

### Stage 2 — Capital live ($500–1,000)

Enter only via one of two doors, recorded in `docs/plans/`:
- **Door A (evidence):** strategy passes Stage 3 gates at the **actual** fee tier.
- **Door B (override):** Luke explicitly sets `live.ev_gate_mode: shadow` in the live profile with the expected monthly loss from §5 written into the decision log. Engine logs a startup banner every session.

Hard limits: risk 0.5%/trade · ≤ 2 positions · daily −2% · weekly −5% · max DD −15% → auto-flatten + halt (manual resume) · monthly loss budget (default $100) → halt for the month.

### Stage 3 — Edge work (parallel, P1)

TASK_017 (backtest integrity) → TASK_018 (timeframe/exit experiments). **Kill rule:** if no configuration clears the gates within 2 weeks of 018 starting, stop pursuing sub-daily strategies on Coinbase spot at this capital.
Gates (all at the tier-consistent fee): PF ≥ 1.2 · ≥ 60 trades / 12m · ≥ 3 of 4 quarters PF ≥ 1.0 · max DD ≤ 15% · zero synthetic bars · long-only.

---

## 4. Live profiles (created by TASK_012)

`atlas/config/guardrails.live-canary.yaml` — deep-merged over `guardrails.yaml` when `GUARDRAILS_FILE` points at it:

```yaml
profile: live-canary
account:
  equity_usd: 0              # ignored in live: equity comes from Coinbase (TASK_011); 0 = fail if unknown
  risk_per_trade: 0.005
  max_open_positions: 1
strategy:
  allow_short: false         # spot is long-only (also enforced in code for spot venues)
per_symbol:
  ETH-USD: { max_notional_usd: 25, max_daily_loss_usd: 10 }
live:
  symbols: [ETH-USD]
  max_round_trips: 20
  ev_gate_mode: shadow       # enforce | shadow — shadow MUST log a startup banner
  require_exchange_protection: true
  reconcile_interval_sec: 60
  monthly_loss_budget_usd: 25
perps_symbols: {}            # no INTX in live (non-US + deprecated endpoints)
```

`atlas/config/guardrails.live-1k.yaml` (Stage 2): same shape; `symbols: [BTC-USD, ETH-USD]`, `max_open_positions: 2`, `max_notional_usd: 300`, `max_daily_loss_usd: 20`, `ev_gate_mode: enforce`, `monthly_loss_budget_usd: 100`.

---

## 5. Economics at $1,000 (read before Door B)

| Fee tier (per side) | Monthly fees @ backtested frequency (83 trades/mo, $289 notional) | Net PnL range |
|---|---|---|
| Intro 1 — 120 bps taker (today) | ≈ $578 | −$574 to −$600 |
| $1K+ — 75 bps | ≈ $361 | −$357 to −$384 |
| $10K+ — 40 bps | ≈ $193 | −$189 to −$215 |
| Regime-gated frequency (18 trades/mo) @ 75 bps | ≈ $76 | −$76 to −$81 |

Volume from backtested frequency (~$48K/30d) would reach the $10K+ tier inside ~2 weeks — you would be **buying** a fee tier with losses. Month-to-month noise ≈ ±$41; the loss is structural, not variance.

---

## 6. Operations

- **Host:** a live runtime on a personal Windows PC is exposed to sleep, updates, and reboots. Exchange-side protection (013) is the P0 mitigation; P1 is an always-on host (container on Azure — `deploy/docker/Dockerfile.api` exists).
- **Secrets:** CDP key stays View+Trade, no Transfer (verified). Rotate if it ever appears in logs.
- **Daily:** `pnpm cb:preflight` → reconcile report → review risk events. Weekly: fee tier + realized vs expected slippage.
- **Git:** merge `feat/a6-regime-conditional-gates` → `main`, then branch `sprint9/live-coinbase`. One task per PR.

## 7. Venue verdicts

| Venue | Verdict | Why |
|---|---|---|
| Coinbase spot (Advanced Trade) | **Proceed** | Only venue wired; key verified; US-regulated |
| Coinbase INTX perps | **Remove from live** | Non-US product; Advanced Trade INTX endpoints deprecated |
| Kraken Pro | **Not now** | Tier 1 spot 40/80 bps (Jul 2026 schedule) — no structural fee edge vs Coinbase $1K+ tier; new adapter = second unvalidated live path |
| eToro | **No** | ~1% per crypto trade (200 bps round trip); broker model unsuited to systematic sub-daily trading |
| Hyperliquid | **No** | Terms exclude US persons; backtests showed no edge even at 4.5 bps |

The binding constraint is signal quality × trade frequency, not venue.
