# TASK_002A — Extend CoinbaseAdapter for Perpetual Futures

**Status:** TODO
**Priority:** CRITICAL — Foundation for all perps trading
**Depends on:** TASK_001 (exchange abstraction layer) ✅
**Estimated checks:** ~80

---

## Context

Coinbase Advanced Trade API supports perpetual futures (BTC-PERP-INTX, ETH-PERP-INTX) through the **same REST and WebSocket endpoints** used for spot. The key differences:

- Perp products have `product_type: 'FUTURE'` and `contract_expiry_type: 'PERPETUAL'`
- Perp product IDs follow format: `{BASE}-PERP-INTX` (e.g., `BTC-PERP-INTX`, `ETH-PERP-INTX`)
- Nano contracts: 1/100th of underlying (e.g., 1 BTC-PERP-INTX contract = 0.01 BTC)
- Positions, leverage, and funding rates use INTX-specific endpoints
- Fees: 0% maker / 0.03% taker (much lower than spot)
- Leverage: up to 10x intraday

This task adds **perps-specific REST endpoints** to the Coinbase client layer and extends the **CoinbaseAdapter** to detect and handle perpetual futures products.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** modify the existing `IExchangeAdapter` interface in `types.ts` — we extend it with a new optional interface
2. **DO NOT** break existing spot trading — all changes must be backward compatible
3. **DO NOT** touch `CoinbaseExchange` internal logic (index.ts) — add perps methods to the REST client and wrap them in the adapter
4. **ALL new files** must have JSDoc comments on every exported function/class/interface
5. **ALL string numbers** — financial values are strings to avoid floating point errors
6. Follow existing code patterns exactly (see rest-client.ts for API call patterns)

---

## Step 1: Add Perps Types to `coinbase/types.ts`

**File:** `atlas/apps/core-node/src/exchanges/coinbase/types.ts`
**Action:** APPEND the following types at the end of the file (after line 158)

```typescript
// ============ Perpetual Futures Types ============

/** Coinbase perpetual futures product metadata */
export interface CoinbasePerpsProduct {
  product_id: string;                    // e.g., 'BTC-PERP-INTX'
  product_type: 'FUTURE';
  contract_expiry_type: 'PERPETUAL';
  base_currency: string;                 // e.g., 'BTC'
  quote_currency: string;                // e.g., 'USD'
  contract_size: string;                 // e.g., '0.01' for nano contracts
  max_leverage: string;                  // e.g., '10'
  base_increment: string;
  quote_increment: string;
  status: string;
  trading_disabled: boolean;
}

/** Coinbase INTX position from /api/v3/brokerage/intx/positions */
export interface CoinbaseIntxPosition {
  product_id: string;                    // e.g., 'BTC-PERP-INTX'
  side: 'LONG' | 'SHORT' | 'UNKNOWN';
  number_of_contracts: string;
  avg_entry_price: string;
  current_price: string;                 // mark price
  unrealized_pnl: string;
  liquidation_price?: string;
  margin_type?: string;
  leverage?: string;
  margin_used?: string;
}

/** Coinbase INTX portfolio summary */
export interface CoinbaseIntxPortfolio {
  portfolio_uuid: string;
  collateral: string;                    // total collateral in USD
  unrealized_pnl: string;
  buying_power: string;
  margin_used: string;
  max_withdrawal: string;
}

/** Funding rate data for a perpetual contract */
export interface CoinbaseFundingRate {
  product_id: string;
  funding_rate: string;                  // decimal (e.g., '0.0001' = 0.01%)
  funding_time: string;                  // ISO timestamp of next settlement
  mark_price: string;
  index_price: string;
}

/** Leverage setting request */
export interface CoinbaseLeverageRequest {
  product_id: string;
  leverage: string;                      // e.g., '3'
}
```

---

## Step 2: Add Perps REST Endpoints to `coinbase/rest-client.ts`

**File:** `atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts`
**Action:** ADD the following methods to the `CoinbaseRestClient` class, BEFORE the `// Rate limit info` comment (before the `getRateLimitInfo()` method).

