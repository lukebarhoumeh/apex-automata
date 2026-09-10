/**
 * Live preflight — account-truth checks run before a LIVE engine start (Sprint 9 / TASK_011).
 *
 * Mirrors the read-only CLI (`src/cli/coinbase-preflight.ts`, `pnpm cb:preflight`) but runs
 * inside the API process against the same `LiveAccountTruth` the engine will size from, so
 * the preflight verdict and the session's equity/fees/specs come from ONE snapshot.
 *
 * | Check                    | FAIL condition                                                        |
 * |--------------------------|-----------------------------------------------------------------------|
 * | env.COINBASE_API_VERSION | ≠ `advanced`                                                          |
 * | products.intx            | any `*-PERP-INTX` among the symbols the live session would trade      |
 * | clock.skew               | unreadable or > 30 s                                                  |
 * | key.can_trade            | `false`                                                               |
 * | key.can_transfer         | `true` (a bot key must be View+Trade only)                            |
 * | account.truth            | `/accounts`, `/transaction_summary` or any `/products/{id}` unknown   |
 * | account.equity           | USD+USDC available < `live.min_quote_usd`                             |
 * | fees.tier                | unknown (folded into account.truth)                                   |
 * | product.<symbol>         | missing / not tradable / cancel_only                                  |
 * | preview.<symbol>         | `POST /orders/preview` (min-size limit BUY + bracket) throws or errs  |
 *
 * `POST /orders/preview` validates an order shape without executing it. Nothing in this
 * module places, edits or cancels orders. Logs carry `{status, code, message}` only.
 */

import type { Logger } from '../../core/logger';
import {
  decimalCompare,
  decimalDiv,
  decimalMul,
  decimalRoundToIncrement,
} from '../../core/decimal';
import type {
  AtKeyPermissions,
  AtPreviewOrderBody,
  AtPreviewResult,
} from '../../exchanges/coinbase/advanced-trade-client';
import type { LiveProductSpec } from '../execution/coinbase-advanced-adapter';
import {
  LiveAccountSnapshot,
  LiveAccountSummary,
  LiveAccountTruth,
  describeError,
} from './live-account-truth';

export type LivePreflightVerdict = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

export interface LivePreflightCheck {
  name: string;
  verdict: LivePreflightVerdict;
  detail: string;
  data?: unknown;
}

/** Subset of `AdvancedTradeRestClient` the preflight needs beyond what `LiveAccountTruth` uses. */
export interface LivePreflightClient {
  getClockSkewSeconds(): Promise<number>;
  getKeyPermissions(): Promise<AtKeyPermissions>;
  previewOrder(body: AtPreviewOrderBody): Promise<AtPreviewResult>;
}

export interface LivePreflightInput {
  logger: Logger;
  client: LivePreflightClient;
  /** Account truth for the session; `refresh()` is invoked here (throws ⇒ FAIL). */
  truth: LiveAccountTruth;
  /** Spot symbols the engine will trade. */
  liveSymbols: string[];
  /** Perps symbols that would be active in the session (INTX check). Default none. */
  perpsSymbols?: string[];
  /** Value of COINBASE_API_VERSION (must be `advanced`). */
  apiVersion: string;
  /** `live.min_quote_usd` — minimum USD+USDC available. */
  minQuoteUsd: number;
  /** Clock skew FAIL threshold in seconds (default 30). */
  maxClockSkewSec?: number;
  /** Taker rate (decimal) at/above which the fee tier check WARNs (default 0.0075 = 75 bps). */
  highTakerFeeRate?: number;
}

export interface LivePreflightReport {
  ok: boolean;
  /** First FAIL detail(s), joined — the operator-facing error line. */
  error?: string;
  details?: Record<string, unknown>;
  warnings: string[];
  checks: LivePreflightCheck[];
  /** Snapshot summary (equity, tier, specs) so the dashboard can show what the session will use. */
  account: LiveAccountSummary | null;
}

