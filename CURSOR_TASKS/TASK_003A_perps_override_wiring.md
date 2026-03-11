# TASK_003A — Wire Perps Symbol Overrides + Notional Limits

**Status:** TODO
**Priority:** HIGH — Perps strategy params are configured but not applied at runtime
**Depends on:** TASK_002 series (all complete) ✅
**Estimated checks:** ~20

---

## Context

The `perps_symbols` section in `guardrails.yaml` contains per-symbol strategy overrides AND per-symbol risk limits (max_notional_usd, max_daily_loss_usd, default_leverage, max_leverage) for perpetual futures symbols (ETH-PERP-INTX, BTC-PERP-INTX).

**Problem:** These values are loaded by the Zod schema but **NOT applied at runtime**:
1. Strategy overrides (MACD params, RSI thresholds, etc.) for perps symbols are never passed to `signalProcessor.loadPerSymbolOverridesFromGuardrails()`
2. Per-symbol notional limits for perps symbols are never passed to `evaluateRiskThresholds()`
3. Per-symbol leverage settings are never applied to the CoinbasePerpsAdapter

This means ETH-PERP-INTX and BTC-PERP-INTX use **global defaults** instead of their tuned parameters.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** modify the `per_symbol` (spot) loading — it works correctly
2. **DO NOT** change `loadPerSymbolOverridesFromGuardrails()` signature — `perps_symbols` has compatible structure
3. **DO NOT** change Zod schemas or guardrails.yaml — those are already correct from 002B
4. **DO NOT** modify momentum-strategy.ts, base-strategy.ts, or any strategy internals
5. This is WIRING ONLY — connecting existing config to existing consumers

---

## Step 1: Wire perps_symbols strategy overrides into signal processor

**File:** `atlas/apps/core-node/src/api/server.ts`

### 1A. Add perps_symbols override loading (after the existing per_symbol loading, around line 1249)

**FIND:**
```typescript
    if (guardrails.per_symbol) {
      signalProcessor.loadPerSymbolOverridesFromGuardrails(guardrails.per_symbol);
      logger.info('Loaded per-symbol strategy overrides', {
        symbols: Object.keys(guardrails.per_symbol),
      });
    }
```

**REPLACE WITH:**
```typescript
    if (guardrails.per_symbol) {
      signalProcessor.loadPerSymbolOverridesFromGuardrails(guardrails.per_symbol);
      logger.info('Loaded per-symbol strategy overrides (spot)', {
        symbols: Object.keys(guardrails.per_symbol),
      });
    }

    // Load perps-specific strategy overrides (MACD params, RSI thresholds, etc.)
    if (guardrails.perps_symbols) {
      signalProcessor.loadPerSymbolOverridesFromGuardrails(guardrails.perps_symbols);
      logger.info('Loaded per-symbol strategy overrides (perps)', {
        symbols: Object.keys(guardrails.perps_symbols),
      });
    }
```

**Why this works:** The `loadPerSymbolOverridesFromGuardrails()` method accepts `Record<string, { strategy_overrides?: ... }>` — the `perps_symbols` schema has identical structure (plus extra fields like `max_notional_usd` that the method simply ignores). Type-compatible.

---

## Step 2: Wire perps_symbols notional/loss limits into risk evaluation

**File:** `atlas/apps/core-node/src/trading/risk/evaluate-risk.ts`

### 2A. Extend the guardrails parameter type to accept perps_symbols (find the type definition around line 442)

**FIND:**
```typescript
    per_symbol?: Record<string, { max_notional_usd: number; max_daily_loss_usd: number }>;
```

**REPLACE WITH:**
```typescript
    per_symbol?: Record<string, { max_notional_usd: number; max_daily_loss_usd: number }>;
    perps_symbols?: Record<string, { max_notional_usd: number; max_daily_loss_usd: number }>;
```

### 2B. Merge perps_symbols limits into the per-symbol limit maps (after the per_symbol loop, around line 462)

**FIND:**
```typescript
  if (guardrails.per_symbol) {
    for (const [symbol, limits] of Object.entries(guardrails.per_symbol)) {
      maxExposurePerSymbolUsd[symbol] = limits.max_notional_usd;
      maxDailyLossPerSymbolUsd[symbol] = limits.max_daily_loss_usd;
    }
  }
```

