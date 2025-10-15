import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

export const EnvSchema = z.object({
  COINBASE_API_KEY: z.string().optional(),
  COINBASE_API_SECRET: z.string().optional(),
  COINBASE_API_PASSPHRASE: z.string().optional(),
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  ENCRYPTION_KEY: z.string().optional(),
  CONFIRM_LIVE: z.enum(['YES', 'NO']).default('NO'),
});

export type Env = z.infer<typeof EnvSchema>;

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
  
  const env = EnvSchema.parse({
    COINBASE_API_KEY: process.env.COINBASE_API_KEY,
    COINBASE_API_SECRET: process.env.COINBASE_API_SECRET,
    COINBASE_API_PASSPHRASE: process.env.COINBASE_API_PASSPHRASE,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
    CONFIRM_LIVE: (process.env.CONFIRM_LIVE as 'YES' | 'NO') ?? 'NO',
  });
  return env;
}
