/**
 * Coinbase API Error Taxonomy
 * 
 * Provides structured error classification for all Coinbase API interactions.
 * Enables intelligent retry decisions and proper error handling throughout the system.
 */

/**
 * Error kinds for classification
 */
export type CoinbaseErrorKind = 
  | 'timeout'       // Request timed out
  | 'network'       // Network-level error (DNS, connection refused, etc.)
  | 'rate_limit'    // 429 - Rate limited
  | 'server'        // 5xx - Server error
  | 'auth'          // 401/403 - Authentication/authorization error
  | 'bad_request'   // 4xx (except 401/403/408/429) - Client error
  | 'post_only'     // Post-only order would have been taker
  | 'insufficient_funds' // Not enough balance
  | 'order_rejected'     // Order rejected for business reasons
  | 'not_found'     // 404 - Resource not found
  | 'unknown';      // Unknown error

/**
 * Base error class for all Coinbase-related errors
 */
export class CoinbaseError extends Error {
  public readonly kind: CoinbaseErrorKind;
  public readonly retryable: boolean;
  public readonly timestamp: number;
  
  constructor(
    kind: CoinbaseErrorKind,
    message: string,
    retryable: boolean = false
  ) {
    super(message);
    this.name = 'CoinbaseError';
    this.kind = kind;
    this.retryable = retryable;
    this.timestamp = Date.now();
  }
}

/**
 * API error from Coinbase REST endpoints
 */
export class CoinbaseApiError extends CoinbaseError {
  public readonly httpStatus: number;
  public readonly coinbaseCode?: string;
  public readonly coinbaseMessage?: string;
  public readonly requestId?: string;
  public readonly route?: string;
  public readonly method?: string;
  public readonly retryAfterMs?: number;

  constructor(options: {
    kind: CoinbaseErrorKind;
    message: string;
    httpStatus: number;
    coinbaseCode?: string;
    coinbaseMessage?: string;
    requestId?: string;
    route?: string;
    method?: string;
    retryable?: boolean;
    retryAfterMs?: number;
  }) {
    super(options.kind, options.message, options.retryable ?? false);
    this.name = 'CoinbaseApiError';
    this.httpStatus = options.httpStatus;
    this.coinbaseCode = options.coinbaseCode;
    this.coinbaseMessage = options.coinbaseMessage;
    this.requestId = options.requestId;
    this.route = options.route;
    this.method = options.method;
    this.retryAfterMs = options.retryAfterMs;
  }

  /**
   * Create from an axios-style error response
   */
  static fromResponse(
    response: { status: number; data?: any; headers?: Record<string, string> },
    route?: string,
    method?: string
  ): CoinbaseApiError {
    const { status, data, headers } = response;
    const { kind, retryable, retryAfterMs } = classifyHttpStatus(status, data, headers);
    
    const coinbaseCode = data?.id || data?.code || data?.error_code;
    const coinbaseMessage = data?.message || data?.error || data?.msg;
    const requestId = headers?.['x-request-id'] || headers?.['x-correlation-id'];

    return new CoinbaseApiError({
      kind,
      message: coinbaseMessage || `HTTP ${status} error`,
      httpStatus: status,
      coinbaseCode,
      coinbaseMessage,
      requestId,
      route,
      method,
      retryable,
      retryAfterMs,
    });
  }

  /**
   * Serialize for logging
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      httpStatus: this.httpStatus,
      coinbaseCode: this.coinbaseCode,
      coinbaseMessage: this.coinbaseMessage,
      requestId: this.requestId,
      route: this.route,
      method: this.method,
      retryable: this.retryable,
      retryAfterMs: this.retryAfterMs,
      timestamp: this.timestamp,
    };
  }
}

/**
 * Network-level error (timeout, connection refused, DNS failure, etc.)
 */
export class CoinbaseNetworkError extends CoinbaseError {
  public readonly originalError?: Error;
  public readonly code?: string;
  public readonly route?: string;
  public readonly method?: string;

