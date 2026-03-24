# TASK_005: Runtime Bug Fixes — Paper Mode Critical Path

**Priority:** CRITICAL — 6 bugs preventing paper trading from functioning correctly
**Status:** READY FOR CURSOR
**Created:** 2026-03-13 by Cowork (Architecture AI)

---

## Context

After starting the engine in paper mode, terminal logs and dashboard reveal 6 runtime bugs.
The engine starts successfully (TASK_004 resilience works), market data flows, regime detection
runs on all 5 symbols — but signal generation, order execution, and observability are all broken.

**Impact Summary:**
- Bug A: Order polling 404 spam → 12+ error logs/min, pollutes observability
- Bug B: trend_follow EMA validation → PRIMARY validated strategy generates ZERO signals
- Bug C: disabled_strategies not enforced → KILLED strategies (breakout, vwap_mr) still fire
- Bug D: PaperSimulator short sell rejection → ALL short signals blocked in paper mode
- Bug E: WebSocket stall detection too aggressive → unnecessary reconnects every ~90s
- Bug F: INTX 401 spam in paper mode → PerpsRiskMonitor polls INTX with invalid creds

---

## Bug A: Order Polling 404 Spam

### Root Cause
`CoinbaseExchange` (index.ts:464) polls orders every 5 seconds via `startOrderPolling()`.
It calls `this.getOpenOrders()` → `this.restClient.getOrders()` → REST endpoint `/orders`.

The `/orders` endpoint is the **deprecated GDAX v1 API**. Coinbase migrated to Advanced Trade
API v3 at `/api/v3/brokerage/orders/historical`. The old endpoint returns 404.

The `AdvancedTradeRestClient` already has the correct endpoint (line 487) but `CoinbaseExchange`
uses `CoinbaseRestClient` (old client).

### Files
- `atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts` — lines 225-237
- `atlas/apps/core-node/src/exchanges/coinbase/index.ts` — lines 464-470 (polling), 421-423 (getOpenOrders)

### Fix

**File: `atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts`**

FIND:
```typescript
  public async getOrders(
    status?: string[],
    productId?: string,
    limit?: number
  ): Promise<CoinbaseOrder[]> {
    const params: any = {};
    if (status) params.status = status;
    if (productId) params.product_id = productId;
    if (limit) params.limit = limit;

    const response = await this.client.get<CoinbaseOrder[]>('/orders', { params });
    return response.data;
  }
```

REPLACE:
```typescript
  public async getOrders(
    status?: string[],
    productId?: string,
    limit?: number
  ): Promise<CoinbaseOrder[]> {
    const params: any = {};
    if (productId) params.product_id = productId;
    if (limit) params.limit = limit;
    // Advanced Trade API v3 uses order_status filter (uppercase)
    if (status && status.length > 0) {
      params.order_status = status.map(s => s.toUpperCase());
    }

    try {
      const response = await this.client.get('/api/v3/brokerage/orders/historical', { params });
      const orders = response.data?.orders || response.data || [];
      // Map Advanced Trade order format to legacy CoinbaseOrder format
      return Array.isArray(orders) ? orders.map((o: any) => ({
        id: o.order_id || o.id,
        product_id: o.product_id,
        side: (o.side || '').toLowerCase() as 'buy' | 'sell',
        type: (o.order_type || o.type || 'market').toLowerCase(),
        size: o.filled_size || o.base_size || '0',
        price: o.average_filled_price || o.limit_price || '0',
        status: o.status ? o.status.toLowerCase() : 'pending',
        created_at: o.created_time || o.created_at || '',
        done_at: o.last_fill_time || '',
        fill_fees: o.total_fees || o.fee || '0',
        filled_size: o.filled_size || '0',
        executed_value: o.filled_value || '0',
        settled: o.status === 'FILLED',
        post_only: false,
      })) : [];
    } catch (error: any) {
      // Graceful fallback — return empty array instead of crashing polling loop
      if (error?.response?.status === 404 || error?.response?.status === 401) {
        return []; // Silently skip in paper mode where credentials may be invalid
      }
      throw error;
    }
  }
```

Also fix `getOrder` which has the same deprecated endpoint:

