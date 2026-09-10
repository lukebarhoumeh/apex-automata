/**
 * Persistence Module
 * 
 * Unified write layer for all Supabase operations.
 * 
 * Features:
 * - Single writer instance with queue + retry + coalescing
 * - Schema capability detection
 * - Idempotent writes via unique constraints
 * - Disk spool for critical facts during outages
 */

export * from './supabase-writer';
export * from './schema-capabilities';
export * from './fill-row';
