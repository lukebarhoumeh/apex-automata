/**
 * Exact decimal-string arithmetic (BigInt fixed-point).
 *
 * Financial values travel through this codebase as strings. These helpers let the
 * execution layer round sizes/prices to exchange increments, compare balances and
 * accumulate fill quantities without ever touching IEEE-754 floating point.
 *
 * All inputs are decimal strings such as "0.00000001", "1234.5" or "42".
 * Scientific notation is accepted (e.g. "1e-8") and expanded exactly.
 */

export interface ScaledDecimal {
  /** Integer mantissa — value = units / 10^scale */
  units: bigint;
  /** Number of fractional digits encoded in `units` */
  scale: number;
}

export type DecimalRoundingMode = 'down' | 'up' | 'nearest';

const DECIMAL_RE = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/**
 * Parse a decimal string (or finite number) into an exact scaled BigInt.
 * Throws on malformed input so callers fail closed instead of sending garbage sizes.
 */
export function parseDecimal(value: string | number): ScaledDecimal {
  const text = typeof value === 'number' ? numberToDecimalString(value) : value.trim();
  const match = DECIMAL_RE.exec(text);
  if (!match || (match[2] === '' && (match[3] ?? '') === '')) {
    throw new Error(`Invalid decimal string: "${value}"`);
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const intPart = match[2] || '0';
  const fracPart = match[3] ?? '';
  const exponent = match[4] ? Number.parseInt(match[4], 10) : 0;

  let units = BigInt(intPart + fracPart) * sign;
  let scale = fracPart.length - exponent;
  if (scale < 0) {
    units *= 10n ** BigInt(-scale);
    scale = 0;
  }
  return { units, scale };
}

/** Convert a JS number to a plain decimal string without exponent notation. */
function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid decimal number: ${value}`);
  }
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  // Expand exponent form (e.g. 1e-7) exactly using the shortest round-trip digits.
  const match = /^([+-])?(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (!match) return text;
  const sign = match[1] ?? '';
  const digits = match[2] + (match[3] ?? '');
  const pointPos = match[2].length + Number.parseInt(match[4], 10);
  if (pointPos <= 0) {
    return `${sign}0.${'0'.repeat(-pointPos)}${digits}`;
  }
  if (pointPos >= digits.length) {
    return `${sign}${digits}${'0'.repeat(pointPos - digits.length)}`;
  }
  return `${sign}${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
}

/** Bring two scaled decimals to a common scale. */
function align(a: ScaledDecimal, b: ScaledDecimal): { a: bigint; b: bigint; scale: number } {
  const scale = Math.max(a.scale, b.scale);
  return {
    a: a.units * 10n ** BigInt(scale - a.scale),
    b: b.units * 10n ** BigInt(scale - b.scale),
    scale,
  };
}

/** Render a scaled decimal as a plain string with exactly `scale` fractional digits. */
export function formatDecimal(d: ScaledDecimal): string {
  const negative = d.units < 0n;
  const abs = negative ? -d.units : d.units;
  const digits = abs.toString().padStart(d.scale + 1, '0');
  const intPart = digits.slice(0, digits.length - d.scale);
  const fracPart = digits.slice(digits.length - d.scale);
  const body = d.scale > 0 ? `${intPart}.${fracPart}` : intPart;
  return negative ? `-${body}` : body;
}

/** Number of fractional digits implied by an increment string ("0.001" → 3). */
export function decimalScaleOf(value: string): number {
  return parseDecimal(value).scale;
}

/** Compare two decimal strings: -1 if a < b, 0 if equal, 1 if a > b. */
export function decimalCompare(a: string | number, b: string | number): -1 | 0 | 1 {
  const aligned = align(parseDecimal(a), parseDecimal(b));
  if (aligned.a < aligned.b) return -1;
  if (aligned.a > aligned.b) return 1;
  return 0;
}

/** a + b as a decimal string (scale = max of inputs). */
export function decimalAdd(a: string | number, b: string | number): string {
  const aligned = align(parseDecimal(a), parseDecimal(b));
  return formatDecimal({ units: aligned.a + aligned.b, scale: aligned.scale });
}

/** a - b as a decimal string (scale = max of inputs). May be negative. */
export function decimalSub(a: string | number, b: string | number): string {
  const aligned = align(parseDecimal(a), parseDecimal(b));
  return formatDecimal({ units: aligned.a - aligned.b, scale: aligned.scale });
}

/** a * b as an exact decimal string (scale = sum of input scales). */
export function decimalMul(a: string | number, b: string | number): string {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  return formatDecimal({ units: da.units * db.units, scale: da.scale + db.scale });
}

/**
 * a / b rendered with exactly `scale` fractional digits (truncated toward zero).
 * Throws on division by zero.
 */
export function decimalDiv(a: string | number, b: string | number, scale = 12): string {
  const da = parseDecimal(a);
  const db = parseDecimal(b);
  if (db.units === 0n) {
    throw new Error('Division by zero');
  }
  // (a.units / 10^a.scale) / (b.units / 10^b.scale) * 10^scale
  //   = a.units * 10^(scale + b.scale) / (b.units * 10^a.scale)
  const numerator = da.units * 10n ** BigInt(scale + db.scale);
  const denominator = db.units * 10n ** BigInt(da.scale);
  return formatDecimal({ units: numerator / denominator, scale });
}

/** True when the decimal string is exactly zero. */
export function decimalIsZero(value: string | number): boolean {
  return parseDecimal(value).units === 0n;
}

/** True when the decimal string is strictly positive. */
export function decimalIsPositive(value: string | number): boolean {
  return parseDecimal(value).units > 0n;
}

/**
 * Round `value` to a multiple of `increment` and render it with the increment's
 * precision — the exact form exchanges expect for `base_size` / `limit_price`.
 *
 * - `down`    → floor (never exceed the intended size or notional)
 * - `up`      → ceil
 * - `nearest` → half-up
 *
 * Throws for non-positive increments or negative values.
 */
export function decimalRoundToIncrement(
  value: string | number,
  increment: string,
  mode: DecimalRoundingMode = 'down',
): string {
  const inc = parseDecimal(increment);
  if (inc.units <= 0n) {
    throw new Error(`Increment must be positive, got "${increment}"`);
  }
  const val = parseDecimal(value);
  if (val.units < 0n) {
    throw new Error(`Cannot round negative value "${value}" to increment`);
  }
  const aligned = align(val, inc);
  let quotient = aligned.a / aligned.b;
  const remainder = aligned.a % aligned.b;
  if (remainder !== 0n) {
    if (mode === 'up') {
      quotient += 1n;
    } else if (mode === 'nearest' && remainder * 2n >= aligned.b) {
      quotient += 1n;
    }
  }
  const rounded: ScaledDecimal = { units: quotient * aligned.b, scale: aligned.scale };
  return rescale(rounded, inc.scale);
}

/** Change the rendered scale of an exact value (only valid when no precision is lost). */
function rescale(d: ScaledDecimal, targetScale: number): string {
  if (targetScale >= d.scale) {
    return formatDecimal({ units: d.units * 10n ** BigInt(targetScale - d.scale), scale: targetScale });
  }
  const divisor = 10n ** BigInt(d.scale - targetScale);
  if (d.units % divisor !== 0n) {
    // Value carries more precision than the target scale; keep it exact.
    return formatDecimal(d);
  }
  return formatDecimal({ units: d.units / divisor, scale: targetScale });
}

/** Convert a decimal string to a JS number at the boundary where numeric APIs are required. */
export function decimalToNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid decimal string: "${value}"`);
  }
  return parsed;
}
