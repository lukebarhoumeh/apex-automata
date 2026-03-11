# TASK_002D — Strategy Layer Wiring for Perpetual Futures

**Status:** TODO
**Priority:** HIGH — Final integration task
**Depends on:** TASK_002A (perps adapter), TASK_002B (guardrails), TASK_002C (risk module)
**Estimated checks:** ~35

---

## Context

TASK_002A created the CoinbasePerpsAdapter, TASK_002B updated guardrails, TASK_002C built the risk monitor. This final task **wires everything together** in the signal handling pipeline inside `server.ts`.

Currently, the signal handler in `server.ts` (around line 1367) has:
- `shortAllowed` check that treats sell signals as "exit long" when shorts are disabled
- A funding bias stub: `logger.debug('Funding bias guardrail enabled (spot mode stub) - no action taken')`
- Entry sizing that uses `tradingEngine.computeOrderSize()` with spot risk_per_trade

With perps enabled (`allow_short: true`), the logic changes:
1. Sell signals on flat positions → open SHORT (not ignore)
2. Sell signals on long positions → still close the long first
3. Funding bias stub → real funding rate check via PerpsRiskMonitor
4. Position sizing → uses perps `risk_per_trade: 0.015` for perps symbols
5. PerpsRiskMonitor is instantiated and started alongside the trading engine

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** rewrite the entire signal handler — make SURGICAL changes
2. **DO NOT** remove the `shortAllowed` variable — it's now `true` from guardrails
3. **DO NOT** change any strategy files (momentum, trend_follow plugins) — they already generate buy/sell signals
4. **DO NOT** modify the existing entry order path for spot — perps changes are ADDITIONAL logic
5. Changes to `server.ts` must be minimal and clearly commented
6. **JSDoc** on any new functions added

---

## Step 1: Register CoinbasePerpsAdapter in Engine Startup

**File:** `atlas/apps/core-node/src/api/server.ts`

Find the section where the CoinbaseAdapter and ExchangeRegistry are set up. This is typically in the engine initialization block. Search for `ExchangeRegistry` or `CoinbaseAdapter` in the file.

**ADD** after the spot adapter registration (after the line that registers the CoinbaseAdapter with the registry):

```typescript
// Register perps adapter (shares underlying exchange connection)
import { CoinbasePerpsAdapter } from '../exchanges/coinbase-perps-adapter';

// ... in the engine init block, after spot adapter registration:
const perpsAdapter = new CoinbasePerpsAdapter(logger);
await perpsAdapter.initialize(credentials);
exchangeRegistry.register(perpsAdapter);
logger.info('Coinbase Perps adapter registered');
```

If the imports section already has exchange imports, add `CoinbasePerpsAdapter` there. If there's no explicit registry setup yet (the registry was just created in TASK_001), add the full registration block.

---

## Step 2: Initialize PerpsRiskMonitor

**File:** `atlas/apps/core-node/src/api/server.ts`

**ADD** import at the top of the file with other imports:

```typescript
import { PerpsRiskMonitor } from '../trading/perps';
```

**ADD** after the perps adapter registration from Step 1:

```typescript
// Initialize perps risk monitor
const perpsConfig = guardrails.perps;
let perpsRiskMonitor: PerpsRiskMonitor | null = null;
if (perpsConfig) {
  perpsRiskMonitor = new PerpsRiskMonitor(
    {
      riskPerTrade: perpsConfig.risk_per_trade,
      defaultLeverage: perpsConfig.default_leverage,
      maxLeverage: perpsConfig.max_leverage,
      liquidationBufferPct: perpsConfig.liquidation_buffer_pct,
      maxFundingRateBps: perpsConfig.max_funding_rate_bps,
      fundingCheckIntervalSec: perpsConfig.funding_check_interval_sec,
      makerFee: perpsConfig.maker_fee,
      takerFee: perpsConfig.taker_fee,
      nanoContractSize: perpsConfig.nano_contract_size,
    },
    logger
  );
  perpsRiskMonitor.setAdapter(perpsAdapter);
  perpsRiskMonitor.start();
  logger.info('Perps risk monitor started');

  // Wire risk events to engine-level handling
  perpsRiskMonitor.on('perps:liquidation_warning', (risk) => {
    logger.warn('LIQUIDATION WARNING', { symbol: risk.symbol, distance: risk.liquidationDistance });
  });

  perpsRiskMonitor.on('perps:leverage_warning', (summary) => {
    logger.warn('LEVERAGE WARNING', { effectiveLeverage: summary.effectiveLeverage, max: summary.maxLeverage });
  });
}
```

