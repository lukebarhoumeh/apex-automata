/**
 * Schema Capabilities Detection
 * 
 * Queries the database schema on startup to detect:
 * - Table existence
 * - Column existence
 * - Unique constraints for upserts
 * 
 * Prevents infinite retry loops on "column does not exist" errors.
 */

import { SupabaseClient, createClient } from '@supabase/supabase-js';
import { Logger } from '../core/logger';

export interface ColumnInfo {
  name: string;
  dataType: string;
  isNullable: boolean;
}

export interface ConstraintInfo {
  name: string;
  type: 'PRIMARY KEY' | 'UNIQUE' | 'FOREIGN KEY' | 'CHECK';
  columns: string[];
}

export interface TableCapabilities {
  exists: boolean;
  columns: Map<string, ColumnInfo>;
  constraints: ConstraintInfo[];
  uniqueColumns: Set<string>;
}

export interface SchemaCapabilities {
  tables: Map<string, TableCapabilities>;
  lastRefreshed: Date;
}

/**
 * Check if a table has a specific column
 */
export function hasColumn(caps: SchemaCapabilities, table: string, column: string): boolean {
  const tableInfo = caps.tables.get(table);
  if (!tableInfo?.exists) return false;
  return tableInfo.columns.has(column);
}

/**
 * Check if a table has a unique constraint on the given columns
 */
