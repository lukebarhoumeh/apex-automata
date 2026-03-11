# TASK_002B — Guardrails Update for Perpetual Futures

**Status:** TODO
**Priority:** HIGH — Required before perps can trade
**Depends on:** TASK_002A (perps adapter) ✅
**Estimated checks:** ~35

---

## Context

The guardrails system (`config/guardrails.yaml` + `config/loadGuardrails.ts`) needs to support perpetual futures configuration. Currently:
- `allow_short: false` — platform limitation comment, now removable
- `risk_per_trade: 0.005` — too conservative for leveraged perps (approved bump to 0.015 for perps)
- No perps-specific symbols (only ETH-USD, BTC-USD, SOL-USD spot)
- No leverage limits per symbol
- No liquidation buffer config
- No perps fee schedule

This task updates BOTH the YAML config AND the Zod validation schema to support perps.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** remove existing spot symbol configs — perps symbols are ADDED alongside them
2. **DO NOT** change the overall schema structure — add new OPTIONAL sections
3. **DO NOT** modify `risk-engine.ts`, `server.ts`, or any runtime code — those are TASK_002C/D
4. The Zod schema MUST validate the updated YAML without errors
5. All new fields must be documented with inline YAML comments

---

## Step 1: Update `guardrails.yaml`

**File:** `atlas/config/guardrails.yaml`

### 1A. Change `allow_short` to `true` and update comment (line 100-106)

**FIND:**
```yaml
  # IMPORTANT: allow_short is false because Coinbase spot markets do not support shorting.
  # This is a PLATFORM LIMITATION, not a strategy choice.
  # - Strategies may still generate 'sell' signals for analytics/backtesting
  # - 'sell' on a long position = close position (valid)
  # - 'sell' on flat position = no action (cannot open short on Coinbase spot)
  # To enable shorting, use an exchange that supports margin/futures (e.g., Binance Futures, dYdX)
  allow_short: false
```

**REPLACE WITH:**
```yaml
  # Shorting enabled via Coinbase Perpetual Futures (CFTC-regulated)
  # - Spot adapter ('coinbase'): shorts still blocked at execution level
  # - Perps adapter ('coinbase-perps'): full long/short capability
  # - Strategies generate both long and short signals
  allow_short: true
```

### 1B. Add `perps` section AFTER the `strategy` section and BEFORE the `execution` section (after `trade_cooldown_min: 15`, before `execution:`)

**INSERT:**
```yaml

# Perpetual Futures Configuration
# Applies only when trading via 'coinbase-perps' adapter
perps:
  # Risk per trade for leveraged positions (1.5% approved — quarter-Kelly at leverage)
  risk_per_trade: 0.015
  # Default leverage for new positions (conservative start)
  default_leverage: 3
  # Maximum leverage allowed (Coinbase limit: 10x intraday)
  max_leverage: 10
  # Minimum distance from liquidation price before position is auto-reduced (%)
  liquidation_buffer_pct: 0.20
  # Maximum funding rate (bps) before position bias is applied
  max_funding_rate_bps: 50
  # Funding rate check interval (seconds)
  funding_check_interval_sec: 300
  # Fee schedule for perps (decimal format)
  maker_fee: 0.0000
  taker_fee: 0.0003
  # Contract specifications
  nano_contract_size: 0.01

# Per-symbol perpetual futures configuration
perps_symbols:
  ETH-PERP-INTX:
    max_notional_usd: 5000
    max_daily_loss_usd: 300
    default_leverage: 3
    max_leverage: 5
    strategy_overrides:
      trend_follow:
        emaFast: 12
        emaSlow: 15
        stopAtr: 2.5
        takeProfitAtr: 5.0
      momentum:
        rsiPeriod: 10
        rsiOversold: 40
        rsiOverbought: 55
        macdFast: 8
        macdSlow: 21
        macdSignal: 5
        stopAtr: 2.0
        takeProfitAtr: 4.0
        atrMultiplier: 2.0
  BTC-PERP-INTX:
    max_notional_usd: 5000
    max_daily_loss_usd: 300
    default_leverage: 3
    max_leverage: 5
    strategy_overrides:
      momentum:
        atrMultiplier: 2.0
        rsiOversold: 30
        rsiOverbought: 70
      trend_follow:
        emaFast: 12
        emaSlow: 26
        stopAtr: 2.0
        takeProfitAtr: 4.0
```

### 1C. Update `max_open_positions` from 2 to 4 (line 4)

**FIND:**
```yaml
  max_open_positions: 2
```

**REPLACE WITH:**
```yaml
  max_open_positions: 4
```

This allows 2 spot + 2 perps positions simultaneously.

---

## Step 2: Update Zod Schema in `loadGuardrails.ts`

**File:** `atlas/apps/core-node/src/config/loadGuardrails.ts`

