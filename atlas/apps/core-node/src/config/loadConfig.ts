import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { z } from 'zod';
import { AppConfig } from '@/core/types';

const AppConfigSchema = z.object({
  mode: z.enum(['paper', 'live']),
  exchange: z.literal('coinbase-advanced'),
  symbols: z.array(z.string()).min(1),
  bars: z.object({ tf_primary: z.enum(['1m', '5m', '15m']) }),
  risk: z.object({
    per_trade_risk_bp: z.number(),
    max_heat_bp: z.number(),
    daily_stop_R: z.number(),
  }),
  signals: z.record(z.any()).optional(),
  meta: z.object({
    enabled: z.boolean(),
    threshold: z.number(),
    model_path: z.string(),
  }).optional(),
  execution: z.record(z.any()).optional(),
  killswitch: z.record(z.any()).optional(),
  limits: z.object({
    min_order_usd: z.number(),
    per_symbol_usd_cap: z.number(),
  }).optional(),
});

export function loadConfig(configPath: string): AppConfig {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = YAML.parse(raw);
  const cfg = AppConfigSchema.parse(parsed);
  return cfg as AppConfig;
}