FIND:
```typescript
  public async getOrder(orderId: string): Promise<CoinbaseOrder> {
    const response = await this.client.get<CoinbaseOrder>(`/orders/${orderId}`);
    return response.data;
  }
```

REPLACE:
```typescript
  public async getOrder(orderId: string): Promise<CoinbaseOrder> {
    try {
      const response = await this.client.get(`/api/v3/brokerage/orders/historical/${orderId}`);
      const o = response.data?.order || response.data;
      return {
        id: o.order_id || o.id || orderId,
        product_id: o.product_id,
        side: (o.side || '').toLowerCase() as 'buy' | 'sell',
        type: (o.order_type || o.type || 'market').toLowerCase(),
        size: o.filled_size || o.base_size || '0',
        price: o.average_filled_price || o.limit_price || '0',
        status: o.status ? o.status.toLowerCase() : 'pending',
        created_at: o.created_time || o.created_at || '',
        done_at: o.last_fill_time || '',
        fill_fees: o.total_fees || o.fee || '0',
        filled_size: o.filled_size || '0',
        executed_value: o.filled_value || '0',
        settled: o.status === 'FILLED',
        post_only: false,
      };
    } catch (error: any) {
      if (error?.response?.status === 404 || error?.response?.status === 401) {
        throw new Error(`Order ${orderId} not found`);
      }
      throw error;
    }
  }
```

---

## Bug B: trend_follow EMA Validation — Hardcoded 25-Candle Minimum

### Root Cause
`trend-follow-strategy.ts` line 370-376 has hardcoded `< 25` checks for both fast and slow EMA
arrays. The configured `emaSlow: 15` only needs ~15 candles, but the validator demands 25+.

More critically: the check is `slowEma.length < 25` — but `slowEma` IS populated with 200+
values. The bug is that `context.indicators[`ema${emaSlow}`]` returns `undefined` because
the indicator key doesn't match. The fallback `context.indicators.ema15` also returns undefined
if indicators are keyed differently (e.g., `ema_15` or stored as objects).

### Files
- `atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts` — lines 363-383

### Fix

**File: `atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts`**

FIND:
```typescript
    const emaFast = this.getConfig<number>('emaFast', 12);
    const emaSlow = this.getConfig<number>('emaSlow', 15);
    const fastEma = context.indicators[`ema${emaFast}`] || context.indicators.ema12;
    const slowEma = context.indicators[`ema${emaSlow}`] || context.indicators.ema15;
    const atr = context.indicators.atr;

    if (!fastEma || fastEma.length < 25) {
      return { valid: false, reason: 'Insufficient fast EMA data (need 25+ candles)' };
    }

    if (!slowEma || slowEma.length < 25) {
      return { valid: false, reason: 'Insufficient slow EMA data (need 25+ candles)' };
    }

    if (!atr || atr.length < 15) {
      return { valid: false, reason: 'Insufficient ATR data (need 15+ candles)' };
    }

    return { valid: true };
```

REPLACE:
```typescript
    const emaFast = this.getConfig<number>('emaFast', 12);
    const emaSlow = this.getConfig<number>('emaSlow', 15);
    // Try multiple indicator key formats for robustness
    const fastEma = context.indicators[`ema${emaFast}`]
      || context.indicators[`ema_${emaFast}`]
      || context.indicators.ema12
      || context.indicators.emaFast;
    const slowEma = context.indicators[`ema${emaSlow}`]
      || context.indicators[`ema_${emaSlow}`]
      || context.indicators.ema15
      || context.indicators.emaSlow;
    const atr = context.indicators.atr;

    // Use dynamic thresholds based on actual config, not hardcoded 25
    const minFastData = emaFast + 5; // EMA period + small warmup buffer
    const minSlowData = emaSlow + 5;

    if (!fastEma || fastEma.length < minFastData) {
      return { valid: false, reason: `Insufficient fast EMA data (need ${minFastData}+ candles, have ${fastEma?.length || 0})` };
    }

    if (!slowEma || slowEma.length < minSlowData) {
      return { valid: false, reason: `Insufficient slow EMA data (need ${minSlowData}+ candles, have ${slowEma?.length || 0})` };
    }

    if (!atr || atr.length < 15) {
      return { valid: false, reason: `Insufficient ATR data (need 15+ candles, have ${atr?.length || 0})` };
    }

    return { valid: true };
```