Also add the new type imports at the top of the file. Update the import statement on lines 4-15 to include the new types:

```typescript
import {
  CoinbaseConfig,
  CoinbaseCredentials,
  CoinbaseOrder,
  OrderRequest,
  Fill,
  Account,
  Product,
  Candle,
  HistoricRatesParams,
  RateLimitInfo,
  CoinbasePerpsProduct,
  CoinbaseIntxPosition,
  CoinbaseIntxPortfolio,
  CoinbaseFundingRate,
  CoinbaseLeverageRequest,
} from './types';
```

Then add these methods to the class body:

```typescript
  // ============ Perpetual Futures Endpoints ============

  /**
   * List all perpetual futures products.
   * Uses the standard products endpoint with product_type=FUTURE filter.
   * Falls back to filtering the full product list if the filter param isn't supported.
   */
  public async getPerpsProducts(): Promise<CoinbasePerpsProduct[]> {
    try {
      // Try Coinbase Advanced Trade v3 endpoint with filter
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
      // Fallback: fetch all products and filter
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

  /**
   * Get all INTX (perpetual futures) positions for the portfolio.
   * Returns open positions with PnL, leverage, and liquidation data.
   */
  public async getIntxPositions(): Promise<CoinbaseIntxPosition[]> {
    try {
      const response = await this.client.get('/api/v3/brokerage/intx/positions');
      return response.data?.positions || response.data || [];
    } catch (error) {
      this.logger.warn('Failed to fetch INTX positions:', error);
      return [];
    }
  }

  /**
   * Get a specific INTX position by product ID.
   */
  public async getIntxPosition(productId: string): Promise<CoinbaseIntxPosition | null> {
    try {
      const response = await this.client.get(`/api/v3/brokerage/intx/positions/${productId}`);
      return response.data?.position || response.data || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch INTX position for ${productId}:`, error);
      return null;
    }
  }

  /**
   * Get INTX portfolio summary (collateral, margin, buying power).
   */
  public async getIntxPortfolio(): Promise<CoinbaseIntxPortfolio | null> {
    try {
      const response = await this.client.get('/api/v3/brokerage/intx/portfolio');
      return response.data?.portfolio || response.data || null;
    } catch (error) {
      this.logger.warn('Failed to fetch INTX portfolio:', error);
      return null;
    }
  }

  /**
   * Get current funding rate for a perpetual contract.
   * Funding accrues hourly, settles twice daily on Coinbase.
   */
  public async getFundingRate(productId: string): Promise<CoinbaseFundingRate | null> {
    try {
      // Try the product-specific funding endpoint
      const response = await this.client.get(`/api/v3/brokerage/products/${productId}/funding`, {});
      return response.data || null;
    } catch (error) {
      this.logger.warn(`Failed to fetch funding rate for ${productId}:`, error);
      return null;
    }
  }

  /**
   * Set leverage for a perpetual futures product.
   * Leverage is per-product, not per-position.
   * Max leverage: 10x intraday on Coinbase.
   */
  public async setLeverage(productId: string, leverage: number): Promise<boolean> {
    try {
      await this.client.post('/api/v3/brokerage/intx/leverage', {
        product_id: productId,
        leverage: String(leverage),
      });
      this.logger.info(`Leverage set to ${leverage}x for ${productId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to set leverage for ${productId}:`, error);
      return false;
    }
  }
```

---

## Step 3: Add Perps-Capable Adapter Interface to `exchanges/types.ts`

**File:** `atlas/apps/core-node/src/exchanges/types.ts`
**Action:** APPEND after the `IExchangeAdapter` interface closing brace (after line 222)

```typescript

// ============ Perpetual Futures Extension ============

/** Funding rate snapshot for a perpetual contract */
export interface AdapterFundingRate {
  symbol: string;
  rate: string;                          // decimal (e.g., '0.0001' = 1 bps)
  nextSettlement: number;                // unix ms
  markPrice: string;
  indexPrice: string;
}

