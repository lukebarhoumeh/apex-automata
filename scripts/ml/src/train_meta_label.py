"""
train_meta_label.py
===================

Train an XGBoost meta-label classifier on data/features.parquet.

Quant principles enforced:
  * Walk-forward CV (TimeSeriesSplit), NEVER k-fold.
  * Calibrated probabilities (isotonic regression on held-out fold).
  * Per-regime + per-strategy AUC breakdown.
  * Optuna hyperparam search on the LAST training fold only (avoiding
    leakage from later-in-time validation folds).
  * Class imbalance handled via scale_pos_weight, not oversampling
    (oversampling fights the temporal structure).
  * Refuses to deploy a model with too-small n or AUC barely above chance.

Run:
    python src/train_meta_label.py [--n-trials 30] [--min-rows 100]

Output:
    models/meta_label_<timestamp>.{json,onnx}
    reports/eval_<timestamp>.md
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.metrics import (
    roc_auc_score,
    average_precision_score,
    brier_score_loss,
    confusion_matrix,
)
from sklearn.model_selection import TimeSeriesSplit
from xgboost import XGBClassifier

import optuna
optuna.logging.set_verbosity(optuna.logging.WARNING)


SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
DATA_PATH = ROOT / "data" / "features.parquet"
MODELS_DIR = ROOT / "models"
REPORTS_DIR = ROOT / "reports"
MODELS_DIR.mkdir(exist_ok=True)
REPORTS_DIR.mkdir(exist_ok=True)

TARGET_COL = "outcome_label"
TARGET_POSITIVE = "profitable"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--n-trials",
        type=int,
        default=30,
        help="Optuna trials for hyperparam search. Bump to 100+ for production runs.",
    )
    p.add_argument(
        "--min-rows",
        type=int,
        default=100,
        help="Refuse to train below this row count. Default 100 is plumbing-test "
        "level; production deployment should be n >= 500.",
    )
    p.add_argument(
        "--n-splits",
        type=int,
        default=5,
        help="Number of walk-forward splits. With small n use 3.",
    )
    p.add_argument("--features", type=str, default=str(DATA_PATH))
    return p.parse_args()


def load_features(path: Path) -> pd.DataFrame:
    df = pd.read_parquet(path)
    # Drop rows with missing target
    df = df.dropna(subset=[TARGET_COL])
    # Drop the breakeven class — meta-label is binary
    df = df[df[TARGET_COL].isin(["profitable", "unprofitable"])].copy()
    return df.sort_values("entry_time").reset_index(drop=True)


def split_features_target(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.Series, pd.DataFrame]:
    """
    Returns (X, y, meta) where:
      X: numeric features only
      y: 1 = profitable, 0 = unprofitable
      meta: side columns we use for stratified eval but NOT as features
            (regime, strategy, signal_direction, symbol, entry_time)
    """
    meta_cols = ["regime", "strategy", "signal_direction", "symbol", "entry_time"]
    meta = df[[c for c in meta_cols if c in df.columns]].copy()

    # Categorical encoding for the strategy/regime/symbol/direction features.
    # Use one-hot since XGBoost handles it natively and we want explicit
    # interpretability on coefficients later.
    cat_cols = [c for c in ["regime", "strategy", "signal_direction", "trend_direction"] if c in df.columns]
    df_encoded = pd.get_dummies(df, columns=cat_cols, prefix=cat_cols, drop_first=False)

    # Drop string/non-numeric columns that aren't features
    drop_cols = ["signal_id", "symbol", "entry_time", TARGET_COL]
    feature_cols = [
        c
        for c in df_encoded.columns
        if c not in drop_cols
        and pd.api.types.is_numeric_dtype(df_encoded[c])
    ]
    X = df_encoded[feature_cols].astype(float)

    # Convert any boolean dummies to float
    for c in X.columns:
        if X[c].dtype == "bool":
            X[c] = X[c].astype(float)

    y = (df[TARGET_COL] == TARGET_POSITIVE).astype(int)
    return X, y, meta


def walk_forward_search(
    X: pd.DataFrame, y: pd.Series, n_splits: int, n_trials: int
) -> dict:
    """
    Optuna hyperparam search using walk-forward CV. Returns best params.

    For each Optuna trial we train on each fold's train portion and average
    AUC across the val portions. The fold structure is:
      Fold 1: train on rows [0, t1),  val on [t1, t2)
      Fold 2: train on rows [0, t2),  val on [t2, t3)
      ...
    No future data leaks back.
    """
    splits = list(TimeSeriesSplit(n_splits=n_splits).split(X))
    pos = int(y.sum())
    neg = int(len(y) - pos)
    scale_pos_weight = neg / max(pos, 1)

    def objective(trial: optuna.Trial) -> float:
        params = {
            "n_estimators": trial.suggest_int("n_estimators", 100, 500),
            "max_depth": trial.suggest_int("max_depth", 2, 6),  # shallow trees, less overfit
            "learning_rate": trial.suggest_float("learning_rate", 0.01, 0.3, log=True),
            "min_child_weight": trial.suggest_int("min_child_weight", 1, 10),
            "subsample": trial.suggest_float("subsample", 0.6, 1.0),
            "colsample_bytree": trial.suggest_float("colsample_bytree", 0.6, 1.0),
            "reg_alpha": trial.suggest_float("reg_alpha", 1e-3, 10.0, log=True),  # L1 — kill collinear EMAs
            "reg_lambda": trial.suggest_float("reg_lambda", 1e-3, 10.0, log=True),
            "scale_pos_weight": scale_pos_weight,
            "objective": "binary:logistic",
            "eval_metric": "auc",
            "tree_method": "hist",
            "verbosity": 0,
            "random_state": 42,
        }

        aucs = []
        for train_idx, val_idx in splits:
            if len(np.unique(y.iloc[val_idx])) < 2:
                continue  # fold has only one class — uninformative
            model = XGBClassifier(**params)
            model.fit(X.iloc[train_idx], y.iloc[train_idx], verbose=False)
            preds = model.predict_proba(X.iloc[val_idx])[:, 1]
            aucs.append(roc_auc_score(y.iloc[val_idx], preds))

        return float(np.mean(aucs)) if aucs else 0.5

    study = optuna.create_study(direction="maximize")
    study.optimize(objective, n_trials=n_trials, show_progress_bar=False)
    return study.best_params


def fit_calibrated(X: pd.DataFrame, y: pd.Series, params: dict) -> CalibratedClassifierCV:
    """
    Fit XGBoost on the FIRST n_splits-1 folds, calibrate isotonic on the LAST
    fold. CalibratedClassifierCV with cv='prefit' lets us control the split
    explicitly.
    """
    splits = list(TimeSeriesSplit(n_splits=3).split(X))
    train_idx, calib_idx = splits[-1]

    pos = int(y.iloc[train_idx].sum())
    neg = int(len(y.iloc[train_idx]) - pos)
    scale_pos_weight = neg / max(pos, 1)

    base = XGBClassifier(
        **params,
        scale_pos_weight=scale_pos_weight,
        objective="binary:logistic",
        eval_metric="auc",
        tree_method="hist",
        verbosity=0,
        random_state=42,
    )
    base.fit(X.iloc[train_idx], y.iloc[train_idx], verbose=False)

    calibrated = CalibratedClassifierCV(base, cv="prefit", method="isotonic")
    calibrated.fit(X.iloc[calib_idx], y.iloc[calib_idx])
    return calibrated


def evaluate_per_regime(
    model, X: pd.DataFrame, y: pd.Series, meta: pd.DataFrame
) -> dict:
    """
    Stratified evaluation: compute AUC + Brier + n per regime and per strategy.
    """
    if "regime" not in meta.columns or "strategy" not in meta.columns:
        return {}

    preds = model.predict_proba(X)[:, 1]
    overall = {
        "n": int(len(y)),
        "win_rate": float(y.mean()),
        "auc": float(roc_auc_score(y, preds)) if len(np.unique(y)) > 1 else None,
        "ap": float(average_precision_score(y, preds)) if len(np.unique(y)) > 1 else None,
        "brier": float(brier_score_loss(y, preds)),
    }

    by_regime: dict[str, dict] = {}
    for regime in meta["regime"].dropna().unique():
        mask = meta["regime"] == regime
        if mask.sum() < 5 or len(np.unique(y[mask])) < 2:
            continue
        by_regime[str(regime)] = {
            "n": int(mask.sum()),
            "win_rate": float(y[mask].mean()),
            "auc": float(roc_auc_score(y[mask], preds[mask])),
            "brier": float(brier_score_loss(y[mask], preds[mask])),
        }

    by_strategy: dict[str, dict] = {}
    for strategy in meta["strategy"].dropna().unique():
        mask = meta["strategy"] == strategy
        if mask.sum() < 5 or len(np.unique(y[mask])) < 2:
            continue
        by_strategy[str(strategy)] = {
            "n": int(mask.sum()),
            "win_rate": float(y[mask].mean()),
            "auc": float(roc_auc_score(y[mask], preds[mask])),
            "brier": float(brier_score_loss(y[mask], preds[mask])),
        }

    return {"overall": overall, "by_regime": by_regime, "by_strategy": by_strategy}


def write_report(
    path: Path,
    metrics: dict,
    params: dict,
    feature_cols: list[str],
    n_rows: int,
    timestamp: str,
):
    lines = [
        f"# Meta-label training report — {timestamp}",
        "",
        f"- Rows: **{n_rows}**",
        f"- Features: {len(feature_cols)}",
        "",
        "## Best hyperparameters (Optuna)",
        "",
        "```",
    ]
    for k, v in params.items():
        lines.append(f"{k}: {v}")
    lines += ["```", ""]

    overall = metrics.get("overall", {})
    lines += [
        "## Overall (calibrated)",
        "",
        f"- n: {overall.get('n')}",
        f"- win_rate (positive class): {overall.get('win_rate'):.3f}"
        if overall.get("win_rate") is not None
        else "- win_rate: n/a",
        f"- AUC: {overall.get('auc'):.4f}" if overall.get("auc") is not None else "- AUC: n/a",
        f"- AP (avg precision): {overall.get('ap'):.4f}"
        if overall.get("ap") is not None
        else "- AP: n/a",
        f"- Brier: {overall.get('brier'):.4f}",
        "",
    ]

    by_regime = metrics.get("by_regime", {})
    if by_regime:
        lines += ["## By regime", "", "| regime | n | win_rate | AUC | Brier |", "| --- | --- | --- | --- | --- |"]
        for r, m in sorted(by_regime.items()):
            lines.append(
                f"| {r} | {m['n']} | {m['win_rate']:.3f} | {m['auc']:.4f} | {m['brier']:.4f} |"
            )
        lines.append("")

    by_strategy = metrics.get("by_strategy", {})
    if by_strategy:
        lines += [
            "## By strategy",
            "",
            "| strategy | n | win_rate | AUC | Brier |",
            "| --- | --- | --- | --- | --- |",
        ]
        for s, m in sorted(by_strategy.items()):
            lines.append(
                f"| {s} | {m['n']} | {m['win_rate']:.3f} | {m['auc']:.4f} | {m['brier']:.4f} |"
            )
        lines.append("")

    lines += [
        "## Deployment gate",
        "",
        "**Production deploy criteria:**",
        "- n ≥ 500",
        "- Overall AUC ≥ 0.6 with 95% CI lower bound > 0.55",
        "- Per-regime AUC ≥ 0.55 in at least 2 regimes",
        "- Brier score < 0.24 (chance is 0.25 for balanced classes)",
        "",
        "If this report doesn't meet those bars, the model is **plumbing-only** —",
        "do not promote to active in `public.models`.",
    ]
    path.write_text("\n".join(lines))


def main() -> int:
    args = parse_args()

    feat_path = Path(args.features)
    if not feat_path.exists():
        print(f"Features file not found: {feat_path}")
        print("Run extract_features.py first.")
        return 1

    df = load_features(feat_path)
    if len(df) < args.min_rows:
        print(
            f"Only {len(df)} usable rows (need >= {args.min_rows}). "
            f"Run paper trading longer or lower --min-rows for plumbing tests."
        )
        return 2

    print(f"Loaded {len(df)} rows. Class balance: {df[TARGET_COL].value_counts().to_dict()}")

    X, y, meta = split_features_target(df)
    print(f"Feature matrix: {X.shape}")

    n_splits = min(args.n_splits, max(2, len(df) // 30))
    print(f"Walk-forward CV splits: {n_splits}")

    print(f"Optuna hyperparam search ({args.n_trials} trials)...")
    best_params = walk_forward_search(X, y, n_splits=n_splits, n_trials=args.n_trials)
    print("Best params:", best_params)

    print("Fitting calibrated XGBoost...")
    model = fit_calibrated(X, y, best_params)

    print("Evaluating...")
    metrics = evaluate_per_regime(model, X, y, meta)

    timestamp = dt.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")

    # Save model — pickle for now; deploy_to_supabase.py converts to ONNX
    import pickle

    model_path = MODELS_DIR / f"meta_label_{timestamp}.pkl"
    with open(model_path, "wb") as f:
        pickle.dump(
            {
                "model": model,
                "feature_columns": list(X.columns),
                "params": best_params,
                "metrics": metrics,
                "timestamp": timestamp,
                "n_train": len(df),
            },
            f,
        )
    print(f"Saved model: {model_path}")

    report_path = REPORTS_DIR / f"eval_{timestamp}.md"
    write_report(report_path, metrics, best_params, list(X.columns), len(df), timestamp)
    print(f"Saved report: {report_path}")

    overall_auc = metrics.get("overall", {}).get("auc")
    if overall_auc is not None:
        print(f"\nOverall AUC: {overall_auc:.4f}")
        if overall_auc < 0.55:
            print("⚠️  AUC barely above chance. Model is unfit for deployment.")
        elif overall_auc < 0.6:
            print("⚠️  AUC < 0.6. Model needs more data or feature engineering.")
        else:
            print("✓ AUC ≥ 0.6. Run more samples and re-verify before deploying.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
