@echo off
setlocal enabledelayedexpansion

:: AtlasBot Local Development Startup Script (Windows)
:: ----------------------------------------------------
:: This script starts both the backend (port 3001) and frontend (port 8080)

echo.
echo ===============================================================
echo                     AtlasBot Local Dev
echo ===============================================================
echo.

:: Check for .env file
if not exist ".env" (
    echo [ERROR] .env file not found in project root
    echo.
    echo Create a .env file with the following variables:
    echo   VITE_SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co
    echo   VITE_SUPABASE_PUBLISHABLE_KEY=your_anon_key
    echo   SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co
    echo   SUPABASE_ANON_KEY=your_anon_key
    echo   SUPABASE_SERVICE_KEY=your_service_key
    echo   ENCRYPTION_KEY=your_encryption_key
    echo   COINBASE_API_KEY=your_coinbase_key
    echo   COINBASE_API_SECRET=your_coinbase_secret
    echo   CONFIRM_LIVE=NO
    echo   VITE_RUNTIME_API_URL=http://localhost:3001
    exit /b 1
)

echo [INFO] Checking environment variables...

:: Validate required env vars (basic check)
findstr /c:"SUPABASE_SERVICE_KEY=" .env >nul
if errorlevel 1 (
    echo [ERROR] Missing SUPABASE_SERVICE_KEY in .env
    exit /b 1
)

findstr /c:"COINBASE_API_KEY=" .env >nul
if errorlevel 1 (
    echo [ERROR] Missing COINBASE_API_KEY in .env
    exit /b 1
)

echo [OK] Environment variables found

:: Install dependencies if needed
echo.
echo [INFO] Checking dependencies...

if not exist "node_modules" (
    echo [INFO] Installing frontend dependencies...
    call npm install
)

if not exist "atlas\apps\core-node\node_modules" (
    echo [INFO] Installing backend dependencies...
    cd atlas\apps\core-node
    call pnpm install
    cd ..\..\..
)

echo [OK] Dependencies ready

:: Copy .env to backend
echo.
echo [INFO] Syncing environment to backend...
copy /Y .env atlas\apps\core-node\.env >nul
echo [OK] Environment synced

:: Start backend in new window
echo.
echo [INFO] Starting Backend API (port 3001)...
start "AtlasBot Backend" cmd /c "cd atlas\apps\core-node && pnpm run api"

:: Wait for backend to start
echo [INFO] Waiting for backend to start...
timeout /t 5 /nobreak >nul

:: Start frontend in new window
echo.
echo [INFO] Starting Frontend (port 8080)...
start "AtlasBot Frontend" cmd /c "npm run dev -- --port 8080"

:: Wait for frontend
timeout /t 3 /nobreak >nul

echo.
echo ===============================================================
echo              AtlasBot is Running!
echo ===============================================================
echo.
echo   Frontend:  http://localhost:8080
echo   Backend:   http://localhost:3001
echo   Health:    http://localhost:3001/health
echo.
echo Close the terminal windows to stop the services.
echo.

pause
