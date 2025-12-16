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
    powershell -NoProfile -Command "Start-Sleep -Seconds 2" >nul
)

netstat -an | findstr :8080 >nul
if %errorlevel% equ 0 (
    echo Port 8080 is in use. Attempting to free it...
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8080 ^| findstr LISTENING') do (
        taskkill /F /PID %%a >nul 2>nul
    )
    powershell -NoProfile -Command "Start-Sleep -Seconds 2" >nul
)

REM Install dependencies if needed
echo Checking dependencies...

if not exist node_modules (
    echo Installing frontend dependencies...
    call pnpm install
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install frontend dependencies
        pause
        exit /b 1
    )
)

REM Check backend dependencies and rimraf specifically
echo Checking backend dependencies...
cd atlas\apps\core-node
if not exist node_modules (
    echo Installing backend dependencies...
    call pnpm install
    if %errorlevel% neq 0 (
        echo ERROR: Failed to install backend dependencies
        cd ..\..\..
        pause
        exit /b 1
    )
) else (
    REM Check if rimraf exists
    if not exist node_modules\.bin\rimraf.cmd (
        echo Backend missing rimraf - reinstalling dependencies...
        call pnpm install
    )
)

REM Build backend if needed
if not exist dist (
    echo Building backend...
    call pnpm build
    if %errorlevel% neq 0 (
        echo ERROR: Failed to build backend
        cd ..\..\..
        pause
        exit /b 1
    )
)
cd ..\..\..

REM Start backend API in new window (use compiled JS to avoid tsx on Windows)
echo Starting backend API...
cd atlas\apps\core-node
start "AtlasBot Backend" cmd /c "node --enable-source-maps dist\api\server.js > ..\..\..\\logs\backend.log 2>&1"
cd ..\..\..

REM Wait for backend to be ready
echo Waiting for backend to start...
set /a attempts=0
:wait_backend
powershell -NoProfile -Command "Start-Sleep -Seconds 2" >nul
curl -s http://localhost:3001/health >nul 2>nul
if %errorlevel% neq 0 (
    set /a attempts+=1
    if %attempts% geq 30 (
        echo ERROR: Backend failed to start after 60 seconds
        echo Check logs\backend.log for details
        echo Opening backend log...
        start notepad logs\backend.log
        pause
        exit /b 1
    )
    goto wait_backend
)

echo Backend is ready!

REM Start trading engine
echo Starting trading engine in paper mode...
curl -X POST http://localhost:3001/api/engine/start -H "Content-Type: application/json" -d "{\"mode\": \"paper\"}" >nul 2>nul
if %errorlevel% equ 0 (
    echo Trading engine started!
) else (
    echo WARNING: Failed to start trading engine automatically
    echo You can start it manually from the UI
)

REM Start frontend in new window
echo Starting frontend...
start "AtlasBot Frontend" cmd /c "pnpm dev > logs\frontend.log 2>&1"

REM Wait for frontend
echo Waiting for frontend to start...
set /a attempts=0
:wait_frontend
powershell -NoProfile -Command "Start-Sleep -Seconds 2" >nul
curl -s http://localhost:8080 >nul 2>nul
if %errorlevel% neq 0 (
    set /a attempts+=1
    if %attempts% geq 30 (
        echo ERROR: Frontend failed to start after 60 seconds
        echo Check logs\frontend.log for details
        echo Opening frontend log...
        start notepad logs\frontend.log
        pause
        exit /b 1
    )
    goto wait_frontend
)

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

REM Open browser
echo Opening browser...
start http://localhost:8080

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