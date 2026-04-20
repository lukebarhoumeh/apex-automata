import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HyperliquidAdapter } from '../exchanges/hyperliquid/index';
import type { Logger } from '../core/logger';
import {
  toHyperliquidSymbol,
  fromHyperliquidSymbol,
  toHyperliquidSide,
  fromHyperliquidSide,
  fromHyperliquidStatus,
} from '../exchanges/hyperliquid/types';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as any;

describe('HyperliquidAdapter', () => {
  let adapter: HyperliquidAdapter;

  beforeEach(() => {
    adapter = new HyperliquidAdapter(mockLogger, { testnet: true });
  });

  it('has correct identity', () => {
    expect(adapter.id).toBe('hyperliquid');
    expect(adapter.name).toBe('Hyperliquid Perpetual DEX');
    expect(adapter.exchangeType).toBe('perpetual');
  });

  it('defaults to not connected', () => {
    expect(adapter.isConnected()).toBe(false);
  });

  it('rejects placeOrder when not connected', async () => {
    await expect(adapter.placeOrder({
      symbol: 'ETH-USD',
      side: 'buy',
      type: 'limit',
      size: '0.1',
      price: '3500',
    })).rejects.toThrow('not connected');
  });

  it('rejects getBalances when not connected', async () => {
    await expect(adapter.getBalances()).rejects.toThrow('not connected');
  });

  it('rejects getPositions when not connected', async () => {
    await expect(adapter.getPositions()).rejects.toThrow('not connected');
  });

  it('returns empty markets before initialization', async () => {
    const markets = await adapter.getMarkets();
    expect(markets).toEqual([]);
  });

  it('getPerpsSymbols returns empty before initialization', async () => {
    const symbols = await adapter.getPerpsSymbols();
    expect(symbols).toEqual([]);
  });

  it('isPerpsSymbol returns false before initialization', () => {
    expect(adapter.isPerpsSymbol('ETH-USD')).toBe(false);
  });
});

describe('Symbol Mapping', () => {
  it('converts Apex symbols to Hyperliquid format', () => {
    expect(toHyperliquidSymbol('ETH-USD')).toBe('ETH-PERP');
    expect(toHyperliquidSymbol('BTC-USD')).toBe('BTC-PERP');
    expect(toHyperliquidSymbol('SOL-USD')).toBe('SOL-PERP');
  });

  it('converts Hyperliquid symbols to Apex format', () => {
    expect(fromHyperliquidSymbol('ETH-PERP')).toBe('ETH-USD');
    expect(fromHyperliquidSymbol('BTC-PERP')).toBe('BTC-USD');
    expect(fromHyperliquidSymbol('SOL-PERP')).toBe('SOL-USD');
    expect(fromHyperliquidSymbol('ETH')).toBe('ETH-USD');
  });

  it('maps order sides correctly', () => {
    expect(toHyperliquidSide('buy')).toBe(true);
    expect(toHyperliquidSide('sell')).toBe(false);
    expect(fromHyperliquidSide(true)).toBe('buy');
    expect(fromHyperliquidSide(false)).toBe('sell');
  });

  it('maps order statuses correctly', () => {
    expect(fromHyperliquidStatus('open')).toBe('open');
    expect(fromHyperliquidStatus('resting')).toBe('open');
    expect(fromHyperliquidStatus('filled')).toBe('filled');
    expect(fromHyperliquidStatus('cancelled')).toBe('cancelled');
    expect(fromHyperliquidStatus('canceled')).toBe('cancelled');
    expect(fromHyperliquidStatus('rejected')).toBe('rejected');
    expect(fromHyperliquidStatus('unknown')).toBe('pending');
  });
});
