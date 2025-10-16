# 🚀 AtlasBot Quick Start Guide

## What You Have Now

✅ **Frontend**: Fully functional React dashboard (this Lovable project)  
✅ **Database**: Supabase configured with all tables and RLS policies  
✅ **Backend**: Node.js trading engine ready in `atlas/apps/core-node`  
⚠️ **Connection**: Backend needs to run locally to connect

## Current Status

### The Problem (FIXED)
The frontend was showing "DB Only Mode" and couldn't access any data because:
- RLS policies required authenticated users (`auth.uid()`)
- You removed authentication for single-user mode
- All database queries returned empty (403 forbidden)

### The Fix Applied ✅
- **Updated all RLS policies** to work without authentication
- **Enabled single-user mode** (no login required)
- **Frontend can now read/write** to Supabase directly
- **Backend integration ready** when you start it

## 🎯 What to Do Next

### Step 1: Get Your Supabase Service Key
```bash
1. Go to: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/settings/api
2. Find "Project API keys" section
3. Copy the "service_role" key (NOT the anon key)
```

### Step 2: Create User ID
Run this in Supabase SQL Editor (https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/sql):

```sql
-- Create a user for the backend to use
INSERT INTO auth.users (
  instance_id,
  id,
  aud,
  role,
  email,
  encrypted_password,
  email_confirmed_at,
  raw_user_meta_data,
  created_at,
  updated_at,
  confirmation_token,
  recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  'trader@atlas.local',
  crypt('change_me_123', gen_salt('bf')),
  now(),
  '{"display_name": "Atlas Trader"}',
  now(),
  now(),
  '',
  ''
) RETURNING id, email;
```

**Copy the UUID that's returned!**

### Step 3: Configure Backend .env
Create `.env` file in `atlas/apps/core-node/`:

```bash
# Supabase
SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co
SUPABASE_SERVICE_KEY=<paste-service-key-from-step-1>
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I

# Security
ENCRYPTION_KEY=61610d12777cedb4207951f172e708aace1da3bac19acb5022bd84b563f880f9

# Trading Mode
CONFIRM_LIVE=NO

# User ID from Step 2
USER_ID=<paste-uuid-from-step-2>
```

### Step 4: Start the Backend
```bash
cd atlas/apps/core-node
pnpm install
pnpm api
```

### Step 5: Verify Connection
- Badge changes from "DB Only Mode" → "Backend Connected" (green)
- Start/Pause buttons become active
- Click "Start" to begin paper trading
- Watch data flow into the dashboard

## 📊 What Happens When Backend Runs

```
Backend starts → Connects to Coinbase → Analyzes markets → 
Generates signals → Places orders → Data flows to Supabase → 
Frontend updates in real-time
```

## 🔍 Troubleshooting

### "DB Only Mode" Persists
- **Check**: Is backend running? Terminal should show "Server listening on port 3001"
- **Check**: Browser console for connection errors
- **Fix**: Restart backend with correct .env

### No Data in Tables
- **Normal**: Tables are empty until backend generates trading activity
- **Check**: Backend logs for "Trading engine started"
- **Test**: Insert sample data via SQL to verify frontend works

### Backend Won't Start
- **Check**: All .env variables are set (no `<paste-...>` placeholders)
- **Check**: Port 3001 is available (`lsof -i :3001`)
- **Check**: Dependencies installed (`pnpm install`)

### Backend Crashes
- **Check**: User UUID exists in auth.users table
- **Check**: Service key is correct (not anon key)
- **Check**: Backend logs for specific error messages

## 📁 Key Files Reference

### Frontend (Lovable - This Project)
- `src/pages/Index.tsx` - Main dashboard
- `src/services/tradingApi.ts` - Backend API client  
- `src/hooks/useTradingEngine.ts` - Engine state management
- `src/integrations/supabase/client.ts` - Database client

### Backend (Local - `atlas/apps/core-node/`)
- `src/api/server.ts` - API server & WebSocket
- `.env` - Configuration (you create this)
- `src/trading/trading-engine.ts` - Core trading logic
- `../config/paper.local.yaml` - Strategy parameters

### Database (Supabase)
- Tables: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/editor
- SQL: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/sql
- API: https://supabase.com/dashboard/project/gdrdaajvutmewgxbjurk/api

## 🎓 Architecture Overview

```
┌─────────────────┐         ┌──────────────────┐
│   Frontend      │◄───────►│   Supabase       │
│   (Lovable)     │  Direct │   (Database)     │
│   React UI      │  Queries│   Postgres+RLS   │
└────────┬────────┘         └──────────────────┘
         │                           ▲
         │ WebSocket                 │
         │ REST API                  │ Writes
         ▼                           │
┌─────────────────┐                  │
│   Backend       ├──────────────────┘
│   (Local Node)  │   Service Key
│   Trading Engine│   (Bypasses RLS)
└─────────────────┘
         │
         ▼
┌─────────────────┐
│   Coinbase      │
│   Exchange API  │
│   Market Data   │
└─────────────────┘
```

## 💡 Quick Tips

- **Start with Paper Trading**: Don't enable live until thoroughly tested
- **Watch Backend Logs**: Shows all trading decisions in real-time
- **Use Supabase Dashboard**: Great for inspecting data directly
- **Monitor Risk Heat**: Red gauge = approaching risk limits
- **Adjust Parameters**: Edit `atlas/config/paper.local.yaml` for strategies

## 📚 More Documentation

- `BACKEND_SETUP.md` - Detailed backend configuration
- `DATABASE_SCHEMA.md` - Complete database schema
- `DEPLOYMENT.md` - Production deployment guide
- `IMPLEMENTATION_STATUS.md` - Feature completion status

---

**Current Status:**
- ✅ Frontend: Fully functional
- ✅ Database: RLS policies fixed, ready for data
- ⏳ Backend: Needs `.env` and startup
- ⏳ Integration: Will work once backend starts
