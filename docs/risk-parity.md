# Risk Parity: Paper/Live Mode Equivalence

This document specifies the risk system's paper/live parity guarantees. **Paper mode behavior is identical to live mode by default.** Any divergence must be through explicit configuration flags.

## Design Principle

> If paper mode trips a guardrail at -2R, live mode will also trip at -2R given the same inputs.

Paper trading is trustworthy. You can run paper for hours and know that live mode would behave identically.

## Guardrail Inventory

| Guardrail | Evaluated In | Threshold Source | Action When Tripped | Paper/Live Divergence |
|-----------|--------------|------------------|---------------------|----------------------|
| Daily Stop (R-based) | `evaluate-risk.ts` | `guardrails.risk.daily_loss_limit` | HALT_TRADING (daily) | None |
| Daily Stop (USD) | `evaluate-risk.ts` | Computed from equity | HALT_TRADING (daily) | None |
| Weekly Stop | `evaluate-risk.ts` | `guardrails.risk.weekly_loss_limit` | HALT_TRADING | None |
| Max Drawdown | `evaluate-risk.ts` | `guardrails.risk.max_drawdown_limit` | HALT_TRADING | None |
| Consecutive Losses | `evaluate-risk.ts` | `circuit_breakers.max_consecutive_losses` | HALT_TRADING | None |
| Error Rate | `evaluate-risk.ts` | 20% (hardcoded) | HALT_TRADING | Override flag available |
| Latency | `evaluate-risk.ts` | `circuit_breakers.data_gap_sec * 1000` | HALT_TRADING | Override flag available |
| Data Gap | `evaluate-risk.ts` | `circuit_breakers.data_gap_sec * 1000` | HALT_TRADING | Override flag available |
| Max Exposure | `evaluate-risk.ts` | `equity * max_account_leverage` | BLOCK_ENTRY | None |
| Max Open Positions | `evaluate-risk.ts` | `account.max_open_positions` | BLOCK_ENTRY | None |
| Max Open Orders | `evaluate-risk.ts` | `account.max_open_positions` | BLOCK_ENTRY | None |
| Per-Symbol Loss | `evaluate-risk.ts` | `per_symbol[X].max_daily_loss_usd` | BLOCK_ENTRY (symbol) | None |
| Position Notional | `evaluate-risk.ts` | `risk.max_position_exposure_pct * equity` | BLOCK_ENTRY | None |
| Order Notional Min | `evaluate-risk.ts` | `risk_per_trade * equity * min_notional_buffer` | BLOCK_ENTRY | None |
| Order Notional Max | `evaluate-risk.ts` | `max_position_exposure_pct * equity` | BLOCK_ENTRY | None |
| Shorts Allowed | `risk-engine.ts` | `strategy.allow_short` | BLOCK_ENTRY | None |
| Soft Launch | `risk-engine.ts` | Env/code config | Reduced sizing | Override flag available |
| Kill Switch Persistence | `risk-state.ts` | Supabase | Restore HALTED on start | Override flag available |

## Explicit Paper Override Flags

These are the **ONLY** allowed divergences between paper and live. All default to `false` (parity behavior).

| Flag | Default | Description |
|------|---------|-------------|
| `PAPER_RESET_RISK_STATE_ON_START` | `false` | If true, paper mode clears halts on startup instead of restoring persisted state |
| `PAPER_DISABLE_ERROR_RATE_LIMIT` | `false` | If true, paper mode ignores error rate guardrail |
| `PAPER_DISABLE_LATENCY_LIMIT` | `false` | If true, paper mode ignores latency guardrail |
| `PAPER_DISABLE_DATA_GAP_LIMIT` | `false` | If true, paper mode ignores market data staleness guardrail |
| `PAPER_DISABLE_SOFT_LAUNCH` | `false` | If true, paper mode skips soft launch constraints |

### Setting Override Flags

```bash
# In .env or environment
PAPER_RESET_RISK_STATE_ON_START=true  # Clear halts on paper startup (for dev convenience)
```

### Transparency

Active overrides are:
1. Logged on engine startup
2. Included in `/api/status` response
3. Surfaced in risk evaluation results

## Standardized Definitions

These definitions are consistent across paper and live modes.

### Error Rate

```
error_rate = (error_events / total_operations) * 100
```

**Error events** (rolling 5-minute window):
- Exchange REST hard failures (timeout/5xx/429 after retries)
- WebSocket disconnect/stall events
- Order placement failures (after retries)
- Internal engine loop exceptions

**Total operations**:
- REST calls + WS messages + order actions in window

**Threshold**: 20% (triggers HALT_TRADING)

### Latency

```
avg_latency = mean(REST_request_latencies) in rolling window
```

Measured in milliseconds. Both paper and live measure actual exchange API latency.

**Threshold**: `circuit_breakers.data_gap_sec * 1000` ms (triggers HALT_TRADING)

### Market Data Staleness

```
staleness = now() - lastMarketDataAt
```

Both paper and live use the same market data feed (Coinbase production). The staleness is identical.

**Threshold**: `circuit_breakers.data_gap_sec * 1000` ms (triggers HALT_TRADING)

