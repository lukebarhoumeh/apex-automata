/**
 * Coinbase Advanced Trade user WebSocket (`wss://advanced-trade-ws-user.coinbase.com`).
 *
 * Primary source of order/fill truth for the live execution adapter:
 * - subscribes to the `user` channel (all of the account's orders) and the
 *   `heartbeats` channel (keeps the socket alive, gives us a staleness signal);
 * - mints a FRESH JWT for every subscribe message (tokens expire after 120s and
 *   WebSocket JWTs carry no `uri` claim);
 * - reconnects with exponential backoff + jitter and emits `reconnected` so the
 *   adapter can reconcile via REST before trusting the stream again;
 * - flags itself `degraded` (`USER_STREAM_STALE`) when no message arrives for
 *   more than `staleAfterMs` (15s by default) and forces a reconnect past 2x that.
 *
 * The stream is a faithful relay: it normalises the wire shape into
 * `UserStreamOrderUpdate` and leaves fill-delta accounting to the adapter.
 *
 * NEVER logs JWTs or key material. Only `{code, message}`-style fields are logged.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import { Logger } from '../../core/logger';
import {
  AdvancedTradeAuth,
  AtOrderStatus,
  loadAdvancedTradeAuth,
  signAdvancedTradeJwt,
} from './advanced-trade-client';

export const ADVANCED_TRADE_USER_WS_URL = 'wss://advanced-trade-ws-user.coinbase.com';

/** Coinbase disconnects sockets that do not subscribe within 5 seconds. */
const SUBSCRIBE_DEADLINE_MS = 5_000;
const DEFAULT_STALE_AFTER_MS = 15_000;
const DEFAULT_STALE_CHECK_MS = 2_500;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/** Minimal socket surface so tests can inject a fake instead of mocking `ws`. */
export interface WsLike {
  readyState: number;
  on(event: 'open', listener: () => void): unknown;
  on(event: 'message', listener: (data: unknown) => void): unknown;
  on(event: 'close', listener: (code: number, reason?: unknown) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  removeAllListeners?(): unknown;
}

export interface AdvancedTradeUserStreamConfig {
  logger: Logger;
  /** Either pass raw credentials... */
  apiKey?: string;
  apiSecret?: string;
  /** ...or an already-parsed auth object (e.g. from `AdvancedTradeRestClient.getAuth()`). */
  auth?: AdvancedTradeAuth;
  /** Restrict the `user` channel to these products (omit for all). */
  productIds?: string[];
  url?: string;
  /** Socket factory (tests). Defaults to `new WebSocket(url)` from `ws`. */
  wsFactory?: (url: string) => WsLike;
  /** No message for this long ⇒ degraded (default 15 000 ms). */
  staleAfterMs?: number;
  /** How often to evaluate staleness (default 2 500 ms). */
  staleCheckIntervalMs?: number;
  reconnect?: {
    baseDelayMs?: number;
    maxDelayMs?: number;
    /** `null` = unlimited (default). */
    maxAttempts?: number | null;
  };
  /** Clock + RNG hooks for deterministic tests. */
  now?: () => number;
  random?: () => number;
}

/** Normalised `user` channel order record. All amounts are decimal strings. */
export interface UserStreamOrderUpdate {
  orderId: string;
  clientOrderId: string;
  productId: string;
  status: AtOrderStatus | string;
  side: 'buy' | 'sell';
  orderType: string;
  cumulativeQuantity: string;
  leavesQuantity: string;
  avgPrice: string;
  totalFees: string;
  filledValue?: string;
  limitPrice?: string;
  stopPrice?: string;
  postOnly: boolean;
  rejectReason?: string;
  cancelReason?: string;
  creationTime: string;
  eventType: 'snapshot' | 'update' | string;
  sequenceNum: number;
  timestamp: string;
  raw: unknown;
}

export interface UserStreamHealth {
  connected: boolean;
  reconnecting: boolean;
  reconnectAttempts: number;
  totalReconnects: number;
  lastMessageAt: number | null;
  lastHeartbeatAt: number | null;
  messageAgeMs: number | null;
  stale: boolean;
  degraded: boolean;
  reasonCodes: string[];
}

export const USER_STREAM_STALE = 'USER_STREAM_STALE';
export const USER_STREAM_DISCONNECTED = 'USER_STREAM_DISCONNECTED';

interface UserChannelOrderWire {
  order_id?: string;
  client_order_id?: string;
  product_id?: string;
  status?: string;
  order_side?: string;
  order_type?: string;
  cumulative_quantity?: string;
  leaves_quantity?: string;
  avg_price?: string;
  total_fees?: string;
  filled_value?: string;
  limit_price?: string;
  stop_price?: string;
  post_only?: string | boolean;
  reject_reason?: string;
  cancel_reason?: string;
  creation_time?: string;
}

interface WireMessage {
  type?: string;
  channel?: string;
  message?: string;
  sequence_num?: number;
  timestamp?: string;
  events?: Array<{ type?: string; orders?: UserChannelOrderWire[]; heartbeat_counter?: string; current_time?: string }>;
}

/**
 * Authenticated user-order stream with reconnect + staleness detection.
 *
 * Events:
 * - `order` (UserStreamOrderUpdate)      one per order record in a `user` message
 * - `snapshot` (UserStreamOrderUpdate[]) the initial snapshot after (re)subscribe
 * - `heartbeat` (counter: string)
 * - `connected` / `disconnected` / `reconnecting` (attempt, delayMs) / `reconnected`
 * - `stale` (ageMs) / `healthy`
 * - `error` (Error) — sanitised, never contains tokens
 */
export class AdvancedTradeUserStream extends EventEmitter {
  private readonly logger: Logger;
  private readonly auth: AdvancedTradeAuth;
  private readonly productIds: string[] | undefined;
  private readonly url: string;
  private readonly wsFactory: (url: string) => WsLike;
  private readonly staleAfterMs: number;
  private readonly staleCheckIntervalMs: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number | null;
  private readonly now: () => number;
  private readonly random: () => number;

