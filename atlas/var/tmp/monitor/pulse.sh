#!/bin/bash
# 6-hour pulse monitor for paper trading run starting 2026-05-13 ~14:33 CT
# Polls /api/status, /api/positions, /api/signals/recent every 5 minutes.
# Writes per-pulse log + a "latest" summary file overwritten each cycle.

set -u
cd "$(dirname "$0")/../../../.."

LOG_DIR="atlas/var/tmp/monitor"
RUN_TAG="run-2026-05-13_1433"
LOG="${LOG_DIR}/${RUN_TAG}.log"
SUMMARY="${LOG_DIR}/${RUN_TAG}_latest.txt"
ALERTS="${LOG_DIR}/${RUN_TAG}_alerts.log"

START=$(date +%s)
END=$((START + 6*3600))

# JSON numeric extractor — prefers jq, falls back to python(3).
# Returns the scalar value at the given dotted path (e.g. risk.maxDrawdownPct)
# or an empty string if missing/invalid. Caller decides how to handle empty.
#
# Replaces the pre-existing regex on `maxDrawdownPct` which mis-fired on any
# drawdown >= 0.1% because the field is in percent units (1.11 means 1.11%),
# not fraction units. We now parse JSON properly and compare numerically.
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
    # Pass the JSON through env (not stdin) so we never collide with the
    # `python -c` heredoc/script-source pattern, and so the JSON survives
    # arbitrary quoting. PATH_QUERY is a dotted path like `risk.maxDrawdownPct`.
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

echo "=== Pulse monitor started $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" >> "$LOG"
echo "End scheduled: $(date -u -d "@$END" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "+6h")" >> "$LOG"

CYCLE=0
while [ "$(date +%s)" -lt "$END" ]; do
  CYCLE=$((CYCLE+1))
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  EPOCH=$(date +%s)
  ELAPSED_MIN=$(( (EPOCH - START) / 60 ))

  STATUS=$(curl -s -m 10 http://localhost:3001/api/status 2>&1 || echo '{"error":"curl_failed"}')
  sleep 2
  RISK=$(curl -s -m 10 http://localhost:3001/api/risk/status 2>&1 || echo '{"error":"curl_failed"}')
  sleep 2
  TRADES=$(curl -s -m 10 "http://localhost:3001/api/analytics/trade-history?limit=10" 2>&1 || echo '{"error":"curl_failed"}')
  sleep 2
  METAFILTER=$(curl -s -m 10 "http://localhost:3001/api/metafilter/decisions?limit=10" 2>&1 || echo '{"error":"curl_failed"}')
  sleep 2
  REGIME=$(curl -s -m 10 http://localhost:3001/api/regime/state 2>&1 || echo '{"error":"curl_failed"}')
  sleep 2
  EXCHANGE=$(curl -s -m 10 http://localhost:3001/api/exchange/health 2>&1 || echo '{"error":"curl_failed"}')

  {
    echo "--- cycle=$CYCLE ts=$TS elapsed_min=$ELAPSED_MIN ---"
    echo "STATUS: $STATUS"
    echo "RISK: $RISK"
    echo "TRADES: $TRADES"
    echo "METAFILTER: $METAFILTER"
    echo "REGIME: $REGIME"
    echo "EXCHANGE: $EXCHANGE"
  } >> "$LOG"

  {
    echo "Pulse cycle $CYCLE @ $TS (run elapsed ${ELAPSED_MIN} min)"
    echo ""
    echo "[STATUS]"
    echo "$STATUS"
    echo ""
    echo "[RISK]"
    echo "$RISK"
    echo ""
    echo "[RECENT TRADES]"
    echo "$TRADES"
    echo ""
    echo "[META-FILTER DECISIONS]"
    echo "$METAFILTER"
    echo ""
    echo "[REGIME PER SYMBOL]"
    echo "$REGIME"
    echo ""
    echo "[EXCHANGE HEALTH]"
    echo "$EXCHANGE"
  } > "$SUMMARY"

  if echo "$STATUS" | grep -q '"killSwitch":{"active":true'; then
    echo "$TS ALERT killSwitch active" >> "$ALERTS"
  fi
  if echo "$STATUS" | grep -q '"dailyStopHit":true'; then
    echo "$TS ALERT dailyStopHit true" >> "$ALERTS"
  fi
  if echo "$STATUS" | grep -q '"engineRunning":false'; then
    echo "$TS ALERT engineRunning false" >> "$ALERTS"
  fi
  if echo "$STATUS" | grep -q '"connected":false'; then
    echo "$TS ALERT WS disconnected" >> "$ALERTS"
  fi
  # Drawdown is reported in PERCENT units (e.g. 1.11 means 1.11%), so the
  # old regex `(0\.[1-9]|[1-9])` fired on any drawdown >= 0.1% and produced
  # 100+ false positives at today's 1.11% drawdown. Parse JSON and compare
  # numerically; awk handles floats portably across bash/zsh/git-bash.
  DD_PCT=$(read_json_num "$STATUS" risk.maxDrawdownPct)
  if [ -n "$DD_PCT" ] && awk -v v="$DD_PCT" 'BEGIN{ exit !(v+0 >= 10) }'; then
    echo "$TS ALERT drawdown >= 10pct (value=${DD_PCT}%)" >> "$ALERTS"
  fi
  if echo "$STATUS" | grep -q '"degraded":true'; then
    echo "$TS ALERT exchange degraded" >> "$ALERTS"
  fi

  sleep 287
done

echo "=== Pulse monitor complete $(date -u +%Y-%m-%dT%H:%M:%SZ) === cycles=$CYCLE" >> "$LOG"