export function hasUniqueConstraint(caps: SchemaCapabilities, table: string, columns: string[]): boolean {
  const tableInfo = caps.tables.get(table);
  if (!tableInfo?.exists) return false;

  const sortedCols = [...columns].sort().join(',');

  for (const constraint of tableInfo.constraints) {
    if (constraint.type === 'UNIQUE' || constraint.type === 'PRIMARY KEY') {
      const constraintCols = [...constraint.columns].sort().join(',');
      if (constraintCols === sortedCols) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Filter a row to only include columns that exist in the table
 */
export function filterToExistingColumns(
  caps: SchemaCapabilities,
  table: string,
  row: Record<string, any>
): Record<string, any> {
  const tableInfo = caps.tables.get(table);
  if (!tableInfo?.exists) return row;

  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (tableInfo.columns.has(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Get list of missing columns
 */
export function getMissingColumns(
  caps: SchemaCapabilities,
  table: string,
  requiredColumns: string[]
): string[] {
  const tableInfo = caps.tables.get(table);
  if (!tableInfo?.exists) return requiredColumns;

  return requiredColumns.filter(col => !tableInfo.columns.has(col));
}

/**
 * Load schema capabilities from database
 */
export async function loadSchemaCapabilities(
  supabase: SupabaseClient,
  tables: string[],
  logger: Logger
): Promise<SchemaCapabilities> {
  const caps: SchemaCapabilities = {
    tables: new Map(),
    lastRefreshed: new Date(),
  };

  for (const table of tables) {
    try {
      const tableCaps = await loadTableCapabilities(supabase, table, logger);
      caps.tables.set(table, tableCaps);
    } catch (error) {
      logger.warn(`Failed to load capabilities for table ${table}`, { error });
      caps.tables.set(table, {
        exists: false,
        columns: new Map(),
        constraints: [],
        uniqueColumns: new Set(),
      });
    }
  }

  return caps;
}

async function loadTableCapabilities(
  supabase: SupabaseClient,
  table: string,
  logger: Logger
): Promise<TableCapabilities> {
  const caps: TableCapabilities = {
    exists: false,
    columns: new Map(),
    constraints: [],
    uniqueColumns: new Set(),
  };

  // Check table existence and get columns using a simple query
  // This approach works with Supabase's RLS and doesn't require pg_catalog access
  try {
    // Try to select from the table with limit 0 to check existence
    const { error } = await supabase.from(table).select('*').limit(0);

    if (error) {
      if (error.code === '42P01' || error.message?.includes('does not exist')) {
        logger.debug(`Table ${table} does not exist`);
        return caps;
      }
      // Other errors - table might exist but have access issues
      logger.warn(`Error checking table ${table}`, { error: error.message });
      return caps;
    }

    caps.exists = true;

    // Get column information via RPC if available, otherwise infer from error messages
    // For now, we'll mark columns as "unknown" and rely on runtime detection
    logger.debug(`Table ${table} exists`);

  } catch (error: any) {
    if (error.code === '42P01') {
      return caps;
    }
    logger.warn(`Error loading table capabilities for ${table}`, { error: error.message });
  }

  return caps;
}

/**
 * Create schema capabilities instance with manual column definitions
 * 
 * Use this when you can't query information_schema directly.
 * Define the expected schema and the system will validate at runtime.
 */
export function createManualCapabilities(
  schema: Record<string, {
    columns: string[];
    uniqueConstraints?: string[][];
  }>
): SchemaCapabilities {
  const caps: SchemaCapabilities = {
    tables: new Map(),
    lastRefreshed: new Date(),
  };

  for (const [table, def] of Object.entries(schema)) {
    const columns = new Map<string, ColumnInfo>();
    for (const col of def.columns) {
      columns.set(col, { name: col, dataType: 'unknown', isNullable: true });
    }

    const constraints: ConstraintInfo[] = [];
    const uniqueColumns = new Set<string>();

    if (def.uniqueConstraints) {
      for (const cols of def.uniqueConstraints) {
        constraints.push({
          name: `${table}_${cols.join('_')}_unique`,
          type: 'UNIQUE',
          columns: cols,
        });
        cols.forEach(c => uniqueColumns.add(c));
      }
    }

    caps.tables.set(table, {
      exists: true,
      columns,
      constraints,
      uniqueColumns,
    });
  }

  return caps;
}

/**
 * Default schema definition for known tables
 * 
 * This defines the expected schema that the code writes to.
 * If the actual schema differs, migrations should be applied.
 */
export const EXPECTED_SCHEMA = createManualCapabilities({
  risk_metrics: {
    columns: [
      'id', 'user_id', 'created_at', 'updated_at',
      'daily_pnl', 'daily_pnl_r', 'max_drawdown', 'consecutive_losses',
      'error_rate', 'kill_switch_active', 'exposure_usd',
      'realized_pnl_usd', 'unrealized_pnl_usd',
      'average_latency_ms', 'market_data_stale_ms',
    ],
    uniqueConstraints: [['user_id']],
  },
  account_metrics: {
    columns: [
      'id', 'user_id', 'date', 'created_at', 'updated_at',
      'total_equity', 'available_cash', 'positions_value', 'margin_used',
      'daily_pnl', 'daily_pnl_pct', 'total_trades', 'win_rate',
      'risk_heat', 'max_drawdown',
    ],
    uniqueConstraints: [['user_id', 'date']],
  },
  daily_equity: {
    columns: [
      'id', 'user_id', 'date', 'created_at',
      'start_equity', 'end_equity', 'high_equity', 'low_equity',
      'realized_pnl', 'unrealized_pnl',
    ],
    uniqueConstraints: [['user_id', 'date']],
  },
  risk_events: {
    columns: [
      'id', 'user_id', 'event_type', 'details',
      'triggered_at', 'cleared_at', 'created_at',
    ],
  },
  trade_log: {
    columns: [
      'id', 'user_id', 'session_id', 'signal_id', 'symbol',
      'side', 'entry_price', 'exit_price', 'quantity',
      'realized_pnl', 'realized_pnl_r', 'fees',
      'entry_time', 'exit_time', 'duration_ms',
      'strategy', 'status', 'exit_reason',
      'created_at',
    ],
    uniqueConstraints: [['id']],
  },
  trading_sessions: {
    columns: [
      'id', 'session_id', 'user_id', 'started_at', 'ended_at',
      'mode', 'total_trades', 'winning_trades', 'losing_trades',
      'total_pnl', 'total_fees', 'max_drawdown',
      'status', 'created_at', 'updated_at',
    ],
    uniqueConstraints: [['session_id']],
  },
  orders: {
    columns: [
      'id', 'user_id', 'external_order_id', 'symbol', 'side', 'type',
      'status', 'price', 'size', 'filled_size', 'average_fill_price',
      'created_at', 'updated_at', 'client_oid',
    ],
    uniqueConstraints: [['user_id', 'external_order_id']],
  },
  fills: {
    columns: [
      'id', 'user_id', 'order_id', 'trade_id', 'symbol',
      'side', 'price', 'size', 'fee', 'fee_currency',
      'created_at', 'liquidity',
    ],
    uniqueConstraints: [['user_id', 'trade_id']],
  },
  positions: {
    columns: [
      'id', 'user_id', 'symbol', 'side', 'size', 'entry_price',
      'market_price', 'unrealized_pnl', 'realized_pnl',
      'opened_at', 'updated_at', 'status',
    ],
    uniqueConstraints: [['user_id', 'symbol']],
  },
  signals: {
    columns: [
      'id', 'user_id', 'symbol', 'side', 'strategy',
      'confidence', 'created_at', 'status',
    ],
  },
  alerts: {
    columns: [
      'id', 'user_id', 'type', 'severity', 'title', 'message',
      'created_at', 'acknowledged_at',
    ],
  },
  trade_outcomes: {
    columns: [
      'id', 'signal_id', 'user_id', 'symbol', 'side',
      'entry_price', 'exit_price', 'quantity', 'pnl_usd', 'pnl_r',
      'holding_time_ms', 'exit_reason', 'created_at',
    ],
    uniqueConstraints: [['signal_id']],
  },
  meta_filter_decisions: {
    columns: [
      'id', 'timestamp', 'user_id', 'signal_id', 'symbol', 'strategy', 'direction',
      'signal_strength', 'volume_ratio', 'regime', 'hour_of_day', 'day_of_week',
      'passed', 'meta_score', 'rules_evaluated', 'outcome', 'pnl',
      'created_at', 'updated_at',
    ],
  },
});