  constructor(options: {
    kind: 'timeout' | 'network';
    message: string;
    originalError?: Error;
    code?: string;
    route?: string;
    method?: string;
  }) {
    // Network errors are always retryable
    super(options.kind, options.message, true);
    this.name = 'CoinbaseNetworkError';
    this.originalError = options.originalError;
    this.code = options.code;
    this.route = options.route;
    this.method = options.method;
  }

  /**
   * Create from an axios-style error
   */
  static fromAxiosError(
    error: any,
    route?: string,
    method?: string
  ): CoinbaseNetworkError {
    const isTimeout = error.code === 'ECONNABORTED' || 
                      error.code === 'ETIMEDOUT' ||
                      error.message?.includes('timeout');

    return new CoinbaseNetworkError({
      kind: isTimeout ? 'timeout' : 'network',
      message: error.message || 'Network error',
      originalError: error,
      code: error.code,
      route,
      method,
    });
  }

  toJSON(): Record<string, any> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      code: this.code,
      route: this.route,
      method: this.method,
      retryable: this.retryable,
      timestamp: this.timestamp,
    };
  }
}

/**
 * Circuit breaker open error - thrown when circuit is open and request is blocked
 */
export class CircuitOpenError extends CoinbaseError {
  public readonly route?: string;
  public readonly cooldownRemainingMs: number;

  constructor(options: {
    message: string;
    route?: string;
    cooldownRemainingMs: number;
  }) {
    super('unknown', options.message, false);
    this.name = 'CircuitOpenError';
    this.route = options.route;
    this.cooldownRemainingMs = options.cooldownRemainingMs;
  }
}

/**
 * Classify HTTP status code into error kind and retryability
 */
function classifyHttpStatus(
  status: number,
  data?: any,
  headers?: Record<string, string>
): { kind: CoinbaseErrorKind; retryable: boolean; retryAfterMs?: number } {
  // Rate limited
  if (status === 429) {
    const retryAfter = headers?.['retry-after'];
    const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
    return { kind: 'rate_limit', retryable: true, retryAfterMs };
  }

  // Server errors - retryable
  if (status >= 500) {
    return { kind: 'server', retryable: true };
  }

  // Timeout (408)
  if (status === 408) {
    return { kind: 'timeout', retryable: true };
  }

  // Auth errors - NOT retryable
  if (status === 401 || status === 403) {
    return { kind: 'auth', retryable: false };
  }

  // Not found
  if (status === 404) {
    return { kind: 'not_found', retryable: false };
  }

  // Business logic errors (check response body for specifics)
  if (status >= 400 && status < 500) {
    const message = (data?.message || data?.error || '').toLowerCase();
    
    // Post-only rejection
    if (message.includes('post-only') || message.includes('post only')) {
      return { kind: 'post_only', retryable: false };
    }
    
    // Insufficient funds
    if (message.includes('insufficient') || message.includes('nsf')) {
      return { kind: 'insufficient_funds', retryable: false };
    }
    
    // Order rejected for various reasons
    if (message.includes('rejected') || message.includes('invalid')) {
      return { kind: 'order_rejected', retryable: false };
    }

    return { kind: 'bad_request', retryable: false };
  }

  return { kind: 'unknown', retryable: false };
}

/**
 * Check if an error is a CoinbaseError
 */
export function isCoinbaseError(error: unknown): error is CoinbaseError {
  return error instanceof CoinbaseError;
}

/**
 * Check if an error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof CoinbaseError) {
    return error.retryable;
  }
  // Network errors without response are generally retryable
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes('timeout') || 
           msg.includes('network') ||
           msg.includes('econnrefused') ||
           msg.includes('enotfound');
  }
  return false;
}

/**
 * Check if an error is a rate limit error
 */
export function isRateLimitError(error: unknown): boolean {
  return error instanceof CoinbaseApiError && error.kind === 'rate_limit';
}

/**
 * Check if an error is an auth error
 */
export function isAuthError(error: unknown): boolean {
  return error instanceof CoinbaseApiError && error.kind === 'auth';
}

/**
 * Check if an error is a business error (not retryable, not network/server)
 */
export function isBusinessError(error: unknown): boolean {
  if (!(error instanceof CoinbaseApiError)) return false;
  return ['post_only', 'insufficient_funds', 'order_rejected', 'bad_request'].includes(error.kind);
}
