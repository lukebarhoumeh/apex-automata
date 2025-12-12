#!/bin/bash

# AtlasBot Local Development Startup Script
# -----------------------------------------
# This script starts both the backend (port 3001) and frontend (port 8080)

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}"
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║                    AtlasBot Local Dev                     ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Check for .env file
if [ ! -f ".env" ]; then
    echo -e "${RED}❌ Error: .env file not found in project root${NC}"
    echo ""
    echo "Create a .env file with the following variables:"
    echo "  VITE_SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co"
    echo "  VITE_SUPABASE_PUBLISHABLE_KEY=your_anon_key"
    echo "  SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co"
    echo "  SUPABASE_ANON_KEY=your_anon_key"
    echo "  SUPABASE_SERVICE_KEY=your_service_key"
    echo "  ENCRYPTION_KEY=your_encryption_key"
    echo "  COINBASE_API_KEY=your_coinbase_key"
    echo "  COINBASE_API_SECRET=your_coinbase_secret"
    echo "  CONFIRM_LIVE=NO"
    echo "  VITE_RUNTIME_API_URL=http://localhost:3001"
    exit 1
fi

# Validate required env vars
echo -e "${YELLOW}📋 Validating .env file...${NC}"

required_vars=("SUPABASE_URL" "SUPABASE_SERVICE_KEY" "COINBASE_API_KEY" "COINBASE_API_SECRET")
missing_vars=()

for var in "${required_vars[@]}"; do
    if ! grep -q "^${var}=" .env || [ -z "$(grep "^${var}=" .env | cut -d'=' -f2)" ]; then
        missing_vars+=("$var")
    fi
done

if [ ${#missing_vars[@]} -gt 0 ]; then
    echo -e "${RED}❌ Missing required environment variables:${NC}"
    for var in "${missing_vars[@]}"; do
        echo "   - $var"
    done
    exit 1
fi

echo -e "${GREEN}✓ Environment variables validated${NC}"

# Install dependencies if needed
echo ""
echo -e "${YELLOW}📦 Checking dependencies...${NC}"

# Frontend dependencies
if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing frontend dependencies...${NC}"
    npm install
fi

# Backend dependencies
if [ ! -d "atlas/apps/core-node/node_modules" ]; then
    echo -e "${YELLOW}Installing backend dependencies...${NC}"
    cd atlas/apps/core-node
    pnpm install
    cd ../../..
fi

echo -e "${GREEN}✓ Dependencies ready${NC}"

# Copy .env to backend if needed
echo ""
echo -e "${YELLOW}📄 Syncing environment to backend...${NC}"
cp .env atlas/apps/core-node/.env
echo -e "${GREEN}✓ Environment synced${NC}"

# Function to cleanup on exit
cleanup() {
    echo ""
    echo -e "${YELLOW}🛑 Shutting down AtlasBot...${NC}"
    kill $(jobs -p) 2>/dev/null || true
    exit 0
}

trap cleanup SIGINT SIGTERM

# Start backend
echo ""
echo -e "${BLUE}🚀 Starting Backend API (port 3001)...${NC}"
cd atlas/apps/core-node
pnpm run api &
BACKEND_PID=$!
cd ../../..

# Wait for backend to be ready
echo -e "${YELLOW}⏳ Waiting for backend to start...${NC}"
sleep 3

# Check if backend is running
if curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Backend is running${NC}"
else
    echo -e "${YELLOW}⚠ Backend may still be starting...${NC}"
fi

# Start frontend
echo ""
echo -e "${BLUE}🌐 Starting Frontend (port 8080)...${NC}"
npm run dev -- --port 8080 &
FRONTEND_PID=$!

# Wait for frontend to start
sleep 3

echo ""
echo -e "${GREEN}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              AtlasBot is Running! 🚀                       ║${NC}"
echo -e "${GREEN}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BLUE}Frontend:${NC}  http://localhost:8080"
echo -e "  ${BLUE}Backend:${NC}   http://localhost:3001"
echo -e "  ${BLUE}Health:${NC}    http://localhost:3001/health"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for processes
wait