---

## Step 3: Update Signal Handler for Perps-Aware Shorting

**File:** `atlas/apps/core-node/src/api/server.ts`

### 3A. Update the funding bias stub

**FIND** (around line 1461-1463):
```typescript
        if (guardrails.filters.funding_bias_enabled) {
          logger.debug('Funding bias guardrail enabled (spot mode stub) - no action taken');
        }
```

**REPLACE WITH:**
```typescript
        // Funding bias guardrail — check if funding rate is excessive for perps symbols
        if (guardrails.filters.funding_bias_enabled && perpsRiskMonitor) {
          const riskSummary = perpsRiskMonitor.getLastSummary();
          if (riskSummary && riskSummary.positionsWithHighFunding.includes(signal.symbol)) {
            logger.info('Signal filtered by funding bias guardrail', {
              symbol: signal.symbol,
              direction: signal.direction,
              reason: 'excessive_funding_rate',
            });
            return;
          }
        }
```

### 3B. Update position sizing to use perps risk_per_trade for perps symbols

**FIND** (around line 1465):
```typescript
        const rawSize = tradingEngine!.computeOrderSize(signal.symbol, entryPrice, stopPrice);
```

**REPLACE WITH:**
```typescript
        // Use perps risk_per_trade for perpetual symbols, spot risk for others
        const isPerpsSymbol = signal.symbol.includes('-PERP-');
        const effectiveRiskPerTrade = isPerpsSymbol && guardrails.perps
          ? guardrails.perps.risk_per_trade
          : guardrails.account.risk_per_trade;
        const rawSize = isPerpsSymbol && guardrails.perps
          ? tradingEngine!.computeOrderSize(signal.symbol, entryPrice, stopPrice, effectiveRiskPerTrade)
          : tradingEngine!.computeOrderSize(signal.symbol, entryPrice, stopPrice);
```

**NOTE:** This requires that `computeOrderSize` accepts an optional `riskPerTrade` override parameter. Check if it already does. If not, add an optional 4th parameter to `computeOrderSize()` in `trading-engine.ts`:

Find the `computeOrderSize` method signature and add the optional parameter:
```typescript
computeOrderSize(symbol: string, entryPrice: number, stopPrice: number, riskPerTradeOverride?: number): number {
  const riskPerTrade = riskPerTradeOverride ?? this.guardrails.account.risk_per_trade;
  // ... rest of the method using riskPerTrade instead of this.guardrails.account.risk_per_trade
}
```

### 3C. Add `reduceOnly` flag for perps exits

**FIND** the existing close order block (around line 1405-1410):
```typescript
          const closeOrder: Omit<OrderRequest, 'client_oid'> = {
            product_id: signal.symbol,
            side: 'sell',
            type: 'market',
            size: openPosition.size.toString(),
          };
```

**REPLACE WITH:**
```typescript
          const closeOrder: Omit<OrderRequest, 'client_oid'> = {
            product_id: signal.symbol,
            side: 'sell',
            type: 'market',
            size: openPosition.size.toString(),
          };
          // For perps symbols, add reduce_only flag to prevent accidental flip
          if (signal.symbol.includes('-PERP-')) {
            (closeOrder as any).reduce_only = true;
          }
```