**IMPORTANT:** Also investigate what indicator keys the `TechnicalIndicators` class actually
produces. If it uses `ema_12` (underscore) instead of `ema12`, that's the real root cause.
Check `atlas/apps/core-node/src/indicators/technical.ts` for the indicator output format
and ensure the strategy looks up the correct key. Add a debug log inside `validateContext`
that logs `Object.keys(context.indicators)` so you can verify the actual keys at runtime.

---

## Bug C: disabled_strategies Not Enforced

### Root Cause
Three-link chain is broken:

1. `guardrails.yaml` line 12: `disabled_strategies: [vwap_mr, breakout]` ✓ (exists)
2. `loadGuardrails.ts` Zod schema: `disabled_strategies` NOT in schema → silently stripped ✗
3. `server.ts` line 1171-1202: `signalConfig` hardcodes `breakout.enabled: true` ✗
4. `SignalProcessor` config has `disabledStrategies?: string[]` field ✓ (exists, never populated)
5. `StrategyRegistry` line 84-86: correctly filters if `config.disabledStrategies` is set ✓

The infrastructure exists on both ends — it's just never wired through.

### Files
- `atlas/apps/core-node/src/config/loadGuardrails.ts` — Zod schema (add field)
- `atlas/apps/core-node/src/api/server.ts` — lines 1171-1204 (pass field through)

### Fix

**File: `atlas/apps/core-node/src/config/loadGuardrails.ts`**

FIND (inside GuardrailsSchema, right after the opening `z.object({`):
```typescript
const GuardrailsSchema = z.object({
  account: z.object({
```

REPLACE:
```typescript
const GuardrailsSchema = z.object({
  // Strategies permanently killed by backtest verdict — never fire signals
  disabled_strategies: z.array(z.string()).optional().default([]),
  account: z.object({
```

**File: `atlas/apps/core-node/src/api/server.ts`**

FIND (the signalConfig object and SignalProcessor creation):
```typescript
    const signalConfig = {
      supabaseUrl: env.SUPABASE_URL || '',
      supabaseKey: env.SUPABASE_SERVICE_KEY || '',
      strategies: {
        breakout: {
          enabled: true,
```

REPLACE:
```typescript
    // Respect disabled_strategies from guardrails (Phase 3 backtest verdicts)
    const disabledStrategies = guardrails.disabled_strategies || [];
    const signalConfig = {
      supabaseUrl: env.SUPABASE_URL || '',
      supabaseKey: env.SUPABASE_SERVICE_KEY || '',
      disabledStrategies,
      strategies: {
        breakout: {
          enabled: !disabledStrategies.includes('breakout'),
```

Also update the other strategy enabled flags in the same object:

FIND:
```typescript
        vwapMeanReversion: {
          enabled: true,
```

REPLACE:
```typescript
        vwapMeanReversion: {
          enabled: !disabledStrategies.includes('vwap_mr'),
```

FIND:
```typescript
        momentum: {
          enabled: strategyGuard.mode.includes('momentum'),
```

REPLACE:
```typescript
        momentum: {
          enabled: strategyGuard.mode.includes('momentum') && !disabledStrategies.includes('momentum'),
```

After the `signalProcessor = new SignalProcessor(signalConfig, logger);` line, add a log:
```typescript
    if (disabledStrategies.length > 0) {
      logger.info('Disabled strategies from guardrails:', { disabledStrategies });
    }
```

---

## Bug D: PaperSimulator Short Sell Balance Check

### Root Cause
`paper-trading-simulator.ts` line 444-453: the `validateOrder()` method checks base currency
balance for ALL sell orders. For short sells, this incorrectly requires holding the asset.

A short sell should check quote currency (USD) collateral, not base currency (SOL) balance.

### Files
- `atlas/apps/core-node/src/trading/paper-trading-simulator.ts` — lines 423-457

### Fix

**File: `atlas/apps/core-node/src/trading/paper-trading-simulator.ts`**

