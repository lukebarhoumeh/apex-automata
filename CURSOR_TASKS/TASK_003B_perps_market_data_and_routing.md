# TASK_003B — Perps Market Data Proxy + Order Routing

**Status:** TODO
**Priority:** HIGH — Required before paper trading perps
**Depends on:** TASK_003A (complete) ✅
**Estimated checks:** ~25

---

## Context

The system is architecturally complete for perps (adapter, risk monitor, config, overrides) but perps symbols cannot currently participate in the trading loop because:

1. **Products array is hardcoded** to `['BTC-USD', 'ETH-USD', 'SOL-USD']` (lines 873 and 895 of server.ts). Perps symbols (ETH-PERP-INTX, BTC-PERP-INTX) are not included.
2. **No candle data** flows for perps symbols — no WebSocket subscription, no warmup, no signals.
3. **No order routing** — perps orders would route through TradingEngine's spot exchange instead of CoinbasePerpsAdapter.
4. **perpsAdapter is function-scoped** (line 923) — the signal handler closure can't access it for order routing.

### Market Data Strategy

The Coinbase Advanced Trade WS **ticker channel does NOT support INTX product IDs** for market data. This is expected — in professional derivatives trading, signals are generated from the **spot index price** (which perps track via funding rate). The perps basis (price deviation from spot) is negligible for signal generation at 15m+ timeframes.

**Architecture:** Mirror spot candles → perps symbols. When a BTC-USD candle arrives, also feed a BTC-PERP-INTX candle with the same OHLCV data. This enables signal generation for perps without a separate data feed.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** change WebSocket connection logic — we use spot feed only
2. **DO NOT** modify TradingEngine.createOrder() internals — paper simulator already handles any product_id
3. **DO NOT** modify strategy files or signal processor — they work with any symbol string
4. **DO NOT** touch PerpsRiskMonitor — it already works
5. **DO NOT** change guardrails.yaml or Zod schemas
6. Keep all changes in `server.ts` — this is wiring/orchestration only

---

## Step 1: Hoist perpsAdapter to module scope

**File:** `atlas/apps/core-node/src/api/server.ts`

### 1A. Add module-scoped variable (near line 258 where perpsRiskMonitor is declared)

**FIND:**
```typescript
let perpsRiskMonitor: PerpsRiskMonitor | null = null;
```

**REPLACE WITH:**
```typescript
let perpsRiskMonitor: PerpsRiskMonitor | null = null;
let perpsAdapter: CoinbasePerpsAdapter | null = null;
```

### 1B. Update the local variable assignment (line 923) to use the module-scoped variable

**FIND:**
```typescript
    const perpsAdapter = new CoinbasePerpsAdapter(logger);
```

**REPLACE WITH:**
```typescript
    perpsAdapter = new CoinbasePerpsAdapter(logger);
```

### 1C. Null out perpsAdapter on shutdown (wherever perpsRiskMonitor is cleaned up)

In the shutdown/stop handler, wherever `perpsRiskMonitor = null;` appears, add `perpsAdapter = null;` on the next line. There should be TWO locations (graceful shutdown + SIGTERM handler).

---

## Step 2: Build dynamic products list from guardrails

**File:** `atlas/apps/core-node/src/api/server.ts`

### 2A. Replace hardcoded products arrays (lines 873 and 895) with dynamic list

Create a helper that builds the products list from guardrails. Place it BEFORE the live preflight block (before line 866).

**INSERT BEFORE the `engineGuardrails` clone (around line 866):**
```typescript
    // Build dynamic products list from guardrails config
    // Spot symbols from per_symbol, perps symbols from perps_symbols
    const spotSymbols = guardrails.per_symbol ? Object.keys(guardrails.per_symbol) : ['BTC-USD', 'ETH-USD', 'SOL-USD'];
    const perpsSymbols = guardrails.perps_symbols ? Object.keys(guardrails.perps_symbols) : [];
    // Only spot symbols go into engine products (WS subscription)
    // Perps symbols get market data via spot price proxy (Step 3)
    const engineProducts = [...spotSymbols];

    logger.info('Dynamic products list built', {
      spot: spotSymbols,
      perps: perpsSymbols,
      engineProducts,
    });
```

### 2B. Replace hardcoded product arrays with `engineProducts`

**LINE 873 — Replace:**
```typescript
        products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
```
**WITH:**
```typescript
        products: engineProducts,
```

**LINE 895 — Replace:**
```typescript
      products: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
```
**WITH:**
```typescript
      products: engineProducts,
```

---

## Step 3: Add spot→perps candle proxy

**File:** `atlas/apps/core-node/src/api/server.ts`

### 3A. Create the spot-to-perps symbol mapping

