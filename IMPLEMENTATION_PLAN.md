# Apex Automata — Complete Implementation Plan v3

**Date:** March 5, 2026
**Scope:** Fix all critical/high/medium bugs → Backtest validation → Multi-exchange (Kraken + Hyperliquid) with simultaneous execution
**Source:** Three rounds of full codebase diagnostic — 69 total issues identified across all layers

---

## Phase 0: Emergency Fixes (Day 1 — Cursor)

These are SECURITY and DATA-INTEGRITY issues that must be addressed before ANY other work. They exist outside the trading logic but represent existential risk.

### 0.1 — Revoke exposed secrets and fix .env handling

**Issue:** `.env` file is committed to git with live Coinbase API keys, Supabase service key, and encryption key.

**File:** `.env` (root) — Lines 2-17 contain:
- `COINBASE_API_KEY` (line 2)
- `COINBASE_API_SECRET` with actual EC private key (line 3)
- `SUPABASE_SERVICE_KEY` (line 14)
- `ENCRYPTION_KEY` (line 17)

**Required actions:**
1. Immediately revoke all Coinbase API keys via Coinbase dashboard
2. Rotate Supabase service key via Supabase dashboard
3. Generate new encryption key
4. Add `.env` to `.gitignore`
5. Remove `.env` from git history: `git filter-branch` or `BFG Repo-Cleaner`
6. Commit only `.env.example` with placeholder values

### 0.2 — Add authentication to API endpoints

**File:** `atlas/apps/core-node/src/api/server.ts` — Line 42
**Issue:** Zero authentication on all endpoints including `/api/engine/start`, `/api/engine/stop`, `/api/engine/kill`, and all config POST endpoints.

**Required:** Add API key middleware:
```typescript
const API_KEY = process.env.API_SECRET_KEY;
const authMiddleware = (req, res, next) => {
  const key = req.headers['x-api-key'];
  if (!key || key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
app.use('/api', authMiddleware);
```

### 0.3 — Restrict CORS

**File:** `atlas/apps/core-node/src/api/server.ts` — Line 42
**Current:** `app.use(cors());` — accepts ALL origins
**Fix:**
```typescript
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:8080'],
  credentials: true,
}));
```

### 0.4 — Add request size limit

**File:** `atlas/apps/core-node/src/api/server.ts` — Line 43
**Current:** `app.use(express.json());` — no size limit (DoS vector)
**Fix:** `app.use(express.json({ limit: '10kb' }));`

### 0.5 — Fix memory leak: event listeners on engine stop

**File:** `atlas/apps/core-node/src/api/server.ts` — Lines 821-963 (listener registration), 1629-1660 (engine stop)
**Issue:** Engine stop nullifies the instance but NEVER removes event listeners. Each restart adds new listeners → exponential memory growth over 24/7 operation.
**Fix:** Before `tradingEngine = null` at line 1643, add:
```typescript
tradingEngine.removeAllListeners();
```

---

## Phase 1: Fix Critical Trading Bugs (Days 2-3 — Cursor)

### 1.1 — Fix regime filter DEFAULT_CONFIG (6 changes in 1 file)

**File:** `atlas/apps/core-node/src/strategies/regime-filter.ts`
**Location:** Lines 118-128

**Current (BROKEN):**
```typescript
const DEFAULT_CONFIG: RegimeFilterConfig = {
  enabled: true,
  minCompatibilityScore: 0.1,
  counterRegimeStrengthBoost: 0,
  maxPositionMultiplier: 1.0,
  minPositionMultiplier: 0.1,
  minRegimeConfidence: 0.1,
  alwaysAllowStrategies: ['vwap_mr', 'breakout', 'momentum', 'trend_follow'],
  requireMTFAlignment: false,
  mtfAlignmentThreshold: 0.3,
};
```

**Fix:**
```typescript
const DEFAULT_CONFIG: RegimeFilterConfig = {
  enabled: true,
  minCompatibilityScore: 0.3,
  counterRegimeStrengthBoost: 0,
  maxPositionMultiplier: 1.0,
  minPositionMultiplier: 0.25,
  minRegimeConfidence: 0.4,
  alwaysAllowStrategies: [],       // No bypasses
  requireMTFAlignment: false,
  mtfAlignmentThreshold: 0.3,
};
```

### 1.2 — Wire positionMultiplier into order sizing

**File:** `atlas/apps/core-node/src/api/server.ts` — Lines ~1363-1395

**Current (BROKEN):** positionMultiplier computed but NEVER applied to `computedSize`

**Fix at line ~1395:**
```typescript
const multiplier = signal.metadata?.positionMultiplier ?? 1.0;
const adjustedSize = computedSize * multiplier;
const baseOrder = {
  product_id: signal.symbol,
  side: signal.direction,
  type: orderType,
  size: adjustedSize.toFixed(6)
};
```

### 1.3 — Fix backtest capital accounting (ALL P&L WRONG)

