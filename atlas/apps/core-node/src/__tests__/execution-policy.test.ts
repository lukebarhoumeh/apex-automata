/**
 * Card SH-QMAKER-CFM-PAPER-v0, blocker 1 — per-venue entry execution policy.
 *
 * The router used to derive every entry from the single global
 * `execution.order_type` (marketable_limit +2 bps → always crosses). `*-CDE`
 * symbols must instead follow `guardrails.cfm.execution`: TRUE post-only at
 * the signal price, never chased — while spot / INTX keep the legacy profile
 * bit-for-bit. Also pins that `cfm_symbols.disabled_strategies` flows into the
 * per-symbol disable map (infra wired, NOT strategy GO).
 */
import { describe, it, expect } from 'vitest';
import { resolveEntryExecution } from '../trading/execution/execution-policy';
import { buildPerSymbolDisabledStrategies, isSymbolStrategyDisabled } from '../strategies/per-symbol-disable';
import { loadGuardrails } from '../config/loadGuardrails';

const BIP = 'BIP-20DEC30-CDE';
const legacy = { execution: { order_type: 'marketable_limit', price_offset_ticks: 2 } };

describe('resolveEntryExecution', () => {
  it('*-CDE → cfm_post_only: limit, post_only, price = entry (no offset), noChase — from guardrails.cfm.execution', () => {
    const guardrails = loadGuardrails();
    const buy = resolveEntryExecution(BIP, guardrails, 77_717, 'buy');
    expect(buy).toEqual({ policy: 'cfm_post_only', orderType: 'limit', postOnly: true, limitPrice: 77_717, noChase: true });
    const sell = resolveEntryExecution(BIP, guardrails, 77_717, 'sell');
    expect(sell.limitPrice).toBe(77_717);
    expect(sell.postOnly).toBe(true);
    expect(sell.noChase).toBe(true);
  });

  it('*-CDE with no cfm block falls back to the Charter defaults (still post-only, still no chase)', () => {
    const exec = resolveEntryExecution(BIP, legacy, 100, 'buy');
    expect(exec).toMatchObject({ policy: 'cfm_post_only', postOnly: true, noChase: true, limitPrice: 100 });
  });

  it('spot keeps the legacy marketable_limit profile: ±price_offset_ticks bps, not post-only, chase allowed', () => {
    const buy = resolveEntryExecution('ETH-USD', legacy, 2752.31, 'buy');
    expect(buy.policy).toBe('marketable_limit');
    expect(buy.orderType).toBe('limit');
    expect(buy.postOnly).toBe(false);
    expect(buy.noChase).toBe(false);
    expect(buy.limitPrice).toBeCloseTo(2752.31 * (1 + 2 / 10_000), 9);
    const sell = resolveEntryExecution('ETH-PERP-INTX', legacy, 2752.31, 'sell');
    expect(sell.limitPrice).toBeCloseTo(2752.31 * (1 - 2 / 10_000), 9);
  });

  it('other legacy settings: market / post_only / plain limit', () => {
    expect(resolveEntryExecution('BTC-USD', { execution: { order_type: 'market', price_offset_ticks: 2 } }, 100, 'buy')).toMatchObject({ policy: 'market', orderType: 'market', postOnly: false });
    expect(resolveEntryExecution('BTC-USD', { execution: { order_type: 'post_only', price_offset_ticks: 2 } }, 100, 'buy')).toMatchObject({ policy: 'post_only', orderType: 'limit', postOnly: true, limitPrice: 100, noChase: false });
    expect(resolveEntryExecution('BTC-USD', { execution: { order_type: 'limit', price_offset_ticks: 2 } }, 100, 'buy')).toMatchObject({ policy: 'limit', orderType: 'limit', postOnly: false, limitPrice: 100 });
  });

  it('a marketable_limit offset that would go non-positive falls back to the entry price', () => {
    expect(resolveEntryExecution('X-USD', { execution: { order_type: 'marketable_limit', price_offset_ticks: 20_000 } }, 100, 'sell').limitPrice).toBe(100);
  });
});

describe('cfm_symbols.disabled_strategies → per-symbol disable map (NOT strategy GO)', () => {
  it('every built-in strategy is disabled on the CFM paper symbol in the canonical guardrails', () => {
    const map = buildPerSymbolDisabledStrategies(loadGuardrails());
    for (const strategy of ['trend_follow', 'momentum', 'vwap_mr', 'breakout']) {
      expect(isSymbolStrategyDisabled(map, BIP, strategy)).toBe(true);
    }
    // spot is untouched by the CFM block
    expect(isSymbolStrategyDisabled(map, 'BTC-USD', 'trend_follow')).toBe(false);
  });

  it('the cfm_symbols block is read alongside per_symbol / perps_symbols / hyperliquid_symbols', () => {
    const map = buildPerSymbolDisabledStrategies({
      perps_symbols: { 'ETH-PERP-INTX': { disabled_strategies: ['momentum'] } },
      cfm_symbols: { [BIP]: { disabled_strategies: ['trend_follow'] } },
    });
    expect(map).toEqual({ 'ETH-PERP-INTX': ['momentum'], [BIP]: ['trend_follow'] });
  });
});
