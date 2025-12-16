@echo off
REM Clean installation script for Windows
REM Removes all node_modules and reinstalls everything

echo ===================================================
echo   AtlasBot v2 - Clean Install (Windows)
echo ===================================================
echo.
echo This will remove all node_modules and reinstall.
echo.
pause

echo Removing node_modules...
if exist node_modules (
    echo Removing frontend node_modules...
    rmdir /s /q node_modules
)

if exist atlas\apps\core-node\node_modules (
    echo Removing backend node_modules...
    rmdir /s /q atlas\apps\core-node\node_modules
)

if exist atlas\node_modules (
    echo Removing atlas workspace node_modules...
    rmdir /s /q atlas\node_modules
)

if exist atlas\apps\core-node\dist (
    echo Removing backend dist...
    rmdir /s /q atlas\apps\core-node\dist
)

REM Remove lock files to ensure clean install
if exist atlas\apps\core-node\pnpm-lock.yaml (
    echo Removing backend lock file...
    del /f atlas\apps\core-node\pnpm-lock.yaml
)

echo.
echo Installing frontend dependencies...
call pnpm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install frontend dependencies
    pause
    exit /b 1
)

echo.
echo Installing backend dependencies...
cd atlas\apps\core-node
call pnpm install
if %errorlevel% neq 0 (
    echo ERROR: Failed to install backend dependencies
    cd ..\..\..\
    pause
    exit /b 1
)
cd ..\..\..\

echo.
echo Building backend...
cd atlas\apps\core-node
call pnpm build
if %errorlevel% neq 0 (
    echo ERROR: Failed to build backend
    cd ..\..\..\
    pause
    exit /b 1
)
cd ..\..\..\

echo.
echo ===================================================
echo   Clean install complete!
echo ===================================================
echo.
echo Run start.bat to start the application.
pause