/**
 * Sprint 9 / Stage 0 live gate — LIVE_STAGE0_INCOMPLETE.
 *
 * Uses the REAL gate module (no mocks): while `LIVE_STAGE0_COMPLETE` is `false`,
 * `createAdapters()` must refuse live before running any other live check, and
 * paper must be untouched. Nothing here touches the network or places orders.
 *
 * `coinbase-advanced-adapter.test.ts` mocks the gate as complete so the TASK_010
 * CDP/credential checks and adapter wiring stay covered; this file owns the gate itself.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { Logger } from '../core/logger';
import { FeeModel } from '../core/fee-model';
import type { FeesConfig } from '../config/loadGuardrails';
import {
  LIVE_STAGE0_COMPLETE,
  LIVE_STAGE0_INCOMPLETE,
  LIVE_STAGE0_REQUIRED_TASKS,
  assertLiveStage0Complete,
  isLiveStage0Complete,
} from '../trading/execution/live-stage0-gate';
import {
  createAdapters,
  LIVE_CREDENTIALS_MISSING,
  LIVE_REQUIRES_ADVANCED_TRADE,
  LIVE_STAGE0_INCOMPLETE as REEXPORTED_LIVE_STAGE0_INCOMPLETE,
  RuntimeConfig,
} from '../trading/execution/adapter-factory';
import { PaperExecutionAdapter } from '../trading/execution/paper-adapter';
import { PaperAccountProvider } from '../trading/account/account-provider';

const TEST_FEES: FeesConfig = {
  coinbase: {
    spot: { maker_bps: 25, taker_bps: 40 },
    perps_intx: { maker_bps: 0, taker_bps: 5 },
  },
  hyperliquid: { perps: { maker_bps: -1.5, taker_bps: 4.5 } },
};
const feeModel = new FeeModel(TEST_FEES);

const KEY_NAME = 'organizations/11111111-1111-1111-1111-111111111111/apiKeys/22222222-2222-2222-2222-222222222222';
const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const PRIVATE_PEM = privateKey.export({ type: 'sec1', format: 'pem' }) as string;

function stubLogger(): Logger & { info: ReturnType<typeof vi.fn> } {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function liveConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    executionMode: 'live',
    marketDataEnv: 'production',
    executionEnv: 'production',
    paperInitialEquityUsd: 0,
    feeModel,
    ...overrides,
  };
}

/** Any property access on this object fails the test: proves the live branch never runs past the gate. */
function untouchable<T extends object>(label: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      throw new Error(`${label}.${String(prop)} was accessed while Stage 0 is incomplete`);
    },
  });
}

const fakeExchange = {} as any;
const STAGE0_RE = new RegExp(`^${LIVE_STAGE0_INCOMPLETE}:`);