**File:** `atlas/apps/core-node/src/backtesting/backtest-engine.ts` — Lines 345-347
**Issue:** When closing a position, capital is updated with raw `exitPrice * size` instead of `(exitPrice - entryPrice) * size`. This means capital grows by the full notional value of a winning trade, not just the profit.

**Fix:** Change capital update to:
```typescript
const pnl = (exitPrice - entryPrice) * position.size * (position.side === 'sell' ? -1 : 1);
capital += pnl - fees;
```

### 1.4 — Fix daily returns calculation (Sharpe depends on this)

**File:** `atlas/apps/core-node/src/backtesting/backtest-engine.ts` — Lines 371-380
**Issue:** Daily returns computed as `(equity[i] - equity[i-1]) / equity[i-1]` but equity array has gaps and may include intraday snapshots, producing wrong Sharpe ratios.

**Fix:** Ensure equity curve is snapshotted exactly once per day at close, use consistent daily P&L.

### 1.5 — Fix Sharpe ratio NaN

**File:** `atlas/apps/core-node/src/backtesting/backtest-engine.ts` — Lines 482-487
**Issue:** If all daily returns are identical (e.g., zero), stddev = 0, Sharpe = mean/0 = NaN.

**Fix:**
```typescript
const sharpe = stdDev === 0 ? 0 : (meanReturn / stdDev) * Math.sqrt(252);
```

### 1.6 — Fix Sortino ratio formula

**File:** `atlas/apps/core-node/src/backtesting/backtest-engine.ts`
**Issue:** Sortino uses standard deviation of ALL returns instead of only downside returns.

**Fix:**
```typescript
const downsideReturns = dailyReturns.filter(r => r < 0);
const downsideDev = Math.sqrt(downsideReturns.reduce((sum, r) => sum + r * r, 0) / downsideReturns.length);
const sortino = downsideDev === 0 ? 0 : (meanReturn / downsideDev) * Math.sqrt(252);
```

### 1.7 — Fix VWAP daily reset (wrong date comparison)

**File:** `atlas/apps/core-node/src/indicators/technical.ts` — Line 184
**Issue:** VWAP daily reset compares dates using string or partial comparison that fails across month boundaries (e.g., Jan 31 → Feb 1).

**Fix:** Use proper date comparison:
```typescript
const currentDay = new Date(candle.time).toISOString().split('T')[0];
const previousDay = new Date(previousCandle.time).toISOString().split('T')[0];
if (currentDay !== previousDay) { resetVWAP(); }
```

### 1.8 — Fix RSI NaN with zero average loss

**File:** `atlas/apps/core-node/src/indicators/technical.ts`
**Issue:** When average loss = 0, RSI calculation divides by zero → NaN propagates through all downstream strategy signals.

**Fix:**
```typescript
if (avgLoss === 0) return 100; // All gains, no losses = max RSI
const rs = avgGain / avgLoss;
return 100 - (100 / (1 + rs));
```

### 1.9 — Fix order-manager fill race condition

**File:** `atlas/apps/core-node/src/trading/order-manager.ts` — Lines 157-197
**Issue:** Fill accumulation is non-atomic. Concurrent fill events can interleave reads/writes, causing lost fills.

**Fix:** Add mutex/lock around fill processing:
```typescript
private fillLock = false;
async processFill(fill: Fill) {
  while (this.fillLock) await new Promise(r => setTimeout(r, 10));
  this.fillLock = true;
  try { /* existing fill logic */ }
  finally { this.fillLock = false; }
}
```

### 1.10 — Fix position-tracker P&L on position flips

**File:** `atlas/apps/core-node/src/trading/position-tracker.ts` — Lines 299-360
**Issue:** When a position flips from long to short (or vice versa), fee semantics are inverted — fees are added to P&L instead of subtracted.

**Fix:** Ensure fees are always subtracted regardless of position flip direction:
```typescript
const realizedPnl = (exitPrice - entryPrice) * closedSize * sideMultiplier - Math.abs(fees);
```

### 1.11 — Add bounds checking to risk engine

**File:** `atlas/apps/core-node/src/trading/risk-engine.ts`
**Issue:** No validation that financial calculations produce valid numbers. NaN or Infinity can bypass all risk limits.

