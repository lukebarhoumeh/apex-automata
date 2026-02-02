# ML Meta-Label Training Guide

This guide explains how to train the Meta-Label ML model that filters trading signals to improve profitability.

## Overview

The Meta-Label system uses a binary classifier to predict whether a generated signal will be profitable. It sits in the signal pipeline after regime and meta filters, providing an additional layer of signal quality assessment.

**Flow:**
```
Signal Generated → Regime Filter → Meta Filter → ML Meta-Label → Order Execution
```

## Prerequisites

1. **Minimum 500+ closed trades** in the `trade_outcomes` table
2. Python 3.9+ with scikit-learn, pandas, onnxruntime, skl2onnx
3. Access to Supabase database

## Step 1: Verify Data Collection

Check that outcomes are being collected:

```bash
# Via API
curl http://localhost:3001/api/ml/outcomes/status

# Or check Supabase directly
SELECT 
  COUNT(*) as total,
  COUNT(*) FILTER (WHERE outcome_label = 'profitable') as wins,
  COUNT(*) FILTER (WHERE outcome_label = 'unprofitable') as losses
FROM trade_outcomes;
```

You need at least 500 trades with `outcome_label IS NOT NULL` before training is worthwhile.

## Step 2: Export Training Data

### Option A: Use the ML Training View

```sql
-- Export from Supabase
\copy (SELECT * FROM ml_training_data) TO 'training_data.csv' WITH CSV HEADER;
```

### Option B: Python Export Script

```python
import pandas as pd
from supabase import create_client

# Connect to Supabase
supabase = create_client(
    "your-supabase-url",
    "your-service-key"
)

# Fetch training data
response = supabase.table('trade_outcomes').select('*').not_('outcome_label', 'is', 'null').execute()
df = pd.DataFrame(response.data)
df.to_csv('training_data.csv', index=False)
print(f"Exported {len(df)} records")
```

## Step 3: Train the Model

```python
import pandas as pd
import numpy as np
from sklearn.model_selection import train_test_split, cross_val_score
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import classification_report, roc_auc_score
import joblib

# Load data
df = pd.read_csv('training_data.csv')

# Feature engineering
FEATURES = [
    'signal_strength',
    'regime_confidence',
    'adx',
    'atr_percent',
    'bb_width',
    'choppiness',
    'mtf_alignment',
    'volume_ratio',
    'meta_filter_score',
    'cold_streak_active',
    'position_multiplier',
]

# Encode regime
regime_dummies = pd.get_dummies(df['regime'], prefix='regime')
df = pd.concat([df, regime_dummies], axis=1)
FEATURES.extend(regime_dummies.columns.tolist())

# Encode strategy
strategy_dummies = pd.get_dummies(df['strategy'], prefix='strategy')
df = pd.concat([df, strategy_dummies], axis=1)
FEATURES.extend(strategy_dummies.columns.tolist())

# Encode direction
df['direction_encoded'] = (df['signal_direction'] == 'buy').astype(int)
FEATURES.append('direction_encoded')

# Prepare X, y
X = df[FEATURES].fillna(0)
y = (df['outcome_label'] == 'profitable').astype(int)

# Split
X_train, X_test, y_train, y_test = train_test_split(
    X, y, test_size=0.2, random_state=42, stratify=y
)

# Scale features
scaler = StandardScaler()
X_train_scaled = scaler.fit_transform(X_train)
X_test_scaled = scaler.transform(X_test)

# Train model
model = GradientBoostingClassifier(
    n_estimators=100,
    max_depth=4,
    learning_rate=0.1,
    min_samples_split=20,
    random_state=42
)
model.fit(X_train_scaled, y_train)

# Evaluate
y_pred = model.predict(X_test_scaled)
y_proba = model.predict_proba(X_test_scaled)[:, 1]

print("Classification Report:")
print(classification_report(y_test, y_pred))
print(f"ROC AUC: {roc_auc_score(y_test, y_proba):.4f}")

# Cross-validation
cv_scores = cross_val_score(model, X_train_scaled, y_train, cv=5, scoring='roc_auc')
print(f"CV ROC AUC: {cv_scores.mean():.4f} (+/- {cv_scores.std() * 2:.4f})")

# Feature importance
importance = pd.DataFrame({
    'feature': FEATURES,
    'importance': model.feature_importances_
}).sort_values('importance', ascending=False)
print("\nTop 10 Features:")
print(importance.head(10))

# Save sklearn model and scaler
joblib.dump(model, 'meta_label_model.pkl')
joblib.dump(scaler, 'meta_label_scaler.pkl')
joblib.dump(FEATURES, 'meta_label_features.pkl')
```