---

## Step 4: Add PerpsRiskMonitor Shutdown

**File:** `atlas/apps/core-node/src/api/server.ts`

Find the engine shutdown/stop handler (where `tradingEngine.removeAllListeners()` and similar cleanup happens).

**ADD** before the existing cleanup:
```typescript
      // Stop perps risk monitor
      if (perpsRiskMonitor) {
        perpsRiskMonitor.stop();
        perpsRiskMonitor.removeAllListeners();
        logger.info('Perps risk monitor stopped');
      }
```

---

## Step 5: Update `.cursorrules` with Perps Context

**File:** `.cursorrules` (project root)

**ADD** to the architecture section:

```
## Perpetual Futures
- CoinbasePerpsAdapter extends CoinbaseAdapter for perps trading
- Registered as 'coinbase-perps' alongside 'coinbase' (spot) in ExchangeRegistry
- IPerpsAdapter interface: getFundingRate, setLeverage, getPortfolioSummary
- isPerpsAdapter() type guard for runtime capability check
- PerpsRiskMonitor: liquidation proximity, funding rate, leverage enforcement
- Perps symbols follow pattern: XXX-PERP-INTX (e.g., BTC-PERP-INTX, ETH-PERP-INTX)
- allow_short: true — strategies generate both long and short signals
- Perps risk_per_trade: 0.015 (vs 0.005 for spot)
- Perps fees: 0% maker / 0.03% taker
```

---

## Verification Checklist

Run: `node CURSOR_TASKS/verify/verify_002d.js`

### Section 1: Server.ts Integration (10 checks)
- [ ] `CoinbasePerpsAdapter` is imported in server.ts
- [ ] `PerpsRiskMonitor` is imported in server.ts
- [ ] Perps adapter is instantiated and registered
- [ ] PerpsRiskMonitor is instantiated with config from guardrails.perps
- [ ] PerpsRiskMonitor.start() is called
- [ ] PerpsRiskMonitor.stop() is called in shutdown
- [ ] Funding bias stub replaced with real funding check
- [ ] No more "spot mode stub" text in server.ts
- [ ] `isPerpsSymbol` check used for risk_per_trade selection
- [ ] `reduce_only` added for perps exit orders

### Section 2: Position Sizing (4 checks)
- [ ] `computeOrderSize` accepts optional riskPerTradeOverride parameter
- [ ] Perps symbols use `guardrails.perps.risk_per_trade`
- [ ] Spot symbols still use `guardrails.account.risk_per_trade`
- [ ] `effectiveRiskPerTrade` variable exists in signal handler

### Section 3: .cursorrules Updated (3 checks)
- [ ] `.cursorrules` mentions CoinbasePerpsAdapter
- [ ] `.cursorrules` mentions PerpsRiskMonitor
- [ ] `.cursorrules` mentions `allow_short: true`

### Section 4: No Regressions (5 checks)
- [ ] `shortAllowed` variable still exists in server.ts
- [ ] Kill switch logic unchanged
- [ ] Daily stop logic unchanged
- [ ] Time filter logic unchanged
- [ ] ATR filter logic unchanged

**Total: ~22 checks**

---

## Files Modified Summary

| File | Action | Description |
|------|--------|-------------|
| `api/server.ts` | MODIFY | Register perps adapter, init risk monitor, update signal handler |
| `trading-engine.ts` | MODIFY | Add optional riskPerTradeOverride to computeOrderSize |
| `.cursorrules` | MODIFY | Add perps architecture context |

---

## What NOT To Do

- Do NOT rewrite the entire signal handler — make targeted changes
- Do NOT modify strategy plugin files — they already generate buy/sell signals
- Do NOT remove the `isExitSignal` logic — it's still used when `shortAllowed` is false in tests
- Do NOT add new WebSocket subscriptions in server.ts
- Do NOT modify the order-manager.ts
- Do NOT change how spot trading works — perps changes are additive
