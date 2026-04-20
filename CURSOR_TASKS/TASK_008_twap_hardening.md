# TASK_008: TWAP Execution Hardening — Anti-Signaling Randomization

**Priority:** MEDIUM — Execution quality improvement for larger position sizes
**Status:** PARKED (begin after TASK_007 Hyperliquid adapter is live)
**Depends on:** TASK_007 (Hyperliquid adapter) — TWAP is more critical on-chain where order visibility is higher
**Created:** 2026-03-24 by Cowork (Architecture AI)
**Phase:** 5C — Open-Source Integration Sprint 3

---

## Context

The existing TWAP implementation in `order-manager.ts` already has the structural components: parent orders, slicing, scheduled execution, and configurable randomization flags. However, the randomization is **naive** and **detectable** by predatory algorithms.

### What we have (order-manager.ts lines 314–477)

```typescript
twapConfig: {
  minSliceSize: number;
  maxSliceSize: number;
  sliceDuration: number;     // ms
  randomizeSize: boolean;    // ±20% variation
  randomizeTime: boolean;    // ±10% of timeDelta
}
```

Current issues:
1. **Size randomization is uniform ±20%** — Predatory algos detect uniform-distribution slice sizes easily. The mean is still perfectly centered at baseSliceSize, making the TWAP pattern obvious.
2. **Time randomization is ±10% of slice interval** — This is predictable. A burst of 10 child orders at roughly equal intervals, regardless of ±10% jitter, is still identifiable as TWAP.
3. **No volume participation** — Slices execute regardless of current market volume. A TWAP that places 30% of a thin bar's volume is loudly signaling.
4. **No urgency adaptation** — All slices have equal priority regardless of time remaining or fill progress.
5. **No spread-aware pricing** — Slices use post-only limit orders at a fixed price, missing opportunities when spread widens.

### What crypto-chassis/ccapi teaches us (reference, NOT library integration)

The `crypto-chassis/ccapi` repository has published analysis on **TWAP signaling risk** (Medium articles + codebase). Key insights to mine:

1. **Non-uniform size distribution:** Use a Gaussian or exponential distribution for slice sizes, not uniform. This breaks the "equal mean" signature.
2. **Volume participation rate:** Each slice should target a % of recent bar volume (e.g., max 5% participation). If volume is thin, delay the slice.
3. **Randomized inter-arrival times:** Don't use time offsets from a fixed grid. Instead, use a Poisson process for slice scheduling — arrivals that are truly random, not jittered-periodic.
4. **Spread-responsive pricing:** When the spread widens, use more aggressive pricing. When spread is tight, use passive pricing.
5. **Time-urgency weighting:** As the TWAP window progresses, increase aggression on remaining slices to ensure completion.

**We are NOT installing ccapi.** This is a pure pattern-mining exercise. The improvements are applied directly to the existing `order-manager.ts` TWAP implementation.

---

## IMPORTANT CONSTRAINTS

1. **DO NOT** install any new packages — all improvements are to existing code
2. **DO NOT** change the `TWAPOrder`, `TWAPSlice`, or `OrderManagerConfig` types in a breaking way — extend them
3. **DO NOT** modify the `ManagedOrder` interface or `createOrder()` flow
4. **DO NOT** break existing TWAP tests
5. Keep the `randomizeSize` and `randomizeTime` config flags — add new flags for the advanced features
6. All randomization improvements must be deterministic when a seed is provided (for backtesting)

---

## Step 1: Extend TWAP Configuration

**File:** `atlas/apps/core-node/src/trading/order-manager.ts`

Extend the `twapConfig` type with new fields (backward compatible — all new fields optional with defaults):

FIND:
```typescript
  twapConfig: {
    minSliceSize: number;
    maxSliceSize: number;
    sliceDuration: number; // milliseconds
    randomizeSize: boolean;
    randomizeTime: boolean;
  };
```

REPLACE:
```typescript
  twapConfig: {
    minSliceSize: number;
    maxSliceSize: number;
    sliceDuration: number; // milliseconds
    randomizeSize: boolean;
    randomizeTime: boolean;
    // === Advanced anti-signaling options (v2) ===
    /** Use Gaussian distribution for slice sizes (vs uniform). Default: false */
    gaussianSizeDistribution?: boolean;
    /** Gaussian standard deviation as fraction of baseSliceSize. Default: 0.3 */
    gaussianSizeSigma?: number;
    /** Use Poisson inter-arrival times (vs jittered grid). Default: false */
    poissonScheduling?: boolean;
    /** Max participation rate as fraction of recent bar volume. 0 = disabled. Default: 0 */
    maxVolumeParticipation?: number;
    /** Enable time-urgency weighting (increase aggression toward end). Default: false */
    timeUrgencyEnabled?: boolean;
    /** Random seed for deterministic testing. null = truly random. Default: null */
    randomSeed?: number | null;
  };
```