/** Portfolio margin summary for perpetual trading */
export interface AdapterPortfolioSummary {
  totalCollateral: string;               // USD value
  unrealizedPnl: string;
  buyingPower: string;
  marginUsed: string;
  maxWithdrawal: string;
}

/**
 * Extension interface for exchanges that support perpetual futures.
 * Adapters that handle perps implement BOTH IExchangeAdapter AND IPerpsAdapter.
 * Use `isPerpsAdapter(adapter)` type guard to check capability at runtime.
 */
export interface IPerpsAdapter {
  /** Get current funding rate for a perpetual contract */
  getFundingRate(symbol: string): Promise<AdapterFundingRate | null>;

  /** Set leverage for a symbol. Returns true on success. */
  setLeverage(symbol: string, leverage: number): Promise<boolean>;

  /** Get current leverage for a symbol. Returns null if not set. */
  getLeverage(symbol: string): Promise<number | null>;

  /** Get portfolio margin summary (collateral, buying power, etc.) */
  getPortfolioSummary(): Promise<AdapterPortfolioSummary | null>;

  /** List all available perpetual futures symbols */
  getPerpsSymbols(): Promise<string[]>;

  /** Check if a symbol is a perpetual futures contract */
  isPerpsSymbol(symbol: string): boolean;
}

/**
 * Type guard to check if an adapter supports perpetual futures.
 * Usage: if (isPerpsAdapter(adapter)) { adapter.getFundingRate('BTC-PERP-INTX'); }
 */
export function isPerpsAdapter(adapter: IExchangeAdapter): adapter is IExchangeAdapter & IPerpsAdapter {
  return (
    'getFundingRate' in adapter &&
    'setLeverage' in adapter &&
    'getPerpsSymbols' in adapter &&
    typeof (adapter as any).getFundingRate === 'function'
  );
}
```

---

## Step 4: Create `CoinbasePerpsAdapter` in New File

**File:** `atlas/apps/core-node/src/exchanges/coinbase-perps-adapter.ts` (NEW FILE)

This adapter extends the existing `CoinbaseAdapter` for perpetual futures trading. It inherits all spot functionality and adds perps-specific methods.

```typescript
/**
 * CoinbasePerpsAdapter — extends CoinbaseAdapter for perpetual futures.
 *
 * Inherits all spot trading capabilities from CoinbaseAdapter and adds:
 * - Perpetual futures position tracking (real positions, not empty array)
 * - Funding rate queries
 * - Leverage management
 * - Portfolio margin summary
 * - Perps product detection and filtering
 *
 * Registered as 'coinbase-perps' in the ExchangeRegistry alongside
 * the spot 'coinbase' adapter. Both share the same underlying CoinbaseExchange.
 */

import { Logger } from '../core/logger';
import { CoinbaseExchange } from './coinbase';
import {
  CoinbasePerpsProduct,
  CoinbaseIntxPosition,
} from './coinbase/types';
import { CoinbaseAdapter } from './coinbase-adapter';
import {
  ExchangeCredentials,
  ExchangeType,
  AdapterPosition,
  AdapterMarketInfo,
  AdapterFundingRate,
  AdapterPortfolioSummary,
  IPerpsAdapter,
} from './types';

export class CoinbasePerpsAdapter extends CoinbaseAdapter implements IPerpsAdapter {
  override readonly id = 'coinbase-perps';
  override readonly name = 'Coinbase Perpetual Futures';
  override readonly exchangeType: ExchangeType = 'perpetual';

  private perpsProductCache: Map<string, CoinbasePerpsProduct> = new Map();
  private leverageCache: Map<string, number> = new Map();
  private logger: Logger;

  constructor(logger: Logger) {
    super(logger);
    this.logger = logger;
  }

  // ---- Lifecycle Override ----

  /**
   * Initialize and cache available perps products.
   * Calls parent initialize() first, then loads perps product list.
   */
  override async initialize(credentials: ExchangeCredentials): Promise<void> {
    await super.initialize(credentials);
    await this.refreshPerpsProducts();
    this.logger.info(
      `CoinbasePerpsAdapter initialized with ${this.perpsProductCache.size} perps products`
    );
  }

