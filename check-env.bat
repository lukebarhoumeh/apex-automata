@echo off
echo ===================================================
echo   AtlasBot Environment Check
echo ===================================================
echo.

echo Node.js version:
node --version
echo.

echo NPM version:
call npm --version
echo.

echo PNPM version:
where pnpm >nul 2>nul
if %errorlevel% equ 0 (
    call pnpm --version
) else (
    echo PNPM not installed
)
echo.

echo Checking .env file...
if exist .env (
    echo .env file exists
) else (
    echo WARNING: .env file not found!
    echo Creating template .env file...
    (
        echo # Frontend Environment Variables
        echo VITE_RUNTIME_API_URL=http://localhost:3001
        echo.
        echo # Backend Environment Variables
        echo SUPABASE_URL=
        echo SUPABASE_ANON_KEY=
        echo SUPABASE_SERVICE_KEY=
        echo.
        echo # Trading Configuration
        echo CONFIRM_LIVE=NO
        echo.
        echo # Fixed USER_ID for single-user MVP
        echo USER_ID=b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f
        echo.
        echo # Encryption key for development
        echo ENCRYPTION_KEY=dev-only-secret-key-change-in-production
    ) > .env
    echo Created template .env file - please add your Supabase credentials
)
echo.

echo Checking rimraf in backend...
cd atlas\apps\core-node
if exist node_modules\.bin\rimraf.cmd (
    echo Rimraf is installed
) else (
    echo Rimraf not found
)
cd ..\..\..

echo.
pause