---

## Step 2: Implement Gaussian Size Distribution

Replace the uniform size randomization with a Gaussian (normal) distribution.

**File:** `atlas/apps/core-node/src/trading/order-manager.ts`

### 2A: Add seeded random utility methods

Add these private methods to the `OrderManager` class:

```typescript
  // Seeded RNG state for deterministic TWAP slicing
  private twapRngState: number = Math.floor(Math.random() * 2147483647);

  /** Initialize RNG seed from config */
  private initTwapRng(): void {
    const seed = this.config.twapConfig.randomSeed;
    this.twapRngState = seed ?? Math.floor(Math.random() * 2147483647);
  }

  /** Uniform random [0, 1) — seeded */
  private twapRandom(): number {
    this.twapRngState = (this.twapRngState * 1103515245 + 12345) % 2147483648;
    return this.twapRngState / 2147483648;
  }

  /** Gaussian random via Box-Muller transform — seeded */
  private twapGaussian(mean: number, sigma: number): number {
    const u1 = this.twapRandom();
    const u2 = this.twapRandom();
    const z0 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return mean + z0 * sigma;
  }

  /** Poisson-distributed inter-arrival time */
  private twapPoissonDelay(meanDelay: number): number {
    // Inverse CDF: -meanDelay * ln(1 - U)
    const u = this.twapRandom();
    return -meanDelay * Math.log(1 - u + 1e-10);
  }
```

### 2B: Replace `generateTWAPSlices` size randomization

FIND in `generateTWAPSlices`:
```typescript
      // Randomize size if configured
      if (this.config.twapConfig.randomizeSize) {
        const variation = 0.2; // 20% variation
        sliceSize = baseSliceSize * (1 + (Math.random() - 0.5) * variation);
      }
```

REPLACE:
```typescript
      // Randomize size if configured
      if (this.config.twapConfig.randomizeSize) {
        if (this.config.twapConfig.gaussianSizeDistribution) {
          // Gaussian distribution — harder to detect than uniform
          const sigma = this.config.twapConfig.gaussianSizeSigma ?? 0.3;
          sliceSize = this.twapGaussian(baseSliceSize, baseSliceSize * sigma);
          // Clamp to [minSliceSize, maxSliceSize]
          sliceSize = Math.max(
            this.config.twapConfig.minSliceSize,
            Math.min(sliceSize, this.config.twapConfig.maxSliceSize)
          );
        } else {
          // Legacy: uniform ±20% variation
          const variation = 0.2;
          sliceSize = baseSliceSize * (1 + (this.twapRandom() - 0.5) * variation);
        }
      }
```

---

## Step 3: Implement Poisson Inter-Arrival Scheduling

Replace the jittered-grid time scheduling with a Poisson process.

FIND in `generateTWAPSlices`:
```typescript
      // Randomize time if configured
      if (this.config.twapConfig.randomizeTime && i > 0) {
        const timeVariation = timeDelta * 0.1; // 10% time variation
        const randomOffset = (Math.random() - 0.5) * timeVariation;
        scheduledTime = new Date(scheduledTime.getTime() + randomOffset);
      }
```

REPLACE:
```typescript
      // Randomize time if configured
      if (this.config.twapConfig.randomizeTime && i > 0) {
        if (this.config.twapConfig.poissonScheduling) {
          // Poisson inter-arrival: truly random timing, not jittered grid
          const poissonDelay = this.twapPoissonDelay(timeDelta);
          // Clamp to prevent extreme delays (max 3x mean delay)
          const clampedDelay = Math.min(poissonDelay, timeDelta * 3);
          scheduledTime = new Date(prevScheduledTime + clampedDelay);
          // Don't exceed end time
          if (scheduledTime.getTime() > endTime.getTime()) {
            scheduledTime = new Date(endTime.getTime() - (numSlices - i) * 1000);
          }
          prevScheduledTime = scheduledTime.getTime();
        } else {
          // Legacy: jittered grid ±10%
          const timeVariation = timeDelta * 0.1;
          const randomOffset = (this.twapRandom() - 0.5) * timeVariation;
          scheduledTime = new Date(scheduledTime.getTime() + randomOffset);
          prevScheduledTime = scheduledTime.getTime();
        }
      } else {
        prevScheduledTime = scheduledTime.getTime();
      }
```

