# Risk System

This document describes the unified risk system introduced in Step 5 of the stabilization plan.

**Related documentation:**
- [Risk Parity (Paper/Live)](./risk-parity.md) - Paper/live mode equivalence specification
- [Persistence System](./persistence.md) - Supabase write layer and metrics ownership

## Design Philosophy

**Kill switch halts trading, not the runtime.**

When risk limits trip:
- New entries are blocked
- Reduce-only exits are allowed
- Positions can be flattened if configured
- Runtime stays alive
- WebSocket stays connected
- Status heartbeat continues
- UI shows clear "HALTED" state with reason

## Risk State Machine

The system uses an explicit state machine for trading permissions.

### Trading States

| State | Description | Entries | Exits |
|-------|-------------|---------|-------|
| `RUNNING` | Normal operation | ✅ | ✅ |
| `PAUSED` | Temporarily paused | ❌ | ✅ |
| `HALTED` | Risk limit triggered | ❌ | ✅ |

### Halt Reason Codes

| Code | Description | Daily? |
|------|-------------|--------|
| `daily_stop` | Daily P&L limit hit | ✅ |
| `weekly_stop` | Weekly P&L limit hit | ❌ |
| `max_drawdown` | Max drawdown exceeded | ❌ |
| `consecutive_losses` | Too many losses in a row | ❌ |
| `rapid_loss` | Lost too much too fast | ✅ |
| `error_rate` | Too many order errors | ❌ |
| `latency` | Latency too high | ❌ |
| `data_gap` | Market data stale | ❌ |
| `manual_killswitch` | User-triggered halt | ❌ |

**Daily halts** auto-clear on risk day rollover. Non-daily halts require manual reset.

## Risk Math (R Units)

All risk calculations use a consistent "R" unit system.

### Key Definitions

```
1R = per_trade_risk × day_start_equity
```

For example, with $50,000 equity and 1% per-trade risk:
```
1R = 0.01 × $50,000 = $500
```

### Converting Between USD and R

```typescript
dailyPnlR = dailyPnlUsd / riskUnitUsd
```

A loss of $1,000 with 1R = $500:
```
dailyPnlR = -$1,000 / $500 = -2R
```

### Daily Stop Threshold

Daily stop is configured as a fraction of equity (e.g., 0.02 = 2%).

Converted to R:
```
thresholdR = -(dailyLossLimit / perTradeRisk)
           = -(0.02 / 0.01)
           = -2R
```

**IMPORTANT**: `per_trade_risk` in config is a **FRACTION** (0.01 = 1%), not a percentage.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `RISK_DAY_TZ` | `UTC` | Timezone for risk day |
| `RISK_DAY_ROLLOVER_HOUR` | `0` | Hour at which risk day rolls over |
| `RISK_DISABLE_ERROR_RATE_IN_PAPER` | `false` | Disable error rate halt in paper mode |
| `RISK_RESET_KILLSWITCH_ON_PAPER_START` | `false` | Clear halt on paper mode start |

### Guardrails Config

```yaml
risk:
  daily_loss_limit: 0.02      # 2% = -2R with 1% per trade
  max_drawdown_limit: 0.05    # 5% drawdown limit
  weekly_loss_limit: 0.04     # 4% weekly limit

account:
  risk_per_trade: 0.01        # 1% per trade = 1R
  equity_usd: 50000           # Starting equity
```

## API Status

The `/api/status` endpoint includes comprehensive risk state:

```json
{
  "risk": {
    "tradingState": "HALTED",
    "reasonCode": "daily_stop",
    "reasonText": "Daily P&L limit hit: -2.00R (threshold: -2R)",
    "since": 1706832000000,
    "daily": true,
    "context": {
      "dailyPnlUsd": -1000,
      "dailyPnlR": -2.0,
      "thresholdR": -2.0
    },
    "dayStartEquityUsd": 50000,
    "riskUnitUsd": 500,
    "perTradeRiskPct": 1.0,
    "dailyPnlUsd": -1000,
    "dailyPnlR": -2.0,
    "realizedPnlUsd": -800,
    "unrealizedPnlUsd": -200,
    "drawdownPct": 0.02
  }
}
```

