import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import type { CipherGCM, DecipherGCM } from 'crypto';
import { Logger } from '../core/logger';

export interface SecretConfig {
  supabaseUrl: string;
  supabaseServiceKey: string;
  encryptionKey: string; // 32-byte key for AES-256
}

export interface ExchangeCredentials {
  apiKey: string;
  apiSecret: string;
  apiPassphrase?: string;
  exchange: string;
  environment: 'production' | 'sandbox';
  createdAt: string;
  updatedAt: string;
}

export class SecretManager {
  private supabase;
  private logger: Logger;
  private encryptionKey: Buffer;
  private algorithm = 'aes-256-gcm';

  constructor(config: SecretConfig, logger: Logger) {
    this.logger = logger;
    this.supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
    this.encryptionKey = Buffer.from(config.encryptionKey, 'hex');

    if (this.encryptionKey.length !== 32) {
      throw new Error('Encryption key must be 32 bytes (64 hex characters)');
    }
  }

  // Encrypt sensitive data
  private encrypt(text: string): { encrypted: string; iv: string; tag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.encryptionKey, iv) as CipherGCM;
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    
    const tag = cipher.getAuthTag();
    
    return {
      encrypted,
      iv: iv.toString('hex'),
      tag: tag.toString('hex')
    };
  }

  // Decrypt sensitive data
  private decrypt(encrypted: string, iv: string, tag: string): string {
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.encryptionKey,
      Buffer.from(iv, 'hex')
    ) as DecipherGCM;
    
    decipher.setAuthTag(Buffer.from(tag, 'hex'));
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  }

  // Store exchange credentials
  public async storeExchangeCredentials(
    exchange: string,
    credentials: Omit<ExchangeCredentials, 'exchange' | 'createdAt' | 'updatedAt'>
  ): Promise<void> {
    try {
      // Encrypt sensitive fields
      const encryptedKey = this.encrypt(credentials.apiKey);
      const encryptedSecret = this.encrypt(credentials.apiSecret);
      const encryptedPassphrase = credentials.apiPassphrase 
        ? this.encrypt(credentials.apiPassphrase)
        : null;

      const { error } = await this.supabase
        .from('exchange_credentials')
        .upsert({
          exchange,
          environment: credentials.environment,
          api_key_encrypted: encryptedKey.encrypted,
          api_key_iv: encryptedKey.iv,
          api_key_tag: encryptedKey.tag,
          api_secret_encrypted: encryptedSecret.encrypted,
          api_secret_iv: encryptedSecret.iv,
          api_secret_tag: encryptedSecret.tag,
          api_passphrase_encrypted: encryptedPassphrase?.encrypted,
          api_passphrase_iv: encryptedPassphrase?.iv,
          api_passphrase_tag: encryptedPassphrase?.tag,
          updated_at: new Date().toISOString()
        });

      if (error) {
        throw error;
      }

      this.logger.info(`Stored credentials for ${exchange} (${credentials.environment})`);
    } catch (error) {
      this.logger.error('Failed to store exchange credentials:', error);
      throw error;
    }
  }

  // Retrieve exchange credentials
  public async getExchangeCredentials(
    exchange: string,
    environment: 'production' | 'sandbox' = 'production'
  ): Promise<ExchangeCredentials | null> {
    try {
      const { data, error } = await this.supabase
        .from('exchange_credentials')
        .select('*')
        .eq('exchange', exchange)
        .eq('environment', environment)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No credentials found
          return null;
        }
        if (error.code === 'PGRST205' || error.message?.includes('not find the table')) {
          // Table doesn't exist - return null gracefully
          this.logger.warn('exchange_credentials table not found, returning null');
          return null;
        }
        throw error;
      }

      if (!data) {
        return null;
      }

      // Decrypt credentials
      const apiKey = this.decrypt(
        data.api_key_encrypted,
        data.api_key_iv,
        data.api_key_tag
      );

      const apiSecret = this.decrypt(
        data.api_secret_encrypted,
        data.api_secret_iv,
        data.api_secret_tag
      );

      const apiPassphrase = data.api_passphrase_encrypted
        ? this.decrypt(
            data.api_passphrase_encrypted,
            data.api_passphrase_iv,
            data.api_passphrase_tag
          )
        : undefined;

      return {
        apiKey,
        apiSecret,
        apiPassphrase,
        exchange: data.exchange,
        environment: data.environment,
        createdAt: data.created_at,
        updatedAt: data.updated_at
      };
    } catch (error) {
      this.logger.error('Failed to retrieve exchange credentials:', error);
      throw error;
    }
  }

  // Delete exchange credentials
  public async deleteExchangeCredentials(
    exchange: string,
    environment: 'production' | 'sandbox' = 'production'
  ): Promise<void> {
    try {
      const { error } = await this.supabase
        .from('exchange_credentials')
        .delete()
        .eq('exchange', exchange)
        .eq('environment', environment);

      if (error) {
        throw error;
      }

      this.logger.info(`Deleted credentials for ${exchange} (${environment})`);
    } catch (error) {
      this.logger.error('Failed to delete exchange credentials:', error);
      throw error;
    }
  }

  // Rotate encryption key (requires re-encrypting all secrets)
  public async rotateEncryptionKey(newKey: string): Promise<void> {
    // This is a complex operation that should be done carefully
    // It involves:
    // 1. Retrieving all encrypted data
    // 2. Decrypting with old key
    // 3. Encrypting with new key
    // 4. Updating all records
    // 5. Updating the encryption key in config
    
    this.logger.warn('Encryption key rotation not implemented yet');
    throw new Error('Encryption key rotation not implemented');
  }
}