**IMPORTANT:** Add `let prevScheduledTime = startTime.getTime();` before the `for` loop to track cumulative Poisson timing.

---

## Step 4: Implement Volume Participation Check

Add a volume check before executing each TWAP slice. If the slice would exceed the max participation rate, delay it.

FIND in `executeTWAPSlice`:
```typescript
  private async executeTWAPSlice(
    twapOrder: TWAPOrder,
    slice: TWAPSlice,
    request: any
  ): Promise<void> {
    try {
      this.logger.info(`Executing TWAP slice ${slice.id} for order ${twapOrder.id}`);
```

REPLACE:
```typescript
  private async executeTWAPSlice(
    twapOrder: TWAPOrder,
    slice: TWAPSlice,
    request: any
  ): Promise<void> {
    try {
      const maxParticipation = this.config.twapConfig.maxVolumeParticipation || 0;

      // Volume participation check (if configured)
      if (maxParticipation > 0) {
        const recentVolume = await this.getRecentBarVolume(twapOrder.product);
        if (recentVolume > 0) {
          const sliceSize = parseFloat(slice.size);
          const participationRate = sliceSize / recentVolume;

          if (participationRate > maxParticipation) {
            this.logger.debug('TWAP slice delayed — volume participation too high', {
              sliceId: slice.id,
              sliceSize,
              recentVolume,
              participationRate: (participationRate * 100).toFixed(1) + '%',
              maxAllowed: (maxParticipation * 100).toFixed(1) + '%',
            });

            // Reschedule slice 30s later (simple retry)
            const retryDelay = 30000;
            setTimeout(async () => {
              await this.executeTWAPSlice(twapOrder, slice, request);
            }, retryDelay);
            return;
          }
        }
      }

      this.logger.info(`Executing TWAP slice ${slice.id} for order ${twapOrder.id}`);
```

Also add the helper method:

```typescript
  /**
   * Get recent bar volume for volume participation checks.
   * Returns the volume of the most recent completed candle for the symbol.
   */
  private async getRecentBarVolume(symbol: string): Promise<number> {
    // TODO: Wire this to the candle aggregation pipeline or market data cache
    // For now, return 0 which disables the check
    return 0;
  }
```

---

## Step 5: Add Time-Urgency Weighting

As the TWAP window progresses, increase the aggressiveness of remaining slices to ensure completion within the window.

In `executeTWAPSlice`, after the volume participation check and before placing the child order:

```typescript
      // Time-urgency weighting — increase aggression toward end of window
      let priceAdjustmentBps = 0;
      if (this.config.twapConfig.timeUrgencyEnabled) {
        const elapsed = Date.now() - twapOrder.startTime.getTime();
        const totalDuration = twapOrder.endTime.getTime() - twapOrder.startTime.getTime();
        const progressPct = Math.min(elapsed / totalDuration, 1);
        const fillPct = twapOrder.filledSize / twapOrder.totalSize;

        // If we're behind schedule (more time elapsed than filled), add urgency
        if (progressPct > fillPct + 0.1) {
          // Scale urgency: 0 bps at start → up to 5 bps at end
          priceAdjustmentBps = Math.floor((progressPct - fillPct) * 50);
          priceAdjustmentBps = Math.min(priceAdjustmentBps, 10); // Cap at 10 bps

          this.logger.debug('TWAP urgency adjustment', {
            progressPct: (progressPct * 100).toFixed(1) + '%',
            fillPct: (fillPct * 100).toFixed(1) + '%',
            urgencyBps: priceAdjustmentBps,
          });
        }
      }

      // Apply urgency to price
      let adjustedPrice = request.price ? parseFloat(request.price) : undefined;
      if (adjustedPrice && priceAdjustmentBps > 0) {
        const direction = twapOrder.side === 'buy' ? 1 : -1;
        adjustedPrice = adjustedPrice * (1 + direction * priceAdjustmentBps / 10000);
      }
```

Then update the `createOrder` call to use `adjustedPrice`:

```typescript
      const sliceOrder = await this.createOrder({
        product_id: request.product_id,
        side: request.side,
        type: request.type || 'limit',
        size: slice.size,
        price: adjustedPrice?.toString() || request.price,
        time_in_force: this.config.defaultTimeInForce,
        post_only: priceAdjustmentBps === 0 // Use taker when urgent
      });
```

---

## Step 6: Add TWAP Analytics Logging

After each TWAP completes, log a summary for analysis:

In `checkTWAPProgress`, when `twapOrder.status = 'filled'`:

