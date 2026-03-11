# TASK_004 — Startup Resilience: Non-Fatal Perps Init + State Cleanup

**Status:** TODO
**Priority:** CRITICAL — Blocks paper trading entirely
**Depends on:** TASK_003B (complete) ✅
**Estimated checks:** ~15

---

## Context

When starting the paper trading engine, the system crashes because:

1. `CoinbasePerpsAdapter.initialize()` calls `refreshPerpsProducts()` which calls `restClient.getPerpsProducts()`. The `/api/v3/brokerage/products?product_type=FUTURE` endpoint returns **404** (likely due to missing INTX account entitlements or API key permissions). This error propagates up and crashes the entire engine startup.

2. When startup crashes, `tradingEngine` has already been assigned (line 951) but the catch block (line 1718) does NOT null it out. So the next startup attempt hits `if (tradingEngine)` → "Trading engine already running." The user has to manually call the stop endpoint to clear state.

### Why perps product fetch is non-essential in paper mode

- Paper mode uses `PaperSimulator` which handles ANY product_id string
- Signal generation uses spot→perps candle proxy (from TASK_003B) — no perps API needed
- `isPerpsSymbol()` already has a fallback: `symbol.includes('-PERP-')`
- The perps product cache is only used for `getMarketInfo()` which can fall back to parent

### Root Cause Chain

```
POST /api/engine/start
  → tradingEngine = new TradingEngine(...) ← succeeds, state set
  → perpsAdapter = new CoinbasePerpsAdapter(logger)
  → await perpsAdapter.initialize(credentials)
    → await super.initialize(credentials) ← succeeds
    → await this.refreshPerpsProducts()
      → restClient.getPerpsProducts()
        → GET /api/v3/brokerage/products?product_type=FUTURE → 404
        → catch → fallback getProducts()
          → GET /products → succeeds but no PERP products in list
          → empty array returned (not an error)
        OR → catch fails to catch properly → throws
      → products array might be empty (OK) or the call throws (CRASH)
    → CRASH propagates up
  → catch block: logs error, returns 500
  → BUT tradingEngine is still set, perpsAdapter is still set
  → Next start attempt: "Trading engine already running"
```

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** change the engine startup flow order — only add error handling
2. **DO NOT** modify TradingEngine, strategies, or signal processor
3. **DO NOT** touch guardrails, Zod schemas, or config files
4. **DO NOT** remove the perps initialization — just make it non-fatal
5. Keep all changes in `server.ts` and `coinbase-perps-adapter.ts`

---

## Step 1: Make refreshPerpsProducts() non-fatal in the adapter

**File:** `atlas/apps/core-node/src/exchanges/coinbase-perps-adapter.ts`

### 1A. Wrap refreshPerpsProducts call in initialize() with try-catch

**FIND:**
```typescript
  override async initialize(credentials: ExchangeCredentials): Promise<void> {
    await super.initialize(credentials);
    await this.refreshPerpsProducts();
    this.perpsLogger.info(
      `CoinbasePerpsAdapter initialized with ${this.perpsProductCache.size} perps products`,
    );
  }
```

**REPLACE WITH:**
```typescript
  override async initialize(credentials: ExchangeCredentials): Promise<void> {
    await super.initialize(credentials);
    try {
      await this.refreshPerpsProducts();
    } catch (err) {
      this.perpsLogger.warn(
        'Failed to fetch perps products — continuing with empty product cache. ' +
        'isPerpsSymbol() will use string matching fallback. ' +
        'This is expected if INTX is not enabled on this API key.',
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    this.perpsLogger.info(
      `CoinbasePerpsAdapter initialized with ${this.perpsProductCache.size} perps products`,
    );
  }
```

### 1B. Also harden refreshPerpsProducts itself

**FIND:**
```typescript
  async refreshPerpsProducts(): Promise<void> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getPerpsProducts) {
      this.perpsLogger.warn('REST client does not support getPerpsProducts — no perps available');
      return;
    }
    const products: CoinbasePerpsProduct[] = await restClient.getPerpsProducts();
    this.perpsProductCache.clear();
    for (const p of products) {
      this.perpsProductCache.set(p.product_id, p);
    }
  }
```