## Day Rollover

The risk day boundary is configurable:

- `RISK_DAY_TZ`: Timezone (default: UTC)
- `RISK_DAY_ROLLOVER_HOUR`: Hour (0-23, default: 0)

### Rollover Behavior

1. Previous day's `daily_equity.end_equity` is written
2. New day's `daily_equity.start_equity` is initialized
3. Daily counters (dailyPnl) are reset
4. `HALTED.daily=true` states are auto-cleared
5. Non-daily halts persist until manual reset

## Persistence

### Tables

**`risk_metrics`**: Current risk state
- `daily_pnl`: Daily P&L in USD
- `max_drawdown`: Max drawdown percentage
- `consecutive_losses`: Current loss streak
- `kill_switch_active`: Whether trading is halted
- `exposure_usd`: Current total exposure

**`risk_events`**: Halt/resume history
- `event_type`: Reason code
- `details`: Context JSON
- `triggered_at`: When halt occurred
- `cleared_at`: When reset/rolled over

**`daily_equity`**: Daily equity tracking
- `date`: Risk day (YYYY-MM-DD)
- `start_equity`: Equity at day start
- `end_equity`: Equity at day end

## Prometheus Metrics

```
# Halt/reset counters
atlas_risk_halt_total{reason_code="daily_stop"}
atlas_risk_reset_total{reason_code="daily_stop"}
atlas_daily_rollover_total

# State gauge (0=running, 1=paused, 2=halted)
atlas_risk_state
```

## Code Architecture

```
trading/
├── risk-state.ts       # State machine (RUNNING/PAUSED/HALTED)
├── risk-math.ts        # Canonical R calculations
├── risk-engine.ts      # Integration with trading engine
└── risk-controller.ts  # Extended analytics (optional)
```

### Usage Example

```typescript
import { RiskStateMachine, createDailyStopHalt } from './risk-state';
import { RiskMath, computeDailyStopThresholdR } from './risk-math';

// Initialize
const riskMath = new RiskMath({
  accountEquityUsd: 50000,
  perTradeRiskFraction: 0.01,
  logger,
});

const stateMachine = new RiskStateMachine({ logger });

// Compute snapshot on each tick
const snapshot = riskMath.computeSnapshot(realizedPnl, unrealizedPnl);

// Check daily stop
const thresholdR = computeDailyStopThresholdR(0.02, 0.01); // -2R
if (riskMath.isDailyStopTriggered(thresholdR)) {
  const halt = createDailyStopHalt(
    snapshot.dailyPnlUsd,
    snapshot.dailyPnlR,
    thresholdR
  );
  stateMachine.halt(halt.reasonCode, halt.reasonText, halt.daily, halt.context);
}

// Check permissions
if (stateMachine.canEnterTrades()) {
  // Place entry order
}

if (stateMachine.canExitTrades()) {
  // Place exit order (always allowed)
}
```

## Paper/Live Parity

By default, paper and live modes have **identical** risk behavior:

- Same thresholds trigger at the same R values
- Same halt persistence rules
- Same day rollover behavior

Explicit opt-out flags (off by default):
- `RISK_DISABLE_ERROR_RATE_IN_PAPER`
- `RISK_RESET_KILLSWITCH_ON_PAPER_START`

## Recovery

### Automatic (Day Rollover)
- Daily halts auto-clear at day boundary
- No manual intervention needed

### Manual Reset
```bash
# Via API
curl -X POST http://localhost:3001/api/killswitch/deactivate \
  -H "Content-Type: application/json" \
  -d '{"confirm": true}'

# Via supervisor endpoint
curl -X POST http://localhost:3001/api/supervisor/reset-restarts
```

### Safety Gates
- Live mode requires explicit confirmation
- Cannot resume without `force=true` for non-daily halts
- All resets are logged and persisted