```typescript
      // Log TWAP analytics
      const totalDuration = twapOrder.endTime.getTime() - twapOrder.startTime.getTime();
      const actualDuration = Date.now() - twapOrder.startTime.getTime();
      const sliceCount = twapOrder.slices.length;
      const executedSlices = twapOrder.slices.filter(s => s.status === 'executed').length;
      const failedSlices = twapOrder.slices.filter(s => s.status === 'failed').length;

      this.logger.info('TWAP execution complete', {
        orderId: twapOrder.id,
        symbol: twapOrder.product,
        side: twapOrder.side,
        totalSize: twapOrder.totalSize,
        filledSize: twapOrder.filledSize,
        fillPct: ((twapOrder.filledSize / twapOrder.totalSize) * 100).toFixed(1) + '%',
        plannedDurationMs: totalDuration,
        actualDurationMs: actualDuration,
        sliceCount,
        executedSlices,
        failedSlices,
        avgSliceSize: (twapOrder.filledSize / executedSlices).toFixed(6),
      });
```

---

## Step 7: Update TWAP Tests

**File:** `atlas/apps/core-node/src/__tests__/order-manager.test.ts`

Add tests for the new features:

```typescript
describe('TWAP Hardening (v2)', () => {
  it('generates Gaussian-distributed slice sizes when configured', () => {
    // Create TWAP with gaussianSizeDistribution: true
    // Verify slice sizes follow a non-uniform distribution
    // Statistical test: Kolmogorov-Smirnov or simple variance check
  });

  it('generates Poisson-distributed inter-arrival times when configured', () => {
    // Create TWAP with poissonScheduling: true
    // Verify scheduled times are not evenly spaced
    // Check: no two slices within 10% of the mean interval
  });

  it('produces deterministic slices with randomSeed', () => {
    // Create two TMAPs with same seed
    // Verify identical slice sizes and times
  });

  it('delays slices when volume participation exceeds threshold', () => {
    // Mock getRecentBarVolume to return low volume
    // Set maxVolumeParticipation to 0.05
    // Verify slice is rescheduled, not executed
  });

  it('increases urgency when behind schedule', () => {
    // Mock time to be 80% through window
    // Set fills to 50% complete
    // Verify priceAdjustmentBps > 0
  });

  it('maintains backward compatibility with legacy config', () => {
    // Create TWAP with only legacy fields (randomizeSize, randomizeTime)
    // Verify it works exactly as before
  });
});
```

---

## Verification Script

Create `CURSOR_TASKS/verify/verify_008.sh`:

```bash
#!/usr/bin/env bash
set -e

echo "=== TASK_008 Verification ==="

# Check Gaussian distribution support
echo -n "1. Gaussian size distribution added... "
if grep -q "gaussianSizeDistribution\|gaussianSizeSigma\|twapGaussian" atlas/apps/core-node/src/trading/order-manager.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check Poisson scheduling support
echo -n "2. Poisson scheduling added... "
if grep -q "poissonScheduling\|twapPoissonDelay\|Poisson" atlas/apps/core-node/src/trading/order-manager.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check volume participation check
echo -n "3. Volume participation check added... "
if grep -q "maxVolumeParticipation\|participationRate\|getRecentBarVolume" atlas/apps/core-node/src/trading/order-manager.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check seeded RNG
echo -n "4. Seeded RNG for deterministic testing... "
if grep -q "twapRngState\|twapRandom\|randomSeed" atlas/apps/core-node/src/trading/order-manager.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

# Check backward compatibility (legacy flags still present)
echo -n "5. Legacy randomizeSize/randomizeTime preserved... "
if grep -q "randomizeSize" atlas/apps/core-node/src/trading/order-manager.ts && \
   grep -q "randomizeTime" atlas/apps/core-node/src/trading/order-manager.ts; then
  echo "PASS"
else
  echo "FAIL — legacy flags removed (breaks backward compat)"
  exit 1
fi

# Check TWAP analytics logging
echo -n "6. TWAP analytics logging added... "
if grep -q "TWAP execution complete\|avgSliceSize\|fillPct" atlas/apps/core-node/src/trading/order-manager.ts; then
  echo "PASS"
else
  echo "FAIL"
  exit 1
fi

echo ""
echo "=== All TASK_008 checks passed ==="
```

---

## Execution Order

1. **Step 1** — Extend TWAP config (additive, no breaking changes)
2. **Step 2** — Add RNG methods + Gaussian size distribution
3. **Step 3** — Add Poisson scheduling
4. **Step 4** — Add volume participation check (with stub for volume data)
5. **Step 5** — Add time-urgency weighting
6. **Step 6** — Add analytics logging
7. **Step 7** — Create and run new tests

**No new dependencies required.** This is pure algorithmic improvement to existing code.
