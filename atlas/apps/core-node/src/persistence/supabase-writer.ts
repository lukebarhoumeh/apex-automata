/**
 * Supabase Writer - Unified Write Layer
 * 
 * Single entry point for all Supabase writes with:
 * - Bounded in-memory queue
 * - Retry with exponential backoff + jitter
 * - Coalescing for high-frequency snapshot tables
 * - Connectivity state tracking
 * - Schema error detection (non-retryable)
 * - Optional disk spool for critical facts
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Counter, Gauge } from 'prom-client';
import { Logger } from '../core/logger';
import * as fs from 'fs';
import * as path from 'path';

// ============ Prometheus Metrics ============

const dbConnectionStatus = new Gauge({
  name: 'atlas_db_connection_status',
  help: 'Database connection status (1=connected, 0=disconnected)',
});

const dbWriteQueueDepth = new Gauge({
  name: 'atlas_db_write_queue_depth',
  help: 'Current depth of the write queue',
});

const dbWriteTotal = new Counter({
  name: 'atlas_db_write_total',
  help: 'Total database writes by table and result',
  labelNames: ['table', 'result'],
});

const dbSchemaErrors = new Counter({
  name: 'atlas_db_schema_errors_total',
  help: 'Total schema mismatch errors (non-retryable)',
  labelNames: ['table', 'error_type'],
});

const dbRetries = new Counter({
  name: 'atlas_db_retries_total',
  help: 'Total write retries',
  labelNames: ['table'],
});

const dbSpoolDepth = new Gauge({
  name: 'atlas_db_spool_depth',
  help: 'Number of operations in disk spool',
});

// ============ Types ============

export type WriteKind = 'insert' | 'upsert' | 'update';

export interface WriteOp {
  kind: WriteKind;
  table: string;
  row?: Record<string, any>;
  rows?: Record<string, any>[];
  match?: Record<string, any>;
  patch?: Record<string, any>;
  onConflict?: string;
  /** Key for deduplication (same key = same logical write) */
  dedupeKey?: string;
  /** Key for coalescing (keeps only latest per key) */
  coalesceKey?: string;
  /** Critical facts are spooled to disk on failure */
  critical?: boolean;
  /** Retry count (internal) */
  _retries?: number;
  /** Timestamp enqueued */
  _enqueuedAt?: number;
}

export interface WriterHealth {
  connected: boolean;
  queueDepth: number;
  lastSuccessAt?: number;
  lastError?: string;
  spoolDepth: number;
}

export interface WriterConfig {
  supabaseUrl: string;
  supabaseServiceKey: string;
  logger: Logger;
  /** Max queue size before dropping non-critical writes */
  maxQueueSize?: number;
  /** Max retries for transient failures */
  maxRetries?: number;
  /** Base delay for retry backoff (ms) */
  retryBaseDelayMs?: number;
  /** Max delay between retries (ms) */
  retryMaxDelayMs?: number;
  /** Enable disk spool for critical facts */
  enableSpool?: boolean;
  /** Spool directory path */
  spoolDir?: string;
  /** Flush interval (ms) */
  flushIntervalMs?: number;
}

// ============ Schema Error Detection ============

const SCHEMA_ERROR_CODES = new Set([
  '42P01', // relation does not exist
  '42703', // column does not exist
  '42601', // syntax error
  '42P16', // invalid table definition
  '23514', // check violation
]);

const RETRYABLE_ERROR_CODES = new Set([
  '08000', // connection exception
  '08003', // connection does not exist
  '08006', // connection failure
  '57P01', // admin shutdown
  '57P02', // crash shutdown
  '57P03', // cannot connect now
  '40001', // serialization failure
  '40P01', // deadlock detected
  '53000', // insufficient resources
  '53100', // disk full
  '53200', // out of memory
  '53300', // too many connections
  'PGRST000', // Supabase REST generic error
]);