const DEFAULT_MAX_CLOCK_SKEW_SEC = 30;
const CLOCK_SKEW_WARN_SEC = 5;
/** ≥ 75 bps/side: 15m strategies cannot clear this (Sprint 9 §5). */
const DEFAULT_HIGH_TAKER_FEE_RATE = 0.0075;
/** Entry price offset for the preview (1% below mark — a passive buy that cannot fill). */
const PREVIEW_ENTRY_OFFSET = '0.99';
/** Bracket take-profit / stop trigger offsets around the mark. */
const PREVIEW_TP_OFFSET = '1.02';
const PREVIEW_STOP_OFFSET = '0.98';
/** Notional buffer above quote_min_size so rounding never lands below the minimum. */
const PREVIEW_NOTIONAL_BUFFER = '1.05';

export const INTX_SYMBOL_PATTERN = /-PERP-INTX$/i;

/** True when a symbol is a Coinbase INTX perpetual (never allowed in live). */
export function isIntxSymbol(symbol: string): boolean {
  return INTX_SYMBOL_PATTERN.test(symbol.trim());
}

function bps(rate: number): string {
  return `${(rate * 10_000).toFixed(1)} bps`;
}

/**
 * Build the minimum-size limit BUY (+ attached `trigger_bracket_gtc`) used to validate the
 * order shape via `POST /orders/preview`. Pure; exported for tests.
 */
export function buildPreviewBody(spec: LiveProductSpec, markPrice: number): AtPreviewOrderBody {
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error(`Cannot build preview for ${spec.symbol}: mark price ${markPrice} is not positive`);
  }
  const limitPrice = decimalRoundToIncrement(decimalMul(markPrice, PREVIEW_ENTRY_OFFSET), spec.quoteIncrement, 'down');
  if (decimalCompare(limitPrice, '0') <= 0) {
    throw new Error(`Cannot build preview for ${spec.symbol}: limit price rounds to zero`);
  }
  const notionalTarget = decimalMul(spec.quoteMinSize || '0', PREVIEW_NOTIONAL_BUFFER);
  const sizeForNotional = decimalRoundToIncrement(decimalDiv(notionalTarget, limitPrice, 18), spec.baseIncrement, 'up');
  const baseSize = decimalCompare(sizeForNotional, spec.baseMinSize) > 0 ? sizeForNotional : spec.baseMinSize;
  const takeProfit = decimalRoundToIncrement(decimalMul(markPrice, PREVIEW_TP_OFFSET), spec.quoteIncrement, 'up');
  const stopTrigger = decimalRoundToIncrement(decimalMul(markPrice, PREVIEW_STOP_OFFSET), spec.quoteIncrement, 'down');
  return {
    product_id: spec.symbol,
    side: 'BUY',
    order_configuration: {
      limit_limit_gtc: { base_size: baseSize, limit_price: limitPrice, post_only: false },
    },
    attached_order_configuration: {
      trigger_bracket_gtc: { limit_price: takeProfit, stop_trigger_price: stopTrigger },
    },
  };
}

/**
 * Run every live preflight check and return a report. Never throws for check failures —
 * those become FAIL verdicts — so the caller can show the operator everything at once.
 */
