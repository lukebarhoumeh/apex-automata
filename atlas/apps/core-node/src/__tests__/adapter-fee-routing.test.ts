/**
 * Exchange adapter fee-routing tests (B5 residual cleanup).
 *
 * Anchors the invariant from `core/fee-model.ts:1-7`: every `AdapterMarketInfo`
 * surface — coinbase spot, coinbase perps, hyperliquid perps — must resolve
 * makerFee/takerFee through the injected `FeeModel` instead of hardcoded
 * decimals. The pre-PR state hardcoded:
 *   - coinbase-perps-adapter:   maker '0.0000',  taker '0.0003'  (taker stale -2 bps vs YAML)
 *   - coinbase-adapter:         maker '0.004',   taker '0.006'   (+20 bps both sides vs YAML)
 *   - hyperliquid/index:        maker '0.0002',  taker '0.0005'  (LOST maker-rebate sign + 0.5 bps taker)
 *
 * These adapters feed UI cost-estimate surfaces (not the fill path — that was
 * fixed in PR #15 / 402e757). Loosening any assertion here re-opens the door
 * to UI/fill drift on the very invariant the FeeModel was built to enforce.
 */

import { describe, it, expect, vi } from 'vitest';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig } from '../config/loadGuardrails';
import { CoinbasePerpsAdapter } from '../exchanges/coinbase-perps-adapter';
import { CoinbaseAdapter } from '../exchanges/coinbase-adapter';
import { HyperliquidAdapter } from '../exchanges/hyperliquid';
import type { Logger } from '../core/logger';
import type { Product, CoinbasePerpsProduct } from '../exchanges/coinbase/types';

const mockLogger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

// Mirror of production guardrails.yaml -> fees block.
const TEST_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: {
    perps: { maker_bps: -1.5, taker_bps: 4.5 },
  },
};

const PERPS_PRODUCT: CoinbasePerpsProduct = {
  product_id: 'ETH-PERP-INTX',
  product_type: 'FUTURE',
  contract_expiry_type: 'PERPETUAL',
  base_currency: 'ETH',
  quote_currency: 'USD',
  contract_size: '0.01',
  max_leverage: '10',
  base_increment: '0.001',
  quote_increment: '0.01',
  status: 'online',
  trading_disabled: false,
};

const SPOT_PRODUCT: Product = {
  id: 'BTC-USD',
  base_currency: 'BTC',
  quote_currency: 'USD',
  base_min_size: '0.0001',
  base_max_size: '999999',
  quote_increment: '0.01',
  base_increment: '0.00000001',
  display_name: 'BTC/USD',
  min_market_funds: '1',
  max_market_funds: '1000000',
  margin_enabled: false,
  post_only: false,
  limit_only: false,
  cancel_only: false,
  status: 'online',
  status_message: '',
  trading_disabled: false,
};

describe('adapter fee routing (B5 residual)', () => {
  it('CoinbasePerpsAdapter resolves perps fees via FeeModel.coinbase.perps_intx', async () => {
    const fm = new FeeModel(TEST_FEES);
    const adapter = new CoinbasePerpsAdapter(mockLogger, fm);
    // Seed the perps product cache directly — bypass the network refresh path
    // since this test isolates the fee-resolution wiring, not the SDK call.
    (adapter as unknown as { perpsProductCache: Map<string, CoinbasePerpsProduct> })
      .perpsProductCache.set('ETH-PERP-INTX', PERPS_PRODUCT);

    const info = await adapter.getMarketInfo('ETH-PERP-INTX');

    expect(parseFloat(info.makerFee)).toBe(fm.getFeeRate('coinbase', 'perps', 'maker'));
    expect(parseFloat(info.takerFee)).toBe(fm.getFeeRate('coinbase', 'perps', 'taker'));
    // Specifically: post-fix taker is 5 bps (0.0005), NOT the legacy 3 bps (0.0003).
    expect(parseFloat(info.takerFee)).toBeCloseTo(0.0005, 8);
    expect(info.exchangeType).toBe('perpetual');
  });

  it('CoinbaseAdapter resolves spot fees via FeeModel.coinbase.spot', async () => {
    const fm = new FeeModel(TEST_FEES);
    const adapter = new CoinbaseAdapter(mockLogger, fm);
    // Stub the underlying CoinbaseExchange so getMarketInfo() can fetch a
    // canned Product without a real REST connection.
    (adapter as unknown as { exchange: { getProduct: (s: string) => Promise<Product> } })
      .exchange = { getProduct: async () => SPOT_PRODUCT };

    const info = await adapter.getMarketInfo('BTC-USD');

    expect(parseFloat(info.makerFee)).toBe(fm.getFeeRate('coinbase', 'spot', 'maker'));
    expect(parseFloat(info.takerFee)).toBe(fm.getFeeRate('coinbase', 'spot', 'taker'));
    // Specifically: post-fix maker/taker are 25/40 bps, NOT the legacy 40/60 bps.
    expect(parseFloat(info.makerFee)).toBeCloseTo(0.0025, 8);
    expect(parseFloat(info.takerFee)).toBeCloseTo(0.004, 8);
    expect(info.exchangeType).toBe('spot');
  });

  it('HyperliquidAdapter resolves perps fees via FeeModel.hyperliquid.perps (preserves maker rebate sign)', async () => {
    const fm = new FeeModel(TEST_FEES);
    const adapter = new HyperliquidAdapter(mockLogger, fm, { testnet: true });
    // Stub the SDK so refreshMarketCache() can populate from canned meta
    // without opening a real WebSocket to api.hyperliquid-testnet.xyz.
    (adapter as unknown as { sdk: { info: { perpetuals: { getMeta: () => Promise<unknown> } } } }).sdk = {
      info: {
        perpetuals: {
          getMeta: async () => ({
            universe: [{ name: 'ETH', maxLeverage: 50, szDecimals: 4 }],
          }),
        },
      },
    };

    await (adapter as unknown as { refreshMarketCache: () => Promise<void> }).refreshMarketCache();
    const info = await adapter.getMarketInfo('ETH-USD');

    expect(parseFloat(info.makerFee)).toBe(fm.getFeeRate('hyperliquid', 'perps', 'maker'));
    expect(parseFloat(info.takerFee)).toBe(fm.getFeeRate('hyperliquid', 'perps', 'taker'));
    // Critical regression guard: the maker rate is NEGATIVE (rebate). The pre-PR
    // hardcode was +0.0002 — wrong sign, silently dropped the rebate.
    expect(parseFloat(info.makerFee)).toBeLessThan(0);
    expect(fm.getFeeRate('hyperliquid', 'perps', 'maker')).toBeLessThan(0);
    // And post-fix taker is 4.5 bps (0.00045), NOT the legacy 5 bps (0.0005).
    expect(parseFloat(info.takerFee)).toBeCloseTo(0.00045, 8);
    expect(info.exchangeType).toBe('perpetual');
  });
});
