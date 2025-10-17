#!/bin/bash

# AtlasBot v2 Startup Script
# This script starts both the frontend and backend services

set -e

echo "🚀 Starting AtlasBot v2..."

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed. Please install Node.js 20+ first.${NC}"
    exit 1
fi

# Check if pnpm is installed
if ! command -v pnpm &> /dev/null; then
    echo -e "${YELLOW}📦 Installing pnpm...${NC}"
    npm install -g pnpm
fi

# Function to check if port is in use
check_port() {
    if lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null 2>&1; then
        echo -e "${YELLOW}⚠️  Port $1 is already in use. Attempting to free it...${NC}"
        lsof -ti:$1 | xargs kill -9 2>/dev/null || true
        sleep 2
    fi
}

# Function to wait for service
wait_for_service() {
    local url=$1
    local name=$2
    local max_attempts=30
    local attempt=0
    
    echo -e "${YELLOW}⏳ Waiting for $name to start...${NC}"
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -s "$url" > /dev/null 2>&1; then
            echo -e "${GREEN}✅ $name is ready!${NC}"
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    
    echo -e "${RED}❌ $name failed to start after 30 seconds${NC}"
    return 1
}

# Install dependencies if needed
echo -e "${YELLOW}📦 Checking dependencies...${NC}"

if [ ! -d "node_modules" ]; then
    echo -e "${YELLOW}Installing frontend dependencies...${NC}"
    pnpm install
fi

if [ ! -d "atlas/apps/core-node/node_modules" ]; then
    echo -e "${YELLOW}Installing backend dependencies...${NC}"
    cd atlas/apps/core-node
    pnpm install
    cd ../../..
fi

# Build backend if needed
if [ ! -d "atlas/apps/core-node/dist" ]; then
    echo -e "${YELLOW}🔨 Building backend...${NC}"
    cd atlas/apps/core-node
    pnpm build
    cd ../../..
fi

# Check and free ports
check_port 3001
check_port 5173

# Start backend API
echo -e "${GREEN}🚀 Starting backend API...${NC}"
cd atlas/apps/core-node
pnpm api > ../../../logs/backend.log 2>&1 &
BACKEND_PID=$!
cd ../../..

# Wait for backend to be ready
wait_for_service "http://localhost:3001/health" "Backend API"

# Start trading engine
echo -e "${GREEN}📈 Starting trading engine in paper mode...${NC}"
curl -X POST http://localhost:3001/api/engine/start \
  -H "Content-Type: application/json" \
  -d '{"mode": "paper"}' \
  > /dev/null 2>&1

echo -e "${GREEN}✅ Trading engine started!${NC}"

# Start frontend
echo -e "${GREEN}🎨 Starting frontend...${NC}"
pnpm dev > logs/frontend.log 2>&1 &
FRONTEND_PID=$!

# Wait for frontend
wait_for_service "http://localhost:5173" "Frontend"

# Print success message
echo -e "${GREEN}"
echo "═══════════════════════════════════════════════════════════════"
echo "  🎉 AtlasBot v2 is running!"
echo "═══════════════════════════════════════════════════════════════"
echo -e "${NC}"
echo "  📊 Frontend:   http://localhost:5173"
echo "  🔧 Backend:    http://localhost:3001"
echo "  📝 API Health: http://localhost:3001/health"
echo "  📈 Status:     http://localhost:3001/api/status"
echo ""
echo "  💡 Tips:"
echo "  - Signals start after ~50 minutes of market data"
echo "  - Check logs/ folder for detailed output"
echo "  - Press Ctrl+C to stop all services"
echo ""
echo "═══════════════════════════════════════════════════════════════"

# Function to cleanup on exit
cleanup() {
    echo -e "\n${YELLOW}🛑 Shutting down AtlasBot...${NC}"
    
    # Kill frontend
    if [ ! -z "$FRONTEND_PID" ]; then
        kill $FRONTEND_PID 2>/dev/null || true
    fi
    
    # Kill backend
    if [ ! -z "$BACKEND_PID" ]; then
        kill $BACKEND_PID 2>/dev/null || true
    fi
    
    # Kill any remaining processes on ports
    lsof -ti:3001 | xargs kill -9 2>/dev/null || true
    lsof -ti:5173 | xargs kill -9 2>/dev/null || true
    
    echo -e "${GREEN}✅ AtlasBot stopped${NC}"
    exit 0
}

# Set up trap to cleanup on Ctrl+C
trap cleanup INT TERM

# Keep script running
while true; do
    sleep 1
done
