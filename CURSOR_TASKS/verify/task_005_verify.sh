#!/usr/bin/env bash
set -e

echo "=== TASK_005 Verification ==="

echo -n "Bug A: REST client uses v3 orders endpoint... "
if grep -q "api/v3/brokerage/orders/historical" atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

echo -n "Bug B: trend_follow uses dynamic EMA thresholds... "
if grep -q "length < 25" atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts; then
  echo "FAIL"
  exit 1
else
  echo "PASS"
fi

echo -n "Bug C: disabled_strategies in Zod schema... "
if grep -q "disabled_strategies" atlas/apps/core-node/src/config/loadGuardrails.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

echo -n "Bug C: server.ts passes disabledStrategies... "
if grep -q "disabledStrategies" atlas/apps/core-node/src/api/server.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

echo -n "Bug D: PaperSimulator supports short sells... "
if grep -q "collateral" atlas/apps/core-node/src/trading/paper-trading-simulator.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

echo -n "Bug E: WS stall no longer forces reconnect on msg age... "
COUNT=$(grep -c "forceReconnect" atlas/apps/core-node/src/exchanges/coinbase/websocket.ts)
if [ "$COUNT" -le 2 ]; then
  echo "PASS"
else
  echo "FAIL (forceReconnect called $COUNT times)"
  exit 1
fi

echo -n "Bug F: PerpsRiskMonitor gated on live mode... "
if grep -q "paper mode" atlas/apps/core-node/src/api/server.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

echo ""
echo "=== All TASK_005 checks passed ==="
