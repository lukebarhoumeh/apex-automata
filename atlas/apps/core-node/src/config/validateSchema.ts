import { SupabaseClient } from '@supabase/supabase-js';
import { Logger } from '../core/logger';

/**
 * Required tables for engine operation (engine cannot start without these)
 */
const REQUIRED_TABLES = [
  'orders',
  'fills',
  'positions',
  'signals',
  'risk_metrics',
  'daily_equity',
  'account_metrics',
  'alerts',
] as const;

/**
 * Optional tables (engine can run in limited mode without these)
 */
const OPTIONAL_TABLES = [
  'exchange_credentials',  // Only needed for live trading
  'trading_sessions',      // For session persistence
  'trade_log',             // Extended trade logging
  'equity_snapshots',      // Equity curve persistence
  'meta_filter_decisions', // ML training data
] as const;

/**
 * Required RPCs for engine operation
 */
const REQUIRED_RPCS = [
  'upsert_account_metrics',
] as const;

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    public readonly missingTables: string[],
    public readonly missingRpcs: string[]
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export interface SchemaValidationResult {
  valid: boolean;
  missingTables: string[];
  missingRpcs: string[];
  errors: string[];
}

/**
 * Validates that all required database tables and RPCs exist.
 * Call this at startup to fail fast if schema is incomplete.
 */
export async function validateSchema(
  supabase: SupabaseClient,
  logger: Logger
): Promise<SchemaValidationResult> {
  const result: SchemaValidationResult = {
    valid: true,
    missingTables: [],
    missingRpcs: [],
    errors: [],
  };

  logger.info('Validating database schema...');

  // Check each required table
  for (const table of REQUIRED_TABLES) {
    try {
      const { error } = await supabase
        .from(table)
        .select('*')
        .limit(1);

      if (error) {
        // PGRST204 = no rows found (table exists but empty) - this is OK
        // PGRST116 = single row expected but none found - also OK for validation
        if (error.code === 'PGRST204' || error.code === 'PGRST116') {
          logger.debug(`Table '${table}' exists (empty)`);
        } else if (error.code === '42P01' || error.code === 'PGRST205' || error.message.includes('does not exist')) {
          // 42P01 = undefined_table, PGRST205 = PostgREST table not found
          result.missingTables.push(table);
          result.errors.push(`Table '${table}' does not exist`);
          logger.error(`Missing table: ${table}`);
        } else {
          // Other errors - log but don't fail validation
          logger.warn(`Unexpected error checking table '${table}': ${error.message}`);
        }
      } else {
        logger.debug(`Table '${table}' validated`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Error checking table '${table}': ${message}`);
    }
  }

  // Check optional tables (log warnings but don't fail validation)
  const missingOptional: string[] = [];
  for (const table of OPTIONAL_TABLES) {
    try {
      const { error } = await supabase
        .from(table)
        .select('*')
        .limit(1);

      if (error) {
        if (error.code === 'PGRST204' || error.code === 'PGRST116') {
          logger.debug(`Optional table '${table}' exists (empty)`);
        } else if (error.code === '42P01' || error.code === 'PGRST205' || error.message.includes('does not exist')) {
          missingOptional.push(table);
          logger.debug(`Optional table '${table}' not found (non-critical)`);
        } else {
          logger.debug(`Optional table '${table}' check: ${error.message}`);
        }
      } else {
        logger.debug(`Optional table '${table}' validated`);
      }
    } catch (error) {
      // Ignore errors for optional tables
    }
  }
  
  if (missingOptional.length > 0) {
    logger.info(`Optional tables not found (will use defaults): ${missingOptional.join(', ')}`);
  }

  // Check required RPCs by attempting to call them
  for (const rpc of REQUIRED_RPCS) {
    try {
      // Try calling the RPC - we expect it to fail due to invalid params,
      // but the error should indicate the function exists
      const { error } = await supabase.rpc(rpc, {
        p_user_id: '00000000-0000-0000-0000-000000000000' // Dummy UUID
      });

      if (error) {
        // Check if error is about function not existing
        if (
          error.code === '42883' || // undefined_function
          error.message.includes('function') && error.message.includes('does not exist')
        ) {
          result.missingRpcs.push(rpc);
          result.errors.push(`RPC '${rpc}' does not exist`);
          logger.error(`Missing RPC: ${rpc}`);
        } else {
          // Other errors (like invalid params) mean the function exists
          logger.debug(`RPC '${rpc}' validated (exists)`);
        }
      } else {
        logger.debug(`RPC '${rpc}' validated`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Network errors shouldn't count as missing RPC
      if (message.includes('does not exist')) {
        result.missingRpcs.push(rpc);
        result.errors.push(`RPC '${rpc}' does not exist`);
        logger.error(`Missing RPC: ${rpc}`);
      } else {
        logger.warn(`Error checking RPC '${rpc}': ${message}`);
      }
    }
  }

  // Determine overall validity
  result.valid = result.missingTables.length === 0 && result.missingRpcs.length === 0;

  if (result.valid) {
    logger.info(`✅ Schema validation passed (${REQUIRED_TABLES.length} tables, ${REQUIRED_RPCS.length} RPCs)`);
  } else {
    const summary = [
      result.missingTables.length > 0 
        ? `Missing tables: ${result.missingTables.join(', ')}` 
        : null,
      result.missingRpcs.length > 0 
        ? `Missing RPCs: ${result.missingRpcs.join(', ')}` 
        : null,
    ].filter(Boolean).join('; ');
    
    logger.error(`❌ Schema validation failed: ${summary}`);
  }

  return result;
}

/**
 * Validates schema and throws if critical tables/RPCs are missing.
 * Use this at startup to prevent engine from running with incomplete schema.
 */
export async function validateSchemaOrFail(
  supabase: SupabaseClient,
  logger: Logger,
  options: { allowLimitedMode?: boolean } = {}
): Promise<void> {
  const result = await validateSchema(supabase, logger);

  if (!result.valid) {
    if (options.allowLimitedMode) {
      logger.warn('Schema incomplete - running in LIMITED MODE. Risk engine may not function correctly.');
      logger.warn('Missing components:', {
        tables: result.missingTables,
        rpcs: result.missingRpcs,
      });
    } else {
      throw new SchemaValidationError(
        `Database schema is incomplete. Cannot start trading engine safely.\n` +
        `Missing tables: ${result.missingTables.join(', ') || 'none'}\n` +
        `Missing RPCs: ${result.missingRpcs.join(', ') || 'none'}`,
        result.missingTables,
        result.missingRpcs
      );
    }
  }
}
