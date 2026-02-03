/**
 * Coinbase HTTP Module
 * 
 * Provides resilient HTTP connectivity for Coinbase REST API:
 * - Structured error handling
 * - Rate limiting
 * - Retry with backoff
 * - Circuit breaker
 */

export * from './errors';
export * from './rate-limiter';
export * from './resilient-http';
