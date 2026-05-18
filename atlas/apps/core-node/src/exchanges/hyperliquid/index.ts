/**
 * Hyperliquid Exchange Adapter
 *
 * Implements IExchangeAdapter + IPerpsAdapter for the Hyperliquid perpetual
 * futures DEX using the nomeida/hyperliquid SDK.
 *
 * Key differences from Coinbase:
 * - All products are perpetual futures (no spot)
 * - No native market orders (IOC limit at aggressive price)
 * - Symbol format: SDK uses 'ETH-PERP', API uses 'ETH'
 * - Auth via Ethereum private key signing, not API key/secret
 * - Funding rates settle every 1h
 * - Cross-margin by default
 * - Collateral in USDC
 */

import { EventEmitter } from 'events';
import { Hyperliquid } from 'hyperliquid';
import { Logger } from '../../core/logger.js';
import { FeeModel } from '../../core/fee-model.js';
import type {
  IExchangeAdapter,
  IPerpsAdapter,
  ExchangeCredentials,
  ExchangeType,
  AdapterOrderRequest,
  AdapterOrderResult,
  AdapterPosition,
  AdapterBalance,
  AdapterMarketInfo,
  AdapterCandle,
  AdapterOrderBook,
  AdapterTicker,
  AdapterFundingRate,
  AdapterPortfolioSummary,
} from '../types.js';
import {
  HyperliquidConfig,
  DEFAULT_HYPERLIQUID_CONFIG,
  toHyperliquidSymbol,
  fromHyperliquidSymbol,
  fromHyperliquidStatus,
} from './types.js';

export class HyperliquidAdapter extends EventEmitter implements IExchangeAdapter, IPerpsAdapter {
  readonly id = 'hyperliquid';
  readonly name = 'Hyperliquid Perpetual DEX';
  readonly exchangeType: ExchangeType = 'perpetual';

  private logger: Logger;
  private config: HyperliquidConfig;
  private sdk: Hyperliquid | null = null;
  private connected = false;
  private walletAddress: string = '';
  private marketCache: Map<string, AdapterMarketInfo> = new Map();
  // Single source of truth for HL fee rates surfaced on AdapterMarketInfo.
  // Resolved per refresh via FeeModel.getFeeRate('hyperliquid','perps',side)
  // so this UI surface honors guardrails.yaml -> fees.hyperliquid.perps —
  // critically preserving the maker-rebate sign (-1.5 bps) the legacy
  // hardcode dropped.
  private feeModel: FeeModel;

  constructor(logger: Logger, feeModel: FeeModel, config?: Partial<HyperliquidConfig>) {
    super();
    this.logger = logger;
    this.feeModel = feeModel;
    this.config = { ...DEFAULT_HYPERLIQUID_CONFIG, ...config };
  }

  // ============ Lifecycle ============

  async initialize(credentials: ExchangeCredentials): Promise<void> {
    const privateKey = credentials.privateKey || this.config.privateKey;
    this.walletAddress = credentials.walletAddress || this.config.walletAddress || '';

    this.logger.info('Initializing Hyperliquid adapter', {
      testnet: this.config.testnet,
      hasPrivateKey: !!privateKey,
      hasWalletAddress: !!this.walletAddress,
    });

    this.sdk = new Hyperliquid({
      privateKey: privateKey || undefined,
      testnet: this.config.testnet,
      walletAddress: this.walletAddress || undefined,
      enableWs: true,
    });

    await this.sdk.connect();
    await this.refreshMarketCache();
    this.connected = true;
    this.emit('connected');

    this.logger.info(`Hyperliquid adapter initialized with ${this.marketCache.size} markets`);
  }

