/** Seeded PRNG — mulberry32. Deterministic so mock data is stable across reloads. */
export function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate a drifted random walk series. */
export function makeSeries(
  seed: number,
  n: number,
  base: number,
  vol: number,
  drift = 0,
): number[] {
  const rnd = mulberry32(seed);
  const pts: number[] = [];
  let v = base;
  for (let i = 0; i < n; i++) {
    const shock = (rnd() - 0.5) * 2 * vol;
    v = v + drift + shock + (base - v) * 0.012;
    pts.push(v);
  }
  return pts;
}