FIND:
```typescript
    } else {
      // Check base currency balance
      const available = this.getBalance(baseCurrency);

      if (available < size) {
        return {
          valid: false,
          reason: `Insufficient ${baseCurrency} balance. Required: ${size}, Available: ${available}`
        };
      }
    }
```

REPLACE:
```typescript
    } else {
      // Check if this is a closing sell (we hold the asset) or a short sell (opening short)
      const baseBalance = this.getBalance(baseCurrency);

      if (baseBalance >= size) {
        // We hold enough of the base asset — this is a regular sell (closing long)
        // Validation passes
      } else {
        // Short sell: check quote currency (USD) for collateral
        // Require enough USD to cover the notional value + fees as margin
        const notional = size * price;
        const requiredCollateral = notional * (1 + this.config.takerFee);
        const quoteAvailable = this.getBalance(quoteCurrency);

        if (quoteAvailable < requiredCollateral) {
          return {
            valid: false,
            reason: `Insufficient ${quoteCurrency} collateral for short. Required: ${requiredCollateral.toFixed(2)}, Available: ${quoteAvailable.toFixed(2)}`
          };
        }
      }
    }
```

**NOTE:** Also check `executeMarketOrder()` and `executeLimitOrder()` to ensure they handle
short position tracking correctly — the balance updates for shorts should debit quote currency
(collateral) and track a negative base currency position, not try to subtract from a zero
base balance.

---

## Bug E: WebSocket Stall Detection Too Aggressive

### Root Cause
`websocket.ts` line 506: `messageAge > RECONNECT_CONFIG.heartbeatTimeoutMs * 2` = 90 seconds.
Coinbase ticker messages can have gaps >90s for low-volume pairs. The stall detector triggers
on normal ticker gaps, causing unnecessary `forceReconnect()` → reconnect loop.

The PONG-based detection (line 497) is the correct liveness check. The message-age check is
redundant and harmful — it causes `totalReconnects` to climb rapidly.

### Files
- `atlas/apps/core-node/src/exchanges/coinbase/websocket.ts` — lines 506-514

### Fix

**File: `atlas/apps/core-node/src/exchanges/coinbase/websocket.ts`**

FIND:
```typescript
      } else if (this.isConnected && messageAge > RECONNECT_CONFIG.heartbeatTimeoutMs * 2) {
        // Even longer without any message - definitely dead
        this.logger.warn('coinbase_ws_stalled_detected', {
          reason: 'no_messages',
          lastMessageAge: messageAge,
        });
        this.emit('ws:stalled', messageAge);
        this.emit('health_degraded', 'no_messages');
        this.forceReconnect();
      }
```

REPLACE:
```typescript
      } else if (this.isConnected && messageAge > RECONNECT_CONFIG.heartbeatTimeoutMs * 4) {
        // 3 minutes without ANY message (including pongs) — log warning but don't reconnect
        // The pong-based check above is the authoritative liveness signal.
        // Ticker gaps >90s are normal for low-volume pairs on Coinbase.
        this.logger.debug('coinbase_ws_no_recent_messages', {
          lastMessageAge: messageAge,
          note: 'Ticker gaps are normal — pong check is the liveness authority',
        });
        this.emit('health_degraded', 'no_messages');
        // Do NOT forceReconnect here — let the pong timeout handle dead connections
      }
```

---

## Bug F: INTX 401 Spam in Paper Mode

### Root Cause
`server.ts` line 965-981: `perpsRiskMonitor.start()` is called unconditionally. In paper mode,
INTX API credentials are either missing or invalid. Every `fundingCheckIntervalSec` seconds,
the monitor calls `getPositions()` and `getPortfolioSummary()` which hit INTX endpoints and
get 401 Unauthorized.

### Files
- `atlas/apps/core-node/src/api/server.ts` — lines 963-982
- `atlas/apps/core-node/src/trading/perps/perps-risk-monitor.ts` — runRiskCheck method

### Fix

**File: `atlas/apps/core-node/src/api/server.ts`**

FIND:
```typescript
    const perpsConfig = engineGuardrails.perps;
    perpsRiskMonitor = null;
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
```

