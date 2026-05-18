/**
 * Hyperliquid Adapter Initialization & Kill-Switch
 *
 * Single source of truth for wiring the Hyperliquid adapter into the runtime.
 * Both the YAML guardrails block AND the env var must explicitly opt-in before
 * the adapter is initialized — see `KILL SWITCH` below.
 *
 * Behavior:
 *   - DISABLED (default): adapter is constructed and registered into ExchangeRegistry
 *     so callers can introspect it, but `.initialize()` is NEVER called. Any caller
 *     who tries to use it will hit the "not connected" guard inside the adapter.
 *   - ENABLED: adapter is constructed, registered, and `.initialize()` is called.
 *     If initialization fails (network, bad creds), we log the error and return
 *     `null` — engine startup MUST NOT crash because of HL.
 *
 * Scope (this module is plumbing only):
 *   - We do NOT change Coinbase routing.
 *   - We do NOT route any signals to HL — until paper-mode HL is implemented,
 *     HL-targeted signals continue to flow through the existing perps simulator
 *     path. A follow-up PR will wire actual symbol→adapter routing.
 *   - We do NOT touch real-money order paths. Even when HYPERLIQUID_ENABLED=true,
 *     no live HL orders can be placed via this adapter from the engine until
 *     signal routing is wired in a separate PR.
 *
 * Security:
 *   - HL credentials (private key, wallet) are read from env only and are
 *     never logged. Only their presence is logged.
 */

import type { Logger } from '../core/logger';
import type { Env } from '../core/env';
import type { GuardrailConfig } from '../config/loadGuardrails';
import type { FeeModel } from '../core/fee-model';
import { ExchangeRegistry } from './exchange-registry';
import { HyperliquidAdapter } from './hyperliquid';

export interface HyperliquidInitDeps {
  logger: Logger;
  registry: ExchangeRegistry;
  guardrails: GuardrailConfig;
  env: Env;
  /** FeeModel built from the same guardrails block — single source of truth. */
  feeModel: FeeModel;
  /** Bypass network init (used by tests / read-only smoke checks). */
  skipInitialize?: boolean;
}

export interface HyperliquidInitResult {
  /** The constructed adapter, or null if construction was skipped. */
  adapter: HyperliquidAdapter | null;
  /** Whether the kill-switch evaluated to enabled. */
  enabled: boolean;
  /** Whether `.initialize()` was actually called and resolved successfully. */
  initialized: boolean;
  /** Human-readable status line (logged on startup). */
  status: 'ready' | 'skipped:disabled' | 'skipped:init_failed' | 'skipped:no_block';
}

/**
 * KILL SWITCH:
 *   guardrails.hyperliquid.enabled === true  AND  env.HYPERLIQUID_ENABLED === 'true'
 *
 * If either is false/missing, the adapter is registered as inert.
 */
export function isHyperliquidEnabled(
  guardrails: GuardrailConfig,
  env: Env,
): { enabled: boolean; reason: string } {
  if (!guardrails.hyperliquid) {
    return { enabled: false, reason: 'no hyperliquid block in guardrails.yaml' };
  }
  if (guardrails.hyperliquid.enabled !== true) {
    return { enabled: false, reason: 'guardrails.hyperliquid.enabled=false' };
  }
  if (env.HYPERLIQUID_ENABLED !== 'true') {
    return { enabled: false, reason: 'HYPERLIQUID_ENABLED env var not set to "true"' };
  }
  return { enabled: true, reason: 'kill-switch open' };
}

/**
 * Initialize the Hyperliquid adapter and register it in the provided registry.
 *
 * This function is intentionally non-throwing — failures during HL init must NOT
 * abort engine startup. Returns the result so the caller can decide what to do.
 */
export async function initHyperliquidAdapter(
  deps: HyperliquidInitDeps,
): Promise<HyperliquidInitResult> {
  const { logger, registry, guardrails, env, feeModel, skipInitialize } = deps;

  // Resolve testnet: env override (HYPERLIQUID_TESTNET) wins over YAML; default true.
  const yamlBlock = guardrails.hyperliquid;
  const testnetFromEnv = env.HYPERLIQUID_TESTNET;
  const testnet =
    testnetFromEnv === 'true' ? true :
    testnetFromEnv === 'false' ? false :
    yamlBlock?.testnet ?? true;

  const configuredSymbols = guardrails.hyperliquid_symbols
    ? Object.keys(guardrails.hyperliquid_symbols)
    : [];

  const { enabled, reason } = isHyperliquidEnabled(guardrails, env);

  if (!yamlBlock) {
    logger.info('Hyperliquid adapter: skipped (no `hyperliquid:` block in guardrails.yaml)');
    return { adapter: null, enabled: false, initialized: false, status: 'skipped:no_block' };
  }

  // Always construct + register the adapter so the registry is consistent and
  // introspectable, regardless of enabled state.
  const adapter = new HyperliquidAdapter(logger, feeModel, {
    testnet,
    privateKey: env.HYPERLIQUID_PRIVATE_KEY,
    walletAddress: env.HYPERLIQUID_WALLET_ADDRESS,
  });

  try {
    registry.register(adapter);
  } catch (err) {
    // Already-registered is the only realistic error here. Log and continue with
    // the existing instance from the registry — but in this codepath we're the
    // single registration site, so this is treated as a programmer error.
    logger.warn('Hyperliquid adapter: registry.register() rejected', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const baseLogPayload = {
    enabled,
    reason,
    testnet,
    network: testnet ? 'testnet' : 'mainnet',
    configuredSymbols,
    hasPrivateKey: !!env.HYPERLIQUID_PRIVATE_KEY,
    hasWalletAddress: !!env.HYPERLIQUID_WALLET_ADDRESS,
  };

  if (!enabled) {
    logger.info(
      `Hyperliquid adapter: registered but INERT (kill-switch closed: ${reason}). ` +
      `No HL orders, subscriptions, or routing will occur. Set guardrails.hyperliquid.enabled=true ` +
      `AND HYPERLIQUID_ENABLED=true to activate.`,
      baseLogPayload,
    );
    return { adapter, enabled: false, initialized: false, status: 'skipped:disabled' };
  }

  if (skipInitialize) {
    logger.info('Hyperliquid adapter: enabled but initialize() skipped by caller', baseLogPayload);
    return { adapter, enabled: true, initialized: false, status: 'ready' };
  }

  // Loud warning — this PR registers the adapter but does NOT wire signal routing
  // to it. Until that follow-up lands, any "HL-targeted" signal still flows through
  // the existing paper-perps simulator (which mirrors spot tickers — a known issue).
  logger.warn(
    'Hyperliquid adapter ENABLED — connecting now. NOTE: signal routing to HL is ' +
    'NOT wired in this PR. HL-targeted signals are still simulated via the perps ' +
    'paper path until the routing PR lands. No real HL orders will be placed.',
    baseLogPayload,
  );

  try {
    await adapter.initialize({
      privateKey: env.HYPERLIQUID_PRIVATE_KEY ?? '',
      walletAddress: env.HYPERLIQUID_WALLET_ADDRESS ?? '',
    });
    logger.info('Hyperliquid adapter: ready', {
      ...baseLogPayload,
      connected: adapter.isConnected(),
    });
    return { adapter, enabled: true, initialized: true, status: 'ready' };
  } catch (err) {
    logger.error('Hyperliquid adapter: initialize() failed — leaving adapter inert', {
      ...baseLogPayload,
      error: err instanceof Error ? err.message : String(err),
    });
    return { adapter, enabled: true, initialized: false, status: 'skipped:init_failed' };
  }
}
