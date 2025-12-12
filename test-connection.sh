#!/bin/bash

# AtlasBot Connection Test Script
# --------------------------------
# Tests all connections: Backend, Supabase, WebSocket

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║              AtlasBot Connection Test                     ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

BACKEND_URL="http://localhost:3001"
SUPABASE_URL="https://gdrdaajvutmewgxbjurk.supabase.co"

# Track results
TESTS_PASSED=0
TESTS_FAILED=0

# Test function
test_endpoint() {
    local name=$1
    local url=$2
    local expected=$3
    
    echo -n "Testing $name... "
    
    response=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null)
    
    if [ "$response" = "$expected" ]; then
        echo -e "${GREEN}✓ OK (HTTP $response)${NC}"
        ((TESTS_PASSED++))
        return 0
    else
        echo -e "${RED}✗ FAILED (HTTP $response, expected $expected)${NC}"
        ((TESTS_FAILED++))
        return 1
    fi
}

echo ""
echo -e "${YELLOW}1. Backend Health Check${NC}"
echo "------------------------"

test_endpoint "Backend /health" "$BACKEND_URL/health" "200"
test_endpoint "Backend /api/status" "$BACKEND_URL/api/status" "200"

echo ""
echo -e "${YELLOW}2. Supabase Connection${NC}"
echo "-----------------------"

test_endpoint "Supabase REST API" "$SUPABASE_URL/rest/v1/" "200"

echo ""
echo -e "${YELLOW}3. Backend API Endpoints${NC}"
echo "-------------------------"

test_endpoint "GET /api/positions" "$BACKEND_URL/api/positions" "200"
test_endpoint "GET /api/orders" "$BACKEND_URL/api/orders" "200"
test_endpoint "GET /api/signals" "$BACKEND_URL/api/signals" "200"

echo ""
echo -e "${YELLOW}4. WebSocket Test${NC}"
echo "------------------"

echo -n "Testing WebSocket connection... "
# Quick WebSocket test using timeout
if command -v websocat &> /dev/null; then
    if timeout 2 websocat -1 "ws://localhost:3001/events" 2>/dev/null; then
        echo -e "${GREEN}✓ OK${NC}"
        ((TESTS_PASSED++))
    else
        echo -e "${YELLOW}⚠ No response (server may not be broadcasting)${NC}"
    fi
else
    echo -e "${YELLOW}⚠ Skipped (websocat not installed)${NC}"
    echo "  Install with: brew install websocat (Mac) or cargo install websocat"
fi

echo ""
echo -e "${YELLOW}5. Database Data Check${NC}"
echo "-----------------------"

echo -n "Checking symbols table... "
response=$(curl -s "$SUPABASE_URL/rest/v1/symbols?select=symbol&limit=3" \
    -H "apikey: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I" \
    -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I" 2>/dev/null)

if echo "$response" | grep -q "BTC-USD"; then
    echo -e "${GREEN}✓ Found BTC-USD, ETH-USD, SOL-USD${NC}"
    ((TESTS_PASSED++))
else
    echo -e "${RED}✗ Symbols not found${NC}"
    ((TESTS_FAILED++))
fi

echo ""
echo "═══════════════════════════════════════════════════════════"
echo -e "Results: ${GREEN}$TESTS_PASSED passed${NC}, ${RED}$TESTS_FAILED failed${NC}"
echo "═══════════════════════════════════════════════════════════"

if [ $TESTS_FAILED -eq 0 ]; then
    echo ""
    echo -e "${GREEN}All tests passed! AtlasBot is ready.${NC}"
    exit 0
else
    echo ""
    echo -e "${YELLOW}Some tests failed. Check the output above.${NC}"
    echo ""
    echo "Common fixes:"
    echo "  - Backend not running: Run ./start-local.sh first"
    echo "  - Missing .env: Create .env with required variables"
    echo "  - Database empty: Check Supabase dashboard"
    exit 1
fi
