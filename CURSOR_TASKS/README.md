# Cursor Task Queue — Apex Automata

## How to Use

1. **CEO (Cowork Claude)** writes task files here with numbered prefixes
2. **You (Luke)** tell Cursor: `Read and execute CURSOR_TASKS/TASK_XXX_name.md`
3. **After Cursor completes**, run the matching verify script: `node CURSOR_TASKS/verify/verify_XXX.js`
4. **Green = move on.** Red = come back to Cowork Claude for diagnosis.

## Task Status

| Task | Description | Status |
|------|-------------|--------|
| 000 | Regime detector confidence fix | ✅ VERIFIED |
| 001 | Phase 4A — Exchange abstraction layer | ✅ VERIFIED |
| 002A | Extend CoinbaseAdapter for perpetual futures | ✅ VERIFIED |
| 002B | Guardrails update for perps config | ✅ VERIFIED |
| 002C | Perps risk module (liquidation/funding/leverage) | ✅ VERIFIED |
| 002D | Strategy layer wiring for perps + shorting | ✅ VERIFIED |
| 003A | Wire perps_symbols strategy overrides + notional limits | ✅ VERIFIED |
| 003B | Perps market data proxy + order routing | ✅ VERIFIED |
| 004 | Startup resilience — non-fatal perps init + state cleanup | PENDING |
| 005 | Runtime bug fixes — 6 paper mode critical bugs | PENDING |
| 006 | trading-signals indicator swap — replace hand-rolled math | PENDING |
| 007 | Hyperliquid exchange adapter via nomeida/hyperliquid SDK | PARKED (Week 4+) |
| 008 | TWAP execution hardening — anti-signaling randomization | PARKED (Week 4+) |
| 009 | CCXT multi-exchange evaluation & expansion layer | PARKED (Month 2+) |

## Current Phase: 4D → 5A — Bug Fixes + Open-Source Integration

**Critical path:** TASK_004 → TASK_005 → TASK_006 → Paper Validation → TASK_007

**TASK_005** fixes 6 runtime bugs blocking paper trading (order 404 spam, trend_follow zero signals, disabled strategies still firing, shorts blocked in paper, WS stall detection, INTX 401 spam).

**TASK_006** swaps hand-rolled indicator math in `indicators/technical.ts` with the `trading-signals` library (already installed, zero imports). This is a stabilization move — eliminates potential calculation bugs before live trading.

**TASK_007** (PARKED) builds the Hyperliquid adapter — the only venue where surviving strategies are profitable. Begins after 2-4 weeks of validated paper trading.

**TASK_008** (PARKED) hardens TWAP execution with anti-signaling randomization (Gaussian sizes, Poisson scheduling, volume participation). Pattern-mined from crypto-chassis/ccapi, no library install.

**TASK_009** (PARKED) evaluates CCXT for rapid multi-exchange expansion. Decision document only — no production code until evaluation recommends proceeding.

## Completed Phases

**Phase 4A (TASK_001):** Exchange abstraction layer
**Phase 4B (TASK_002 A→D):** Coinbase Perpetual Futures integration
**Phase 4C (TASK_003A):** Perps override wiring (strategy params + notional limits)
**Phase 4D-wiring (TASK_003B):** Market data proxy + candle mirroring + dynamic products

## Naming Convention
- Task files: `TASK_XXX_short_description.md`
- Verify scripts: `verify/verify_XXX.js`
- Status: PENDING → IN_PROGRESS → DONE → VERIFIED
