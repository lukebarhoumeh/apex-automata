export function nowUtc(): Date {
  // JavaScript Date is always in UTC internally; toISOString ensures UTC string
  return new Date();
}

export function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

export function monotonicNowMs(): number {
  // Process.hrtime is deprecated in favor of performance
  return performance.now();
}
