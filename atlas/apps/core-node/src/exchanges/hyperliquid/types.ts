/**
 * Hyperliquid-specific types and mapping utilities.
 *
 * Maps between Apex Automata universal adapter types (exchanges/types.ts)
 * and the nomeida/hyperliquid SDK types.
 */

import type { OrderSide, OrderStatus } from '../types.js';

// ============ Symbol Mapping ============

/**
 * Apex 'ETH-USD' → Hyperliquid SDK 'ETH-PERP'
 * The SDK's symbolConversion then maps 'ETH-PERP' → 'ETH' for the raw API.
 */
export function toHyperliquidSymbol(apexSymbol: string): string {
  const base = apexSymbol.split('-')[0];
  return `${base}-PERP`;
}

/**
 * Hyperliquid SDK 'ETH-PERP' → Apex 'ETH-USD'
 */
export function fromHyperliquidSymbol(hlSymbol: string): string {
  const base = hlSymbol.replace(/-PERP$/, '').replace(/-SPOT$/, '');
  return `${base}-USD`;
}

// ============ Order Side Mapping ============

export function toHyperliquidSide(side: OrderSide): boolean {
  return side === 'buy';
}

export function fromHyperliquidSide(isBuy: boolean): OrderSide {
  return isBuy ? 'buy' : 'sell';
}

// ============ Order Status Mapping ============

export function fromHyperliquidStatus(status: string): OrderStatus {
  switch (status.toLowerCase()) {
    case 'open':
    case 'resting': return 'open';
    case 'filled': return 'filled';
    case 'partially_filled': return 'partially_filled';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    case 'rejected': return 'rejected';
    case 'expired': return 'expired';
    default: return 'pending';
  }
}

// ============ Config ============

export interface HyperliquidConfig {
  /** Use testnet (api.hyperliquid-testnet.xyz) or mainnet */
  testnet: boolean;
  /** Private key (hex) for signing — required for trading */
  privateKey?: string;
  /** Wallet address for public data queries */
  walletAddress?: string;
}

export const DEFAULT_HYPERLIQUID_CONFIG: HyperliquidConfig = {
  testnet: true,
};

// ============ Loose SDK payload shapes ============
// The nomeida/hyperliquid SDK's .d.ts does not always match its runtime
// payloads (see the getPredictedFundings note in ./index.ts), so the adapter
// treats SDK payloads as loosely-typed wire data and narrows defensively.
// These interfaces describe only the fields the adapter actually reads;
// everything is optional / union-typed to mirror the historical `any` reads.

/** Raw candle from info.getCandleSnapshot */
export interface HlRawCandle {
  t: number | string;
  o: number | string;
  h: number | string;
  l: number | string;
  c: number | string;
  v: number | string;
}

/** One price level of an L2 book payload */
export interface HlRawBookLevel {
  px: number | string;
  sz: number | string;
}

/** Order placement/ack status entry */
export interface HlRawOrderStatus {
  resting?: { oid?: number | string };
  filled?: { oid?: number | string; totalSz?: string; avgPx?: string };
}

/** Order placement response envelope (both wrapped and flat shapes observed) */
export interface HlRawOrderResponse {
  response?: { data?: { statuses?: HlRawOrderStatus[] } };
  statuses?: HlRawOrderStatus[];
}

/** Raw order from info.getOrderStatus / getUserOpenOrders / order-update stream */
export interface HlRawOrder {
  oid?: number | string;
  coin?: string;
  side?: string;
  status?: string;
  orderStatus?: string;
  sz?: number | string;
  origSz?: number | string;
  totalSz?: number | string;
  avgPx?: number | string;
  limitPx?: number | string;
  timestamp?: number;
  order?: { oid?: number | string; coin?: string; side?: string; sz?: number | string };
}

/** Margin summary block of a clearinghouse state */
export interface HlRawMarginSummary {
  accountValue?: string;
  totalRawUsd?: string;
  totalMarginUsed?: string;
  availableBalance?: string;
  totalNtlPos?: string;
  withdrawable?: string;
}

/** Leverage arrives as a bare number/string or an object with `value` */
export type HlRawLeverage = number | string | { value?: number | string };

/** One asset position of a clearinghouse state */
export interface HlRawAssetPosition {
  position?: {
    coin?: string;
    szi?: string;
    entryPx?: number | string;
    positionValue?: string;
    unrealizedPnl?: number | string;
    liquidationPx?: number | string;
    leverage?: HlRawLeverage;
    marginUsed?: number | string;
  };
}

/** Clearinghouse state from info.perpetuals.getClearinghouseState */
export interface HlRawClearinghouseState {
  marginSummary?: HlRawMarginSummary;
  crossMarginSummary?: HlRawMarginSummary;
  assetPositions?: HlRawAssetPosition[];
}

/** Raw trade from the trades subscription */
export interface HlRawTrade {
  px?: number | string;
  sz?: number | string;
  side?: string;
  time?: number;
}

/** Asset entry of the perpetuals meta universe */
export interface HlRawMetaAsset {
  name?: string;
  coin?: string;
  szDecimals?: number;
  maxLeverage?: number;
}