  private ws: WsLike | null = null;
  private running = false;
  private connected = false;
  private everConnected = false;
  private reconnecting = false;
  private reconnectAttempts = 0;
  private totalReconnects = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private lastMessageAt: number | null = null;
  private lastHeartbeatAt: number | null = null;
  private stale = false;
  private lastSequenceNum: number | null = null;

  constructor(config: AdvancedTradeUserStreamConfig) {
    super();
    this.logger = config.logger;
    this.auth = config.auth ?? loadAdvancedTradeAuth(config.apiKey ?? '', config.apiSecret ?? '');
    this.productIds = config.productIds && config.productIds.length > 0 ? [...config.productIds] : undefined;
    this.url = config.url ?? ADVANCED_TRADE_USER_WS_URL;
    this.wsFactory = config.wsFactory ?? ((url) => new WebSocket(url) as unknown as WsLike);
    this.staleAfterMs = config.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.staleCheckIntervalMs = config.staleCheckIntervalMs ?? DEFAULT_STALE_CHECK_MS;
    this.baseDelayMs = config.reconnect?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = config.reconnect?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxAttempts = config.reconnect?.maxAttempts === undefined ? null : config.reconnect.maxAttempts;
    this.now = config.now ?? (() => Date.now());
    this.random = config.random ?? Math.random;
  }

  /** Open the socket and start staleness monitoring. Idempotent. */
  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.openSocket();
    this.staleTimer = setInterval(() => this.checkStaleness(), this.staleCheckIntervalMs);
  }

