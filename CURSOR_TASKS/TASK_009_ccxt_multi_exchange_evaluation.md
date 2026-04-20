# TASK_009: CCXT Multi-Exchange Evaluation & Expansion Layer

**Priority:** LOW — Scaling play. Only justified after live trading validates core engine.
**Status:** PARKED (Month 2+ — begin after Hyperliquid is live and producing real P&L)
**Depends on:** TASK_007 (Hyperliquid live), validated live trading track record
**Created:** 2026-03-24 by Cowork (Architecture AI)
**Phase:** 6 — Open-Source Integration Sprint 4

---

## Context

CCXT (`github.com/ccxt/ccxt`, 41K+ stars) provides a unified API across 107+ exchanges including Binance, Bybit, OKX, Kraken, Coinbase, and Hyperliquid. The strategic question is whether to use CCXT as a rapid expansion layer for accessing additional exchanges, or to continue building bespoke adapters (the pattern established by CoinbaseAdapter and HyperliquidAdapter).

### The Case For CCXT

- **Breadth:** Instant access to dozens of exchanges through one interface
- **Velocity:** New exchange adapters take hours instead of days
- **Community:** Massive community maintains exchange-specific quirks
- **Hyperliquid included:** CCXT supports Hyperliquid, meaning we could replace our bespoke adapter with CCXT if the abstraction overhead is acceptable

### The Case Against CCXT (Right Now)

- **Abstraction overhead:** Our `IExchangeAdapter` pattern is tight and purpose-built for low-latency execution. CCXT adds a generalization layer that may obscure exchange-specific behavior.
- **Node.js version:** CCXT is a large package (~70MB). It may pull in dependencies that conflict with our lean Node 20+ stack.
- **We only need 2-3 exchanges:** Coinbase, Hyperliquid, and maybe Binance/Bybit. Three bespoke adapters is manageable. CCXT's value emerges at 5+ exchanges.
- **Premature optimization:** Building a multi-exchange routing layer before proving the engine makes money on even one exchange is the definition of scope expansion.

### Decision Framework

CCXT makes sense when ALL of these are true:
1. Live trading on Hyperliquid is producing consistent positive P&L for 30+ days
2. There's a strategic reason to expand to 3+ exchanges (arbitrage, liquidity, diversification)
3. The team has capacity to test and maintain multiple exchange connections
4. The bespoke adapter approach is becoming a bottleneck

Until all four are true, this task remains PARKED.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** install CCXT until the evaluation is approved
2. **DO NOT** replace the CoinbaseAdapter or HyperliquidAdapter with CCXT
3. **DO NOT** modify the `IExchangeAdapter` interface to accommodate CCXT
4. CCXT adapters should implement `IExchangeAdapter` exactly like bespoke adapters
5. This task is an EVALUATION — the output is a decision document, not production code

---

## Step 1: Evaluation — SDK Assessment

When this task is unparked, start with a pure evaluation (no production code):

### 1A: Install CCXT in a Branch

```bash
cd atlas/apps/core-node
git checkout -b evaluate/ccxt-integration
pnpm add ccxt
```

### 1B: Evaluate Package Impact

Check:
- Install size (`du -sh node_modules/ccxt`)
- Import time (benchmark `import ccxt from 'ccxt'` cold start)
- Tree-shaking: Can we import only specific exchanges? (`import { binance } from 'ccxt'`)
- TypeScript types: Quality of type definitions
- ESM compatibility with our `"type": "module"` setup

### 1C: Evaluate API Surface

Run a quick script that tests CCXT against Hyperliquid testnet and compares the results to our bespoke adapter:

```typescript
import ccxt from 'ccxt';

const exchange = new ccxt.hyperliquid({
  walletAddress: process.env.HYPERLIQUID_WALLET_ADDRESS,
  privateKey: process.env.HYPERLIQUID_PRIVATE_KEY,
  sandbox: true,
});

// Compare these to our bespoke adapter output:
const markets = await exchange.loadMarkets();
const ticker = await exchange.fetchTicker('ETH/USDC:USDC');
const orderbook = await exchange.fetchOrderBook('ETH/USDC:USDC');
const ohlcv = await exchange.fetchOHLCV('ETH/USDC:USDC', '5m', undefined, 100);
const balance = await exchange.fetchBalance();

console.log('Markets:', Object.keys(markets).length);
console.log('Ticker:', ticker);
console.log('Orderbook depth:', orderbook.bids.length, 'bids', orderbook.asks.length, 'asks');
console.log('OHLCV candles:', ohlcv.length);
console.log('Balance:', balance);
```