**Fix:** Add at top of `checkOrder()` and `computeOrderSize()`:
```typescript
function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} is ${value}, refusing order`);
}
```
Apply to: order size, price, notional value, exposure calculations.

### 1.12 — Fix TWAP memory leak

**File:** `atlas/apps/core-node/src/trading/order-manager.ts`
**Issue:** TWAP slice timers are never cleaned up on cancellation. Over time, 1000+ zombie timers accumulate.

**Fix:** Track all TWAP timer IDs and clear them on cancel:
```typescript
private twapTimers: Map<string, NodeJS.Timeout[]> = new Map();
// On cancel:
const timers = this.twapTimers.get(orderId);
timers?.forEach(clearTimeout);
this.twapTimers.delete(orderId);
```

### 1.13 — Fix trade outcome threshold

**File:** `atlas/apps/core-node/src/trading/trade-analytics.ts` — Lines 390-396
**Current:** ±$0.01 threshold classifies micro-fee artifacts as wins/losses.

**Fix:**
```typescript
const BREAKEVEN_THRESHOLD = 1.00;
if (params.realizedPnl > BREAKEVEN_THRESHOLD) { outcome = 'win'; }
else if (params.realizedPnl < -BREAKEVEN_THRESHOLD) { outcome = 'loss'; }
else { outcome = 'breakeven'; }
```

### 1.14 — Set production-grade signal parameters

**File:** `atlas/config/guardrails.yaml` — Lines 25-70

| Parameter | Current (test) | New (production) |
|-----------|---------------|-----------------|
| `breakout.volumeThreshold` | 0.3 | 1.5 |
| `breakout.period` | 8 | 20 |
| `vwap_mr.deviationEntry` | 0.1 | 2.0 |
| `momentum.rsiOversold` | 45 | 30 |
| `momentum.rsiOverbought` | 55 | 70 |
| `account.risk_per_trade` | 0.01 (1%) | 0.005 (0.5%) |
| `account.max_open_positions` | 5 | 2 |
| `account.equity_usd` | 50000 | 10000 |
| `risk.max_position_exposure_pct` | 0.75 | 0.30 |

Also verify `paper.local.yaml` `per_trade_risk_bp: 70` aligns (should be 50bp = 0.5%).

### 1.15 — Fix position-monitor exit order race condition

**File:** `atlas/apps/core-node/src/trading/position-monitor.ts` — Lines 265-344
**Issue:** Checks exit condition, then places exit order in separate step. Between check and place, price can move or another exit can trigger → duplicate exit orders.

**Fix:** Add position-level lock before placing exit:
```typescript
if (this.exitInProgress.has(positionId)) return;
this.exitInProgress.add(positionId);
try { await placeExitOrder(); }
finally { this.exitInProgress.delete(positionId); }
```

### 1.16 — Fix advanced backtest slippage capital tracking

**File:** `atlas/apps/core-node/src/backtesting/advanced-backtest-engine.ts` — Lines 540-559
**Issue:** Slippage cost is computed but not consistently subtracted from capital in all code paths.

**Fix:** Ensure every fill path subtracts: `capital -= Math.abs(slippageCost) + fees;`

### 1.17 — Fix signal arbiter strength normalization

**File:** `atlas/apps/core-node/src/trading/signal-arbiter.ts` (or similar path)
**Issue:** Signal strength values from different strategies are on different scales. A momentum signal of 0.8 is not equivalent to a breakout signal of 0.8.

**Fix:** Normalize per-strategy before comparison:
```typescript
const normalizedStrength = (rawStrength - strategyMin) / (strategyMax - strategyMin);
```

---

## Phase 2: Database & Infrastructure Fixes (Day 3-4 — Cursor)

### 2.1 — Create missing `bars` table

**New migration:** `supabase/migrations/YYYYMMDD_create_bars_table.sql`
```sql
CREATE TABLE IF NOT EXISTS bars (
  id BIGSERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  time BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  volume DOUBLE PRECISION NOT NULL DEFAULT 0,
  exchange TEXT NOT NULL DEFAULT 'coinbase',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(symbol, time, exchange)
);
CREATE INDEX idx_bars_symbol_time ON bars(symbol, time DESC);
CREATE INDEX idx_bars_exchange ON bars(exchange);
ALTER TABLE bars ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON bars FOR ALL USING (true);
```

### 2.2 — Add exchange_id to trading tables

**New migration:** `supabase/migrations/YYYYMMDD_add_exchange_id.sql`
```sql
ALTER TABLE positions ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE fills ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS exchange_id TEXT NOT NULL DEFAULT 'coinbase';
ALTER TABLE signals ADD COLUMN IF NOT EXISTS routed_exchange TEXT;
CREATE INDEX idx_positions_exchange ON positions(exchange_id);
CREATE INDEX idx_orders_exchange ON orders(exchange_id);
```

### 2.3 — Add missing indexes on foreign keys

**New migration:** `supabase/migrations/YYYYMMDD_add_missing_indexes.sql`
```sql
CREATE INDEX IF NOT EXISTS idx_fills_order_leg_id ON fills(order_leg_id);
CREATE INDEX IF NOT EXISTS idx_order_legs_user_id ON order_legs(user_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_position_id ON journal_entries(position_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_order_id ON journal_entries(order_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_signal_id ON journal_entries(signal_id);
CREATE INDEX IF NOT EXISTS idx_trade_outcomes_strategy_regime ON trade_outcomes(strategy, regime);
```

### 2.4 — Add missing unique constraints

**New migration:** `supabase/migrations/YYYYMMDD_add_unique_constraints.sql`
```sql
-- Prevent duplicate signals
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedup
  ON signals(user_id, symbol, strategy, decided_at)
  WHERE decided_at IS NOT NULL;

-- Prevent duplicate fills
CREATE UNIQUE INDEX IF NOT EXISTS idx_fills_dedup
  ON fills(order_id, trade_id, filled_at)
  WHERE trade_id IS NOT NULL;
```

### 2.5 — Fix numeric precision in analytics tables

**New migration:** `supabase/migrations/YYYYMMDD_fix_numeric_precision.sql`
```sql
ALTER TABLE trade_outcomes ALTER COLUMN fees TYPE NUMERIC(20,8);
ALTER TABLE trade_outcomes ALTER COLUMN realized_pnl TYPE NUMERIC(20,8);
-- Apply to any other DOUBLE PRECISION P&L columns
```

### 2.6 — Add input validation to ALL config endpoints

**File:** `atlas/apps/core-node/src/api/server.ts`
**Issue:** Lines 1780, 1787, 2089, 2204, 2363, 2509, 2623 — all accept `req.body` without validation.

**Fix:** Add Zod schemas for each config endpoint:
```typescript
import { z } from 'zod';

const riskConfigSchema = z.object({
  per_trade_risk: z.number().min(0.001).max(0.05).optional(),
  max_open_positions: z.number().int().min(1).max(10).optional(),
  daily_loss_limit: z.number().min(-0.10).max(0).optional(),
});

// Apply to each endpoint:
app.post('/api/config/risk', (req, res) => {
  const parsed = riskConfigSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error });
  // ... continue
});
```

### 2.7 — Add rate limiting

**File:** `atlas/apps/core-node/src/api/server.ts`
```typescript
import rateLimit from 'express-rate-limit';
const limiter = rateLimit({ windowMs: 60000, max: 100 });
app.use('/api', limiter);
```

### 2.8 — Fix parseInt radix

**File:** `atlas/apps/core-node/src/api/server.ts` — Lines 1835, 1845, 1874, 2169
**Fix:** Add radix 10 to all parseInt calls:
```typescript
parseInt(req.query.limit as string, 10)
```

### 2.9 — Cap WebSocket connections

**File:** `atlas/apps/core-node/src/api/server.ts` — Lines 230, 414-417
```typescript
const MAX_WS_CLIENTS = 50;
wss.on('connection', (ws) => {
  if (wss.clients.size > MAX_WS_CLIENTS) {
    ws.close(1013, 'Max connections reached');
    return;
  }
  // ... existing logic
});
```

### 2.10 — Standardize package manager

**Issue:** Both `package-lock.json` (npm) and `pnpm-lock.yaml` exist. `atlas/package.json` declares `pnpm@9.12.3`. `Dockerfile.web` uses npm.

**Fix:**
1. Delete `package-lock.json` from root
2. Update `deploy/docker/Dockerfile.web` lines 7, 10 to use pnpm
3. Commit `.npmrc` or `pnpm-workspace.yaml` if not present

---

## Phase 3: Backtest Validation (Week 2 — Cowork + Cursor)

### 3.0 — Fix backtesting infrastructure (Cursor)

**3.0a — Walk-forward is a STUB**
- **File:** `atlas/apps/core-node/src/backtesting/advanced-backtest-engine.ts` — Lines 850-880
- **Fix:** Use `BacktestRunner.runOptimization()` (lines 297-338, FUNCTIONAL) for grid search. Skip stub.

**3.0b — API data loading throws "Not implemented"**
- **File:** `atlas/apps/core-node/src/backtesting/advanced-backtest-engine.ts` — Lines 276-278
- **Fix:** Wire `HistoricalDataLoader` (data-loader.ts lines 165-233) for Coinbase REST data.

**3.0c — Backtest endpoint uses SYNTHETIC data**
- **File:** `atlas/apps/core-node/src/api/server.ts` — Lines 2828-2978
- **Fix:** Wire `HistoricalDataLoader` into endpoint for real market data.

**3.0d — PaperTradingSimulator realized P&L TODO**
- **File:** `atlas/apps/core-node/src/trading/paper-trading-simulator.ts` — Line 672
- **Impact:** Limited — PaperAccountProvider handles this separately.

**3.0e — Fix position sizing ignoring existing positions**
- **File:** `atlas/apps/core-node/src/backtesting/backtest-engine.ts`
- **Issue:** New position size computed as if no other positions open. With 3 open positions using 60% capital, a 4th trade still sizes at full risk.
- **Fix:** Track allocated capital and size new trades against available capital only.

**3.0f — Add OHLCV data validation**
- **File:** `atlas/apps/core-node/src/backtesting/data-loader.ts`
- **Issue:** No validation that loaded candles have valid OHLCV values (non-zero, high >= low, etc.)
- **Fix:**
```typescript
function validateCandle(c: OHLCV): boolean {
  return c.open > 0 && c.high >= c.low && c.close > 0 && c.volume >= 0
    && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close);
}
```

### 3.1 — Fetch and cache historical data

Use `HistoricalDataLoader` (Coinbase REST, 300 candles/request, 100ms delay):
- BTC-USD: 12 months 1m candles (~525,600 candles)
- ETH-USD: 12 months 1m candles
- SOL-USD: 6 months 1m candles

### 3.2 — Run per-strategy backtests

Use `BacktestEngine` with Phase 1.14 production parameters.

**VWAP Mean Reversion (priority 1):** BTC-USD, 15m, deviationEntry=2.0σ, regime=ranging only
**Donchian Breakout:** BTC-USD, 1H, period=20, regime=strong_trend/weak_trend
**EMA Trend Follow:** BTC-USD, 15m, fastEma=9/slowEma=21, regime=strong_trend
**RSI/MACD Momentum:** Only test if above three pass.

Pass criteria per strategy: expectancy > 0, profit factor > 1.3, Sharpe > 1.0, max drawdown < 15%

### 3.3 — Parameter optimization

Use `BacktestRunner.runOptimization()` (lines 297-338, FUNCTIONAL):
- VWAP MR: deviationEntry ∈ [1.5, 2.0, 2.5, 3.0], stopMultiplier ∈ [1.0, 1.5, 2.0]
- Breakout: period ∈ [15, 20, 25, 30], volumeThreshold ∈ [1.2, 1.5, 2.0]
- Trend Follow: fastEma ∈ [8, 9, 12], slowEma ∈ [18, 21, 26]

### 3.4 — Walk-forward validation (manual)

Split 12 months into 4 quarters. Optimize Q1-Q3, test Q4. Roll forward. Pass: out-of-sample degrades < 30%.

### 3.5 — Fee sensitivity analysis

Run same backtest 3x with fee configs: Coinbase (0.004/0.006), Kraken (0.0016/0.0026), Hyperliquid (0.0002/0.0005).

### 3.6 — Monte Carlo confidence intervals

Use `AdvancedBacktestEngine.runMonteCarloSimulation()` (lines 882-929, FUNCTIONAL).

**Deliverable:** Go/no-go per strategy with statistical validation.

---

## Phase 4: Exchange Abstraction Layer (Week 3 — Cursor)

### 4.1 — Create IExchangeAdapter interface

**New file:** `atlas/apps/core-node/src/exchanges/exchange-adapter.ts`

```typescript
interface ExchangeCapabilities {
  exchangeId: string;
  displayName: string;
  supportsShort: boolean;
  supportsPerps: boolean;
  supportsTwap: boolean;
  supportsPostOnly: boolean;
  maxLeverage: number;
  fundingRateInterval: number;
  makerFeeDefault: number;
  takerFeeDefault: number;
}