**REPLACE WITH:**
```typescript
  async refreshPerpsProducts(): Promise<void> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getPerpsProducts) {
      this.perpsLogger.warn('REST client does not support getPerpsProducts — no perps available');
      return;
    }
    try {
      const products: CoinbasePerpsProduct[] = await restClient.getPerpsProducts();
      this.perpsProductCache.clear();
      for (const p of products) {
        this.perpsProductCache.set(p.product_id, p);
      }
    } catch (err) {
      this.perpsLogger.warn('refreshPerpsProducts failed — perps product cache will be empty', {
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't clear existing cache if refresh fails (preserves data from previous successful fetch)
    }
  }
```

---

## Step 2: Add state cleanup on engine startup failure

**File:** `atlas/apps/core-node/src/api/server.ts`

### 2A. Add cleanup in the catch block of the engine start handler

**FIND the catch block (around line 1718):**
```typescript
  } catch (error) {
    const errorDetails = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : typeof error,
    };
    logger.error('Failed to start trading engine:', errorDetails);
    res.status(500).json({ error: 'Failed to start trading engine', details: errorDetails });
  } finally {
    engineOperationInProgress = false;
  }
```

**REPLACE WITH:**
```typescript
  } catch (error) {
    const errorDetails = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      name: error instanceof Error ? error.name : typeof error,
    };
    logger.error('Failed to start trading engine:', errorDetails);

    // Clean up partially-initialized state so next start attempt works
    try {
      if (perpsRiskMonitor) {
        perpsRiskMonitor.stop();
        perpsRiskMonitor.removeAllListeners();
        perpsRiskMonitor = null;
      }
      if (tradingEngine) {
        tradingEngine.removeAllListeners();
        tradingEngine = null;
      }
      perpsAdapter = null;
      activeSpotToPerpsMap = new Map();
      if (signalProcessor) {
        signalProcessor = null;
      }
      engineRunningGauge.set(0);
      logger.info('Cleaned up partial engine state after startup failure');
    } catch (cleanupErr) {
      logger.error('Error during startup failure cleanup:', cleanupErr);
    }

    res.status(500).json({ error: 'Failed to start trading engine', details: errorDetails });
  } finally {
    engineOperationInProgress = false;
  }
```

**IMPORTANT NOTE:** Check if `signalProcessor` is also assigned before the failure point. Look at where `signalProcessor` is set in the startup flow. If it's set before `perpsAdapter.initialize()`, it needs to be cleaned up too. If `signalProcessor` assignment happens after the perps init, it won't be set at the point of failure, so nulling it is harmless.

Also check if `metricsTracker` is set during startup and needs cleanup — but `metricsTracker` is typically module-scoped and reusable, so it probably doesn't need nulling.

---

## Step 3: Harden leverage initialization (already in server.ts)

The leverage init block (around line 953-967) calls `perpsAdapter.setLeverage()` with `.catch()` — this is already non-fatal. No changes needed.

**Verification only — no code changes.**

---

## Step 4: Harden getPerpsProducts fallback in rest-client.ts

**File:** `atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts`

The `getPerpsProducts()` method already has a try-catch with fallback, but the fallback itself can throw if `getProducts()` fails.

### 4A. Double-wrap the fallback

**FIND:**
```typescript
  public async getPerpsProducts(): Promise<CoinbasePerpsProduct[]> {
    try {
      const response = await this.client.get('/api/v3/brokerage/products', {
        params: {
          product_type: 'FUTURE',
          contract_expiry_type: 'PERPETUAL',
        },
      });
      const products = response.data?.products || response.data || [];
      return products.filter((p: any) =>
        p.product_type === 'FUTURE' && (p.contract_expiry_type === 'PERPETUAL' || p.product_id?.includes('-PERP-'))
      );
    } catch (error) {
      this.logger.warn('Failed to fetch perps products via v3 endpoint, falling back to product list filter');
      const allProducts = await this.getProducts();
      return allProducts
        .filter((p: any) => p.product_id?.includes('-PERP-') || p.product_type === 'FUTURE')
        .map((p: any) => ({
          product_id: p.product_id || p.id,
          product_type: 'FUTURE' as const,
          contract_expiry_type: 'PERPETUAL' as const,
          base_currency: p.base_currency || p.product_id?.split('-')[0] || '',
          quote_currency: p.quote_currency || 'USD',
          contract_size: p.contract_size || '0.01',
          max_leverage: p.max_leverage || '10',
          base_increment: p.base_increment || '0.01',
          quote_increment: p.quote_increment || '0.01',
          status: p.status || 'online',
          trading_disabled: p.trading_disabled || false,
        }));
    }
  }
```

