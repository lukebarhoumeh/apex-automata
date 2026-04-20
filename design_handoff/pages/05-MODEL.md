# 05 — Model

**Route:** `/model` · **Screenshot:** `screenshots/05-model.png` · **Source:** `source/src/model.jsx`

## Purpose

Meta-model diagnostics. Is the model healthy? What's it keying on right now? How calibrated is it? What happened in recent training runs?

## Layout

Top: model status hero strip. Main: 2x2 panel grid.

### Model status hero (panel, full width, ~110px)

Three sections separated by vertical dividers:
1. **Model card** — name, version, trained-on date, status pill (`HEALTHY` up / `STALE` warn / `DRIFTED` down)
2. **Key metrics row** — AUC · Log loss · Brier score · Sharpe of top-decile (mono, 4 stacked small-stat blocks)
3. **Actions** — `[Retrain] [Promote] [Rollback] [Export]`

### Panel grid (2×2)

**Top-left: SHAP waterfall** (live inference)
- Shows the most recent live signal's model decision
- Horizontal bar chart: base-rate → +feature1 → -feature2 → ... → final probability
- Each bar labeled with feature name (mono) + contribution value
- Positive contribs in accent blue, negative in down red, final bar in up green
- Header: picked symbol & timestamp, dropdown to pick a recent signal

**Top-right: Live inference stream**
- Table of last 20 inferences:
| TS | SYMBOL | STRAT | FEATURES (spark) | P(take) | DECISION |
- P(take) shown as bar+number, DECISION pill (`TAKEN` accent / `GATED` warn)
- Click row → populates SHAP panel

**Bottom-left: Confusion matrix + calibration**
Split 50/50 inside the panel:
- Left half: 2×2 confusion matrix grid with counts & percentages, cell color intensity scales with count
- Right half: calibration curve — reliability diagram, predicted prob on x, actual freq on y, diagonal dashed ideal line, dots sized by bucket count, line through them

**Bottom-right: Training runs**
- Compact table of last 10 runs:
| ID | DATE | DURATION | DATA RANGE | AUC | LOGLOSS | DIFF | STATUS |
- DIFF column shows Δ vs prior run (+/-), colored
- STATUS pill: `PROMOTED` / `ARCHIVED` / `FAILED`
- Row click → modal with full run details (feature importances, CV scores, params)
- Above table: small line chart tracking AUC across the last 30 runs

## Data hooks

```ts
useModelStatus()
useShapInspection(signalId)
useLiveInferences()       // stream
useConfusionMatrix(window)
useCalibration(window)
useTrainingRuns()
```