**INSERT after the `perpsSymbols` declaration from Step 2A:**
```typescript
    // Map spot symbols to their perps counterparts for candle mirroring
    // BTC-USD → BTC-PERP-INTX, ETH-USD → ETH-PERP-INTX
    const spotToPerpsMap = new Map<string, string>();
    for (const perpsSymbol of perpsSymbols) {
      // Extract base asset: ETH-PERP-INTX → ETH
      const base = perpsSymbol.split('-')[0];
      const spotSymbol = `${base}-USD`;
      if (spotSymbols.includes(spotSymbol)) {
        spotToPerpsMap.set(spotSymbol, perpsSymbol);
      }
    }
    logger.info('Spot-to-perps price proxy map', {
      mapping: Object.fromEntries(spotToPerpsMap),
    });
```

### 3B. Mirror candles in processTickerForCandles

The `processTickerForCandles` function is declared at module scope (line 360). It needs access to the mapping, but the mapping is built inside the route handler. The cleanest approach is a module-scoped Map.

**ADD near the module-scoped variables (around line 258):**
```typescript
let activeSpotToPerpsMap: Map<string, string> = new Map();
```

**In Step 2A/3A section (inside the route handler), after building `spotToPerpsMap`:**
```typescript
    // Store mapping at module scope for processTickerForCandles
    activeSpotToPerpsMap = spotToPerpsMap;
```

### 3C. Add candle mirroring inside processTickerForCandles

**FIND the section in `processTickerForCandles` where it calls `signalProcessor.addCandle(symbol, candle)` (around line 387). After the try block that adds the candle and broadcasts, ADD:**

**FIND (the complete try block that processes the candle, around lines 386-406):**
```typescript
      try {
        signalProcessor.addCandle(symbol, candle);
        metricsTracker.addCandle(symbol, candle);
        tradingEngine?.notifyNewCandle(symbol);
        logger.debug(`Added candle for ${symbol}: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`);
        broadcast({
          type: 'CandleUpdate',
          payload: {
            symbol,
            timeframe: '1m',
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            timestamp: candle.time,
          }
        });
      } catch (err) {
        logger.error('Failed to add candle to signal processor', err);
      }
```

**REPLACE WITH:**
```typescript
      try {
        signalProcessor.addCandle(symbol, candle);
        metricsTracker.addCandle(symbol, candle);
        tradingEngine?.notifyNewCandle(symbol);
        logger.debug(`Added candle for ${symbol}: O=${candle.open} H=${candle.high} L=${candle.low} C=${candle.close} V=${candle.volume}`);
        broadcast({
          type: 'CandleUpdate',
          payload: {
            symbol,
            timeframe: '1m',
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            timestamp: candle.time,
          }
        });

        // Mirror spot candle to perps symbol (spot price proxy for signal generation)
        const perpsSymbol = activeSpotToPerpsMap.get(symbol);
        if (perpsSymbol && signalProcessor) {
          signalProcessor.addCandle(perpsSymbol, candle);
        }
      } catch (err) {
        logger.error('Failed to add candle to signal processor', err);
      }
```

### 3D. Mirror warmup data for perps symbols

**FIND the warmup section (around lines 1651-1665):**
```typescript
    Promise.all(
      activeSymbols.map(symbol =>
        signalProcessor!.loadHistoricalData(symbol).catch(err => {
          logger.warn(`Warmup failed for ${symbol}:`, err);
        })
      )
    ).then(() => {
```

**REPLACE WITH:**
```typescript
    // Warmup spot symbols (from WS subscription)
    const warmupSymbols = [...activeSymbols];
    // Also warmup perps symbols using spot data loader (proxy)
    // Signal processor data loader uses spot REST API, works for perps signals
    for (const [spotSym, perpsSym] of activeSpotToPerpsMap.entries()) {
      if (!warmupSymbols.includes(perpsSym)) {
        warmupSymbols.push(perpsSym);
      }
    }

    Promise.all(
      warmupSymbols.map(symbol => {
        // For perps symbols, load data using the corresponding spot symbol
        const isPerps = symbol.includes('-PERP-');
        const loadSymbol = isPerps
          ? symbol.split('-')[0] + '-USD'  // ETH-PERP-INTX → ETH-USD
          : symbol;

        return signalProcessor!.loadHistoricalData(loadSymbol, symbol).catch(err => {
          logger.warn(`Warmup failed for ${symbol}:`, err);
        });
      })
    ).then(() => {
```

**IMPORTANT:** This requires `loadHistoricalData` to accept an optional second parameter for the target symbol. Check if it already supports this. If not, the simplest alternative is to load warmup for spot symbols first, then after warmup, copy the candle buffer for each spot→perps mapping. See Step 3E.

### 3E. Alternative warmup approach (if loadHistoricalData doesn't support aliasing)

If `loadHistoricalData` only accepts one symbol parameter, replace the warmup section with:

