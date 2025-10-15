#!/bin/bash

# AtlasBot Trading System Startup Script
# This script starts the backend API server and frontend in the correct order

echo "🚀 Starting AtlasBot Trading System..."
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to check if port is in use
check_port() {
    if lsof -Pi :$1 -sTCP:LISTEN -t >/dev/null ; then
        return 0
    else
        return 1
    fi
}

# Kill any existing processes on our ports
echo "🔍 Checking for existing processes..."
if check_port 3001; then
    echo -e "${YELLOW}Found process on port 3001, killing it...${NC}"
    lsof -ti:3001 | xargs kill -9 2>/dev/null
fi

if check_port 8080; then
    echo -e "${YELLOW}Found process on port 8080, killing it...${NC}"
    lsof -ti:8080 | xargs kill -9 2>/dev/null
fi

if check_port 5173; then
    echo -e "${YELLOW}Found process on port 5173, killing it...${NC}"
    lsof -ti:5173 | xargs kill -9 2>/dev/null
fi

# Start the API server
echo ""
echo "🔧 Starting Backend API Server..."
echo -e "${YELLOW}Starting in new terminal window...${NC}"

# For macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e 'tell app "Terminal" to do script "cd '"$PWD"'/atlas/apps/core-node && echo \"🚀 Starting API Server...\" && pnpm api"'
else
    # For Linux/Unix
    gnome-terminal -- bash -c "cd $PWD/atlas/apps/core-node && echo '🚀 Starting API Server...' && pnpm api; exec bash"
fi

# Wait for API server to start
echo "⏳ Waiting for API server to start on port 3001..."
for i in {1..30}; do
    if check_port 3001; then
        echo -e "${GREEN}✅ API Server is running on port 3001${NC}"
        break
    fi
    sleep 1
    echo -n "."
done

if ! check_port 3001; then
    echo -e "${RED}❌ API Server failed to start. Please check the terminal for errors.${NC}"
    exit 1
fi

# Start the frontend
echo ""
echo "🎨 Starting Frontend..."
echo -e "${YELLOW}Starting in new terminal window...${NC}"

# For macOS
if [[ "$OSTYPE" == "darwin"* ]]; then
    osascript -e 'tell app "Terminal" to do script "cd '"$PWD"' && echo \"🚀 Starting Frontend...\" && npm run dev"'
else
    # For Linux/Unix
    gnome-terminal -- bash -c "cd $PWD && echo '🚀 Starting Frontend...' && npm run dev; exec bash"
fi

# Wait for frontend to start
echo "⏳ Waiting for Frontend to start..."
sleep 5

# Check which port the frontend is using
if check_port 8080; then
    FRONTEND_PORT=8080
elif check_port 5173; then
    FRONTEND_PORT=5173
else
    echo -e "${YELLOW}⚠️  Frontend may still be starting...${NC}"
    FRONTEND_PORT=8080
fi

echo ""
echo "✨ AtlasBot Trading System Started!"
echo ""
echo "📊 Access the dashboard at: http://localhost:$FRONTEND_PORT"
echo "🔌 API Server running at: http://localhost:3001"
echo ""
echo -e "${YELLOW}⚠️  Before starting trading:${NC}"
echo "1. Make sure you've created the .env.local file in the atlas directory"
echo "2. Ensure your Supabase service key is added to .env.local"
echo "3. Run the database seed script in Supabase SQL editor"
echo ""
echo -e "${GREEN}Press Ctrl+C in this terminal to stop all services${NC}"

# Keep script running and handle shutdown
trap 'echo -e "\n${YELLOW}Shutting down services...${NC}"; lsof -ti:3001 | xargs kill -9 2>/dev/null; lsof -ti:8080 | xargs kill -9 2>/dev/null; lsof -ti:5173 | xargs kill -9 2>/dev/null; exit' INT

# Keep the script running
while true; do
    sleep 1
done