  // ---- Perps Product Detection ----

  /**
   * Refresh the cached list of available perpetual futures products.
   * Called on init and can be called periodically to pick up new listings.
   */
  async refreshPerpsProducts(): Promise<void> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getPerpsProducts) {
      this.logger.warn('REST client does not support getPerpsProducts — no perps available');
      return;
    }
    const products: CoinbasePerpsProduct[] = await restClient.getPerpsProducts();
    this.perpsProductCache.clear();
    for (const p of products) {
      this.perpsProductCache.set(p.product_id, p);
    }
  }

  /** Check if a symbol is a perpetual futures contract */
  isPerpsSymbol(symbol: string): boolean {
    return this.perpsProductCache.has(symbol) || symbol.includes('-PERP-');
  }

  /** List all available perpetual futures symbols */
  async getPerpsSymbols(): Promise<string[]> {
    if (this.perpsProductCache.size === 0) {
      await this.refreshPerpsProducts();
    }
    return Array.from(this.perpsProductCache.keys());
  }

  // ---- Positions Override (real perps positions) ----

  /**
   * Get open perpetual futures positions from INTX API.
   * Overrides the spot adapter's empty array return.
   */
  override async getPositions(): Promise<AdapterPosition[]> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getIntxPositions) {
      return [];
    }

    const positions: CoinbaseIntxPosition[] = await restClient.getIntxPositions();
    return positions
      .filter((p) => parseFloat(p.number_of_contracts) !== 0)
      .map((p) => this.mapIntxPosition(p));
  }

  // ---- Funding Rate ----

  /**
   * Get current funding rate for a perpetual contract.
   * Funding accrues hourly, settles twice daily on Coinbase.
   */
  async getFundingRate(symbol: string): Promise<AdapterFundingRate | null> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getFundingRate) {
      return null;
    }

    const rate = await restClient.getFundingRate(symbol);
    if (!rate) return null;

    return {
      symbol: rate.product_id,
      rate: rate.funding_rate,
      nextSettlement: new Date(rate.funding_time).getTime(),
      markPrice: rate.mark_price,
      indexPrice: rate.index_price,
    };
  }

  // ---- Leverage Management ----

  /**
   * Set leverage for a perpetual futures symbol.
   * Caches the setting locally for getLeverage() queries.
   */
  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    if (leverage < 1 || leverage > 10) {
      this.logger.error(`Invalid leverage ${leverage} for ${symbol}. Must be 1-10.`);
      return false;
    }

    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.setLeverage) {
      this.logger.warn('REST client does not support setLeverage');
      return false;
    }

    const success = await restClient.setLeverage(symbol, leverage);
    if (success) {
      this.leverageCache.set(symbol, leverage);
      this.logger.info(`Leverage set to ${leverage}x for ${symbol}`);
    }
    return success;
  }

  /**
   * Get current leverage for a symbol.
   * Returns cached value or null if not set.
   */
  async getLeverage(symbol: string): Promise<number | null> {
    return this.leverageCache.get(symbol) ?? null;
  }

  // ---- Portfolio Summary ----

  /**
   * Get portfolio margin summary (collateral, buying power, margin usage).
   */
  async getPortfolioSummary(): Promise<AdapterPortfolioSummary | null> {
    const exchange = this.getUnderlyingExchange();
    const restClient = (exchange as any).restClient;
    if (!restClient?.getIntxPortfolio) {
      return null;
    }

    const portfolio = await restClient.getIntxPortfolio();
    if (!portfolio) return null;

    return {
      totalCollateral: portfolio.collateral,
      unrealizedPnl: portfolio.unrealized_pnl,
      buyingPower: portfolio.buying_power,
      marginUsed: portfolio.margin_used,
      maxWithdrawal: portfolio.max_withdrawal,
    };
  }

  // ---- Market Info Override (perps-aware) ----

  /**
   * Override getMarketInfo to return perps-specific data when symbol is a perp.
   */
  override async getMarketInfo(symbol: string): Promise<AdapterMarketInfo> {
    if (this.isPerpsSymbol(symbol)) {
      const product = this.perpsProductCache.get(symbol);
      if (product) {
        return {
          symbol: product.product_id,
          baseCurrency: product.base_currency,
          quoteCurrency: product.quote_currency,
          minOrderSize: product.contract_size,    // 1 nano contract
          maxOrderSize: '10000',                  // platform limit
          tickSize: product.quote_increment,
          stepSize: product.base_increment,
          makerFee: '0.0000',                     // 0% maker on perps
          takerFee: '0.0003',                     // 0.03% taker on perps
          exchangeType: 'perpetual',
          maxLeverage: parseInt(product.max_leverage) || 10,
        };
      }
    }
    // Fall through to spot for non-perps symbols
    return super.getMarketInfo(symbol);
  }

  // ---- Internal Mapping ----

  private mapIntxPosition(p: CoinbaseIntxPosition): AdapterPosition {
    const contracts = parseFloat(p.number_of_contracts);
    return {
      symbol: p.product_id,
      side: p.side === 'LONG' ? 'buy' : p.side === 'SHORT' ? 'sell' : (contracts > 0 ? 'buy' : 'sell'),
      size: String(Math.abs(contracts)),
      entryPrice: p.avg_entry_price,
      markPrice: p.current_price,
      unrealizedPnl: p.unrealized_pnl,
      liquidationPrice: p.liquidation_price,
      leverage: p.leverage ? parseFloat(p.leverage) : undefined,
      marginUsed: p.margin_used,
    };
  }
}
```

---

## Step 5: Update Barrel Exports in `exchanges/index.ts`

**File:** `atlas/apps/core-node/src/exchanges/index.ts`
**Action:** REPLACE the entire file contents with:

```typescript
// Universal exchange adapter types
export * from './types';