**REPLACE WITH:**
```typescript
  if (guardrails.per_symbol) {
    for (const [symbol, limits] of Object.entries(guardrails.per_symbol)) {
      maxExposurePerSymbolUsd[symbol] = limits.max_notional_usd;
      maxDailyLossPerSymbolUsd[symbol] = limits.max_daily_loss_usd;
    }
  }

  // Merge perps symbol limits (same structure, different symbols)
  if (guardrails.perps_symbols) {
    for (const [symbol, limits] of Object.entries(guardrails.perps_symbols)) {
      maxExposurePerSymbolUsd[symbol] = limits.max_notional_usd;
      maxDailyLossPerSymbolUsd[symbol] = limits.max_daily_loss_usd;
    }
  }
```

### 2C. If `evaluateRiskThresholds` is called from server.ts, check that `perps_symbols` is passed through

Search for where `evaluateRiskThresholds` is called in server.ts or risk-engine.ts. If the call site constructs a partial guardrails object, ensure it includes `perps_symbols`. If it passes the full `guardrails` object from `loadGuardrails()`, no change needed — the field is already on the type.

---

## Step 3: Wire per-symbol leverage into adapter initialization

**File:** `atlas/apps/core-node/src/api/server.ts`

### 3A. After the CoinbasePerpsAdapter is initialized and the PerpsRiskMonitor is started, set per-symbol leverage from config

**FIND the section where perpsRiskMonitor is started (around line 950):**
```typescript
      perpsRiskMonitor.setAdapter(perpsAdapter);
      perpsRiskMonitor.start();
```

**INSERT AFTER:**
```typescript

      // Apply per-symbol leverage from perps_symbols config
      if (guardrails.perps_symbols) {
        for (const [symbol, config] of Object.entries(guardrails.perps_symbols)) {
          const leverage = config.default_leverage ?? guardrails.perps?.default_leverage ?? 3;
          perpsAdapter.setLeverage(symbol, leverage).catch((err) => {
            logger.warn(`Failed to set initial leverage for ${symbol}:`, err);
          });
        }
        logger.info('Applied per-symbol leverage settings', {
          symbols: Object.entries(guardrails.perps_symbols).map(([s, c]) => ({
            symbol: s,
            leverage: c.default_leverage ?? guardrails.perps?.default_leverage ?? 3,
          })),
        });
      }
```

---

## Step 4: Verify evaluate-risk call site passes full guardrails

**File:** Check wherever `evaluateRiskThresholds()` is called — likely in `risk-engine.ts` or `server.ts`.

If the call site uses `guardrails` directly (which includes `perps_symbols` from `loadGuardrails()`), no change needed. If it constructs a partial object, add `perps_symbols` to it.

This is a verification step — if it's already passing the full object, mark as no-op.

---

## Verification Checklist

Run: `node CURSOR_TASKS/verify/verify_003a.js`

### Section 1: Strategy Overrides Wiring (5 checks)
- [ ] `loadPerSymbolOverridesFromGuardrails` is called with `guardrails.perps_symbols`
- [ ] Log message contains 'perps' for the perps overrides loading
- [ ] Original `per_symbol` loading is unchanged
- [ ] Both ETH-PERP-INTX and BTC-PERP-INTX are in the perps symbols log
- [ ] No duplicate loading of spot symbols

### Section 2: Notional Limits Wiring (4 checks)
- [ ] `evaluate-risk.ts` type includes `perps_symbols` field
- [ ] Loop merges `perps_symbols` into `maxExposurePerSymbolUsd`
- [ ] Loop merges `perps_symbols` into `maxDailyLossPerSymbolUsd`
- [ ] Spot `per_symbol` limits unchanged

### Section 3: Leverage Initialization (4 checks)
- [ ] `setLeverage` is called for each perps_symbols entry
- [ ] Default leverage falls back to `perps.default_leverage` then 3
- [ ] Log message includes per-symbol leverage values
- [ ] setLeverage errors are caught and logged (not thrown)

### Section 4: No Regressions (5 checks)
- [ ] `per_symbol` spot override loading still works
- [ ] `effectiveRiskPerTrade` logic unchanged
- [ ] `reduce_only` flag on perps close orders unchanged
- [ ] PerpsRiskMonitor start/stop unchanged
- [ ] Existing signal handler flow unchanged

**Total: ~18 checks**

---

## Files Modified Summary

| File | Action | Description |
|------|--------|-------------|
| `api/server.ts` | MODIFY | Add perps_symbols override loading + leverage init |
| `trading/risk/evaluate-risk.ts` | MODIFY | Add perps_symbols to type + merge loop |

---

## What NOT To Do

- Do NOT modify strategy files — overrides are applied through existing `getConfig()` mechanism
- Do NOT change the Zod schema — `perps_symbols` is already validated
- Do NOT change `loadPerSymbolOverridesFromGuardrails` — the interface is compatible
- Do NOT add new risk engine methods — just feed perps limits through existing paths
- Do NOT touch the PerpsRiskMonitor — it already works correctly
