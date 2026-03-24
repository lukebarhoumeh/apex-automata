#!/usr/bin/env bash
set -e

echo "=== TASK_005 Verification ==="

# Bug A: Check that rest-client.ts uses v3 API endpoint
echo -n "Bug A: REST client uses v3 orders endpoint... "
if grep -q "api/v3/brokerage/orders/historical" atlas/apps/core-node/src/exchanges/coinbase/rest-client.ts; then
  echo "PASS"
else
  echo "FAIL — rest-client.ts still uses deprecated /orders endpoint"
  exit 1
fi

# Bug B: Check that hardcoded 25 is removed from trend-follow
echo -n "Bug B: trend_follow uses dynamic EMA thresholds... "
if grep -q "length < 25" atlas/apps/core-node/src/strategies/plugins/builtin/trend-follow-strategy.ts; then
  echo "FAIL — hardcoded 25-candle minimum still present"
  exit 1
else
  echo "PASS"
fi

# Bug C: Check that disabled_strategies is in Zod schema
echo -n "Bug C: disabled_strategies in Zod schema... "
if grep -q "disabled_strategies" atlas/apps/core-node/src/config/loadGuardrails.ts; then
  echo "PASS"
else
  echo "FAIL — disabled_strategies not added to GuardrailsSchema"
  exit 1
fi

# Bug C: Check that server.ts uses disabledStrategies
echo -n "Bug C: server.ts passes disabledStrategies to SignalProcessor... "
if grep -q "disabledStrategies" atlas/apps/core-node/src/api/server.ts; then
  echo "PASS"
else
  echo "FAIL — server.ts does not wire disabled_strategies"
  exit 1
fi

# Bug D: Check that PaperSimulator handles short sells
echo -n "Bug D: PaperSimulator supports short sells... "
if grep -q "collateral\|short sell\|Short sell\|short" atlas/apps/core-node/src/trading/paper-trading-simulator.ts; then
  echo "PASS"
else
  echo "FAIL — PaperSimulator still blocks short sells"
  exit 1
fi

# Bug E: Check that aggressive message-age reconnect is softened
echo -n "Bug E: WS stall detection not forcing reconnect on message age... "
if grep -A5 "no_messages\|no_recent_messages" atlas/apps/core-node/src/exchanges/coinbase/websocket.ts | grep -q "forceReconnect"; then
  echo "FAIL — message-age stall detection still forces reconnect"
  exit 1
else
  echo "PASS"
fi

# Bug F: Check that perps risk monitor respects paper mode
echo -n "Bug F: PerpsRiskMonitor skips polling in paper mode... "
if grep -q "mode.*live.*perpsRiskMonitor\|paper.*mode.*NOT.*polling\|paper mode.*no INTX" atlas/apps/core-node/src/api/server.ts; then
  echo "PASS"
else
  echo "FAIL — PerpsRiskMonitor still starts unconditionally"
  exit 1
fi

echo ""
echo "=== All TASK_005 checks passed ==="
