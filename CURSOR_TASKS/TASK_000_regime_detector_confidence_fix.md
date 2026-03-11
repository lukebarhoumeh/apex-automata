# TASK 000 — Regime Detector Confidence Calculation Fix

## Priority: HIGH (latent bug)
## Estimated time: 2 minutes
## Files to modify: 1

---

## Problem

In `atlas/apps/core-node/src/strategies/regime-detector.ts`, the `classifyRegime()` method's `adx_primary` branch hardcodes threshold values instead of using config properties. Currently works because `adxWeakTrend = 20`, but will silently break if thresholds are ever tuned.

## Current Code (lines ~375-378)

```typescript
if (adx >= this.config.adxWeakTrend) {
  return { regime: 'weak_trend', confidence: (adx - 20) / 20 };
}
return { regime: 'ranging', confidence: 1 - (adx / 20) };
```

## Required Changes

### Change 1: Fix weak_trend confidence (line 376)

**Replace:**
```typescript
return { regime: 'weak_trend', confidence: (adx - 20) / 20 };
```

**With:**
```typescript
return { regime: 'weak_trend', confidence: (adx - this.config.adxWeakTrend) / (this.config.adxStrongTrend - this.config.adxWeakTrend) };
```

**Why:** Confidence should scale from 0 (at weak threshold) to 1 (at strong threshold). The denominator must be the range between thresholds, not a hardcoded 20.

### Change 2: Fix ranging confidence (line 378)

**Replace:**
```typescript
return { regime: 'ranging', confidence: 1 - (adx / 20) };
```

**With:**
```typescript
return { regime: 'ranging', confidence: 1 - (adx / this.config.adxWeakTrend) };
```

**Why:** Ranging confidence should scale relative to the configured weak trend threshold.

## Constraints
- Do NOT modify anything else in this file
- Do NOT touch the multi_factor branch
- Do NOT change the strong_trend confidence calculation (line 373) — it already uses a dynamic divisor

## Verification
After making changes, confirm:
1. `adx_primary` branch has exactly 3 return statements
2. None of them contain hardcoded numeric thresholds (no raw `20` or `40`)
3. All use `this.config.adxWeakTrend` or `this.config.adxStrongTrend`
