import { describe, test, expect } from 'vitest';
import { reanchorStopAndTakeProfit } from '../trading/reanchor-stop-tp';

describe('reanchorStopAndTakeProfit', () => {
  test('SHORT favorable fill (BTC-USD regression): preserves R/R 1:2 anchored to fill', () => {
    // Recovered from session sess_1776828896308_mtce0y, BTC-USD short:
    //   strategy thought signal.price = 77597.19, atr = 96.14
    //   stop = signal.price + 2*atr = 77789.47
    //   tp   = signal.price - 4*atr = 77212.63
    // Order actually filled 27 bps below signal.price at 77387.72.
    const out = reanchorStopAndTakeProfit({
      fillPrice: 77387.72,
      intendedEntryPrice: 77597.19,
      stopPrice: 77789.47,
      takeProfit: 77212.63,
    });

    // After re-anchor: distances preserved, applied around fill price.
    expect(out.stopPrice!).toBeCloseTo(77580.00, 1);
    expect(out.takeProfit!).toBeCloseTo(77003.16, 1);

    // Sanity: SHORT R/R relative to actual fill should be ~1:2.
    const risk = out.stopPrice! - 77387.72;
    const reward = 77387.72 - out.takeProfit!;
    expect(risk).toBeGreaterThan(0);
    expect(reward).toBeGreaterThan(0);
    expect(reward / risk).toBeCloseTo(2, 1);
  });

  test('SHORT extreme favorable fill (BTC-PERP regression): TP must NOT land on wrong side of entry', () => {
    // Recovered from BTC-PERP-INTX short (the 125ms blowout):
    //   signal.price = 76584.42, atr = 50.11
    //   stop = 76684.64, tp = 76383.98
    // Fill came in 207 below signal.price at 76377.68.
    // BEFORE the fix: tp 76383.98 > fill 76377.68 → TP above SHORT entry → auto-trip.
    const out = reanchorStopAndTakeProfit({
      fillPrice: 76377.68,
      intendedEntryPrice: 76584.42,
      stopPrice: 76684.64,
      takeProfit: 76383.98,
    });

    // The whole point of the fix:
    expect(out.takeProfit!).toBeLessThan(76377.68);
    expect(out.stopPrice!).toBeGreaterThan(76377.68);
  });

  test('LONG adverse fill: re-anchor moves stop closer and TP further from entry', () => {
    // signal.price=100, stop=98 (-2), tp=104 (+4). Fill 0.5 above signal.
    const out = reanchorStopAndTakeProfit({
      fillPrice: 100.5,
      intendedEntryPrice: 100,
      stopPrice: 98,
      takeProfit: 104,
    });
    expect(out.stopPrice!).toBeCloseTo(98.5, 8);
    expect(out.takeProfit!).toBeCloseTo(104.5, 8);
  });

  test('LONG exact fill at signal.price: stop/TP unchanged', () => {
    const out = reanchorStopAndTakeProfit({
      fillPrice: 100,
      intendedEntryPrice: 100,
      stopPrice: 98,
      takeProfit: 104,
    });
    expect(out.stopPrice).toBe(98);
    expect(out.takeProfit).toBe(104);
  });

  test('no-op when intendedEntryPrice missing (exit fills, legacy orders)', () => {
    const out = reanchorStopAndTakeProfit({
      fillPrice: 100,
      intendedEntryPrice: undefined,
      stopPrice: 98,
      takeProfit: 104,
    });
    expect(out.stopPrice).toBe(98);
    expect(out.takeProfit).toBe(104);
  });

  test('no-op when fillPrice is invalid or zero', () => {
    const out = reanchorStopAndTakeProfit({
      fillPrice: 0,
      intendedEntryPrice: 100,
      stopPrice: 98,
      takeProfit: 104,
    });
    expect(out.stopPrice).toBe(98);
    expect(out.takeProfit).toBe(104);
  });

  test('no-op when intendedEntryPrice is non-finite or non-positive', () => {
    expect(
      reanchorStopAndTakeProfit({
        fillPrice: 100,
        intendedEntryPrice: NaN,
        stopPrice: 98,
        takeProfit: 104,
      }),
    ).toEqual({ stopPrice: 98, takeProfit: 104 });

    expect(
      reanchorStopAndTakeProfit({
        fillPrice: 100,
        intendedEntryPrice: -1,
        stopPrice: 98,
        takeProfit: 104,
      }),
    ).toEqual({ stopPrice: 98, takeProfit: 104 });
  });

  test('preserves undefined / non-positive stop or TP', () => {
    const out = reanchorStopAndTakeProfit({
      fillPrice: 100.5,
      intendedEntryPrice: 100,
      stopPrice: undefined,
      takeProfit: 0,
    });
    expect(out.stopPrice).toBeUndefined();
    expect(out.takeProfit).toBe(0);
  });

  test('all 5 regression rows from sess_1776828896308: every position lands with R/R ~ 1:2', () => {
    const cases = [
      { name: 'BTC-USD short',       fill: 77387.72, intended: 77597.19, stop: 77789.47, tp: 77212.63 },
      { name: 'SOL-USD short',       fill: 87.640,   intended: 87.880,   stop: 88.143,   tp: 87.354   },
      { name: 'BTC-PERP short',      fill: 76377.68, intended: 76584.42, stop: 76684.64, tp: 76383.98 },
      { name: 'ETH-USD short',       fill: 2358.19,  intended: 2364.57,  stop: 2369.29,  tp: 2355.12  },
      { name: 'ETH-PERP short',      fill: 2358.19,  intended: 2364.57,  stop: 2369.29,  tp: 2355.12  },
    ];

    for (const c of cases) {
      const out = reanchorStopAndTakeProfit({
        fillPrice: c.fill,
        intendedEntryPrice: c.intended,
        stopPrice: c.stop,
        takeProfit: c.tp,
      });
      const risk = out.stopPrice! - c.fill;       // SHORT: stop above
      const reward = c.fill - out.takeProfit!;    // SHORT: TP below
      expect(risk, `${c.name} risk`).toBeGreaterThan(0);
      expect(reward, `${c.name} reward`).toBeGreaterThan(0);
      expect(reward / risk, `${c.name} R/R`).toBeCloseTo(2, 0);
    }
  });
});
