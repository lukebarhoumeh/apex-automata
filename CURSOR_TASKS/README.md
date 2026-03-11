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

## Current Phase: 4D — Perps Paper Trading Enablement

**TASK_004** is a critical bugfix blocking paper trading startup.

Three surgical fixes:
- Makes `refreshPerpsProducts()` non-fatal (INTX 404 no longer crashes startup)
- Adds state cleanup in engine start catch block (no more "already running" ghost state)
- Double-wraps REST client fallback (returns empty array instead of throwing)

After 004, the system can paper trade both spot and perps simultaneously.

## Completed Phases

**Phase 4A (TASK_001):** Exchange abstraction layer
**Phase 4B (TASK_002 A→D):** Coinbase Perpetual Futures integration
**Phase 4C (TASK_003A):** Perps override wiring (strategy params + notional limits)
**Phase 4D-wiring (TASK_003B):** Market data proxy + candle mirroring + dynamic products

## Naming Convention
- Task files: `TASK_XXX_short_description.md`
- Verify scripts: `verify/verify_XXX.js`
- Status: PENDING → IN_PROGRESS → DONE → VERIFIED