interface IExchangeAdapter extends IExecutionAdapter {
  readonly exchangeId: string;
  readonly capabilities: ExchangeCapabilities;
  connectMarketData(): Promise<void>;
  disconnectMarketData(): Promise<void>;
  subscribeToTicker(symbols: string[]): void;
  subscribeToOrderbook(symbols: string[]): void;
  getHistoricalCandles(symbol: string, start: Date, end: Date, granularity: number): Promise<OHLCV[]>;
  getBalances(): Promise<Balance[]>;
  getAccountInfo(): Promise<AccountInfo>;
  toExchangeSymbol(internalSymbol: string): string;
  toInternalSymbol(exchangeSymbol: string): string;
  getProductSpec(symbol: string): ProductSpec | undefined;
}
```

### 4.2 — Create ExchangeRegistry

**New file:** `atlas/apps/core-node/src/exchanges/exchange-registry.ts`

### 4.3 — Refactor OrderManager to remove Coinbase coupling

**File:** `atlas/apps/core-node/src/trading/order-manager.ts`
- Line 4: Replace `import { CoinbaseExchange }` with `IExchangeAdapter`
- Line 80: Constructor takes `IExecutionAdapter` instead of `CoinbaseExchange`
- Lines 477-508: `placeOrderWithRetry()` uses adapter interface methods

### 4.4 — Refactor adapter-factory.ts for multi-exchange

**File:** `atlas/apps/core-node/src/trading/execution/adapter-factory.ts` — Lines 69-112

### 4.5 — Refactor server.ts for multi-exchange

**File:** `atlas/apps/core-node/src/api/server.ts`
- Line 1579: Create adapters per exchange via ExchangeRegistry
- Lines 261-330: Tag tickers with `exchangeId`
- Lines ~1255-1395: Route signals to correct exchange adapter
- Lines 1265-1267: Check `adapter.capabilities.supportsShort` per exchange

### 4.6 — Wrap CoinbaseExchange as IExchangeAdapter

**New file:** `atlas/apps/core-node/src/exchanges/coinbase/coinbase-adapter.ts`

---

## Phase 5: Kraken Adapter (Week 3-4 — Cursor)

### 5.1 — Kraken REST client
**New file:** `atlas/apps/core-node/src/exchanges/kraken/http/kraken-rest.ts`
- HMAC-SHA512 auth with nonce
- Symbol mapping: `BTC-USD` ↔ `XXBTZUSD`
- Rate limiting: 15 calls/sec token bucket

### 5.2 — Kraken WebSocket client
**New file:** `atlas/apps/core-node/src/exchanges/kraken/ws/kraken-ws.ts`
- Public: `wss://ws.kraken.com`, Private: `wss://ws-auth.kraken.com`
- Channels: ticker, ohlc, book, openOrders, ownTrades