export async function runLiveAccountPreflight(input: LivePreflightInput): Promise<LivePreflightReport> {
  const checks: LivePreflightCheck[] = [];
  const warnings: string[] = [];
  const maxSkew = input.maxClockSkewSec ?? DEFAULT_MAX_CLOCK_SKEW_SEC;
  const highTaker = input.highTakerFeeRate ?? DEFAULT_HIGH_TAKER_FEE_RATE;
  const liveSymbols = [...new Set(input.liveSymbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const perpsSymbols = [...new Set((input.perpsSymbols ?? []).map((s) => s.trim().toUpperCase()).filter(Boolean))];

  // 1. API flavour — static.
  const apiVersion = (input.apiVersion ?? '').trim().toLowerCase();
  checks.push({
    name: 'env.COINBASE_API_VERSION',
    verdict: apiVersion === 'advanced' ? 'PASS' : 'FAIL',
    detail:
      apiVersion === 'advanced'
        ? 'advanced (Advanced Trade / CDP keys)'
        : `"${apiVersion || 'exchange'}" — legacy Exchange API cannot authenticate CDP keys`,
  });

  // 2. No INTX perps in live — static.
  const intx = [...liveSymbols, ...perpsSymbols].filter(isIntxSymbol);
  checks.push({
    name: 'products.intx',
    verdict: intx.length === 0 ? 'PASS' : 'FAIL',
    detail:
      intx.length === 0
        ? 'no *-PERP-INTX symbols in the live session'
        : `${intx.join(', ')} — INTX perps are non-US and deprecated on Advanced Trade; remove from the live profile`,
    data: intx,
  });

  // 3. Clock skew — JWT nbf/exp window is 120 s.
  try {
    const skew = await input.client.getClockSkewSeconds();
    if (!Number.isFinite(skew)) throw new Error('server time unparseable');
    const verdict: LivePreflightVerdict = skew > maxSkew ? 'FAIL' : skew > CLOCK_SKEW_WARN_SEC ? 'WARN' : 'PASS';
    checks.push({ name: 'clock.skew', verdict, detail: `${skew.toFixed(2)}s vs Coinbase (FAIL > ${maxSkew}s)`, data: { skewSec: skew } });
    if (verdict === 'WARN') warnings.push(`Clock skew ${skew.toFixed(1)}s vs Coinbase (JWT window is 120s)`);
  } catch (error) {
    const e = describeError(error);
    checks.push({
      name: 'clock.skew',
      verdict: 'FAIL',
      detail: `could not measure clock skew (${[e.status, e.code, e.message].filter(Boolean).join(' ')})`,
      data: e,
    });
  }

  // 4. Key permissions — the JWT must authenticate; View+Trade only.
  let authed = false;
  try {
    const p = await input.client.getKeyPermissions();
    authed = true;
    checks.push({ name: 'auth.jwt', verdict: 'PASS', detail: 'ES256 JWT accepted' });
    checks.push({ name: 'key.can_view', verdict: p.can_view ? 'PASS' : 'FAIL', detail: String(p.can_view) });
    checks.push({
      name: 'key.can_trade',
      verdict: p.can_trade ? 'PASS' : 'FAIL',
      detail: p.can_trade ? 'true' : 'false — enable Trade on the CDP key (View+Trade, no Transfer)',
    });
    checks.push({
      name: 'key.can_transfer',
      verdict: p.can_transfer ? 'FAIL' : 'PASS',
      detail: p.can_transfer
        ? 'true — a trading bot key must NOT be able to move funds; recreate the key with View+Trade only'
        : 'false (good)',
    });
    if (p.portfolio_uuid) {
      checks.push({ name: 'key.portfolio', verdict: 'INFO', detail: `${p.portfolio_type ?? '?'} …${p.portfolio_uuid.slice(-6)}` });
    }
  } catch (error) {
    const e = describeError(error);
    checks.push({ name: 'auth.jwt', verdict: 'FAIL', detail: `key_permissions failed: HTTP ${e.status ?? '?'} ${e.code ?? ''} ${e.message}`.trim(), data: e });
  }

  // 5. Account truth — equity, fee tier, product specs from ONE snapshot.
  let snapshot: LiveAccountSnapshot | null = null;
  if (authed) {
    try {
      snapshot = await input.truth.refresh();
      checks.push({
        name: 'account.truth',
        verdict: 'PASS',
        detail: `snapshot @ ${new Date(snapshot.fetchedAt).toISOString()} — equity $${snapshot.equityUsd.toFixed(2)}`,
      });
    } catch (error) {
      const e = describeError(error);
      checks.push({
        name: 'account.truth',
        verdict: 'FAIL',
        detail: `could not build the live account snapshot (${[e.status, e.code, e.message].filter(Boolean).join(' ')}) — equity/fees/specs unknown, refusing to start`,
        data: e,
      });
    }
  } else {
    checks.push({ name: 'account.truth', verdict: 'FAIL', detail: 'skipped — key did not authenticate' });
  }

  if (snapshot) {
    // 5a. Equity.
    const quote = snapshot.quoteAvailableUsd;
    checks.push({
      name: 'account.equity',
      verdict: quote >= input.minQuoteUsd ? 'PASS' : 'FAIL',
      detail:
        `USD+USDC available $${quote.toFixed(2)} (hold $${snapshot.quoteHoldUsd.toFixed(2)}, equity $${snapshot.equityUsd.toFixed(2)})` +
        (quote >= input.minQuoteUsd ? '' : ` — below live.min_quote_usd $${input.minQuoteUsd}`),
      data: { quoteAvailableUsd: quote, quoteHoldUsd: snapshot.quoteHoldUsd, equityUsd: snapshot.equityUsd, minQuoteUsd: input.minQuoteUsd },
    });

    // 5b. Fee tier (unknown tiers already failed account.truth).
    const tier = snapshot.feeTier;
    const highFee = tier.takerRate >= highTaker;
    checks.push({
      name: 'fees.tier',
      verdict: highFee ? 'WARN' : 'INFO',
      detail: `${tier.name}: maker ${bps(tier.makerRate)} / taker ${bps(tier.takerRate)} · 30d volume $${tier.volume30dUsd.toFixed(2)}`,
      data: tier,
    });
    if (highFee) {
      warnings.push(`Fee tier ${tier.name} taker ${bps(tier.takerRate)} ≥ ${bps(highTaker)} — 15m strategies are negative-EV at this tier`);
    }

    // 5c. Products + 6. order-shape preview.
    for (const symbol of liveSymbols) {
      const spec = snapshot.products[symbol];
      if (!spec) {
        checks.push({ name: `product.${symbol}`, verdict: 'FAIL', detail: 'missing on Coinbase' });
        continue;
      }
      if (!spec.tradable) {
        checks.push({
          name: `product.${symbol}`,
          verdict: 'FAIL',
          detail: `not tradable (status=${spec.status}${spec.cancelOnly ? ', cancel_only' : ''})`,
          data: spec,
        });
        continue;
      }
      const modeNote = spec.limitOnly ? ' · LIMIT-ONLY' : spec.postOnly ? ' · POST-ONLY' : '';
      checks.push({
        name: `product.${symbol}`,
        verdict: modeNote ? 'WARN' : 'PASS',
        detail: `base_inc ${spec.baseIncrement} · quote_inc ${spec.quoteIncrement} · base_min ${spec.baseMinSize} · quote_min $${spec.quoteMinSize}${modeNote}`,
        data: spec,
      });
      if (modeNote) warnings.push(`${symbol} is ${spec.limitOnly ? 'LIMIT-ONLY' : 'POST-ONLY'} right now`);

      const mark = snapshot.marks[symbol]?.price;
      try {
        const body = buildPreviewBody(spec, mark ?? Number.NaN);
        const preview = await input.client.previewOrder(body);
        if (preview.errs.length > 0) {
          checks.push({
            name: `preview.${symbol}`,
            verdict: 'FAIL',
            detail: `POST /orders/preview returned errors: ${preview.errs.join(', ')}`,
            data: { body, errs: preview.errs, warning: preview.warning },
          });
        } else {
          checks.push({
            name: `preview.${symbol}`,
            verdict: 'PASS',
            detail:
              `min-size limit BUY ${body.order_configuration.limit_limit_gtc?.base_size} @ ${body.order_configuration.limit_limit_gtc?.limit_price} ` +
              `+ bracket OK · order_total $${preview.order_total} · commission $${preview.commission_total}` +
              (preview.warning.length ? ` · warnings: ${preview.warning.join(', ')}` : ''),
            data: { body, order_total: preview.order_total, commission_total: preview.commission_total, warning: preview.warning },
          });
        }
      } catch (error) {
        const e = describeError(error);
        checks.push({
          name: `preview.${symbol}`,
          verdict: 'FAIL',
          detail: `POST /orders/preview failed: ${[e.status, e.code, e.message].filter(Boolean).join(' ')}`,
          data: e,
        });
      }
    }
  }

  const fails = checks.filter((c) => c.verdict === 'FAIL');
  const ok = fails.length === 0;
  const report: LivePreflightReport = {
    ok,
    warnings,
    checks,
    account: input.truth.getSummary(),
  };
  if (!ok) {
    report.error = `Live preflight failed: ${fails.map((c) => `${c.name}: ${c.detail}`).join('; ')}`;
    report.details = { failed: fails.map((c) => ({ name: c.name, detail: c.detail, data: c.data })) };
  }

  input.logger.info('Live preflight complete', {
    ok,
    fails: fails.map((c) => c.name),
    warnings: warnings.length,
    equityUsd: snapshot?.equityUsd,
    feeTier: snapshot ? `${snapshot.feeTier.name} ${snapshot.feeTier.makerBps}/${snapshot.feeTier.takerBps} bps` : undefined,
  });
  return report;
}
