# Apex Automata — ML Meta-Label Training Pipeline

Trains an XGBoost meta-label classifier on `public.trade_outcomes` to predict
`P(profitable | signal context)`. The runtime multiplies signal position size
by the calibrated probability — high-conviction signals get full size, low-
conviction signals get cut entirely (skipping fees on losers is the dominant
P&L lever).

## Why meta-labeling, not direction prediction

The strategies (momentum, trend_follow, breakout, vwap_mr) already pick a
direction. The model's job is **not** to call buy vs sell — that's the
strategy's role. Its job is to score how likely a *given strategy's directional
call* is to actually pay out, given the regime + indicator context at signal
time.

This framing (after López de Prado / Marcos Lopez) avoids learning a
trivially-bad model that fights the strategy's edge. We label what the
strategy did — `outcome_label ∈ {profitable, unprofitable}` — and learn the
contexts where the strategy was right vs wrong.

## Pipeline stages

```
public.trade_outcomes  +  public.bars
            │
            ▼
  src/extract_features.py
    - Flatten indicators_snapshot jsonb
    - Add bar-context features (recent volatility, return distribution)
    - Strict time-ordered output (no shuffle)
            │
            ▼
        data/features.parquet
            │
            ▼
   src/train_meta_label.py
    - Walk-forward cross-validation (NOT k-fold)
    - XGBoost classifier
    - Optuna hyperparam search (TPE)
    - Calibration (isotonic regression on held-out fold)
    - Per-regime evaluation
            │
            ▼
      models/meta_label_<version>.{json,onnx}
      reports/eval_<version>.md
            │
            ▼
   src/deploy_to_supabase.py
    - Insert into public.models with metrics
    - Mark as 'active' so signal-processor.ts picks it up at next restart
```

## Quant-engineer principles enforced

- **No look-ahead leakage.** All features come from `indicators_snapshot`
  captured at signal time, not at close time. Bar-context features use bars
  STRICTLY before signal entry time.
- **Walk-forward, not k-fold.** Crypto regimes are non-stationary; future
  data leaking into training fold inflates AUC and produces a model that
  fails out of sample.
- **Calibrated probabilities, not rankings.** Position sizing multiplies
  by P(profitable). Uncalibrated XGBoost scores are NOT probabilities.
  Isotonic regression on the held-out fold makes them so.
- **Per-regime evaluation.** A 0.6 AUC overall but 0.8 in `weak_trend` and
  0.5 in `ranging` is a hugely different operational story than the average
  suggests. We report broken-down metrics.
- **Class imbalance handled.** Crypto strategies typically run 30-40% win
  rate. Optimize precision-at-K (the threshold we'd actually trade at), not
  accuracy.
- **Regularization.** L1 on the indicator features (ema9/12/15/21/26 are
  highly collinear). Tree pruning via min_child_weight + max_depth limits.
- **Drift monitoring.** After deploy, track rolling 1-day mean of predicted
  scores; alert if it shifts >2σ from the training distribution. Triggers a
  retrain.

## Data requirements

- **Minimum viable training set:** 500 closed trades. With ~30 trades/day
  organic flow, that's ~17 days of paper running.
- **Statistically meaningful:** 1000+ trades. ~5 weeks.
- **Per-regime adequate:** 200+ trades per regime × strategy combination
  (so each cell of the 4-regime × 4-strategy = 16-cell matrix). Realistic
  target: 3 months of paper running.

We use the data we have at any point in time — small-n training shows whether
the plumbing works, but production deployment waits for adequate sample.

## Setup

```bash
cd scripts/ml
python -m venv .venv
source .venv/bin/activate     # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
```

Required env vars (read from project-root `.env`):
```
SUPABASE_URL
SUPABASE_SERVICE_KEY
```

## Running

```bash
# Extract features from current trade_outcomes
python src/extract_features.py

# Train (small-n acceptable for plumbing verification; produces a model
# but NOT one to deploy until n ≥ 500)
python src/train_meta_label.py

# Evaluate against the latest model
python src/evaluate.py

# Deploy a trained model to Supabase models table
python src/deploy_to_supabase.py models/meta_label_<version>.json
```

## Layout

```
scripts/ml/
├── README.md
├── requirements.txt
├── src/
│   ├── extract_features.py     # Supabase → parquet
│   ├── train_meta_label.py     # parquet → model + report
│   ├── evaluate.py             # standalone eval against new data
│   └── deploy_to_supabase.py   # model file → public.models row
├── data/                        # parquet feature sets (gitignored)
├── models/                      # trained model artifacts (gitignored)
└── reports/                     # eval reports (committed for history)
```