## Risk Evaluation Pipeline

The risk system uses a **pure evaluation function** that is mode-agnostic.

### Input: RiskEvaluationSnapshot

```typescript
interface RiskEvaluationSnapshot {
  ts: number;
  sessionId: string;
  executionMode: 'paper' | 'live';  // Only used for explicit overrides
  
  // Canonical P&L
  dayStartEquityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  dailyPnlUsd: number;
  dailyPnlR: number;
  riskUnitUsd: number;
  maxDrawdownPct: number;
  weeklyPnlUsd: number;
  
  // Exposure & Positions
  exposureUsd: number;
  exposureBySymbolUsd: Record<string, number>;
  openPositionsCount: number;
  openOrdersCount: number;
  
  // Stats
  consecutiveLosses: number;
  errorRatePct: number;
  avgLatencyMs: number;
  marketDataStaleMs: number;
  dailyLossPerSymbolUsd: Record<string, number>;
}
```

### Output: RiskDecision

```typescript
type RiskDecision =
  | { type: 'ALLOW' }
  | { type: 'BLOCK_ENTRY'; reasons: string[] }
  | { type: 'HALT_TRADING'; reasonCode: string; reasonText: string; daily: boolean };
```

### Evaluation Flow

```
RiskSnapshot (paper) ─┐
                      ├─> evaluateRisk() ─> RiskDecision
RiskSnapshot (live) ──┘
                    (same function, same thresholds)
```

The `executionMode` field is **only** used when paper override flags are enabled.

## Parity Tests

The test file `src/__tests__/risk-parity.test.ts` contains 36+ tests that verify:

1. **Same inputs → Same outputs**: Paper and live produce identical decisions
2. **Threshold precision**: Guardrails trigger at exact thresholds
3. **Override isolation**: Paper overrides only affect paper mode
4. **Default parity**: With default flags, paper equals live

### Running Parity Tests

```bash
cd atlas/apps/core-node
npx vitest run src/__tests__/risk-parity.test.ts
```

### Test Matrix

Each guardrail is tested with:
- Paper mode snapshot
- Live mode snapshot
- Assertion: `paperResult.decision === liveResult.decision`

## Kill Switch Behavior

Kill switch halts trading, not runtime:

| When HALTED | Status |
|-------------|--------|
| New entries | ❌ Blocked |
| Exits (reduce-only) | ✅ Allowed |
| Runtime | ✅ Running |
| WebSocket | ✅ Connected |
| Status heartbeat | ✅ Active |
| Market data | ✅ Flowing |

### Persistence Parity

By default, both paper and live:
1. Persist halt state to `risk_events` table
2. Restore halt state on startup
3. Auto-clear daily halts on day rollover
4. Require manual reset for non-daily halts

The `PAPER_RESET_RISK_STATE_ON_START=true` flag allows paper to start fresh (for dev convenience).

## API Status

`/api/status` includes:

```json
{
  "executionMode": "paper",
  "risk": {
    "tradingState": "HALTED",
    "reasonCode": "daily_stop",
    "reasonText": "Daily P&L -2.00R <= threshold -2R",
    "since": 1706832000000,
    "daily": true,
    "dayStartEquityUsd": 50000,
    "riskUnitUsd": 500,
    "dailyPnlUsd": -1000,
    "dailyPnlR": -2.0,
    "realizedPnlUsd": -800,
    "unrealizedPnlUsd": -200
  },
  "paperOverrides": {
    "resetRiskStateOnStart": false,
    "disableErrorRateLimit": false,
    "disableLatencyLimit": false,
    "disableDataGapLimit": false,
    "disableSoftLaunch": false
  }
}
```

## Migration Notes

### Before (Pre-Step 6)

```typescript
// DIVERGENT: Paper ignored persisted kill switch
ignorePersistedKillSwitch: this.config.mode === 'paper'

// DIVERGENT: Error rate disabled in paper (101% impossible)
errorRateLimit: this.config.mode === 'paper' ? 101 : 20

// DIVERGENT: Different exposure in paper
maxTotalExposureUsd: this.config.mode === 'paper' ? accountEquity : accountEquity * leverage

// DIVERGENT: Soft launch only in live
const softLaunch = this.config.mode === 'live' ? {...} : undefined
```

### After (Step 6)

```typescript
// PARITY: Explicit flag, defaults to false
ignorePersistedKillSwitch: isPaper && paperOverrides.resetRiskStateOnStart

// PARITY: Same limit, explicit flag to override
errorRateLimit: (isPaper && paperOverrides.disableErrorRateLimit) ? 101 : 20

// PARITY: Same exposure calculation
maxTotalExposureUsd: accountEquity * leverage

// PARITY: Same soft launch, explicit flag to disable
const enableSoftLaunch = isPaper ? !paperOverrides.disableSoftLaunch : true
```

## Verification Checklist

When modifying risk logic, verify:

- [ ] No `if (paper)` without explicit override flag
- [ ] Parity tests still pass
- [ ] New guardrails added to inventory
- [ ] Override flags documented if needed
- [ ] `/api/status` reflects changes