**REPLACE WITH:**
```typescript
  public async getPerpsProducts(): Promise<CoinbasePerpsProduct[]> {
    try {
      const response = await this.client.get('/api/v3/brokerage/products', {
        params: {
          product_type: 'FUTURE',
          contract_expiry_type: 'PERPETUAL',
        },
      });
      const products = response.data?.products || response.data || [];
      return products.filter((p: any) =>
        p.product_type === 'FUTURE' && (p.contract_expiry_type === 'PERPETUAL' || p.product_id?.includes('-PERP-'))
      );
    } catch (error) {
      this.logger.warn('Failed to fetch perps products via v3 endpoint, falling back to product list filter');
      try {
        const allProducts = await this.getProducts();
        return allProducts
          .filter((p: any) => p.product_id?.includes('-PERP-') || p.product_type === 'FUTURE')
          .map((p: any) => ({
            product_id: p.product_id || p.id,
            product_type: 'FUTURE' as const,
            contract_expiry_type: 'PERPETUAL' as const,
            base_currency: p.base_currency || p.product_id?.split('-')[0] || '',
            quote_currency: p.quote_currency || 'USD',
            contract_size: p.contract_size || '0.01',
            max_leverage: p.max_leverage || '10',
            base_increment: p.base_increment || '0.01',
            quote_increment: p.quote_increment || '0.01',
            status: p.status || 'online',
            trading_disabled: p.trading_disabled || false,
          }));
      } catch (fallbackError) {
        this.logger.warn('Fallback product list fetch also failed — returning empty perps list', {
          primaryError: error instanceof Error ? error.message : String(error),
          fallbackError: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
        });
        return [];
      }
    }
  }
```

---

## Verification Checklist

Run: `node CURSOR_TASKS/verify/verify_004.js`

### Section 1: Non-Fatal Perps Init (4 checks)
- [ ] `refreshPerpsProducts` wrapped in try-catch inside `initialize()`
- [ ] `refreshPerpsProducts` itself has inner try-catch
- [ ] `initialize()` always completes even if perps products fetch fails
- [ ] Warning log mentions "INTX" or "perps products" on failure

### Section 2: Engine State Cleanup (5 checks)
- [ ] Catch block in engine start handler nulls `tradingEngine`
- [ ] Catch block nulls `perpsAdapter`
- [ ] Catch block nulls/stops `perpsRiskMonitor`
- [ ] Catch block resets `activeSpotToPerpsMap`
- [ ] Catch block sets `engineRunningGauge` to 0

### Section 3: REST Client Hardening (3 checks)
- [ ] `getPerpsProducts` fallback wrapped in its own try-catch
- [ ] Returns empty array if both primary and fallback fail
- [ ] Warning log includes both primary and fallback error info

### Section 4: No Regressions (4 checks)
- [ ] `perpsAdapter.initialize()` still called in startup flow
- [ ] Spot candle flow unchanged
- [ ] `effectiveRiskPerTrade` logic unchanged
- [ ] Shutdown handlers still clean up all resources

**Total: ~16 checks**

---

## Files Modified Summary

| File | Action | Description |
|------|--------|-------------|
| `exchanges/coinbase-perps-adapter.ts` | MODIFY | Wrap refreshPerpsProducts in try-catch in initialize() + harden refreshPerpsProducts |
| `exchanges/coinbase/rest-client.ts` | MODIFY | Double-wrap getPerpsProducts fallback |
| `api/server.ts` | MODIFY | Add state cleanup in engine start catch block |

---

## What NOT To Do

- Do NOT skip the perps adapter initialization entirely — it still provides useful market info when the API works
- Do NOT change the engine startup order — just add error handling
- Do NOT modify TradingEngine, strategies, signal processor, or risk monitor
- Do NOT change guardrails, Zod schemas, or config
- Do NOT add retries to the perps product fetch — if INTX isn't enabled, retries won't help