### 5.3 — Kraken adapter implementing IExchangeAdapter
**New file:** `atlas/apps/core-node/src/exchanges/kraken/kraken-adapter.ts`
- Capabilities: supportsShort=false, supportsPerps=false, makerFee=0.0016, takerFee=0.0026

### 5.4 — Kraken product specs for paper mode

### 5.5 — Integration tests

---

## Phase 6: Hyperliquid Adapter (Week 4-6 — Cursor)

### 6.1 — Perpetuals risk module

**New file:** `atlas/apps/core-node/src/trading/risk/perps-risk.ts`

```typescript
interface PerpsRiskConfig {
  maxLeverage: number;              // Cap at 3x
  marginType: 'cross' | 'isolated';
  liquidationBuffer: number;        // 15% above liquidation
  maxFundingRateExposure: number;   // 50% APR max
  marginAlertThresholds: {
    warning: 0.70;
    critical: 0.85;
    emergency: 0.95;
  };
}
```

Wire into: `RiskEngine.checkOrder()`, `PositionMonitor.checkExitConditions()`, `PnlService`

### 6.2 — Hyperliquid REST client
**New file:** `atlas/apps/core-node/src/exchanges/hyperliquid/http/hl-rest.ts`
- EIP-712 typed data signing (requires ethers.js v6)
- Info endpoint: `POST https://api.hyperliquid.xyz/info`
- Exchange endpoint: `POST https://api.hyperliquid.xyz/exchange`

