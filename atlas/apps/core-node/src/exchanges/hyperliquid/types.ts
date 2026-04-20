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
