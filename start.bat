@echo off
REM AtlasBot v2 Startup Script for Windows
REM This script starts both the frontend and backend services

echo.
echo ===================================================
echo   Starting AtlasBot v2...
echo ===================================================
echo.

REM Check if Node.js is installed
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo ERROR: Node.js is not installed. Please install Node.js 20+ first.
    echo Download from: https://nodejs.org/
    pause
    exit /b 1
)

REM Check if pnpm is installed
where pnpm >nul 2>nul
if %errorlevel% neq 0 (
    echo Installing pnpm...
    call npm install -g pnpm
)

REM Create logs directory if it doesn't exist
if not exist logs mkdir logs

REM Function to check if port is in use
echo Checking ports...
netstat -an | findstr :3001 >nul
if %errorlevel% equ 0 (
    echo Port 3001 is in use. Attempting to free it...
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do (
        taskkill /F /PID %%a >nul 2>nul
    )
    timeout /t 2 /nobreak >nul
)

netstat -an | findstr :8080 >nul
if %errorlevel% equ 0 (
    echo Port 8080 is in use. Attempting to free it...
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
        taskkill /F /PID %%a >nul 2>nul
    )
    timeout /t 2 /nobreak >nul
)

REM Install dependencies if needed
echo Checking dependencies...

if not exist node_modules (
    echo Installing frontend dependencies...
    call pnpm install
)

if not exist atlas\apps\core-node\node_modules (
    echo Installing backend dependencies...
    cd atlas\apps\core-node
    call pnpm install
    cd ..\..\..
)

REM Build backend if needed
if not exist atlas\apps\core-node\dist (
    echo Building backend...
    cd atlas\apps\core-node
    call pnpm build
    cd ..\..\..
)

REM Start backend API in new window
echo Starting backend API...
cd atlas\apps\core-node
start "AtlasBot Backend" /min cmd /c "pnpm api > ..\..\..\logs\backend.log 2>&1"
cd ..\..\..

REM Wait for backend to be ready
echo Waiting for backend to start...
:wait_backend
timeout /t 2 /nobreak >nul
curl -s http://localhost:3001/health >nul 2>nul
if %errorlevel% neq 0 goto wait_backend

echo Backend is ready!

REM Start trading engine
echo Starting trading engine in paper mode...
curl -X POST http://localhost:3001/api/engine/start -H "Content-Type: application/json" -d "{\"mode\": \"paper\"}" >nul 2>nul
echo Trading engine started!

REM Start frontend in new window
echo Starting frontend...
start "AtlasBot Frontend" /min cmd /c "pnpm dev > logs\frontend.log 2>&1"

REM Wait for frontend
echo Waiting for frontend to start...
:wait_frontend
timeout /t 2 /nobreak >nul
curl -s http://localhost:8080 >nul 2>nul
if %errorlevel% neq 0 goto wait_frontend

REM Success message
cls
echo.
echo ===============================================================
echo   AtlasBot v2 is running!
echo ===============================================================
echo.
echo   Frontend:   http://localhost:8080
echo   Backend:    http://localhost:3001
echo   API Health: http://localhost:3001/health
echo   Status:     http://localhost:3001/api/status
echo.
echo   Tips:
echo   - Signals start after ~50 minutes of market data
echo   - Check logs\ folder for detailed output
echo   - Press Ctrl+C in this window to stop all services
echo.
echo ===============================================================
echo.
echo Press any key to stop AtlasBot...
pause >nul

REM Cleanup
echo.
echo Shutting down AtlasBot...
taskkill /F /FI "WindowTitle eq AtlasBot Backend*" >nul 2>nul
taskkill /F /FI "WindowTitle eq AtlasBot Frontend*" >nul 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3001 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>nul
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>nul
)
echo AtlasBot stopped.
exit /b 0