### 2A. Add perps symbol limit schema (after `PerSymbolLimitSchema` definition, around line 18)

**FIND:**
```typescript
export type PerSymbolLimit = z.infer<typeof PerSymbolLimitSchema>;
```

**INSERT BEFORE that line:**
```typescript
// Per-symbol perpetual futures configuration
const PerpsSymbolLimitSchema = z.object({
  max_notional_usd: z.number().nonnegative(),
  max_daily_loss_usd: z.number().nonnegative(),
  default_leverage: z.number().int().min(1).max(10).optional(),
  max_leverage: z.number().int().min(1).max(10).optional(),
  strategy_overrides: StrategyOverridesSchema,
});

export type PerpsSymbolLimit = z.infer<typeof PerpsSymbolLimitSchema>;

```

### 2B. Add `perps` and `perps_symbols` sections to `GuardrailsSchema`

**FIND (the strategy section closing, around line 51-52):**
```typescript
    trade_cooldown_min: z.number().int().nonnegative()
  }),
  execution: z.object({
```

**REPLACE WITH:**
```typescript
    trade_cooldown_min: z.number().int().nonnegative()
  }),
  perps: z.object({
    risk_per_trade: z.number().positive(),
    default_leverage: z.number().int().min(1).max(10),
    max_leverage: z.number().int().min(1).max(10),
    liquidation_buffer_pct: z.number().min(0).max(1),
    max_funding_rate_bps: z.number().nonnegative(),
    funding_check_interval_sec: z.number().int().positive(),
    maker_fee: z.number().min(0),
    taker_fee: z.number().min(0),
    nano_contract_size: z.number().positive(),
  }).optional(),
  perps_symbols: z.record(z.string(), PerpsSymbolLimitSchema).optional(),
  execution: z.object({
```

---

## Step 3: Export New Types

**File:** `atlas/apps/core-node/src/config/loadGuardrails.ts`

The existing `export type GuardrailConfig = z.infer<typeof GuardrailsSchema>;` will automatically include the new `perps` and `perps_symbols` fields. No additional exports needed.

---

## Verification Checklist

Run: `node CURSOR_TASKS/verify/verify_002b.js`

### Section 1: guardrails.yaml Content (12 checks)
- [ ] `allow_short: true` is present
- [ ] Old "PLATFORM LIMITATION" comment is removed
- [ ] `perps:` section exists
- [ ] `perps.risk_per_trade: 0.015` is present
- [ ] `perps.default_leverage: 3` is present
- [ ] `perps.max_leverage: 10` is present
- [ ] `perps.liquidation_buffer_pct: 0.20` is present
- [ ] `perps.maker_fee: 0.0000` (or `0`) is present
- [ ] `perps.taker_fee: 0.0003` is present
- [ ] `perps_symbols:` section exists
- [ ] `ETH-PERP-INTX` is configured under perps_symbols
- [ ] `BTC-PERP-INTX` is configured under perps_symbols

### Section 2: Zod Schema (8 checks)
- [ ] `PerpsSymbolLimitSchema` exists in loadGuardrails.ts
- [ ] `perps` section in GuardrailsSchema with `risk_per_trade`
- [ ] `perps` section has `max_leverage` field
- [ ] `perps` section has `liquidation_buffer_pct` field
- [ ] `perps` section is `.optional()`
- [ ] `perps_symbols` section in GuardrailsSchema
- [ ] `perps_symbols` is `.optional()`
- [ ] `PerpsSymbolLimit` type is exported

### Section 3: Schema Validation (3 checks)
- [ ] The YAML file parses without error
- [ ] The parsed YAML validates against the Zod schema without error
- [ ] `allow_short` is `true` in the parsed config

### Section 4: No Regressions (6 checks)
- [ ] Spot symbols (ETH-USD, BTC-USD, SOL-USD) still in per_symbol
- [ ] `risk_per_trade: 0.005` still in account section (spot risk)
- [ ] `max_account_leverage: 3.0` unchanged
- [ ] `disabled_strategies` still contains vwap_mr and breakout
- [ ] `execution` section unchanged
- [ ] `circuit_breakers` section unchanged

**Total: ~29 checks**

---

## Files Modified Summary

| File | Action | Description |
|------|--------|-------------|
| `config/guardrails.yaml` | MODIFY | Enable shorting, add perps section, add perps_symbols |
| `config/loadGuardrails.ts` | MODIFY | Add PerpsSymbolLimitSchema, perps + perps_symbols to Zod schema |

---

## What NOT To Do

- Do NOT change `risk_per_trade: 0.005` in the `account` section — that stays for spot
- Do NOT remove SOL-USD from per_symbol — it's kept for future spot use
- Do NOT add runtime perps logic — this is CONFIG ONLY
- Do NOT change the execution, circuit_breakers, or compliance sections
- Do NOT make `perps` section required — it's optional for backward compat