## Step 4: Export to ONNX

```python
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType
import onnxruntime as ort

# Load model
model = joblib.load('meta_label_model.pkl')
scaler = joblib.load('meta_label_scaler.pkl')
features = joblib.load('meta_label_features.pkl')

# Define input type
initial_type = [('float_input', FloatTensorType([None, len(features)]))]

# Convert to ONNX
onnx_model = convert_sklearn(
    model,
    initial_types=initial_type,
    target_opset=12
)

# Save ONNX model
with open('meta_label.onnx', 'wb') as f:
    f.write(onnx_model.SerializeToString())

# Verify ONNX model works
session = ort.InferenceSession('meta_label.onnx')
input_name = session.get_inputs()[0].name

# Test with sample data
import numpy as np
test_input = np.random.randn(1, len(features)).astype(np.float32)
result = session.run(None, {input_name: test_input})
print(f"Test prediction: {result}")
```

## Step 5: Deploy the Model

1. Copy the ONNX model to the config directory:
```bash
cp meta_label.onnx atlas/apps/core-node/config/meta_label.onnx
```

2. Update `guardrails.yaml` to enable meta-labeling:
```yaml
meta_labeling:
  enabled: true
  threshold: 0.5  # Signals below this probability are filtered
  model_path: config/meta_label.onnx
```

3. Restart the trading engine

## Step 6: Monitor Performance

After deployment, monitor the ML filter's impact:

```sql
-- Compare win rates before/after ML filtering
SELECT 
  DATE(entry_time) as date,
  COUNT(*) as total_signals,
  COUNT(*) FILTER (WHERE outcome_label = 'profitable') as wins,
  ROUND(
    COUNT(*) FILTER (WHERE outcome_label = 'profitable')::NUMERIC / 
    NULLIF(COUNT(*), 0)::NUMERIC, 
    4
  ) as win_rate
FROM trade_outcomes
WHERE entry_time > NOW() - INTERVAL '30 days'
GROUP BY DATE(entry_time)
ORDER BY date DESC;
```

## Retraining Schedule

- **Weekly**: Review performance metrics
- **Monthly**: Retrain with new data if performance degrades
- **Quarterly**: Full model review and feature engineering

## Feature Reference

| Feature | Description |
|---------|-------------|
| `signal_strength` | Original signal confidence (0-1) |
| `regime_confidence` | Regime detector confidence |
| `adx` | Average Directional Index |
| `atr_percent` | ATR as % of price |
| `bb_width` | Bollinger Band width |
| `choppiness` | Market choppiness index |
| `mtf_alignment` | Multi-timeframe trend alignment |
| `volume_ratio` | Current vs average volume |
| `meta_filter_score` | Rule-based filter quality score |
| `cold_streak_active` | If strategy is in cold streak |
| `regime_*` | One-hot encoded regime |
| `strategy_*` | One-hot encoded strategy |
| `direction_encoded` | 1 for buy, 0 for sell |

## Troubleshooting

### Model accuracy too low
- Need more training data (aim for 1000+ trades)
- Check class balance (should be ~40-60% split)
- Try different model (RandomForest, XGBoost)

### ONNX export fails
- Ensure scikit-learn version matches skl2onnx compatibility
- Try `target_opset=11` instead of 12

### Model not loading at runtime
- Check file path in guardrails.yaml
- Verify ONNX runtime version compatibility
- Check logs for specific error messages
