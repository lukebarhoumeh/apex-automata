#!/bin/bash
# Regression harness for the pulse-monitor drawdown alert fix.
# Confirms the new JSON extractor + numeric compare reproduces the
# expected behavior on today's 1.11% drawdown plus synthetic edge cases.

set -u

read_json_num() {
  local json="$1"
  local path="$2"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$json" | jq -r ".${path} // empty" 2>/dev/null
    return
  fi
  local py
  py="$(command -v python3 || command -v python)"
  if [ -n "$py" ]; then
    JSON_DATA="$json" JSON_PATH="$path" "$py" -c '
import json, os
try:
    v = json.loads(os.environ["JSON_DATA"])
    for k in os.environ["JSON_PATH"].split("."):
        v = v[k]
    if isinstance(v, (int, float)):
        print(v)
except Exception:
    pass
' 2>/dev/null
  fi
}

# Today's actual STATUS (excerpt from run-2026-05-13_1433_latest.txt line 4).
TODAY_STATUS='{"engineRunning":false,"risk":{"exposureUsd":0,"dailyPnLUsd":-111.07806094893749,"maxDrawdownPct":1.1107806094893748,"killSwitchActive":true}}'
HIGH_STATUS='{"engineRunning":false,"risk":{"exposureUsd":0,"dailyPnLUsd":-1234,"maxDrawdownPct":12.5,"killSwitchActive":true}}'
BOUND_STATUS='{"engineRunning":false,"risk":{"exposureUsd":0,"dailyPnLUsd":-999,"maxDrawdownPct":10.0,"killSwitchActive":true}}'
LOW_STATUS='{"engineRunning":false,"risk":{"exposureUsd":0,"dailyPnLUsd":-50,"maxDrawdownPct":9.99,"killSwitchActive":false}}'
EMPTY_STATUS='{"engineRunning":false,"risk":{}}'
BAD_STATUS='{"junk":1}'

FAILED=0
assert_alert() {
  local label="$1"
  local payload="$2"
  local want="$3"  # "yes" or "no"
  local pct got="no"
  pct=$(read_json_num "$payload" risk.maxDrawdownPct)
  if [ -n "$pct" ] && awk -v v="$pct" 'BEGIN{ exit !(v+0 >= 10) }'; then
    got="yes"
  fi
  if [ "$got" = "$want" ]; then
    printf 'PASS  %-25s pct=%-22s alert=%s\n' "$label" "${pct:-<empty>}" "$got"
  else
    printf 'FAIL  %-25s pct=%-22s alert=%s expected=%s\n' "$label" "${pct:-<empty>}" "$got" "$want"
    FAILED=1
  fi
}

assert_alert "today_1.11pct"       "$TODAY_STATUS"  "no"
assert_alert "synthetic_12.5pct"   "$HIGH_STATUS"   "yes"
assert_alert "boundary_10.0pct"    "$BOUND_STATUS"  "yes"
assert_alert "just_below_9.99pct"  "$LOW_STATUS"    "no"
assert_alert "missing_field"       "$EMPTY_STATUS"  "no"
assert_alert "malformed_json"      "$BAD_STATUS"    "no"

if [ "$FAILED" -ne 0 ]; then
  echo "TEST FAILURES"
  exit 1
fi
echo "ALL TESTS PASS"
