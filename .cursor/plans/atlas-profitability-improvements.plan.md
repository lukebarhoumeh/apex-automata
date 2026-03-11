---
name: ""
overview: ""
todos: []
isProject: false
---

# AtlasBot Profitability Improvements Plan

> **Goal**: Transform AtlasBot from a ~95% complete system to a production-ready, profitable trading bot.
> **Focus**: Profitability, full usability, and functionality.

---

## Executive Summary

After thorough code review, the strategy document is ~90% accurate. The system has more sophistication than described (soft-launch mode, trailing equity stops, MTF alignment, per-symbol limits). The gaps are:

1. **Minor code bugs** that could cause subtle issues
2. **Missing per-asset tuning** (all symbols share parameters)
3. **No signal deconfliction** (strategies can fight each other)
4. **No higher-timeframe strategy** (misses multi-day moves)
5. **ML pipeline incomplete** (ONNX infra exists but no trained model)

---

## PHASE 1: Clarifications & Minor Corrections

### 1.1 Fix Momentum Strategy Type Mismatch

**Problem**: In `regime-filter.ts`, `momentum` is classified as `trend_following`:

```typescript
// regime-filter.ts lines 52-59
const STRATEGY_TYPES: Record<string, StrategyType> = {
  'breakout': 'trend_following',
  'momentum': 'trend_following',  // ← WRONG
  ...
};
```

But `MomentumStrategy` marks `ranging` as `optimal` (multiplier 1.0). This creates a conflict:

- RegimeFilter blocks momentum in ranging (trend_following × ranging = 0.3)
- MomentumStrategy says ranging is optimal

**Solution**: Reclassify momentum as `neutral` OR create a new `oscillator` type with its own compatibility matrix.

**Recommendation**: Create new type `oscillator` with:

```typescript
'ranging': { oscillator: 0.9 },      // Nearly optimal
'weak_trend': { oscillator: 1.0 },   // Optimal  
'strong_trend': { oscillator: 0.6 }, // Cautious
'choppy': { oscillator: 0.5 },       // Half position
```

**Files to modify**:

- `atlas/apps/core-node/src/strategies/regime-filter.ts`

---

### 1.2 Add Missing bbMiddle to VWAP Strategy

**Problem**: When `useBollinger: true`, the code uses `bbMiddle` but doesn't declare it in `requiredIndicators`:

```typescript
// vwap-mr-strategy.ts lines 100-105
readonly requiredIndicators: IndicatorRequirement[] = [
  { name: 'vwap', required: true, ... },
  { name: 'bbUpper', required: false, ... },
  { name: 'bbLower', required: false, ... },
  // bbMiddle is MISSING but used at line 159
];
```

**Solution**: Add `bbMiddle` to the indicator requirements.

**Files to modify**:

- `atlas/apps/core-node/src/strategies/plugins/builtin/vwap-mr-strategy.ts`

---

### 1.3 Verify ONNX MetaLabel Model Status

**Current State**:

- `atlas/apps/core-node/src/ml/meta-label.ts` - Full inference infrastructure ✓
- Model loading from `config.modelPath` - Implemented ✓
- Feature extraction and normalization - Implemented ✓
- **Missing**: Actual trained `.onnx` model file

**Action Required**:

1. Check if `.onnx` file exists in config path
2. If not, document that ML filtering is currently disabled (falls back to rule-based)
3. Add clear console warning at startup if model missing

**Files to check/modify**:

- `atlas/apps/core-node/src/ml/meta-label.ts` (add startup warning)
- Config files for `metaLabeling.modelPath`

---

### 1.4 Document Coinbase Spot Short Limitation

**Current State**:

- `guardrails.yaml` has `allow_short: false`
- `risk-engine.ts` correctly blocks shorts when disabled
- Strategies still generate `sell` signals

**Clarification Needed**:

