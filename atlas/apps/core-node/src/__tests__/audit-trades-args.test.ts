import { describe, test, expect } from 'vitest';
import { parseCliArgs, usage } from '../cli/audit-trades';

describe('audit-trades parseCliArgs', () => {
  // Fixed clock so the default-window test isn't time-of-day dependent.
  const FIXED_NOW = new Date('2026-05-14T10:34:00.000Z');

  test('defaults --since to 7 days before now, truncated to UTC midnight', () => {
    const args = parseCliArgs([], FIXED_NOW);
    expect(args.since.toISOString()).toBe('2026-05-07T00:00:00.000Z');
    expect(args.strict).toBe(false);
  });

  test('parses --since with strict YYYY-MM-DD shape', () => {
    const args = parseCliArgs(['--since', '2026-05-11'], FIXED_NOW);
    expect(args.since.toISOString()).toBe('2026-05-11T00:00:00.000Z');
  });

  test('rejects --since with ISO timestamp shape', () => {
    expect(() => parseCliArgs(['--since', '2026-05-11T12:34:56Z'], FIXED_NOW)).toThrow(/YYYY-MM-DD/);
  });

  test('rejects --since with relative shape', () => {
    expect(() => parseCliArgs(['--since', '7d'], FIXED_NOW)).toThrow(/YYYY-MM-DD/);
  });

  test('rejects --since with no value', () => {
    expect(() => parseCliArgs(['--since'], FIXED_NOW)).toThrow(/--since requires/);
  });

  test('parses --strict alone', () => {
    const args = parseCliArgs(['--strict'], FIXED_NOW);
    expect(args.strict).toBe(true);
  });

  test('parses --since and --strict together (any order)', () => {
    const a = parseCliArgs(['--since', '2026-05-11', '--strict'], FIXED_NOW);
    const b = parseCliArgs(['--strict', '--since', '2026-05-11'], FIXED_NOW);
    expect(a.since.toISOString()).toBe(b.since.toISOString());
    expect(a.strict).toBe(true);
    expect(b.strict).toBe(true);
  });

  test('rejects unknown flags', () => {
    expect(() => parseCliArgs(['--bogus'], FIXED_NOW)).toThrow(/Unknown flag/);
  });

  test('usage() string mentions both flags', () => {
    const text = usage();
    expect(text).toMatch(/--since/);
    expect(text).toMatch(/--strict/);
    expect(text).toMatch(/audit-trades/);
  });
});
