"""
extract_features.py
===================

Pulls trade_outcomes from Supabase, flattens indicators_snapshot jsonb,
adds bar-context features (recent volatility / returns) STRICTLY from bars
preceding the signal time, and writes a time-ordered parquet to
``data/features.parquet``.

No shuffle, no leakage.

Run:
    python src/extract_features.py [--limit N] [--since YYYY-MM-DD]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client

# Load .env from repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(REPO_ROOT / ".env")

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR.parent / "data"
DATA_DIR.mkdir(exist_ok=True)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Cap on rows to fetch (None = all). Use during development to "
        "avoid pulling the entire table on every iteration.",
    )
    p.add_argument(
        "--since",
        type=str,
        default=None,
        help="ISO date (YYYY-MM-DD). Only include trades with entry_time >= this.",
    )
    p.add_argument(
        "--output",
        type=str,
        default=str(DATA_DIR / "features.parquet"),
    )
    return p.parse_args()


def fetch_trade_outcomes(client, since: str | None, limit: int | None) -> pd.DataFrame:
    """
    Pull trade_outcomes paginated. Supabase JS-style 1000-row default applies
    here too via PostgREST — we explicitly page with .range() for >1000 rows.
    """
    PAGE = 1000
    rows: list[dict] = []
    offset = 0

    while True:
        q = (
            client.table("trade_outcomes")
            .select("*")
            .order("entry_time", desc=False)
            .range(offset, offset + PAGE - 1)
        )
        if since:
            q = q.gte("entry_time", since)
        resp = q.execute()
        batch = resp.data or []
        rows.extend(batch)
        if len(batch) < PAGE or (limit and len(rows) >= limit):
            break
        offset += PAGE

    if limit:
        rows = rows[:limit]

    df = pd.DataFrame(rows)
    return df


def flatten_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """
    Expand indicators_snapshot jsonb into columns. Each indicator becomes
    its own feature; missing indicators are NaN (XGBoost handles natively
    without imputation, which is preferable to fillna(0) which would create
    a phantom signal).
    """
    if "indicators_snapshot" not in df.columns:
        return df

    snapshots = df["indicators_snapshot"].fillna({})
    expanded = pd.json_normalize(snapshots).add_prefix("ind_")

    # Reset index so concat aligns row-for-row
    expanded.index = df.index
    return pd.concat([df.drop(columns=["indicators_snapshot"]), expanded], axis=1)


def add_bar_context_features(df: pd.DataFrame, client) -> pd.DataFrame:
    """
    For each trade, pull the 30 bars immediately preceding entry_time and
    compute:
      - bar_return_30m: cumulative return over the prior 30 bars
      - bar_volatility_30m: std of log-returns
      - bar_volume_zscore: latest volume vs 30-bar mean (z-score)

    All windows END at the bar immediately BEFORE entry_time. No look-ahead.
    """
    if df.empty:
        return df

    out = df.copy()
    out["bar_return_30m"] = pd.NA
    out["bar_volatility_30m"] = pd.NA
    out["bar_volume_zscore"] = pd.NA

    for idx, row in out.iterrows():
        symbol = row.get("symbol")
        entry_time = row.get("entry_time")
        if not symbol or not entry_time:
            continue

        # bars.time is BIGINT epoch-seconds; entry_time is ISO timestamptz
        try:
            entry_ts_sec = int(pd.to_datetime(entry_time).timestamp())
        except (ValueError, TypeError):
            continue

        # 30 bars × 60 sec × 15 min = 27000 sec lookback (15-min bars), but
        # querying by bar count via .range(0, 29) handles different intervals.
        resp = (
            client.table("bars")
            .select("time, open, high, low, close, volume")
            .eq("symbol", symbol)
            .lt("time", entry_ts_sec)
            .order("time", desc=True)
            .range(0, 29)
            .execute()
        )
        bars = pd.DataFrame(resp.data or [])
        if len(bars) < 5:
            continue

        bars = bars.sort_values("time").reset_index(drop=True)
        log_ret = (bars["close"].astype(float).pct_change()).dropna()

        if len(log_ret) >= 2:
            out.at[idx, "bar_return_30m"] = (
                bars["close"].iloc[-1] / bars["close"].iloc[0] - 1.0
            )
            out.at[idx, "bar_volatility_30m"] = float(log_ret.std())

        vol = bars["volume"].astype(float)
        if vol.std() > 0:
            out.at[idx, "bar_volume_zscore"] = float(
                (vol.iloc[-1] - vol.mean()) / vol.std()
            )

    return out


def select_training_columns(df: pd.DataFrame) -> pd.DataFrame:
    """
    Keep features + target. Drop columns that would leak the future
    (exit_*, realized_pnl, r_multiple, outcome_score, max_*_excursion are
    all known at exit, NOT at signal time — they go in the *target* but
    can't be inputs).
    """
    leak_cols = {
        "id",
        "exit_time",
        "exit_price",
        "exit_reason",
        "realized_pnl",
        "pnl_percent",
        "max_favorable_excursion",
        "max_adverse_excursion",
        "outcome_score",
        "r_multiple",
        "fees",
        "slippage_bps",
        "hold_duration_seconds",
        "session_id",
        "created_at",
        "updated_at",
        "signal_metadata",
    }
    target_col = "outcome_label"
    if target_col not in df.columns:
        raise RuntimeError(
            f"Missing target column '{target_col}'. Did the trade_outcomes table get populated?"
        )

    keep = [c for c in df.columns if c not in leak_cols]
    return df[keep]


def main() -> int:
    args = parse_args()

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print(
            "Missing SUPABASE_URL / SUPABASE_SERVICE_KEY. Check the .env at repo root.",
            file=sys.stderr,
        )
        return 1

    client = create_client(url, key)
    print(f"Fetching trade_outcomes (limit={args.limit}, since={args.since})...")
    raw = fetch_trade_outcomes(client, since=args.since, limit=args.limit)
    print(f"  -> {len(raw)} rows")

    if raw.empty:
        print("No rows yet. Run the engine in paper mode and let trades close.")
        return 0

    print("Flattening indicators_snapshot...")
    df = flatten_indicators(raw)

    print("Adding bar-context features (this is the slow part — 1 query per trade)...")
    df = add_bar_context_features(df, client)

    print("Selecting non-leaking columns...")
    df = select_training_columns(df)

    # Strict time order. extract_features outputs in entry_time ascending so
    # the training script can do walk-forward CV without re-sorting.
    df = df.sort_values("entry_time").reset_index(drop=True)

    output = Path(args.output)
    output.parent.mkdir(exist_ok=True, parents=True)
    df.to_parquet(output, index=False)
    print(f"Wrote {len(df)} rows × {len(df.columns)} cols to {output}")

    # Quick summary
    if "outcome_label" in df.columns:
        counts = df["outcome_label"].value_counts(dropna=False).to_dict()
        print(f"Class balance: {counts}")
    if "regime" in df.columns:
        regime_counts = df["regime"].value_counts(dropna=False).to_dict()
        print(f"Regime distribution: {regime_counts}")
    if "strategy" in df.columns:
        strategy_counts = df["strategy"].value_counts(dropna=False).to_dict()
        print(f"Strategy distribution: {strategy_counts}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