function isSchemaError(error: any): boolean {
  if (!error) return false;
  const code = error.code || '';
  if (SCHEMA_ERROR_CODES.has(code)) return true;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('column') && msg.includes('does not exist') ||
         msg.includes('relation') && msg.includes('does not exist') ||
         msg.includes('constraint') && msg.includes('does not exist');
}

function isRetryableError(error: any): boolean {
  if (!error) return true; // No error = retryable (network issue)
  const code = error.code || '';
  if (RETRYABLE_ERROR_CODES.has(code)) return true;
  if (SCHEMA_ERROR_CODES.has(code)) return false;
  const msg = (error.message || '').toLowerCase();
  return msg.includes('timeout') ||
         msg.includes('network') ||
         msg.includes('connection') ||
         msg.includes('fetch failed') ||
         msg.includes('ECONNREFUSED');
}

// ============ Supabase Writer ============

export class SupabaseWriter {
  private supabase: SupabaseClient;
  private logger: Logger;
  private queue: WriteOp[] = [];
  private coalescedOps: Map<string, WriteOp> = new Map();
  private dedupeSet: Set<string> = new Set();
  private isConnected = true;
  private lastSuccessAt?: number;
  private lastError?: string;
  private flushTimer: NodeJS.Timeout | null = null;
  private isFlushing = false;
  private isShuttingDown = false;

  // Config
  private maxQueueSize: number;
  private maxRetries: number;
  private retryBaseDelayMs: number;
  private retryMaxDelayMs: number;
  private enableSpool: boolean;
  private spoolDir: string;
  private flushIntervalMs: number;

  constructor(config: WriterConfig) {
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceKey, {
      auth: { persistSession: false },
    });
    this.logger = config.logger;

    this.maxQueueSize = config.maxQueueSize ?? 1000;
    this.maxRetries = config.maxRetries ?? 5;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
    this.retryMaxDelayMs = config.retryMaxDelayMs ?? 30000;
    this.enableSpool = config.enableSpool ?? false;
    this.spoolDir = config.spoolDir ?? './spool';
    this.flushIntervalMs = config.flushIntervalMs ?? 2000;

    // Initialize spool directory
    if (this.enableSpool) {
      try {
        fs.mkdirSync(this.spoolDir, { recursive: true });
      } catch (e) {
        this.logger.warn('Failed to create spool directory', { error: e });
        this.enableSpool = false;
      }
    }

    // Start periodic flush
    this.flushTimer = setInterval(() => {
      this.flush().catch(e => {
        this.logger.error('Periodic flush failed', { error: e.message });
      });
    }, this.flushIntervalMs);

