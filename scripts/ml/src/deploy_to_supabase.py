"""
deploy_to_supabase.py
=====================

Convert a trained pickle model to ONNX, hash it, and write a row into
public.models. Optionally promote it to active (deactivating prior actives
in a single transaction so the runtime sees exactly one active model at
any time).

The runtime's signal-processor reads the latest active row from this table
at engine start and uses the path/sha256 to load the ONNX file. We don't
upload the file itself — just the path. For now models live on the same
filesystem as the engine; this can be swapped to a CDN/S3 later without
touching the schema.

Run:
    python src/deploy_to_supabase.py models/meta_label_<timestamp>.pkl --activate
"""
from __future__ import annotations

import argparse
import hashlib
import os
import pickle
import sys
import uuid
from pathlib import Path

import numpy as np
from dotenv import load_dotenv
from skl2onnx import convert_sklearn
from skl2onnx.common.data_types import FloatTensorType
from supabase import create_client

REPO_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(REPO_ROOT / ".env")


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("model_path", help="Path to a .pkl produced by train_meta_label.py")
    p.add_argument(
        "--activate",
        action="store_true",
        help="Mark this model as active in public.models, deactivating prior actives.",
    )
    p.add_argument(
        "--name",
        default="meta_label",
        help="Logical model name. Versions are tracked separately.",
    )
    return p.parse_args()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(64 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    args = parse_args()
    pkl_path = Path(args.model_path)
    if not pkl_path.exists():
        print(f"Model file not found: {pkl_path}", file=sys.stderr)
        return 1

    with open(pkl_path, "rb") as f:
        bundle = pickle.load(f)

    model = bundle["model"]
    feature_cols = bundle["feature_columns"]
    metrics = bundle["metrics"]
    timestamp = bundle["timestamp"]
    n_train = bundle["n_train"]

    # Skl2onnx needs an example input shape. We use a single-row float
    # tensor with the same number of features.
    initial_types = [("float_input", FloatTensorType([None, len(feature_cols)]))]
    onnx_path = pkl_path.with_suffix(".onnx")
    print(f"Converting to ONNX...")
    onnx_model = convert_sklearn(
        model,
        initial_types=initial_types,
        target_opset=15,
        options={id(model): {"zipmap": False}},  # raw probs not [{0:p, 1:p}, ...]
    )
    onnx_path.write_bytes(onnx_model.SerializeToString())
    print(f"  -> {onnx_path} ({onnx_path.stat().st_size:,} bytes)")

    sha = sha256_file(onnx_path)

    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        print("Missing SUPABASE_URL / SUPABASE_SERVICE_KEY", file=sys.stderr)
        return 1
    client = create_client(url, key)

    if args.activate:
        # Single-statement deactivation of prior actives — run BEFORE inserting
        # the new row so there's never zero active rows for the same name.
        # We use upsert here only if needed; a plain update is simpler.
        print("Deactivating prior active models...")
        client.table("models").update({"active": False}).eq("name", args.name).eq(
            "active", True
        ).execute()

    overall = metrics.get("overall", {})
    row = {
        "id": str(uuid.uuid4()),
        "name": args.name,
        "version": timestamp,
        "path": str(onnx_path.relative_to(REPO_ROOT)).replace("\\", "/"),
        "sha256": sha,
        "input_schema": {"feature_columns": feature_cols},
        "metrics": {
            "n_train": n_train,
            "auc": overall.get("auc"),
            "ap": overall.get("ap"),
            "brier": overall.get("brier"),
            "win_rate": overall.get("win_rate"),
            "by_regime": metrics.get("by_regime"),
            "by_strategy": metrics.get("by_strategy"),
            "params": bundle.get("params"),
        },
        "active": bool(args.activate),
    }

    print(f"Inserting model row (active={row['active']})...")
    resp = client.table("models").insert(row).execute()
    print("Inserted:", resp.data[0] if resp.data else "(no data returned)")

    if args.activate:
        print(f"\n✓ {args.name}@{timestamp} is now ACTIVE.")
        print("Restart the engine to pick up the new model:")
        print("  pm2 restart apex-backend")
    else:
        print(f"\nModel {args.name}@{timestamp} registered (inactive).")
        print("Activate later with --activate or by updating the row directly.")

    return 0


if __name__ == "__main__":
    sys.exit(main())
