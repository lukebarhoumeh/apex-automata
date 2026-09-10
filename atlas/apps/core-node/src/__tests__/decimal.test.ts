/**
 * Exact decimal-string helpers used by the live execution path.
 */

import { describe, it, expect } from 'vitest';
import {
  decimalAdd,
  decimalCompare,
  decimalIsPositive,
  decimalIsZero,
  decimalMul,
  decimalRoundToIncrement,
  decimalScaleOf,
  decimalSub,
  decimalToNumber,
  formatDecimal,
  parseDecimal,
} from '../core/decimal';

describe('decimal helpers', () => {
  it('parses plain, signed and exponent-form decimals exactly', () => {
    expect(parseDecimal('0.00000001')).toEqual({ units: 1n, scale: 8 });
    expect(parseDecimal('1e-8')).toEqual({ units: 1n, scale: 8 });
    expect(parseDecimal('2.5e3')).toEqual({ units: 2500n, scale: 0 });
    expect(parseDecimal('-12.340')).toEqual({ units: -12340n, scale: 3 });
    expect(parseDecimal(1e-7)).toEqual({ units: 1n, scale: 7 });
    expect(() => parseDecimal('abc')).toThrow(/Invalid decimal/);
    expect(() => parseDecimal('')).toThrow(/Invalid decimal/);
  });

  it('formats with the encoded scale', () => {
    expect(formatDecimal({ units: 12345678n, scale: 8 })).toBe('0.12345678');
    expect(formatDecimal({ units: -5n, scale: 2 })).toBe('-0.05');
    expect(formatDecimal({ units: 42n, scale: 0 })).toBe('42');
  });

  it('rounds DOWN to base_increment by default', () => {
    expect(decimalRoundToIncrement('0.123456789', '0.00000001')).toBe('0.12345678');
    expect(decimalRoundToIncrement(0.123456789, '0.00000001')).toBe('0.12345678');
    expect(decimalRoundToIncrement('1.9999', '0.001')).toBe('1.999');
    expect(decimalRoundToIncrement('0.00021999', '0.00001')).toBe('0.00021');
    expect(decimalRoundToIncrement('7', '1')).toBe('7');
  });

  it('rounds to nearest (half-up) and up on request', () => {
    expect(decimalRoundToIncrement('2469.554', '0.01', 'nearest')).toBe('2469.55');
    expect(decimalRoundToIncrement('2469.555', '0.01', 'nearest')).toBe('2469.56');
    expect(decimalRoundToIncrement('2469.551', '0.01', 'up')).toBe('2469.56');
    expect(decimalRoundToIncrement('100', '0.01', 'nearest')).toBe('100.00');
  });

  it('rejects non-positive increments and negative values', () => {
    expect(() => decimalRoundToIncrement('1', '0')).toThrow(/positive/);
    expect(() => decimalRoundToIncrement('-1', '0.1')).toThrow(/negative/);
  });

  it('compares, adds, subtracts and multiplies exactly', () => {
    expect(decimalCompare('0.1', '0.10')).toBe(0);
    expect(decimalCompare('0.00022', '0.0003')).toBe(-1);
    expect(decimalCompare('2', '1.999999')).toBe(1);
    expect(decimalAdd('0.1', '0.2')).toBe('0.3');
    expect(decimalSub('1.0', '0.4')).toBe('0.6');
    expect(decimalSub('0.4', '1.0')).toBe('-0.6');
    expect(decimalMul('0.00022', '2469.55')).toBe('0.5433010');
    expect(decimalIsZero('0.000')).toBe(true);
    expect(decimalIsPositive('0.000001')).toBe(true);
    expect(decimalScaleOf('0.001')).toBe(3);
    expect(decimalToNumber('0.6')).toBe(0.6);
  });
});