```typescript
    Promise.all(
      activeSymbols.map(symbol =>
        signalProcessor!.loadHistoricalData(symbol).catch(err => {
          logger.warn(`Warmup failed for ${symbol}:`, err);
        })
      )
    ).then(() => {
      logger.info('All symbol warmup attempts completed');

      // Mirror warmup candles from spot to perps symbols
      for (const [spotSym, perpsSym] of activeSpotToPerpsMap.entries()) {
        const spotCandles = signalProcessor!.getCandleBuffer(spotSym);
        if (spotCandles && spotCandles.length > 0) {
          for (const candle of spotCandles) {
            signalProcessor!.addCandle(perpsSym, candle);
          }
          logger.info(`Mirrored ${spotCandles.length} warmup candles from ${spotSym} to ${perpsSym}`);
        }
      }

      runtimeState.warmupComplete = signalProcessor!.isAllWarmedUp();
```

**NOTE:** Check if `signalProcessor.getCandleBuffer(symbol)` exists. If it doesn't, check for an equivalent method like `getCandles()`, `getCandleHistory()`, or the internal buffer. If no public getter exists, add one to SignalProcessor (a simple getter returning the internal candle array for a symbol).

---

## Step 4: Order routing for perps signals (paper mode)

In paper mode, `tradingEngine.createOrder()` already handles any product_id through the PaperSimulator. The risk check, position tracking, and P&L calculation all work with arbitrary symbol strings. **No order routing changes needed for paper mode.**

For live mode (future), perps orders will need to route through `perpsAdapter` instead of the spot exchange. That's a future task — paper trading validates the signal→sizing→order flow first.

**No code changes in this step — it's a verification/confirmation.**

---

## Step 5: Include perps symbols in status/runtime reporting

### 5A. Add perps symbols to the engine start response (around line 1667)

**FIND:**
```typescript
    res.json({
      success: true,
      message: `Trading engine started in ${mode} mode`,
      activeSymbols,
    });
```

**REPLACE WITH:**
```typescript
    res.json({
      success: true,
      message: `Trading engine started in ${mode} mode`,
      activeSymbols,
      perpsSymbols: perpsSymbols,
      spotToPerpsMapping: Object.fromEntries(activeSpotToPerpsMap),
    });
```

---

## Verification Checklist

Run: `node CURSOR_TASKS/verify/verify_003b.js`

### Section 1: Module-scoped perpsAdapter (3 checks)
- [ ] `let perpsAdapter` declared at module scope (near line 258)
- [ ] `perpsAdapter = new CoinbasePerpsAdapter` (assignment, not const declaration)
- [ ] `perpsAdapter = null` in shutdown handler(s)

### Section 2: Dynamic Products List (4 checks)
- [ ] Products array is NOT hardcoded to `['BTC-USD', 'ETH-USD', 'SOL-USD']` in engine config
- [ ] `spotSymbols` derived from `guardrails.per_symbol`
- [ ] `perpsSymbols` derived from `guardrails.perps_symbols`
- [ ] `engineProducts` used in TradingEngineConfig

### Section 3: Spot→Perps Candle Proxy (5 checks)
- [ ] `spotToPerpsMap` or equivalent mapping exists
- [ ] `activeSpotToPerpsMap` declared at module scope
- [ ] `processTickerForCandles` mirrors candles to perps symbols
- [ ] Mirroring calls `signalProcessor.addCandle(perpsSymbol, candle)`
- [ ] Warmup includes perps symbol data (either via proxy load or candle copy)

### Section 4: Status Reporting (2 checks)
- [ ] Engine start response includes `perpsSymbols`
- [ ] Engine start response includes spot→perps mapping

### Section 5: No Regressions (5 checks)
- [ ] Spot candle flow unchanged (addCandle + metricsTracker + broadcast)
- [ ] Signal handler `effectiveRiskPerTrade` logic unchanged
- [ ] `reduce_only` flag on perps close orders unchanged
- [ ] PerpsRiskMonitor lifecycle unchanged
- [ ] Shutdown handlers still clean up all resources

**Total: ~19 checks**

---

## Files Modified Summary

| File | Action | Description |
|------|--------|-------------|
| `api/server.ts` | MODIFY | Hoist perpsAdapter, dynamic products, candle proxy, warmup proxy, status response |
| `strategies/signal-processor.ts` | MAYBE MODIFY | Add `getCandleBuffer()` getter if needed for warmup mirroring |

---

## What NOT To Do

- Do NOT subscribe to INTX products on WebSocket — the ticker channel doesn't support them
- Do NOT add a second WebSocket connection — spot proxy is the standard approach
- Do NOT modify TradingEngine.createOrder() — paper mode already handles any symbol
- Do NOT modify strategies — they work with any symbol string
- Do NOT add REST polling for perps prices — unnecessary complexity at this stage
- Do NOT change guardrails.yaml or Zod schemas
