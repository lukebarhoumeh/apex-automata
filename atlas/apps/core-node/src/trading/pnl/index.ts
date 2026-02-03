/**
 * P&L Module - Single Source of Truth for Equity and P&L
 * 
 * This module provides:
 * - PnLService: The canonical source of all P&L computations
 * - PnLSnapshot: The canonical payload for equity/P&L state
 * 
 * All other modules (RiskEngine, TradeAnalytics, API) must consume PnLSnapshot from here.
 * No duplicate P&L calculations allowed elsewhere.
 */

export * from './pnl-types';
export * from './pnl-service';