    dbConnectionStatus.set(1);
    this.logger.info('SupabaseWriter initialized', {
      maxQueueSize: this.maxQueueSize,
      flushIntervalMs: this.flushIntervalMs,
      enableSpool: this.enableSpool,
    });
  }

  // ============ Public API ============

  /**
   * Enqueue a write operation
   */
  public enqueue(op: WriteOp): void {
    // Check for duplicate
    if (op.dedupeKey && this.dedupeSet.has(op.dedupeKey)) {
      this.logger.debug('Dropping duplicate write', { dedupeKey: op.dedupeKey, table: op.table });
      return;
    }

    op._enqueuedAt = Date.now();
    op._retries = 0;

    // Handle coalescing
    if (op.coalesceKey) {
      this.coalescedOps.set(op.coalesceKey, op);
      dbWriteQueueDepth.set(this.queue.length + this.coalescedOps.size);
      return;
    }

    // Check queue overflow
    if (this.queue.length >= this.maxQueueSize) {
      if (op.critical) {
        // Spool critical ops
        if (this.enableSpool) {
          this.spoolOp(op);
        } else {
          this.logger.error('Queue overflow, dropping critical write (spool disabled)', { table: op.table });
        }
      } else {
        this.logger.warn('Queue overflow, dropping non-critical write', { table: op.table });
      }
      return;
    }

    if (op.dedupeKey) {
      this.dedupeSet.add(op.dedupeKey);
    }

    this.queue.push(op);
    dbWriteQueueDepth.set(this.queue.length + this.coalescedOps.size);
  }

  /**
   * Force flush all pending writes
   */
  public async flushNow(): Promise<void> {
    await this.flush();
  }

  /**
   * Get writer health status
   */
  public getHealth(): WriterHealth {
    return {
      connected: this.isConnected,
      queueDepth: this.queue.length + this.coalescedOps.size,
      lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError,
      spoolDepth: this.getSpoolDepth(),
    };
  }

  /**
   * Graceful shutdown
   */
  public async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush
    try {
      await this.flush();
    } catch (e) {
      this.logger.error('Final flush failed during shutdown', { error: e });
    }

    this.logger.info('SupabaseWriter shutdown complete');
  }

  // ============ Convenience Methods ============

  public insert(table: string, row: Record<string, any>, options?: {
    dedupeKey?: string;
    critical?: boolean;
  }): void {
    this.enqueue({
      kind: 'insert',
      table,
      row,
      ...options,
    });
  }

  public upsert(table: string, row: Record<string, any>, onConflict: string, options?: {
    dedupeKey?: string;
    coalesceKey?: string;
    critical?: boolean;
  }): void {
    this.enqueue({
      kind: 'upsert',
      table,
      row,
      onConflict,
      ...options,
    });
  }

  public update(table: string, match: Record<string, any>, patch: Record<string, any>, options?: {
    dedupeKey?: string;
    critical?: boolean;
  }): void {
    this.enqueue({
      kind: 'update',
      table,
      match,
      patch,
      ...options,
    });
  }

  // ============ Internal ============

  private async flush(): Promise<void> {
    if (this.isFlushing) return;
    this.isFlushing = true;

    try {
      // Replay spool first
      if (this.enableSpool) {
        await this.replaySpool();
      }

      // Process coalesced ops
      for (const [key, op] of this.coalescedOps) {
        this.queue.push(op);
      }
      this.coalescedOps.clear();

      // Process queue
      while (this.queue.length > 0 && !this.isShuttingDown) {
        const op = this.queue.shift()!;
        await this.executeOp(op);
      }

      dbWriteQueueDepth.set(this.queue.length + this.coalescedOps.size);
    } finally {
      this.isFlushing = false;
    }
  }

  private async executeOp(op: WriteOp): Promise<void> {
    try {
      let error: any = null;

      switch (op.kind) {
        case 'insert': {
          const result = await this.supabase.from(op.table).insert(op.row || op.rows);
          error = result.error;
          break;
        }
        case 'upsert': {
          const result = await this.supabase.from(op.table).upsert(op.row || op.rows, {
            onConflict: op.onConflict,
          });
          error = result.error;
          break;
        }
        case 'update': {
          let query = this.supabase.from(op.table).update(op.patch!);
          for (const [key, value] of Object.entries(op.match!)) {
            query = query.eq(key, value);
          }
          const result = await query;
          error = result.error;
          break;
        }
      }

      if (error) {
        await this.handleError(op, error);
      } else {
        this.onSuccess(op);
      }
    } catch (e: any) {
      await this.handleError(op, e);
    }
  }

  private onSuccess(op: WriteOp): void {
    this.isConnected = true;
    this.lastSuccessAt = Date.now();
    this.lastError = undefined;
    dbConnectionStatus.set(1);
    dbWriteTotal.labels({ table: op.table, result: 'success' }).inc();

    // Clear dedupe key
    if (op.dedupeKey) {
      // Keep for a short time to handle immediate retries
      setTimeout(() => {
        this.dedupeSet.delete(op.dedupeKey!);
      }, 60000);
    }
  }

  private async handleError(op: WriteOp, error: any): Promise<void> {
    this.lastError = error.message || String(error);

    // Schema errors are not retryable
    if (isSchemaError(error)) {
      this.logger.error('Schema mismatch (non-retryable)', {
        table: op.table,
        error: this.lastError,
        code: error.code,
      });
      dbSchemaErrors.labels({ table: op.table, error_type: error.code || 'unknown' }).inc();
      dbWriteTotal.labels({ table: op.table, result: 'schema_error' }).inc();

      // Spool critical ops even on schema error (may be fixed later)
      if (op.critical && this.enableSpool) {
        this.spoolOp(op);
      }
      return;
    }

    // Check if retryable
    if (!isRetryableError(error)) {
      this.logger.error('Non-retryable write error', {
        table: op.table,
        error: this.lastError,
        code: error.code,
      });
      dbWriteTotal.labels({ table: op.table, result: 'permanent_error' }).inc();
      return;
    }

    // Mark disconnected
    this.isConnected = false;
    dbConnectionStatus.set(0);

    // Check retry limit
    op._retries = (op._retries || 0) + 1;
    if (op._retries > this.maxRetries) {
      this.logger.error('Max retries exceeded', {
        table: op.table,
        retries: op._retries,
        error: this.lastError,
      });
      dbWriteTotal.labels({ table: op.table, result: 'max_retries' }).inc();

      if (op.critical && this.enableSpool) {
        this.spoolOp(op);
      }
      return;
    }

    // Calculate backoff with jitter
    const delay = Math.min(
      this.retryBaseDelayMs * Math.pow(2, op._retries - 1) + Math.random() * 1000,
      this.retryMaxDelayMs
    );

    this.logger.warn('Retrying write after delay', {
      table: op.table,
      retry: op._retries,
      delayMs: Math.round(delay),
      error: this.lastError,
    });

    dbRetries.labels({ table: op.table }).inc();

    // Schedule retry
    await new Promise(resolve => setTimeout(resolve, delay));

    // Re-enqueue at front of queue
    this.queue.unshift(op);
  }

  // ============ Disk Spool ============

  private spoolOp(op: WriteOp): void {
    if (!this.enableSpool) return;

    try {
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
      const filepath = path.join(this.spoolDir, filename);
      fs.writeFileSync(filepath, JSON.stringify(op));
      dbSpoolDepth.set(this.getSpoolDepth());
      this.logger.info('Operation spooled to disk', { table: op.table, file: filename });
    } catch (e) {
      this.logger.error('Failed to spool operation', { table: op.table, error: e });
    }
  }

  private async replaySpool(): Promise<void> {
    if (!this.enableSpool) return;

    try {
      const files = fs.readdirSync(this.spoolDir).filter(f => f.endsWith('.json')).sort();

      for (const file of files) {
        const filepath = path.join(this.spoolDir, file);
        try {
          const content = fs.readFileSync(filepath, 'utf-8');
          const op = JSON.parse(content) as WriteOp;
          op._retries = 0; // Reset retry count for replay

          await this.executeOp(op);

          // Remove file after successful replay
          fs.unlinkSync(filepath);
          this.logger.info('Replayed spooled operation', { table: op.table, file });
        } catch (e) {
          this.logger.error('Failed to replay spooled operation', { file, error: e });
          // Leave file for next attempt
        }
      }

      dbSpoolDepth.set(this.getSpoolDepth());
    } catch (e) {
      this.logger.error('Failed to read spool directory', { error: e });
    }
  }

  private getSpoolDepth(): number {
    if (!this.enableSpool) return 0;
    try {
      return fs.readdirSync(this.spoolDir).filter(f => f.endsWith('.json')).length;
    } catch {
      return 0;
    }
  }
}

// ============ Singleton Factory ============

let writerInstance: SupabaseWriter | null = null;

export function getWriter(): SupabaseWriter {
  if (!writerInstance) {
    throw new Error('SupabaseWriter not initialized. Call initWriter() first.');
  }
  return writerInstance;
}

export function initWriter(config: WriterConfig): SupabaseWriter {
  if (writerInstance) {
    return writerInstance;
  }
  writerInstance = new SupabaseWriter(config);
  return writerInstance;
}

export async function shutdownWriter(): Promise<void> {
  if (writerInstance) {
    await writerInstance.shutdown();
    writerInstance = null;
  }
}