REPLACE:
```typescript
    const perpsConfig = engineGuardrails.perps;
    perpsRiskMonitor = null;
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

      // Only start INTX polling in live mode — paper mode has no valid INTX credentials
      if (mode === 'live') {
        perpsRiskMonitor.start();
        logger.info('Perps risk monitor started (live mode)');
      } else {
        logger.info('Perps risk monitor created but NOT polling (paper mode — no INTX credentials)');
      }
```

---

## Verification Script

Create `CURSOR_TASKS/verify/task_005_verify.sh`:

```bash
#!/usr/bin/env bash
set -e

echo "=== TASK_005 Verification ==="

# Bug A: Check that rest-client.ts uses v3 API endpoint
echo -n "Bug A: REST client uses v3 orders endpoint... "
if grep -q "api/v3/brokerage/orders/historical" atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts; then
  echo "PASS"
else
  echo "FAIL — rest-client.ts still uses deprecated /orders endpoint"
  exit 1
fi

# Bug B: Check that hardcoded 25 is removed from trend-follow
echo -n "Bug B: trend_follow uses dynamic EMA thresholds... "
if grep -q "length < 25" atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts; then
  echo "FAIL — hardcoded 25-candle minimum still present"
  exit 1
else
  echo "PASS"
fi

# Bug C: Check that disabled_strategies is in Zod schema
echo -n "Bug C: disabled_strategies in Zod schema... "
if grep -q "disabled_strategies" atlas/apps/core-node/src/config/loadGuardrails.ts; then
  echo "PASS"
else
  echo "FAIL — disabled_strategies not added to GuardrailsSchema"
  exit 1
fi

# Bug C: Check that server.ts uses disabledStrategies
echo -n "Bug C: server.ts passes disabledStrategies to SignalProcessor... "
if grep -q "disabledStrategies" atlas/apps/core-node/src/api/server.ts; then
  echo "PASS"
else
  echo "FAIL — server.ts does not wire disabled_strategies"
  exit 1
fi

# Bug D: Check that PaperSimulator handles short sells
echo -n "Bug D: PaperSimulator supports short sells... "
if grep -q "collateral\|short sell\|Short sell\|short" atlas/apps/core-node/src/trading/paper-trading-simulator.ts; then
  echo "PASS"
else
  echo "FAIL — PaperSimulator still blocks short sells"
  exit 1
fi

# Bug E: Check that aggressive message-age reconnect is softened
echo -n "Bug E: WS stall detection not forcing reconnect on message age... "
if grep -A5 "no_messages\|no_recent_messages" atlas/apps/core-node/src/exchanges/coinbase/websocket.ts | grep -q "forceReconnect"; then
  echo "FAIL — message-age stall detection still forces reconnect"
  exit 1
else
  echo "PASS"
fi

# Bug F: Check that perps risk monitor respects paper mode
echo -n "Bug F: PerpsRiskMonitor skips polling in paper mode... "
if grep -q "mode.*live.*perpsRiskMonitor\|paper.*mode.*NOT.*polling\|paper mode.*no INTX" atlas/apps/core-node/src/api/server.ts; then
  echo "PASS"
else
  echo "FAIL — PerpsRiskMonitor still starts unconditionally"
  exit 1
fi

echo ""
echo "=== All TASK_005 checks passed ==="
```

---

## Execution Order

Implement bugs in this order (dependency chain):

1. **Bug C** (disabled_strategies) — foundational: stops bad strategies from wasting risk budget
2. **Bug B** (trend_follow EMA) — unblocks the primary validated strategy
3. **Bug D** (PaperSimulator shorts) — unblocks short signals in paper mode
4. **Bug A** (order polling 404) — cleans up log noise
5. **Bug F** (INTX 401 paper) — cleans up log noise
6. **Bug E** (WS stall detection) — improves connection stability

After all fixes, restart in paper mode and verify:
- No 404 or 401 errors in logs
- trend_follow signals appear in signal history
- breakout and vwap_mr signals do NOT appear
- Short sell signals execute (check with `allow_short: true`)
- WebSocket stays connected without unnecessary reconnects
- Dashboard shows trades being generated by trend_follow and momentum only