### 6.3 — Hyperliquid WebSocket client
**New file:** `atlas/apps/core-node/src/exchanges/hyperliquid/ws/hl-ws.ts`
- URL: `wss://api.hyperliquid.xyz/ws`
- Channels: allMids, l2Book, trades, userEvents

### 6.4 — Hyperliquid adapter
**New file:** `atlas/apps/core-node/src/exchanges/hyperliquid/hl-adapter.ts`
- Capabilities: supportsShort=true, supportsPerps=true, maxLeverage=50 (config-capped to 3), makerFee=0.0002, takerFee=0.0005

### 6.5 — Extend PositionTracker for perps

**File:** `atlas/apps/core-node/src/trading/position-tracker.ts`
Add: `exchangeId`, `isPerp`, `leverage`, `marginUsed`, `liquidationPrice`, `cumulativeFunding`
Update `calculatePnL()`: `totalPnL = realizedPnL + unrealizedPnL - cumulativeFunding`

### 6.6 — Extend PositionMonitor for perps exits

**File:** `atlas/apps/core-node/src/trading/position-monitor.ts`
Add exit types: `liquidation_buffer`, `funding_rate`, `margin_call`

### 6.7 — Hyperliquid paper mode + ethers.js dependency

### 6.8 — Integration tests

---

## Phase 7: Multi-Exchange Paper Validation (Week 6-7 — Cowork + Cursor)

### 7.1 — Simultaneous paper trading (3 exchanges)
### 7.2 — Per-exchange performance comparison
### 7.3 — Fee impact validation
### 7.4 — Stress testing
- Kill one exchange WS → others continue
- Funding rate spike → auto-reduce
- Margin approaching liquidation → emergency flatten
- All exchanges down → graceful HALTED state

---

## Phase 8: Frontend & Dashboard Fixes (Week 7-8 — Cursor)

### 8.1 — Fix frontend error handling

**File:** `src/runtime/realtime/catchUp.ts` — Line 103
**Issue:** `Promise.all` — single failure kills all parallel queries.
**Fix:** Replace with `Promise.allSettled` and process results individually.

### 8.2 — Fix infinite WebSocket reconnection

**File:** `src/runtime/ws/RuntimeWsClient.ts` — Line 53
**Current:** `maxReconnectAttempts = Infinity`
**Fix:** Cap at 100, add circuit breaker, emit `maxAttemptsReached` event.

### 8.3 — Add error states to UI components

**Files:** `src/hooks/usePositions.ts`, `src/hooks/useOrders.ts`, etc.
**Issue:** Queries throw on error but components don't render error UI.
**Fix:** Add `isError` checks and error boundary components.

### 8.4 — Replace SELECT * with specific columns

**Files:** All Supabase hook files
**Fix:** `.select('id,symbol,side,qty_open,entry_price,...')` per use case.

### 8.5 — Exchange column in UI tables
- Positions, orders, signals, trade history all show `exchangeId`

### 8.6 — Perps-specific UI components
- Margin gauge, funding rate display, liquidation price, leverage indicator, short position indicator

### 8.7 — Multi-exchange health panel

### 8.8 — Fix existing UI bugs
- WS/REST latency dashes → populate from health check
- Kill switch triple notification → deduplicate
- Open Positions stuck loading → clear state on close

---

## Phase 9: Go-Live Preparation (Week 8-9)