  async shutdown(): Promise<void> {
    this.logger.info('Shutting down Hyperliquid adapter');
    if (this.sdk) {
      this.sdk.disconnect();
      this.sdk = null;
    }
    this.connected = false;
    this.emit('disconnected');
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ============ Market Data ============

  async getMarkets(): Promise<AdapterMarketInfo[]> {
    return Array.from(this.marketCache.values());
  }

  async getMarketInfo(symbol: string): Promise<AdapterMarketInfo> {
    const hlSymbol = toHyperliquidSymbol(symbol);
    const cached = this.marketCache.get(hlSymbol);
    if (cached) return cached;
    await this.refreshMarketCache();
    const refreshed = this.marketCache.get(hlSymbol);
    if (refreshed) return refreshed;
    throw new Error(`Market not found: ${symbol} (HL: ${hlSymbol})`);
  }

  async getCandles(
    symbol: string,
    granularity: string,
    start?: number,
    end?: number
  ): Promise<AdapterCandle[]> {
    this.ensureConnected();
    const hlSymbol = toHyperliquidSymbol(symbol);
    const candles: any[] = await this.sdk!.info.getCandleSnapshot(
      hlSymbol,
      granularity,
      start || Date.now() - 24 * 60 * 60 * 1000,
      end || Date.now(),
    );

    return candles.map((c: any) => ({
      timestamp: typeof c.t === 'number' ? c.t : parseInt(c.t),
      open: typeof c.o === 'number' ? c.o : parseFloat(c.o),
      high: typeof c.h === 'number' ? c.h : parseFloat(c.h),
      low: typeof c.l === 'number' ? c.l : parseFloat(c.l),
      close: typeof c.c === 'number' ? c.c : parseFloat(c.c),
      volume: typeof c.v === 'number' ? c.v : parseFloat(c.v),
    }));
  }

  async getOrderBook(symbol: string, depth?: number): Promise<AdapterOrderBook> {
    this.ensureConnected();
    const hlSymbol = toHyperliquidSymbol(symbol);
    const book: any = await this.sdk!.info.getL2Book(hlSymbol, false, depth || 5);
    const levels = book.levels || book;

    return {
      symbol,
      bids: (levels[0] || []).map((l: any) => [String(l.px), String(l.sz)]),
      asks: (levels[1] || []).map((l: any) => [String(l.px), String(l.sz)]),
      timestamp: Date.now(),
    };
  }

  async getTicker(symbol: string): Promise<AdapterTicker> {
    this.ensureConnected();
    const hlSymbol = toHyperliquidSymbol(symbol);
    const mids = await this.sdk!.info.getAllMids();
    const midPrice = mids[hlSymbol] ?? mids[hlSymbol.replace('-PERP', '')];
    const mid = midPrice !== undefined ? String(midPrice) : '0';

    return {
      symbol,
      bid: mid,
      ask: mid,
      last: mid,
      volume: '0',
      timestamp: Date.now(),
    };
  }

  // ============ Trading ============

  async placeOrder(order: AdapterOrderRequest): Promise<AdapterOrderResult> {
    this.ensureConnected();
    const hlSymbol = toHyperliquidSymbol(order.symbol);
    const isBuy = order.side === 'buy';

    this.logger.info('Placing Hyperliquid order', {
      symbol: hlSymbol, side: order.side, type: order.type, size: order.size,
    });

    let result: any;

    if (order.type === 'market') {
      const mids = await this.sdk!.info.getAllMids();
      const mid = mids[hlSymbol] ?? mids[hlSymbol.replace('-PERP', '')];
      const midPrice = typeof mid === 'number' ? mid : parseFloat(String(mid));
      const slippage = 0.01;
      result = await this.sdk!.custom.marketOpen(
        hlSymbol,
        isBuy,
        parseFloat(order.size),
        midPrice,
        slippage,
        order.clientOrderId,
      );
    } else {
      const limitPx = order.price || '0';
      result = await this.sdk!.exchange.placeOrder({
        coin: hlSymbol,
        is_buy: isBuy,
        sz: parseFloat(order.size),
        limit_px: parseFloat(limitPx),
        order_type: { limit: { tif: 'Gtc' } },
        reduce_only: order.reduceOnly || false,
        cloid: order.clientOrderId,
      });
    }

    const status = result?.response?.data?.statuses?.[0] || result?.statuses?.[0] || {};
    const orderId = status.resting?.oid || status.filled?.oid || String(Date.now());

    return {
      orderId: String(orderId),
      clientOrderId: order.clientOrderId,
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      status: status.filled ? 'filled' : status.resting ? 'open' : 'pending',
      size: order.size,
      filledSize: status.filled?.totalSz || '0',
      avgFillPrice: status.filled?.avgPx || '0',
      fees: '0',
      feeCurrency: 'USDC',
      timestamp: Date.now(),
      raw: result,
    };
  }

  async cancelOrder(orderId: string): Promise<boolean> {
    this.ensureConnected();
    try {
      await this.sdk!.exchange.cancelOrder([{ coin: '', o: parseInt(orderId) }]);
      return true;
    } catch (error) {
      this.logger.warn('Failed to cancel order', { orderId, error });
      return false;
    }
  }

  async cancelAllOrders(symbol?: string): Promise<number> {
    this.ensureConnected();
    try {
      const hlSymbol = symbol ? toHyperliquidSymbol(symbol) : undefined;
      await this.sdk!.custom.cancelAllOrders(hlSymbol);
      return 1;
    } catch {
      return 0;
    }
  }

  async getOrder(orderId: string): Promise<AdapterOrderResult> {
    this.ensureConnected();
    const result: any = await this.sdk!.info.getOrderStatus(this.walletAddress, parseInt(orderId));
    const order = result?.order || result;

    return {
      orderId: String(order.oid || orderId),
      symbol: fromHyperliquidSymbol(order.coin || ''),
      side: order.side === 'B' ? 'buy' : 'sell',
      type: 'limit',
      status: fromHyperliquidStatus(order.status || order.orderStatus || 'pending'),
      size: String(order.sz || order.origSz || '0'),
      filledSize: String(order.totalSz || '0'),
      avgFillPrice: String(order.avgPx || '0'),
      fees: '0',
      feeCurrency: 'USDC',
      timestamp: order.timestamp || Date.now(),
      raw: result,
    };
  }

  async getOpenOrders(symbol?: string): Promise<AdapterOrderResult[]> {
    this.ensureConnected();
    const orders: any[] = await this.sdk!.info.getUserOpenOrders(this.walletAddress);

    return orders
      .filter((o: any) => !symbol || fromHyperliquidSymbol(o.coin) === symbol)
      .map((o: any) => ({
        orderId: String(o.oid),
        symbol: fromHyperliquidSymbol(o.coin),
        side: o.side === 'B' ? 'buy' as const : 'sell' as const,
        type: 'limit' as const,
        status: 'open' as const,
        size: String(o.sz || o.origSz),
        filledSize: '0',
        avgFillPrice: String(o.limitPx || '0'),
        fees: '0',
        feeCurrency: 'USDC',
        timestamp: o.timestamp || Date.now(),
        raw: o,
      }));
  }

  // ============ Account ============

  async getBalances(): Promise<AdapterBalance[]> {
    this.ensureConnected();
    const state: any = await this.sdk!.info.perpetuals.getClearinghouseState(this.walletAddress);
    const mb = state.marginSummary || state.crossMarginSummary || {};

    return [{
      currency: 'USDC',
      available: String(mb.availableBalance || mb.totalRawUsd || '0'),
      held: String(mb.totalMarginUsed || '0'),
      total: String(mb.accountValue || '0'),
    }];
  }

  async getPositions(): Promise<AdapterPosition[]> {
    this.ensureConnected();
    const state: any = await this.sdk!.info.perpetuals.getClearinghouseState(this.walletAddress);
    const positions = state.assetPositions || [];

    return positions
      .filter((p: any) => parseFloat(p.position?.szi || '0') !== 0)
      .map((p: any) => {
        const pos = p.position;
        const szi = parseFloat(pos.szi);
        return {
          symbol: fromHyperliquidSymbol(pos.coin),
          side: szi > 0 ? 'buy' as const : 'sell' as const,
          size: String(Math.abs(szi)),
          entryPrice: String(pos.entryPx || '0'),
          markPrice: String(pos.positionValue ? Math.abs(parseFloat(pos.positionValue) / szi) : '0'),
          unrealizedPnl: String(pos.unrealizedPnl || '0'),
          liquidationPrice: pos.liquidationPx ? String(pos.liquidationPx) : undefined,
          leverage: pos.leverage ? parseFloat(String(pos.leverage.value || pos.leverage)) : undefined,
          marginUsed: pos.marginUsed ? String(pos.marginUsed) : undefined,
        };
      });
  }

  // ============ WebSocket Subscriptions ============

  async subscribeOrderBook(symbol: string): Promise<void> {
    this.ensureConnected();
    const hlSymbol = toHyperliquidSymbol(symbol);
    await this.sdk!.subscriptions.subscribeToL2Book(hlSymbol, (data: any) => {
      this.emit('orderbook:update', {
        symbol,
        bids: (data.levels?.[0] || []).map((l: any) => [String(l.px), String(l.sz)]),
        asks: (data.levels?.[1] || []).map((l: any) => [String(l.px), String(l.sz)]),
        timestamp: Date.now(),
      });
    });
  }

  async subscribeTicker(symbol: string): Promise<void> {
    this.ensureConnected();
    await this.sdk!.subscriptions.subscribeToAllMids((mids: any) => {
      const hlSymbol = toHyperliquidSymbol(symbol);
      const baseSymbol = hlSymbol.replace('-PERP', '');
      const mid = mids[hlSymbol] ?? mids[baseSymbol];
      if (mid !== undefined) {
        this.emit('ticker:update', {
          symbol,
          bid: String(mid),
          ask: String(mid),
          last: String(mid),
          volume: '0',
          timestamp: Date.now(),
        });
      }
    });
  }

  async subscribeTrades(symbol: string): Promise<void> {
    this.ensureConnected();
    const hlSymbol = toHyperliquidSymbol(symbol);
    await this.sdk!.subscriptions.subscribeToTrades(hlSymbol, (trades: any[]) => {
      for (const t of trades) {
        this.emit('trade:update', {
          symbol,
          price: String(t.px),
          size: String(t.sz),
          side: t.side === 'B' ? 'buy' : 'sell',
          timestamp: t.time || Date.now(),
        });
      }
    });
  }

  async subscribeUserOrders(): Promise<void> {
    this.ensureConnected();
    await this.sdk!.subscriptions.subscribeToOrderUpdates(this.walletAddress, (orders: any[]) => {
      for (const o of orders) {
        this.emit('order:update', {
          orderId: String(o.oid || o.order?.oid),
          symbol: fromHyperliquidSymbol(o.coin || o.order?.coin || ''),
          side: (o.side === 'B' || o.order?.side === 'B') ? 'buy' : 'sell',
          type: 'limit',
          status: fromHyperliquidStatus(o.status || o.orderStatus || 'open'),
          size: String(o.sz || o.order?.sz || '0'),
          filledSize: String(o.totalSz || '0'),
          avgFillPrice: String(o.avgPx || '0'),
          fees: '0',
          feeCurrency: 'USDC',
          timestamp: o.timestamp || Date.now(),
          raw: o,
        } satisfies AdapterOrderResult);
      }
    });
  }

  async unsubscribeAll(): Promise<void> {
    if (this.sdk?.ws && typeof this.sdk.ws.close === 'function') {
      this.sdk.ws.close();
    }
  }

  // ============ IPerpsAdapter ============

  async getFundingRate(symbol: string): Promise<AdapterFundingRate | null> {
    this.ensureConnected();
    try {
      const hlSymbol = toHyperliquidSymbol(symbol);
      const predicted: any[] = await this.sdk!.info.perpetuals.getPredictedFundings();
      const entry = predicted.find((p: any) =>
        p[0] === hlSymbol || p[0] === hlSymbol.replace('-PERP', '')
      );

      if (!entry) return null;
      const fundingData = entry[1] || {};

      const mids = await this.sdk!.info.getAllMids();
      const mid = mids[hlSymbol] ?? mids[hlSymbol.replace('-PERP', '')] ?? '0';

      return {
        symbol,
        rate: String(fundingData.fundingRate || fundingData.predictedRate || '0'),
        nextSettlement: Date.now() + 3600_000,
        markPrice: String(mid),
        indexPrice: String(mid),
      };
    } catch (error) {
      this.logger.warn('Failed to get funding rate', { symbol, error });
      return null;
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    this.ensureConnected();
    try {
      const hlSymbol = toHyperliquidSymbol(symbol);
      await this.sdk!.exchange.updateLeverage(hlSymbol, 'cross', leverage);
      return true;
    } catch (error) {
      this.logger.warn('Failed to set leverage', { symbol, leverage, error });
      return false;
    }
  }

  async getLeverage(symbol: string): Promise<number | null> {
    this.ensureConnected();
    try {
      const state: any = await this.sdk!.info.perpetuals.getClearinghouseState(this.walletAddress);
      const hlSymbol = toHyperliquidSymbol(symbol);
      const base = hlSymbol.replace('-PERP', '');
      const pos = (state.assetPositions || []).find((p: any) =>
        p.position?.coin === base || p.position?.coin === hlSymbol
      );
      if (!pos?.position?.leverage) return null;
      const lev = pos.position.leverage;
      return typeof lev === 'number' ? lev : parseFloat(String(lev.value || lev));
    } catch {
      return null;
    }
  }

  async getPortfolioSummary(): Promise<AdapterPortfolioSummary | null> {
    this.ensureConnected();
    try {
      const state: any = await this.sdk!.info.perpetuals.getClearinghouseState(this.walletAddress);
      const ms = state.marginSummary || state.crossMarginSummary || {};
      return {
        totalCollateral: String(ms.accountValue || '0'),
        unrealizedPnl: String(ms.totalNtlPos ? parseFloat(ms.totalNtlPos) * 0 : '0'),
        buyingPower: String(ms.availableBalance || ms.totalRawUsd || '0'),
        marginUsed: String(ms.totalMarginUsed || '0'),
        maxWithdrawal: String(ms.withdrawable || ms.availableBalance || '0'),
      };
    } catch {
      return null;
    }
  }

  async getPerpsSymbols(): Promise<string[]> {
    return Array.from(this.marketCache.keys()).map(fromHyperliquidSymbol);
  }

  isPerpsSymbol(symbol: string): boolean {
    const hlSymbol = toHyperliquidSymbol(symbol);
    return this.marketCache.has(hlSymbol);
  }

  // ============ Private Helpers ============

  private ensureConnected(): void {
    if (!this.connected || !this.sdk) {
      throw new Error('Hyperliquid adapter not connected');
    }
  }

  private async refreshMarketCache(): Promise<void> {
    if (!this.sdk) return;
    try {
      const meta: any = await this.sdk.info.perpetuals.getMeta();
      const universe = meta?.universe || meta || [];

      this.marketCache.clear();
      const makerFee = this.feeModel.getFeeRate('hyperliquid', 'perps', 'maker').toString();
      const takerFee = this.feeModel.getFeeRate('hyperliquid', 'perps', 'taker').toString();
      for (const asset of universe) {
        const name = asset.name || asset.coin;
        if (!name) continue;
        const hlSymbol = `${name}-PERP`;
        this.marketCache.set(hlSymbol, {
          symbol: `${name}-USD`,
          baseCurrency: name,
          quoteCurrency: 'USD',
          minOrderSize: String(asset.szDecimals ? Math.pow(10, -asset.szDecimals) : '0.001'),
          maxOrderSize: String(asset.maxLeverage ? 1000000 / (asset.maxLeverage || 1) : '100000'),
          tickSize: '0.01',
          stepSize: String(asset.szDecimals ? Math.pow(10, -asset.szDecimals) : '0.001'),
          makerFee,
          takerFee,
          exchangeType: 'perpetual',
          maxLeverage: asset.maxLeverage || 50,
        });
      }
      this.logger.info('Refreshed Hyperliquid market cache', { count: this.marketCache.size });
    } catch (error) {
      this.logger.warn('Failed to refresh market cache', { error });
    }
  }
}