### 1D: Measure Latency Overhead

Compare CCXT vs bespoke adapter for the same operations:

```typescript
// Bespoke adapter
const t1 = Date.now();
const bespokeResult = await hyperliquidAdapter.getTicker('ETH-USD');
const bespokeLatency = Date.now() - t1;

// CCXT
const t2 = Date.now();
const ccxtResult = await ccxtExchange.fetchTicker('ETH/USDC:USDC');
const ccxtLatency = Date.now() - t2;

console.log(`Bespoke: ${bespokeLatency}ms, CCXT: ${ccxtLatency}ms, Overhead: ${ccxtLatency - bespokeLatency}ms`);
```

Run this 100 times and compute mean/p99 latency for each.

---

## Step 2: Design — CCXT Adapter Wrapper (If Evaluation Passes)

If the evaluation shows acceptable overhead (<50ms additional latency, <100MB package size), design a generic CCXT adapter wrapper that implements `IExchangeAdapter`.

### Architecture

```
IExchangeAdapter
├── CoinbaseAdapter (bespoke — keep)
├── HyperliquidAdapter (bespoke — keep)
└── CcxtAdapter (generic wrapper)
    ├── CcxtAdapter<'binance'>
    ├── CcxtAdapter<'bybit'>
    ├── CcxtAdapter<'okx'>
    └── CcxtAdapter<'kraken'>
```

The `CcxtAdapter` would be a generic wrapper that takes an exchange ID and delegates all methods to the CCXT unified API. Exchange-specific overrides can be injected via configuration.

### Proposed File Structure

```
atlas/apps/core-node/src/exchanges/ccxt/
├── index.ts                    # CcxtAdapter generic class
├── types.ts                    # CCXT → Adapter type mappings
├── exchange-configs/           # Per-exchange config overrides
│   ├── binance.ts
│   ├── bybit.ts
│   └── okx.ts
└── __tests__/
    ├── ccxt-adapter.test.ts
    └── type-mapping.test.ts
```

### CcxtAdapter Class Sketch

```typescript
/**
 * Generic CCXT Exchange Adapter
 *
 * Wraps any CCXT-supported exchange into the IExchangeAdapter interface.
 * Used for rapid exchange expansion after bespoke adapters prove the pattern.
 *
 * NOT a replacement for bespoke adapters — those remain for primary exchanges
 * where we need maximum control (Coinbase, Hyperliquid).
 */

import { EventEmitter } from 'events';
import ccxt from 'ccxt';
import { IExchangeAdapter, ExchangeCredentials, ... } from '../types';

export class CcxtAdapter extends EventEmitter implements IExchangeAdapter {
  readonly id: string;
  readonly name: string;
  readonly exchangeType: 'spot' | 'perpetual';

  private exchange: ccxt.Exchange;

  constructor(exchangeId: string, config?: Record<string, any>) {
    super();
    this.id = exchangeId;
    this.name = exchangeId;
    this.exchangeType = 'spot'; // Override per exchange

    // Create CCXT exchange instance
    const ExchangeClass = ccxt[exchangeId as keyof typeof ccxt] as any;
    if (!ExchangeClass) {
      throw new Error(`CCXT exchange '${exchangeId}' not found`);
    }
    this.exchange = new ExchangeClass(config);
  }

  async initialize(credentials: ExchangeCredentials): Promise<void> {
    this.exchange.apiKey = credentials.apiKey;
    this.exchange.secret = credentials.apiSecret;
    if (credentials.password) this.exchange.password = credentials.password;
    await this.exchange.loadMarkets();
    this.emit('connected');
  }

  async getMarkets(): Promise<AdapterMarketInfo[]> {
    const markets = this.exchange.markets;
    return Object.values(markets).map(m => ({
      symbol: m.symbol,
      baseCurrency: m.base,
      quoteCurrency: m.quote,
      minOrderSize: m.limits?.amount?.min?.toString() || '0',
      maxOrderSize: m.limits?.amount?.max?.toString() || '999999',
      tickSize: m.precision?.price?.toString() || '0.01',
      stepSize: m.precision?.amount?.toString() || '0.001',
      makerFee: (m.maker || 0).toString(),
      takerFee: (m.taker || 0).toString(),
      exchangeType: m.type === 'swap' ? 'perpetual' : 'spot',
    }));
  }

  async placeOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    const ccxtOrder = await this.exchange.createOrder(
      order.symbol,
      order.type,
      order.side,
      parseFloat(order.size),
      order.price ? parseFloat(order.price) : undefined
    );
    return mapCcxtOrder(ccxtOrder);
  }

  // ... map all other IExchangeAdapter methods to CCXT equivalents
}
```