// Exchange registry
export { ExchangeRegistry } from './exchange-registry';

// Adapters
export { CoinbaseAdapter } from './coinbase-adapter';
export { CoinbasePerpsAdapter } from './coinbase-perps-adapter';

// Re-export coinbase internals for backward compatibility
export { CoinbaseExchange } from './coinbase';
```

---

## Step 6: Update `coinbase/index.ts` to Re-export Perps Types

**File:** `atlas/apps/core-node/src/exchanges/coinbase/index.ts`
**Action:** The `export * from './types';` on line 20 already exports everything from types.ts, so the new perps types will be automatically available. **No changes needed here** — just verify that `export * from './types'` is present.

---

## Verification Checklist

After implementation, run `node CURSOR_TASKS/verify/verify_002a.js` from the project root.

The script checks:

### Section 1: Coinbase Types (7 checks)
- [ ] `CoinbasePerpsProduct` interface exists in `coinbase/types.ts`
- [ ] `CoinbaseIntxPosition` interface exists with `number_of_contracts` field
- [ ] `CoinbaseIntxPortfolio` interface exists with `collateral` field
- [ ] `CoinbaseFundingRate` interface exists with `funding_rate` field
- [ ] `CoinbaseLeverageRequest` interface exists
- [ ] `CoinbasePerpsProduct` has `product_type: 'FUTURE'`
- [ ] `CoinbasePerpsProduct` has `contract_expiry_type: 'PERPETUAL'`

### Section 2: REST Client Endpoints (6 checks)
- [ ] `getPerpsProducts` method exists in rest-client.ts
- [ ] `getIntxPositions` method exists in rest-client.ts
- [ ] `getIntxPosition` method exists in rest-client.ts
- [ ] `getIntxPortfolio` method exists in rest-client.ts
- [ ] `getFundingRate` method exists in rest-client.ts
- [ ] `setLeverage` method exists in rest-client.ts

### Section 3: Adapter Types (6 checks)
- [ ] `AdapterFundingRate` interface exists in `exchanges/types.ts`
- [ ] `AdapterPortfolioSummary` interface exists in `exchanges/types.ts`
- [ ] `IPerpsAdapter` interface exists in `exchanges/types.ts`
- [ ] `isPerpsAdapter` function exists in `exchanges/types.ts`
- [ ] `IPerpsAdapter` has `getFundingRate` method
- [ ] `IPerpsAdapter` has `setLeverage` method
- [ ] `IPerpsAdapter` has `getPerpsSymbols` method
- [ ] `IPerpsAdapter` has `getLeverage` method
- [ ] `IPerpsAdapter` has `getPortfolioSummary` method
- [ ] `IPerpsAdapter` has `isPerpsSymbol` method

### Section 4: CoinbasePerpsAdapter (15 checks)
- [ ] File `coinbase-perps-adapter.ts` exists
- [ ] Class extends `CoinbaseAdapter`
- [ ] Class implements `IPerpsAdapter`
- [ ] `id` is `'coinbase-perps'`
- [ ] `name` is `'Coinbase Perpetual Futures'`
- [ ] `exchangeType` is `'perpetual'`
- [ ] `getPositions()` method exists and does NOT return `[]` unconditionally
- [ ] `getFundingRate()` method exists
- [ ] `setLeverage()` method exists with validation (1-10)
- [ ] `getLeverage()` method exists
- [ ] `getPortfolioSummary()` method exists
- [ ] `getPerpsSymbols()` method exists
- [ ] `isPerpsSymbol()` method exists
- [ ] `refreshPerpsProducts()` method exists
- [ ] `getMarketInfo()` override returns perps fees (0.0000 maker, 0.0003 taker)

### Section 5: Barrel Exports (3 checks)
- [ ] `CoinbasePerpsAdapter` exported from `exchanges/index.ts`
- [ ] `isPerpsAdapter` exported from `exchanges/index.ts` (via `export * from './types'`)
- [ ] `IPerpsAdapter` exported from `exchanges/index.ts` (via `export * from './types'`)

### Section 6: No Regressions (5 checks)
- [ ] `CoinbaseAdapter` still has `id = 'coinbase'`
- [ ] `CoinbaseAdapter` still has `exchangeType = 'spot'`
- [ ] `CoinbaseAdapter.getPositions()` still returns `[]`
- [ ] `IExchangeAdapter` interface is unchanged (still 222 lines or same method count)
- [ ] `ExchangeRegistry` is unchanged

### Section 7: Import Integrity (4 checks)
- [ ] `coinbase-perps-adapter.ts` imports from `./coinbase-adapter`
- [ ] `coinbase-perps-adapter.ts` imports from `./types`
- [ ] `coinbase-perps-adapter.ts` imports from `./coinbase/types`
- [ ] `rest-client.ts` imports new types from `./types`

**Total: ~56 checks**

---

## Files Created/Modified Summary

| File | Action | Description |
|------|--------|-------------|
| `exchanges/coinbase/types.ts` | MODIFY | Add 5 perps-specific interfaces |
| `exchanges/coinbase/rest-client.ts` | MODIFY | Add 6 perps REST methods + imports |
| `exchanges/types.ts` | MODIFY | Add `IPerpsAdapter`, `AdapterFundingRate`, `AdapterPortfolioSummary`, `isPerpsAdapter` |
| `exchanges/coinbase-perps-adapter.ts` | CREATE | New perps adapter extending CoinbaseAdapter |
| `exchanges/index.ts` | MODIFY | Add `CoinbasePerpsAdapter` export |

---

## What NOT To Do

- Do NOT add perps logic to `CoinbaseAdapter` directly — it stays as the spot adapter
- Do NOT modify `IExchangeAdapter` — perps methods go in `IPerpsAdapter`
- Do NOT change the constructor signature of `CoinbaseExchange`
- Do NOT add mock data or test fixtures — this is production code
- Do NOT modify `exchange-registry.ts` — registration happens at the engine level
- Do NOT touch the `trading/order-manager.ts` — that's TASK_002D