### 9.1 — API key setup (Kraken + Hyperliquid wallet)
### 9.2 — Live safety checklist per exchange
### 9.3 — Staged capital rollout
1. Week 1: Kraken live $2,500 — VWAP MR only
2. Week 2: Hyperliquid live $2,500 — trend follow only
3. Week 3: Add breakout on Hyperliquid
4. Week 4: Scale to $10k: $4k Kraken, $6k Hyperliquid

---

## Complete Issue Registry (69 Issues)

### Phase 0 — Security (5 issues)

| # | Issue | Severity | File | Line(s) |
|---|-------|----------|------|---------|
| 1 | `.env` secrets committed to git | CRITICAL | .env | 2-17 |
| 2 | No authentication on API endpoints | CRITICAL | server.ts | 42 |
| 3 | Unrestricted CORS (any origin) | CRITICAL | server.ts | 42 |
| 4 | No request size limit (DoS) | HIGH | server.ts | 43 |
| 5 | Memory leak: event listeners on engine stop | CRITICAL | server.ts | 821-963, 1643 |

### Phase 1 — Trading Logic (17 issues)

| # | Issue | Severity | File | Line(s) |
|---|-------|----------|------|---------|
| 6 | `alwaysAllowStrategies` bypasses regime filter | CRITICAL | regime-filter.ts | 125 |
| 7 | `minCompatibilityScore` = 0.1 (should be 0.3) | CRITICAL | regime-filter.ts | 120 |
| 8 | `minRegimeConfidence` = 0.1 (should be 0.4) | HIGH | regime-filter.ts | 124 |
| 9 | `minPositionMultiplier` = 0.1 (should be 0.25) | MEDIUM | regime-filter.ts | 123 |
| 10 | positionMultiplier never applied to orders | CRITICAL | server.ts | ~1395 |
| 11 | Backtest capital accounting error (ALL P&L WRONG) | CRITICAL | backtest-engine.ts | 345-347 |
| 12 | Daily returns calculated incorrectly | CRITICAL | backtest-engine.ts | 371-380 |
| 13 | Sharpe ratio NaN when stddev=0 | HIGH | backtest-engine.ts | 482-487 |
| 14 | Sortino ratio uses wrong formula | HIGH | backtest-engine.ts | — |
| 15 | VWAP daily reset fails across month boundaries | CRITICAL | technical.ts | 184 |
| 16 | RSI NaN with zero average loss | HIGH | technical.ts | — |
| 17 | Order-manager fill race condition | CRITICAL | order-manager.ts | 157-197 |
| 18 | Position-tracker P&L inverted on flips | HIGH | position-tracker.ts | 299-360 |
| 19 | Risk engine no bounds check (NaN bypass) | CRITICAL | risk-engine.ts | — |
| 20 | TWAP memory leak (zombie timers) | HIGH | order-manager.ts | — |
| 21 | Trade outcome threshold ±$0.01 | MEDIUM | trade-analytics.ts | 390-396 |
| 22 | Ultra-aggressive strategy parameters | CRITICAL | guardrails.yaml | 25-70 |

### Phase 1 continued — More Trading Issues

| # | Issue | Severity | File | Line(s) |
|---|-------|----------|------|---------|
| 23 | Position-monitor exit order race condition | HIGH | position-monitor.ts | 265-344 |
| 24 | Slippage cost confusion in advanced backtest | MEDIUM | advanced-backtest-engine.ts | 540-559 |
| 25 | Signal arbiter strength not normalized | MEDIUM | signal-arbiter.ts | — |
| 26 | paper.local.yaml risk_bp doesn't match guardrails | MEDIUM | paper.local.yaml | 7 |
| 27 | max_position_exposure_pct=0.75 too high | MEDIUM | guardrails.yaml | ~12 |

### Phase 2 — Database & Infrastructure (14 issues)

| # | Issue | Severity | File | Line(s) |
|---|-------|----------|------|---------|
| 28 | `bars` table missing from migrations | HIGH | data-loader.ts | 113-159 |
| 29 | No exchange_id on trading tables | HIGH | migrations/ | — |
| 30 | Missing FK indexes (fills, order_legs, etc.) | HIGH | migrations/ | — |
| 31 | Missing unique constraints (signals, fills) | HIGH | migrations/ | — |
| 32 | Numeric precision issues (DOUBLE vs NUMERIC) | MEDIUM | trade analytics SQL | — |
| 33 | No input validation on config POST endpoints | HIGH | server.ts | 1780+ |
| 34 | No rate limiting on API | MEDIUM | server.ts | — |
| 35 | parseInt without radix | LOW | server.ts | 1835, 1845 |
| 36 | Unbounded WebSocket connections | MEDIUM | server.ts | 230 |
| 37 | npm vs pnpm inconsistency | HIGH | package*.json | — |
| 38 | RLS policies USING(true) overly permissive | MEDIUM | migration 20251016 | 1-143 |
| 39 | auth.users FK constraints dropped | MEDIUM | migration 20251212 | 1-56 |
| 40 | Duplicate table definitions across migrations | MEDIUM | multiple migrations | — |
| 41 | Missing NOT NULL constraints | MEDIUM | 20251013180100 | — |

### Phase 3 — Backtest Infrastructure (7 issues)