  /** Close the socket and stop all timers. Idempotent. */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    this.teardownSocket(1000, 'client stop');
    this.connected = false;
    this.reconnecting = false;
  }

  /** Health snapshot for the adapter / supervisor. */
  public getHealth(): UserStreamHealth {
    const messageAgeMs = this.lastMessageAt === null ? null : this.now() - this.lastMessageAt;
    const reasonCodes: string[] = [];
    if (this.running && !this.connected) reasonCodes.push(USER_STREAM_DISCONNECTED);
    if (this.stale) reasonCodes.push(USER_STREAM_STALE);
    return {
      connected: this.connected,
      reconnecting: this.reconnecting,
      reconnectAttempts: this.reconnectAttempts,
      totalReconnects: this.totalReconnects,
      lastMessageAt: this.lastMessageAt,
      lastHeartbeatAt: this.lastHeartbeatAt,
      messageAgeMs,
      stale: this.stale,
      degraded: reasonCodes.length > 0,
      reasonCodes,
    };
  }

  /**
   * Feed a raw wire message (string/Buffer/object). Public so tests and replay
   * tooling can drive the parser without a socket.
   */
  public ingest(data: unknown): void {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;
    let message: WireMessage;
    try {
      message = (text !== null ? JSON.parse(text) : data) as WireMessage;
    } catch {
      this.logger.warn('User stream: unparseable message ignored');
      return;
    }
    if (!message || typeof message !== 'object') return;

    this.lastMessageAt = this.now();
    if (this.stale) {
      this.stale = false;
      this.emit('healthy');
    }

    if (message.type === 'error') {
      const detail = typeof message.message === 'string' ? message.message : 'unknown error';
      this.logger.error('User stream: server error', { message: detail });
      this.emitError(new Error(`Advanced Trade user stream error: ${detail}`));
      if (/auth/i.test(detail)) {
        // Auth failures are not transient — close so the backoff path re-mints a JWT.
        this.teardownSocket(4001, 'authentication failure');
        this.handleClose(4001);
      }
      return;
    }

    if (typeof message.sequence_num === 'number') {
      if (this.lastSequenceNum !== null && message.sequence_num > this.lastSequenceNum + 1) {
        this.logger.warn('User stream: sequence gap detected', {
          expected: this.lastSequenceNum + 1,
          received: message.sequence_num,
        });
        this.emit('gap', { expected: this.lastSequenceNum + 1, received: message.sequence_num });
      }
      this.lastSequenceNum = message.sequence_num;
    }

    switch (message.channel) {
      case 'heartbeats': {
        this.lastHeartbeatAt = this.lastMessageAt;
        const counter = message.events?.[0]?.heartbeat_counter;
        this.emit('heartbeat', counter ?? '');
        return;
      }
      case 'user': {
        this.handleUserMessage(message);
        return;
      }
      case 'subscriptions': {
        this.logger.debug('User stream: subscriptions acknowledged');
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ socket

  private openSocket(): void {
    if (!this.running) return;
    let ws: WsLike;
    try {
      ws = this.wsFactory(this.url);
    } catch (error) {
      this.logger.error('User stream: failed to create socket', {
        message: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.reconnecting = false;
      const wasReconnect = this.everConnected;
      this.everConnected = true;
      this.reconnectAttempts = 0;
      this.lastMessageAt = this.now();
      this.lastSequenceNum = null;
      this.subscribe(ws);
      this.logger.info('User stream connected', { url: this.url, reconnect: wasReconnect });
      this.emit('connected');
      if (wasReconnect) {
        this.totalReconnects += 1;
        this.emit('reconnected');
      }
    });

    ws.on('message', (data: unknown) => {
      if (this.ws !== ws) return;
      this.ingest(data);
    });

    ws.on('close', (code: number) => {
      if (this.ws !== ws) return;
      this.handleClose(code);
    });

    ws.on('error', (error: Error) => {
      if (this.ws !== ws) return;
      this.logger.warn('User stream socket error', { message: error?.message ?? String(error) });
      this.emitError(new Error(`Advanced Trade user stream socket error: ${error?.message ?? 'unknown'}`));
    });
  }

  /** Node throws on unhandled `error` events; the stream must never take the process down. */
  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }

  /** Send `user` + `heartbeats` subscriptions, each with a freshly minted JWT. */
  private subscribe(ws: WsLike): void {
    const messages: Array<Record<string, unknown>> = [
      {
        type: 'subscribe',
        channel: 'user',
        ...(this.productIds ? { product_ids: this.productIds } : {}),
        jwt: signAdvancedTradeJwt(this.auth),
      },
      { type: 'subscribe', channel: 'heartbeats', jwt: signAdvancedTradeJwt(this.auth) },
    ];
    for (const message of messages) {
      try {
        ws.send(JSON.stringify(message), (error?: Error) => {
          if (error) {
            this.logger.warn('User stream: subscribe send failed', { channel: message.channel, message: error.message });
          }
        });
      } catch (error) {
        this.logger.warn('User stream: subscribe threw', {
          channel: message.channel,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private handleClose(code: number): void {
    const wasConnected = this.connected;
    this.connected = false;
    this.ws = null;
    if (wasConnected) {
      this.logger.warn('User stream disconnected', { code });
      this.emit('disconnected', code);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    if (this.maxAttempts !== null && this.reconnectAttempts >= this.maxAttempts) {
      this.logger.error('User stream: reconnect attempts exhausted', { attempts: this.reconnectAttempts });
      this.emit('exhausted', this.reconnectAttempts);
      return;
    }
    this.reconnecting = true;
    const attempt = this.reconnectAttempts + 1;
    const exponential = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    const jitter = 0.5 + this.random(); // 0.5x .. 1.5x
    const delayMs = Math.round(exponential * jitter);
    this.reconnectAttempts = attempt;
    this.emit('reconnecting', attempt, delayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delayMs);
  }

  private teardownSocket(code: number, reason: string): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      ws.close(code, reason);
    } catch {
      try {
        ws.terminate?.();
      } catch {
        // socket already gone
      }
    }
    ws.removeAllListeners?.();
  }

  private checkStaleness(): void {
    if (!this.running || !this.connected || this.lastMessageAt === null) return;
    const age = this.now() - this.lastMessageAt;
    if (age > this.staleAfterMs && !this.stale) {
      this.stale = true;
      this.logger.warn('User stream stale — no messages received', { ageMs: age, thresholdMs: this.staleAfterMs });
      this.emit('stale', age);
    }
    if (age > this.staleAfterMs * 2) {
      this.logger.warn('User stream stale beyond 2x threshold — forcing reconnect', { ageMs: age });
      this.teardownSocket(4000, 'stale');
      this.handleClose(4000);
    }
  }

  // ------------------------------------------------------------------ parsing

  private handleUserMessage(message: WireMessage): void {
    const updates: UserStreamOrderUpdate[] = [];
    for (const event of message.events ?? []) {
      for (const order of event.orders ?? []) {
        const update = normaliseOrder(order, event.type ?? 'update', message);
        if (update) updates.push(update);
      }
      if (event.type === 'snapshot') {
        this.emit('snapshot', updates.filter((u) => u.eventType === 'snapshot'));
      }
    }
    for (const update of updates) {
      this.emit('order', update);
    }
  }
}

/** Normalise a `user` channel order into the adapter-facing shape. Returns null for unusable rows. */
export function normaliseOrder(
  order: UserChannelOrderWire,
  eventType: string,
  envelope: { sequence_num?: number; timestamp?: string },
): UserStreamOrderUpdate | null {
  if (!order.order_id) return null;
  return {
    orderId: order.order_id,
    clientOrderId: order.client_order_id ?? '',
    productId: order.product_id ?? '',
    status: (order.status ?? 'UNKNOWN_ORDER_STATUS').toUpperCase(),
    side: (order.order_side ?? '').toUpperCase() === 'SELL' ? 'sell' : 'buy',
    orderType: order.order_type ?? '',
    cumulativeQuantity: order.cumulative_quantity || '0',
    leavesQuantity: order.leaves_quantity || '0',
    avgPrice: order.avg_price || '0',
    totalFees: order.total_fees || '0',
    filledValue: order.filled_value || undefined,
    limitPrice: order.limit_price || undefined,
    stopPrice: order.stop_price || undefined,
    postOnly: order.post_only === true || order.post_only === 'true',
    rejectReason: order.reject_reason || undefined,
    cancelReason: order.cancel_reason || undefined,
    creationTime: order.creation_time ?? '',
    eventType,
    sequenceNum: envelope.sequence_num ?? 0,
    timestamp: envelope.timestamp ?? '',
    raw: order,
  };
}
