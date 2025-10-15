# Consolidated Environment Setup

Now that we've updated the backend to use the main `.env` file, you need to create a single `.env` file in the project root that contains all variables for both frontend and backend.

## Create Your .env File

Create a file named `.env` in `/Users/lukebarhoumeh/apex-automata/` with the following content:

```bash
# Frontend Variables (Vite)
VITE_SUPABASE_PROJECT_ID=gdrdaajvutmewgxbjurk
VITE_SUPABASE_PUBLISHABLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I
VITE_SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co

# Backend Variables (Node.js)
# Coinbase API Configuration (copy from your screenshot)
COINBASE_API_KEY=organizations/880b1c4f-ec34-40e8-8e90-76e134e87918/apiKeys/88672634-5...
COINBASE_API_SECRET=-----BEGIN EC PRIVATE KEY-----
MHcCAQEEINjBuDKSq0EAZaj5IwIlT33ky...
-----END EC PRIVATE KEY-----
COINBASE_API_PASSPHRASE=your_passphrase_here

# Supabase Backend Configuration
SUPABASE_URL=https://gdrdaajvutmewgxbjurk.supabase.co
SUPABASE_SERVICE_KEY=YOUR_SERVICE_KEY_HERE
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdkcmRhYWp2dXRtZXdneGJqdXJrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjAzNjAzOTcsImV4cCI6MjA3NTkzNjM5N30.SdShP29qp-N5gPtpKC3rA7eqMtsKhn-3QIyPMup6Q5I

# Security Configuration
ENCRYPTION_KEY=61610d12777cedb4207951f172e708aace1da3bac19acb5022bd84b563f880f9

# Trading Mode
CONFIRM_LIVE=NO
```

## Important Notes:

1. **Copy your exact Coinbase API values** from your screenshot
2. **Get the SUPABASE_SERVICE_KEY** from your Supabase Dashboard:
   - Go to Settings → API
   - Look for "service_role (secret)" - this is different from the anon key
   - It will start with `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...`

## Benefits of This Setup:

- ✅ Single source of truth for all environment variables
- ✅ No need to maintain separate .env files
- ✅ Both frontend and backend read from the same file
- ✅ Easier to manage and deploy

## After Creating the .env File:

1. Restart your API server if it's running
2. Restart your frontend development server
3. The backend will now automatically load from the main .env file
