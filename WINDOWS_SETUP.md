# AtlasBot v2 - Windows Setup Guide

## Quick Start

### Option 1: Clean Install (Recommended First Time)
```cmd
clean-install.bat
```
This removes all existing installations and does a fresh install.

### Option 2: Regular Start
```cmd
start.bat
```
This checks dependencies and starts everything.

## What Gets Fixed

The updated scripts handle these Windows-specific issues:

1. **inotify package** - Linux-only file watcher that fails on Windows (now skipped)
2. **rimraf missing** - Build tool now properly installed
3. **Port conflicts** - Automatically frees ports 3001 and 5173
4. **Better error handling** - Shows clear error messages with timeouts
5. **Auto browser launch** - Opens http://localhost:5173 when ready

## Access Points

- **Frontend UI**: http://localhost:8080
- **Backend API**: http://localhost:3001
- **Health Check**: http://localhost:3001/health
- **Status**: http://localhost:3001/api/status

## Logs

Check the `logs/` folder for detailed output:
- `logs/backend.log` - Backend API and trading engine
- `logs/frontend.log` - Frontend Vite dev server

## Stopping the Application

Press any key in the start.bat window, or run:
```cmd
node stop.cjs
```

## Troubleshooting

### Build Fails
1. Run `clean-install.bat`
2. Make sure you have Node.js 20+ installed
3. Check `logs/backend.log` for specific errors

### Ports Already in Use
The script will attempt to free ports automatically. If it fails:
```cmd
netstat -ano | findstr :3001
taskkill /F /PID <PID>
```

### Missing Dependencies
```cmd
cd atlas\apps\core-node
pnpm install --no-optional --ignore-scripts
pnpm build
```

## Environment Variables

Make sure you have a `.env` file in the root directory with:

```env
VITE_RUNTIME_API_URL=http://localhost:3001
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_anon_key
SUPABASE_SERVICE_KEY=your_service_key
USER_ID=b7e8f9c2-4d6a-4c8b-9e2d-1a3b5c7d9e1f
CONFIRM_LIVE=NO
ENCRYPTION_KEY=your_32_byte_hex_key
```

## First Run Checklist

- [ ] Node.js 20+ installed
- [ ] `.env` file created with Supabase credentials
- [ ] Run `clean-install.bat`
- [ ] Run `start.bat`
- [ ] Open http://localhost:5173
- [ ] Check that backend is connected (green status in UI)

## Paper Trading Mode

The system starts in **paper mode** by default:
- Uses Coinbase sandbox data (BTC-USD)
- Simulated order fills
- Safe for testing
- Signals appear after ~50 minutes of data collection

To switch to live mode, you need real Coinbase API credentials and must set `CONFIRM_LIVE=YES`.