| # | Issue | Severity | File | Line(s) |
|---|-------|----------|------|---------|
| 42 | Walk-forward analysis is STUB | MEDIUM | advanced-backtest-engine.ts | 850-880 |
| 43 | API data loading throws "Not implemented" | MEDIUM | advanced-backtest-engine.ts | 276-278 |
| 44 | Backtest endpoint uses synthetic data | HIGH | server.ts | 2828-2978 |
| 45 | PaperTradingSimulator realized P&L TODO | LOW | paper-trading-simulator.ts | 672 |
| 46 | Position sizing ignores open positions | HIGH | backtest-engine.ts | — |
| 47 | No OHLCV data validation | MEDIUM | data-loader.ts | — |
| 48 | Missing data validation on loaded candles | MEDIUM | data-loader.ts | — |

### Phase 4-6 — Exchange Architecture (7 issues)

| # | Issue | Severity | File | Line(s) |
|---|-------|----------|------|---------|
| 49 | OrderManager imports CoinbaseExchange | HIGH | order-manager.ts | 4, 80 |
| 50 | No IExchangeAdapter interface | HIGH | — (new) | — |
| 51 | server.ts hardcodes single exchange | HIGH | server.ts | 1579 |
| 52 | `allow_short` global, not per-exchange | MEDIUM | guardrails.yaml | ~80 |
| 53-55 | Kraken adapter (new feature) | — | — | — |
| 56-62 | Hyperliquid adapter + perps (new feature) | — | — | — |

### Phase 8 — Frontend (7 issues)

| # | Issue | Severity | File | Line(s) |
|---|-------|----------|------|---------|
| 63 | Promise.all in catchUp fails on single error | HIGH | catchUp.ts | 103 |
| 64 | Infinite WS reconnection attempts | HIGH | RuntimeWsClient.ts | 53 |
| 65 | No error states in UI components | MEDIUM | usePositions.ts, etc. | — |
| 66 | SELECT * on all queries | MEDIUM | all hooks | — |
| 67 | WS/REST latency shows dashes | LOW | frontend | — |
| 68 | Kill switch triple notification | LOW | frontend | — |
| 69 | Duplicate WebSocket implementations | LOW | tradingApi.ts + RuntimeWsClient.ts | — |

### Config/DevOps Issues (not blocking trading, fix as time allows)

| # | Issue | Severity | File |
|---|-------|----------|------|
| 70 | K8s deployment placeholders (YOUR_ORG) | HIGH | deploy/k8s/*.yaml |
| 71 | K8s ingress domain placeholder | HIGH | deploy/k8s/ingress.yaml |
| 72 | Missing backend .env.local.example vars | MEDIUM | atlas/.env.local.example |
| 73 | TypeScript strictness mismatch (FE lax) | MEDIUM | tsconfig files |
| 74 | ESLint disables unused-vars | LOW | eslint.config.js |
| 75 | Tailwind content paths wrong | LOW | tailwind.config.ts |
| 76 | Prometheus metrics may not exist | LOW | deploy/monitoring/alertrules.yaml |
| 77 | No CI/CD pipeline | MEDIUM | — (missing) |
| 78 | No docker-compose for local dev | LOW | — (missing) |
| 79 | HTML meta description says "Lovable" | LOW | index.html |
| 80 | 10s graceful shutdown may be insufficient | LOW | server.ts | 3418-3421 |

---

## Execution Timeline

| Phase | Work | Tool | Timeline |
|-------|------|------|----------|
| 0. Emergency security fixes | Secrets, auth, CORS, memory leak | Cursor | Day 1 |
| 1. Fix critical trading bugs | 17 code fixes across 8 files | Cursor | Days 2-3 |
| 2. Database & infra fixes | Migrations, validation, rate limiting | Cursor | Days 3-4 |
| 3. Backtest validation | Fix engine + run analysis | Cowork + Cursor | Week 2 |
| 4. Exchange abstraction | Registry, interfaces, refactor | Cursor | Week 3 |
| 5. Kraken adapter | REST + WS + adapter + tests | Cursor | Week 3-4 |
| 6. Hyperliquid adapter | REST + WS + perps risk + tests | Cursor | Week 4-6 |
| 7. Multi-exchange paper | Simultaneous trading + analysis | Cowork + Cursor | Week 6-7 |
| 8. Frontend fixes | Error handling, UI, health panel | Cursor | Week 7-8 |
| 9. Go-live preparation | Keys, checklist, staged rollout | Both | Week 8-9 |

## Cowork vs Cursor Ownership

**Cowork:** Backtest analysis (Phase 3), fee sensitivity, Monte Carlo, multi-exchange comparison (Phase 7), strategy validation, architecture review between phases.

**Cursor:** All code changes (Phases 0-2, 4-6, 8), tests, adapters, configs, migrations.

**Joint:** Phase 3 (Cursor fixes backtester, Cowork runs analysis), Phase 7 (Cursor runs engine, Cowork analyzes), Phase 9 (Cursor deploys, Cowork monitors).
