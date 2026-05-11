import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

// Custom validator for encryption key (must be 64 hex chars = 32 bytes)
const hexKey32Bytes = z.string().refine(
  (val) => /^[0-9a-fA-F]{64}$/.test(val),
  { message: 'ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes)' }
);

export const EnvSchema = z.object({
  // Coinbase credentials - optional for paper mode, required for live
  COINBASE_API_KEY: z.string().optional(),
  COINBASE_API_SECRET: z.string().optional(),
  COINBASE_API_PASSPHRASE: z.string().optional(),
  
  // Coinbase API version toggle
  // 'exchange' = deprecated GDAX/Exchange API (current default)
  // 'advanced' = new Coinbase Advanced Trade API
  COINBASE_API_VERSION: z.enum(['exchange', 'advanced']).default('exchange'),
  
  // Supabase - REQUIRED for engine operation
  SUPABASE_URL: z.string().url({ message: 'SUPABASE_URL must be a valid URL' }),
  SUPABASE_SERVICE_KEY: z.string().min(1, { message: 'SUPABASE_SERVICE_KEY is required' }),
  SUPABASE_ANON_KEY: z.string().optional(),
  
  // Security - REQUIRED
  ENCRYPTION_KEY: hexKey32Bytes,
  
  // Live trading safeguard
  CONFIRM_LIVE: z.enum(['YES', 'NO']).default('NO'),

  // Hyperliquid (optional — kill-switch defaults to OFF). The adapter is only
  // initialized when HYPERLIQUID_ENABLED=true AND guardrails.hyperliquid.enabled=true.
  // Private key + wallet address are only required for trading; public-data init works
  // without them (read-only). Never log these values.
  HYPERLIQUID_ENABLED: z.enum(['true', 'false']).optional(),
  HYPERLIQUID_TESTNET: z.enum(['true', 'false']).optional(),
  HYPERLIQUID_PRIVATE_KEY: z.string().optional(),
  HYPERLIQUID_WALLET_ADDRESS: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export class EnvValidationError extends Error {
  constructor(message: string, public readonly details: string[]) {
    super(message);
    this.name = 'EnvValidationError';
  }
}

/**
 * Validates environment variables and throws descriptive errors if any are missing/malformed.
 * Call this at startup before creating any Supabase clients or initializing the engine.
 */
export function validateEnv(env: Env): void {
  const errors: string[] = [];

  // Check required Supabase vars
  if (!env.SUPABASE_URL) {
    errors.push('SUPABASE_URL is missing or empty');
  } else if (!env.SUPABASE_URL.startsWith('https://')) {
    errors.push('SUPABASE_URL must start with https://');
  }

  if (!env.SUPABASE_SERVICE_KEY) {
    errors.push('SUPABASE_SERVICE_KEY is missing or empty');
  } else if (env.SUPABASE_SERVICE_KEY.length < 100) {
    errors.push('SUPABASE_SERVICE_KEY appears malformed (too short)');
  }

  // Check encryption key
  if (!env.ENCRYPTION_KEY) {
    errors.push('ENCRYPTION_KEY is missing or empty');
  } else if (!/^[0-9a-fA-F]{64}$/.test(env.ENCRYPTION_KEY)) {
    errors.push('ENCRYPTION_KEY must be exactly 64 hexadecimal characters (32 bytes). Generate with: openssl rand -hex 32');
  }

  // Warn about anon key usage
  if (env.SUPABASE_ANON_KEY && env.SUPABASE_ANON_KEY === env.SUPABASE_SERVICE_KEY) {
    errors.push('SUPABASE_ANON_KEY and SUPABASE_SERVICE_KEY should not be the same');
  }

  // Live mode requires Coinbase credentials
  if (env.CONFIRM_LIVE === 'YES') {
    if (!env.COINBASE_API_KEY) {
      errors.push('COINBASE_API_KEY is required when CONFIRM_LIVE=YES');
    }
    if (!env.COINBASE_API_SECRET) {
      errors.push('COINBASE_API_SECRET is required when CONFIRM_LIVE=YES');
    }
  }

  if (errors.length > 0) {
    const message = `Environment validation failed:\n${errors.map(e => `  - ${e}`).join('\n')}`;
    console.error('\n❌ ' + message + '\n');
    throw new EnvValidationError('Environment validation failed', errors);
  }

  console.log('✅ Environment validation passed');
}

export function loadEnv(rootDir: string): Env {
  // Look for .env in the main project root
  // rootDir is typically atlas directory, so we go up one level to get to project root
  const mainProjectRoot = path.resolve(rootDir, '..');
  const mainEnvPath = path.join(mainProjectRoot, '.env');
  
  if (fs.existsSync(mainEnvPath)) {
    dotenv.config({ path: mainEnvPath });
    console.log(`Loaded environment from: ${mainEnvPath}`);
  } else {
    // Fallback to .env.local in atlas directory if main .env doesn't exist
    const fallbackPath = path.join(rootDir, '.env.local');
    if (fs.existsSync(fallbackPath)) {
      dotenv.config({ path: fallbackPath });
      console.log(`Loaded environment from fallback: ${fallbackPath}`);
    } else {
      console.warn('No .env file found. Using environment variables.');
    }
  }
  
  try {
    const env = EnvSchema.parse({
      COINBASE_API_KEY: process.env.COINBASE_API_KEY,
      COINBASE_API_SECRET: process.env.COINBASE_API_SECRET,
      COINBASE_API_PASSPHRASE: process.env.COINBASE_API_PASSPHRASE,
      COINBASE_API_VERSION: (process.env.COINBASE_API_VERSION as 'exchange' | 'advanced') ?? 'exchange',
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
      CONFIRM_LIVE: (process.env.CONFIRM_LIVE as 'YES' | 'NO') ?? 'NO',
    });
    return env;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`);
      const message = `Environment parsing failed:\n${issues.map(i => `  - ${i}`).join('\n')}`;
      console.error('\n❌ ' + message + '\n');
      throw new EnvValidationError('Environment parsing failed', issues);
    }
    throw error;
  }
}

/**
 * Load and validate environment in one call.
 * Use this at server startup to fail fast with clear errors.
 */
export function loadAndValidateEnv(rootDir: string): Env {
  const env = loadEnv(rootDir);
  validateEnv(env);
  return env;
}
