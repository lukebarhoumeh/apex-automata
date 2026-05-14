# Secret Rotation Runbook

> **Audience:** on-call operator. **Premise:** every secret in `env.example` has a known issuer, blast radius, and rotation procedure. Use this doc when rotating routinely (quarterly), on staff turnover, or after a leak.

> **Last updated:** 2026-05-14. **Source of truth for vars:** `env.example` at repo root + `atlas/apps/core-node/src/core/env.ts`.

## Priority order (compromised-everything scenario)

If `.env` is leaked or the host is compromised, rotate in this order. Each later step depends on the earlier ones being live.

1. **`ENCRYPTION_KEY`** — re-keys all at-rest secrets stored in Supabase tables. Without this nothing else is durable.
2. **`SUPABASE_SERVICE_KEY`** — service-role key bypasses RLS. Highest blast radius.
3. **`COINBASE_API_*`** — production trading credentials.
4. **`HYPERLIQUID_PRIVATE_KEY`** — wallet signing key for perps.
5. **`SUPABASE_ACCESS_TOKEN`** — CLI/migrations PAT.
6. **`COINDESK_API_KEY*`** — third-party data; lowest blast radius.
7. **`RESEND_API_KEY`, `TWILIO_*`** — alert transports; failure mode is silent alerts, not capital loss.