describe('live-stage0-gate — constant and assertion', () => {
  it('Stage 0 is incomplete by default (constant stays false in this PR)', () => {
    expect(LIVE_STAGE0_COMPLETE).toBe(false);
    expect(isLiveStage0Complete()).toBe(false);
  });

  it('assertLiveStage0Complete throws LIVE_STAGE0_INCOMPLETE naming TASK_011–016 and the verifier', () => {
    expect(() => assertLiveStage0Complete()).toThrow(STAGE0_RE);
    let message = '';
    try {
      assertLiveStage0Complete();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('TASK_011–TASK_016');
    expect(message).toContain('verify_sprint9.cjs');
    expect(message).toContain('Paper mode is unaffected');
  });

  it('required task list is exactly TASK_011 … TASK_016', () => {
    expect([...LIVE_STAGE0_REQUIRED_TASKS]).toEqual([
      'TASK_011',
      'TASK_012',
      'TASK_013',
      'TASK_014',
      'TASK_015',
      'TASK_016',
    ]);
  });

  it('adapter-factory re-exports the same error code', () => {
    expect(REEXPORTED_LIVE_STAGE0_INCOMPLETE).toBe(LIVE_STAGE0_INCOMPLETE);
  });
});

describe('createAdapters — live is refused with LIVE_STAGE0_INCOMPLETE', () => {
  const ENV_KEYS = ['LIVE_STAGE0_COMPLETE', 'CONFIRM_LIVE', 'EXECUTION_MODE'] as const;
  const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (!(key in savedEnv)) continue;
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
      delete savedEnv[key];
    }
  });

  it('refuses live even with COINBASE_API_VERSION=advanced, well-formed CDP credentials and injected collaborators', () => {
    const logger = stubLogger();
    expect(() =>
      createAdapters(
        liveConfig({
          coinbaseApiVersion: 'advanced',
          liveCredentials: { apiKey: KEY_NAME, apiSecret: PRIVATE_PEM },
          liveSymbols: ['ETH-USD'],
        }),
        fakeExchange,
        logger,
        { advancedTradeClient: untouchable('advancedTradeClient'), userStream: null },
      ),
    ).toThrow(STAGE0_RE);
    // Nothing on the live branch ran: no adapter log line, no client access.
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('is checked before the Advanced Trade gate (live + exchange keys => Stage 0, not LIVE_REQUIRES_ADVANCED_TRADE)', () => {
    let message = '';
    try {
      createAdapters(liveConfig({ coinbaseApiVersion: 'exchange' }), fakeExchange, stubLogger());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(STAGE0_RE);
    expect(message).not.toContain(LIVE_REQUIRES_ADVANCED_TRADE);
  });

  it('is checked before the credential gate (live + advanced, no creds => Stage 0, not LIVE_CREDENTIALS_MISSING)', () => {
    let message = '';
    try {
      createAdapters(liveConfig({ coinbaseApiVersion: 'advanced' }), fakeExchange, stubLogger());
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(STAGE0_RE);
    expect(message).not.toContain(LIVE_CREDENTIALS_MISSING);
  });

  it('cannot be opened from the environment (no env var or CONFIRM_LIVE bypass)', () => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    process.env.LIVE_STAGE0_COMPLETE = 'true';
    process.env.CONFIRM_LIVE = 'YES';
    process.env.EXECUTION_MODE = 'live';

    expect(isLiveStage0Complete()).toBe(false);
    expect(() =>
      createAdapters(
        liveConfig({ coinbaseApiVersion: 'advanced', liveCredentials: { apiKey: KEY_NAME, apiSecret: PRIVATE_PEM } }),
        fakeExchange,
        stubLogger(),
        { advancedTradeClient: untouchable('advancedTradeClient'), userStream: null },
      ),
    ).toThrow(STAGE0_RE);
  });
});

describe('createAdapters — paper is unaffected by the Stage-0 gate', () => {
  it('builds PaperExecutionAdapter + PaperAccountProvider exactly as before', () => {
    const logger = stubLogger();
    const { executionAdapter, accountProvider } = createAdapters(
      {
        executionMode: 'paper',
        marketDataEnv: 'production',
        executionEnv: 'production',
        paperInitialEquityUsd: 50_000,
        feeModel,
      },
      fakeExchange,
      logger,
    );
    expect(executionAdapter).toBeInstanceOf(PaperExecutionAdapter);
    expect(executionAdapter.mode).toBe('paper');
    expect(accountProvider).toBeInstanceOf(PaperAccountProvider);
    expect(logger.info).toHaveBeenCalledWith(
      'Creating paper execution adapter and account provider',
      expect.objectContaining({ initialEquityUsd: 50_000, marketDataEnv: 'production' }),
    );
  });

  it('paper ignores live-only fields (api version / credentials) without consulting the gate', () => {
    const { executionAdapter } = createAdapters(
      {
        executionMode: 'paper',
        marketDataEnv: 'sandbox',
        executionEnv: 'production',
        paperInitialEquityUsd: 10_000,
        feeModel,
        coinbaseApiVersion: 'advanced',
        liveCredentials: { apiKey: KEY_NAME, apiSecret: PRIVATE_PEM },
      },
      fakeExchange,
      stubLogger(),
      { advancedTradeClient: untouchable('advancedTradeClient'), userStream: null },
    );
    expect(executionAdapter).toBeInstanceOf(PaperExecutionAdapter);
  });
});