- `sell` signals on flat position = no action (can't short on Coinbase spot)
- `sell` signals on long position = close position (valid)

**Action**: Add comment in guardrails.yaml explaining this is a platform limitation, not a strategy choice.

**Files to modify**:

- `atlas/config/guardrails.yaml` (add documentation comment)

---

## PHASE 2: Per-Asset Parameter Calibration

### Rationale

BTC, ETH, and SOL have different volatility profiles:

- **BTC**: Lower volatility, more institutional, needs tighter ATR multipliers
- **ETH**: Medium volatility, follows BTC but with beta > 1
- **SOL**: Highest volatility, needs wider stops, higher volume thresholds

Currently, all three share the same strategy parameters. This leaves money on the table.

### 2.1 Extend BaseStrategy for Per-Symbol Overrides

**Current State**:

```typescript
// base-strategy.ts
protected getConfig<T>(key: string, defaultValue: T): T {
  const value = this.config[key];
  return value !== undefined ? (value as T) : defaultValue;
}
```

**Proposed Enhancement**:

```typescript
protected getConfig<T>(key: string, defaultValue: T, symbol?: string): T {
  // Check symbol-specific override first
  if (symbol && this.config.perSymbolOverrides?.[symbol]?.[key] !== undefined) {
    return this.config.perSymbolOverrides[symbol][key] as T;
  }
  // Fall back to global config
  const value = this.config[key];
  return value !== undefined ? (value as T) : defaultValue;
}
```

**Files to modify**:

- `atlas/apps/core-node/src/strategies/plugins/base-strategy.ts`
- `atlas/apps/core-node/src/strategies/plugins/types.ts` (add type)

---

### 2.2 Add Per-Symbol Strategy Params to Guardrails

**Current guardrails.yaml** has per-symbol risk limits:

```yaml
per_symbol:
  BTC-USD:
    max_notional_usd: 30000
    max_daily_loss_usd: 1000
```

**Proposed addition**:

```yaml
per_symbol:
  BTC-USD:
    max_notional_usd: 30000
    max_daily_loss_usd: 1000
    strategy_overrides:  # NEW
      breakout:
        volumeThreshold: 1.0
        atrMultiplier: 1.8
      vwap_mr:
        deviationEntry: 2.5
  SOL-USD:
    max_notional_usd: 25000
    max_daily_loss_usd: 500
    strategy_overrides:
      breakout:
        volumeThreshold: 1.3  # Higher threshold for volatile asset
        atrMultiplier: 2.5    # Wider stops
```

**Files to modify**:

- `atlas/apps/core-node/src/config/loadGuardrails.ts` (update schema)
- `atlas/config/guardrails.yaml` (add examples)

---

### 2.3 Update Builtin Strategies to Use Symbol Overrides

Each strategy's `generateSignals()` method needs to pass `context.symbol` to `getConfig()`:

```typescript
// BEFORE
const volumeThreshold = this.getConfig<number>('volumeThreshold', 1.1);

// AFTER  
const volumeThreshold = this.getConfig<number>('volumeThreshold', 1.1, context.symbol);
```

**Files to modify**:

- `atlas/apps/core-node/src/strategies/plugins/builtin/breakout-strategy.ts`
- `atlas/apps/core-node/src/strategies/plugins/builtin/vwap-mr-strategy.ts`
- `atlas/apps/core-node/src/strategies/plugins/builtin/momentum-strategy.ts`

---

## PHASE 3: Signal Deconfliction

### Rationale

With 3 strategies running simultaneously, conflicts will occur:

- Breakout says BUY, VWAP Mean Reversion says SELL
- Result: Position flips back and forth, bleeding fees

Current mitigation (5-minute dedup window) is strategy-specific, not cross-strategy.

### 3.1 Create SignalArbiter Class

**Purpose**: When multiple strategies emit signals in the same window, pick the best one.

**Location**: `atlas/apps/core-node/src/strategies/signal-arbiter.ts`

**Logic**:

```
1. Collect signals within 30-second window
2. Group by symbol
3. For each symbol with conflicting directions:
   a. Check current position (if any)
   b. Prioritize strategy matching current regime
   c. Prioritize signal with higher (strength × regimeCompatibility)
   d. If still tied, prefer trend-following in trends, mean-reversion in ranges
4. Emit winning signal, log filtered ones
```

**Key Features**:

- Configurable window size
- Priority rules per regime
- Logging for post-analysis

---

### 3.2 Add Strategy-Aware Cooldown After Position Flip

**Problem**: If we flip from LONG to SHORT (or vice versa), we should NOT immediately flip back.

**Current State**: `trade_cooldown_min: 15` in guardrails, but it's global.

**Enhancement**: Per-strategy cooldown after a position flip (not just after any trade).

```typescript
interface CooldownState {
  lastFlipTime: Map<string, number>;  // symbol → timestamp
  lastFlipDirection: Map<string, 'long_to_short' | 'short_to_long'>;
}
```

**Files to modify**:

- `atlas/apps/core-node/src/strategies/signal-arbiter.ts` (new file)
- `atlas/apps/core-node/src/trading/position-tracker.ts` (emit flip events)

---

### 3.3 Wire SignalArbiter into SignalProcessor

**Integration Point**: After regime filter, before meta filter.

```typescript
// signal-processor.ts processSignal()
const filterResult = this.regimeFilter.filter(signal);
if (!filterResult.allowed) return;

// NEW: Signal arbitration
const arbitrationResult = this.signalArbiter.evaluate(filterResult.adjustedSignal);
if (!arbitrationResult.allowed) {
  this.emit('signal:arbitrated', signal, arbitrationResult.reason);
  return;
}

// Continue to meta filter...
```

---

## PHASE 4: Higher Timeframe Trend Strategy

### Rationale

Current strategies operate on 1-minute candles. This captures intraday moves but misses multi-day trends. During a 30% BTC rally over 2 weeks:

- Breakout: Catches initial breakout, exits at 2×ATR target (~2-3%)
- Momentum: Catches dips, exits at 2×ATR
- VWAP MR: Actually fights the trend (tries to short)

**Missing**: A strategy that holds for days/weeks with trailing stops.

### 4.1 Create TrendFollowStrategy Plugin

**Location**: `atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts`

**Logic**:

```
Entry Conditions:
- 20-period EMA > 50-period EMA on 1-hour chart (bullish) OR inverse (bearish)
- Price closes above 20 EMA (confirmation)
- ADX > 25 (trend strength)
- Volume above 20-period average

Exit Conditions:
- Trailing stop: 2×ATR from highest close since entry
- EMA crossover reversal
- Time stop: 168 bars (1 week on 1h)

Position Sizing:
- 50% of normal size (to hold longer)
```

**Regime Compatibility**:

```typescript
readonly regimeCompatibility: RegimeCompatibility[] = [
  { regime: 'strong_trend', compatibility: 'optimal', positionMultiplier: 1.0 },
  { regime: 'weak_trend', compatibility: 'compatible', positionMultiplier: 0.6 },
  { regime: 'ranging', compatibility: 'incompatible', positionMultiplier: 0.0 },
  { regime: 'choppy', compatibility: 'incompatible', positionMultiplier: 0.0 },
];
```

---

### 4.2 Integrate with Existing Infrastructure

**MTF Data**: Already available via `context.mtfCandles.h1`

**Position Monitor**: Already supports trailing stops

**Key Addition**: The strategy needs to calculate indicators on hourly data:

```typescript
// Use 1h candles for EMA calculation
const hourlyCloses = context.mtfCandles?.h1?.map(c => c.close) || [];
const ema20 = TechnicalIndicators.EMA(hourlyCloses, 20);
const ema50 = TechnicalIndicators.EMA(hourlyCloses, 50);
```

---

### 4.3 Register in Builtin Strategies

**Files to modify**:

- `atlas/apps/core-node/src/strategies/plugins/builtin/index.ts`
- `atlas/apps/core-node/src/strategies/signal-processor.ts` (add config)

---

## PHASE 5: ML Meta-Label Training Pipeline

### Rationale

The ONNX inference infrastructure exists (`meta-label.ts`), but without a trained model, it returns 0.5 for everything. The rule-based `MetaFilter` is good, but ML can learn patterns humans miss.

### 5.1 Create Trade Outcome Collection Schema

**New Supabase Table**: `trade_outcomes`

```sql
CREATE TABLE trade_outcomes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Signal info
  signal_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy TEXT NOT NULL,
  direction TEXT NOT NULL,
  signal_strength FLOAT NOT NULL,
  
  -- Entry context (features for ML)
  entry_price FLOAT NOT NULL,
  entry_time TIMESTAMPTZ NOT NULL,
  rsi FLOAT,
  macd FLOAT,
  macd_histogram FLOAT,
  atr FLOAT,
  atr_percent FLOAT,
  volume_ratio FLOAT,
  bb_width FLOAT,
  bb_position FLOAT,
  regime TEXT,
  regime_confidence FLOAT,
  mtf_alignment FLOAT,
  hour_of_day INT,
  day_of_week INT,
  
  -- Exit info (filled after close)
  exit_price FLOAT,
  exit_time TIMESTAMPTZ,
  exit_reason TEXT,
  
  -- Outcome (label for ML)
  pnl_usd FLOAT,
  pnl_percent FLOAT,
  outcome TEXT,  -- 'win', 'loss', 'breakeven'
  holding_bars INT
);
```

---

### 5.2 Wire Position Closed Events to Record Outcomes

**Current State**: `PositionTracker` emits `position:closed` with full position data.

**Enhancement**: Capture signal context at entry time, match to exit.

```typescript
// In TradingEngine or SignalProcessor
this.positionTracker.on('position:opened', (position) => {
  // Store entry context from last signal
  this.pendingOutcomes.set(position.id, {
    signalId: lastSignal.id,
    entryContext: { ...capturedIndicators },
  });
});

this.positionTracker.on('position:closed', async (position) => {
  const pending = this.pendingOutcomes.get(position.id);
  if (!pending) return;
  
  await this.recordTradeOutcome({
    ...pending.entryContext,
    exitPrice: position.exitPrice,
    exitTime: new Date(),
    pnlUsd: position.realizedPnL,
    outcome: position.realizedPnL > 0 ? 'win' : 'loss',
  });
});
```

---

### 5.3 Document ML Training Workflow

**Step 1**: Export training data

```bash
# Export from Supabase
psql $DATABASE_URL -c "COPY (SELECT * FROM trade_outcomes WHERE outcome IS NOT NULL) TO STDOUT WITH CSV HEADER" > training_data.csv
```

**Step 2**: Train model (Python)

```python
import pandas as pd
from sklearn.model_selection import train_test_split
from lightgbm import LGBMClassifier
import skl2onnx

df = pd.read_csv('training_data.csv')
features = ['rsi', 'macd', 'atr_percent', 'volume_ratio', 'bb_position', ...]
X = df[features]
y = (df['outcome'] == 'win').astype(int)

X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2)

model = LGBMClassifier(n_estimators=100, max_depth=5)
model.fit(X_train, y_train)

# Export to ONNX
from skl2onnx import convert_sklearn
onnx_model = convert_sklearn(model, initial_types=[('input', FloatTensorType([None, len(features)]))])
with open('meta_label_model.onnx', 'wb') as f:
    f.write(onnx_model.SerializeToString())
```

**Step 3**: Deploy model

```bash
cp meta_label_model.onnx atlas/models/
# Update config: metaLabeling.modelPath = 'models/meta_label_model.onnx'
```

---

## Implementation Priority


| Phase                   | Priority | Effort | Impact | Risk   |
| ----------------------- | -------- | ------ | ------ | ------ |
| 1. Minor Corrections    | HIGH     | 2 hrs  | Medium | Low    |
| 2. Per-Asset Tuning     | HIGH     | 4 hrs  | High   | Low    |
| 3. Signal Deconfliction | HIGH     | 6 hrs  | High   | Medium |
| 4. Trend Strategy       | MEDIUM   | 8 hrs  | High   | Medium |
| 5. ML Pipeline          | LOW      | 12 hrs | Medium | High   |


**Recommended Order**: 1 → 2 → 3 → 4 → 5

Phase 1-3 are critical for avoiding losses. Phase 4 adds alpha capture. Phase 5 is optimization (needs data first).

---

## Dependencies

```
Phase 1: No dependencies (fix bugs)
Phase 2: No dependencies
Phase 3: Depends on Phase 1 (regime filter fix)
Phase 4: Depends on Phase 2 (needs per-symbol config)
Phase 5: Depends on Phase 3 (needs clean signal flow for data collection)
```

---

## Testing Plan

### Phase 1

- Unit tests for regime filter with momentum strategy
- Integration test for VWAP strategy with useBollinger=true

### Phase 2

- Unit tests for BaseStrategy.getConfig with symbol overrides
- Config validation tests

### Phase 3

- Unit tests for SignalArbiter priority logic
- Integration test with conflicting signals

### Phase 4

- Backtest TrendFollowStrategy on historical BTC/ETH/SOL data
- Compare Sharpe ratio before/after adding strategy

### Phase 5

- Validate ONNX model loads correctly
- A/B test ML filter vs rule-based filter

---

## Success Metrics

1. **Win Rate**: Increase from baseline to >45%
2. **Profit Factor**: Target >1.5
3. **Max Drawdown**: Keep under 10%
4. **Signal Conflict Rate**: Reduce to <5% of all signals
5. **Average Trade Duration**: Have distribution from minutes (intraday) to days (trend)

---

## Rollback Plan

Each phase is independent. If issues arise:

- Phase 1: Revert single file changes
- Phase 2: Disable per-symbol overrides in config
- Phase 3: Bypass SignalArbiter with config flag
- Phase 4: Disable TrendFollowStrategy via registry
- Phase 5: Set `metaLabeling.enabled: false`

---

*Plan created: January 9, 2026*
*Last updated: January 9, 2026*