After rotation, see [Restart matrix](#restart-matrix) below.

---

## Per-secret procedures

Each block: **what it grants → where to rotate → restart hook → leaked-now steps.**

### `ENCRYPTION_KEY`

- **Grants:** AES-256 decryption of secrets in Supabase tables (`broker_credentials`, etc.). 64 hex chars / 32 bytes.
- **Rotate:** `openssl rand -hex 32` → write into `.env` → re-encrypt every row in any encrypted table with the old key, then drop the old key. There is no first-class re-key script; coordinate with engineering before rotating.
- **Restart:** Backend (full restart). Frontend unaffected.
- **If leaked now:** rotate `SUPABASE_SERVICE_KEY` first (so the leaker can't read ciphertext), then re-encrypt rows with the new key, then revoke the old key. Treat all encrypted-at-rest values as compromised.

### `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_ANON_KEY`

- **Grants:** `SUPABASE_SERVICE_KEY` bypasses RLS — full read/write on every table. `SUPABASE_ANON_KEY` is RLS-bound (lower blast radius). `SUPABASE_URL` is non-secret but pairs with the keys.
- **Rotate:** Supabase Dashboard → Project Settings → API → "Roll" next to the relevant key. New key valid immediately; old key revoked.
- **Restart:** Backend (full restart). Frontend (rebuild + redeploy if `VITE_SUPABASE_*` changed).
- **If leaked now:** roll service_role first (capital risk path); roll anon_key next; audit Supabase → Reports → API → look for unfamiliar IPs in last 24h; rotate any DB-stored secrets that the leaker could have decrypted (broker creds, etc.).

### `SUPABASE_ACCESS_TOKEN`

- **Grants:** Personal Access Token for Supabase CLI / migrations / branching. Full account access scoped to the user that issued it.
- **Rotate:** Supabase Dashboard → Account → Access Tokens → revoke + issue new. Update `.env` and any GitHub Actions secret of the same name.
- **Restart:** None at runtime. CI will pick up the new value on next workflow run.
- **If leaked now:** revoke immediately. Audit Supabase audit log for unauthorized migrations/branch creates.

### `COINBASE_API_KEY`, `COINBASE_API_SECRET`, `COINBASE_API_PASSPHRASE`

- **Grants:** authenticated trading on Coinbase Advanced Trade. With `Trade` scope: place/cancel orders, read positions. With `View` only: read-only.
- **Rotate:** Coinbase → Settings → API → revoke the existing key → create a new key with **Trade + View** permissions, IP-restricted to the host's egress IP. Save the secret (shown once).
- **Restart:** Backend (full restart) — keys are read at boot in `core/env.ts`.
- **If leaked now:** revoke the key in Coinbase first (this stops new orders). Then check Coinbase order history for unauthorized fills in the last 24h. File a fraud claim if any.

### `COINBASE_API_VERSION`

- **Grants:** none — selects between `'exchange'` (legacy GDAX) and `'advanced'` (Advanced Trade) endpoints.
- **Rotate:** N/A — non-secret toggle.

### `HYPERLIQUID_PRIVATE_KEY`, `HYPERLIQUID_WALLET_ADDRESS`

- **Grants:** EVM signing key for the trading wallet on Hyperliquid. Whoever holds the private key controls every dollar in the wallet.
- **Rotate:** create a new EVM wallet (`cast wallet new` or hardware-wallet derivation) → fund it from the old wallet (or cold storage) → swap `.env` → leave the old wallet empty.
- **Restart:** Backend (full restart). Verify `HYPERLIQUID_ENABLED=true` AND `guardrails.hyperliquid.enabled: true` are still consistent.
- **If leaked now:** **immediately** transfer all funds from the wallet to a fresh address before the leaker drains it. There is no way to "revoke" a private key — only outrun the leaker. Always start with `HYPERLIQUID_TESTNET=true` until the rotation is verified.

### `HYPERLIQUID_ENABLED`, `HYPERLIQUID_TESTNET`

- **Grants:** none — feature flags. `HYPERLIQUID_ENABLED=true` is half of the double-lock for routing signals to HL; the other half is `guardrails.hyperliquid.enabled: true`.
- **Rotate:** N/A — non-secret toggles.

### `CONFIRM_LIVE`

- **Grants:** none — gating flag. Must be `'YES'` for `EXECUTION_MODE=live` to take effect.
- **Rotate:** N/A — non-secret toggle. Treat any unexpected `YES` as an incident.

### `RESEND_API_KEY`

- **Grants:** transactional email send-as authority for the Resend domain configured. Free tier 100/day.
- **Rotate:** https://resend.com/api-keys → revoke + create. Update `.env`.
- **Restart:** Backend (full restart) — the alerts transport (Wave 3 task C5) reads at boot.
- **If leaked now:** revoke. Audit Resend → Logs for outbound mail you didn't authorize.

### `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`

- **Grants:** SMS send-as authority on the Twilio account. With auth token: full account control (place calls, send SMS, list messages).
- **Rotate:** Twilio Console → Account Info → "Request a secondary token" → promote to primary → revoke old. From-number is not a secret but is account-scoped.
- **Restart:** Backend (full restart).
- **If leaked now:** revoke `TWILIO_AUTH_TOKEN` immediately (this stops outbound SMS). Audit Twilio → Monitor → Logs → Messaging for unauthorized sends. File a billing dispute for any.

### `ALERTS_EMAIL_TO`, `ALERTS_SMS_TO`

- **Grants:** none — alert destination addresses. Not secrets but rotate whenever the on-call operator changes.
- **Rotate:** edit `.env`. Backend full restart.

### `COINDESK_API_KEY`, `COINDESK_API_KEY_NAME`

- **Grants:** authenticated read access to CoinDesk News + Sentiment API. Per-tier rate limit; no write or financial access.
- **Rotate:** CoinDesk customer portal (key URL varies by tier) → revoke + reissue.
- **Restart:** Backend (full restart). Optional: only needed when `meta_filter.coindesk_sentiment.enabled: true`.
- **If leaked now:** revoke. Worst case is rate-limit exhaustion (paid tier) or a small overage bill.

---

## Restart matrix

After rotation, restart the listed processes (in this order to keep the UI consistent with the engine):

| Secret rotated | Backend (`pm2 restart core-node-api`) | Frontend (rebuild + redeploy) | Engine (auto-restarted by supervisor) |
|---|---|---|---|
| `ENCRYPTION_KEY` | yes | no | yes |
| `SUPABASE_SERVICE_KEY` | yes | no | yes |
| `SUPABASE_ANON_KEY` | yes | no | yes |
| `VITE_SUPABASE_*` | no | yes | no |
| `SUPABASE_ACCESS_TOKEN` | no | no | no (CI only) |
| `COINBASE_API_*` | yes | no | yes |
| `HYPERLIQUID_PRIVATE_KEY` / `_WALLET_ADDRESS` | yes | no | yes |
| `RESEND_API_KEY` | yes | no | no |
| `TWILIO_*` | yes | no | no |
| `COINDESK_API_*` | yes | no | no |

After restart, verify with:

```bash
curl localhost:3001/health         # liveness
curl localhost:3001/api/status     # engine + risk state
curl localhost:3001/api/runtime/health  # supervisor + adapters
```

---

## Role-of-last-resort: `.env` leaked

Assume the entire `.env` is on Pastebin. Execute these steps in order. Time-to-safe ≈ 30 minutes if you don't pause.

1. **Stop the engine.** `curl -X POST localhost:3001/api/engine/stop` then `pm2 stop core-node-api` so no new orders fire under the old creds.
2. **Drain the Hyperliquid wallet.** Transfer to a cold address before the leaker does. Treat the old wallet as burned.
3. **Revoke `COINBASE_API_*`.** This is the largest active-money path on the legacy venue.
4. **Roll `SUPABASE_SERVICE_KEY`** then `SUPABASE_ANON_KEY`. The leaker had read on every table; now they don't.
5. **Generate a new `ENCRYPTION_KEY`** and re-encrypt every encrypted-at-rest column. Drop the old key.
6. **Revoke `SUPABASE_ACCESS_TOKEN`.** Audit recent migrations/branch creates for tampering.
7. **Revoke `COINDESK_API_KEY`, `RESEND_API_KEY`, `TWILIO_AUTH_TOKEN`** in any order — small blast radius.
8. **Audit access logs:** Supabase → Reports → API; Coinbase → API → recent activity; Hyperliquid → wallet tx history; Resend → Logs; Twilio → Messaging logs. Look back 7 days minimum.
9. **Write the incident up** in `docs/incidents/YYYY-MM-DD_env-leak.md` with timeline + IOCs + action items.
10. **Restart the stack** (`.env` populated with new values), watch `/api/status` and the pulse log for 30 min before re-enabling live or HL trading.

If step 2 isn't done within ~5 minutes of detection, assume the wallet is empty.