---

## Step 3: Evaluate Target Exchanges

If CCXT integration proceeds, evaluate these exchanges in priority order:

| Exchange | Why | CCXT Support | Fee Tier |
|----------|-----|-------------|----------|
| **Binance** | Highest liquidity globally | Excellent | 0.10% taker |
| **Bybit** | Low fees, perps focus | Good | 0.06% taker |
| **OKX** | Strong perps, good API | Good | 0.08% taker |
| **Kraken** | US-accessible, good spreads | Good | 0.26% taker |
| **dYdX** | Decentralized perps, low fees | Experimental | 0.05% taker |

Each exchange should be evaluated against:
1. Fee impact on strategy profitability (run backtest at exchange fee tier)
2. Liquidity depth for our target pairs (ETH, BTC)
3. API reliability and WebSocket quality
4. Regulatory accessibility from the US
5. Withdrawal/deposit friction

---

## Step 4: Multi-Exchange Router (Future Architecture)

If we expand to 3+ exchanges, we'll need a routing layer that decides WHERE to execute each trade:

```
Signal → RiskEngine → OrderManager → ExchangeRouter → BestExchange
                                          ↓
                                    ┌─────┴─────┐
                                    │  Routing   │
                                    │  Strategy  │
                                    └─────┬─────┘
                              ┌───────┬───┴───┬──────┐
                              │       │       │      │
                           Coinbase  HL   Binance  Bybit
```

Routing strategies:
- **Best price:** Route to exchange with best bid/ask for the symbol
- **Lowest fee:** Route to exchange with lowest effective fee
- **Liquidity-aware:** Route to exchange with sufficient depth for the order size
- **Latency-aware:** Route to exchange with lowest observed fill latency
- **Split execution:** Split large orders across multiple exchanges

This is a Phase 7+ architecture concern. Do NOT implement until there are 3+ live exchanges.

---

## Decision Document Template

When this task is unparked, the evaluation should produce a formal decision document:

```markdown
# CCXT Integration Decision — [DATE]

## Evaluation Results

### Package Impact
- Install size: ___MB
- Cold import time: ___ms
- Tree-shaking: yes/no
- TypeScript quality: good/fair/poor

### Latency Overhead (vs Bespoke)
- getTicker: +___ms average, +___ms p99
- placeOrder: +___ms average, +___ms p99
- getOrderBook: +___ms average, +___ms p99

### API Coverage
- [ ] Market data (tickers, orderbooks, candles)
- [ ] Order placement (limit, market, stop)
- [ ] Order management (cancel, status)
- [ ] Account (balances, positions)
- [ ] WebSocket (real-time updates)

### Decision
- [ ] PROCEED — CCXT overhead acceptable, implement CcxtAdapter
- [ ] DEFER — Overhead too high, maintain bespoke adapters
- [ ] HYBRID — Use CCXT for data, bespoke for execution

### Justification
[Why this decision was made]
```

---

## Verification Script

Create `CURSOR_TASKS/verify/verify_009.sh`:

```bash
#!/usr/bin/env bash
set -e

echo "=== TASK_009 Verification ==="

# This task is an EVALUATION — verify the decision document exists
echo -n "1. Decision document created... "
if [ -f "atlas/apps/core-node/CCXT_EVALUATION.md" ] || \
   [ -f "docs/CCXT_EVALUATION.md" ]; then
  echo "PASS"
else
  echo "FAIL — no evaluation document found"
  exit 1
fi

# If CCXT was installed, verify it doesn't break existing tests
echo -n "2. Existing tests still pass... "
cd atlas/apps/core-node
if pnpm test --reporter=dot 2>&1 | grep -q "failed"; then
  echo "FAIL — existing tests broken after evaluation"
  exit 1
else
  echo "PASS"
fi
cd ../../..

echo ""
echo "=== All TASK_009 checks passed ==="
```

---

## Execution Order (When Unparked)

1. **Step 1A-1D** — Pure evaluation (no production code changes)
2. Produce decision document
3. **If PROCEED:** Steps 2-4 (adapter wrapper, exchange configs, routing design)
4. **If DEFER:** Close this task, revisit in 30 days

**This task does NOT produce production code unless the evaluation recommends proceeding.**
