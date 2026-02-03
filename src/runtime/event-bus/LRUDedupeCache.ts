/**
 * LRU Dedupe Cache
 * 
 * Prevents duplicate events from WS + Supabase from double-applying.
 * Uses LRU eviction and TTL expiry.
 */

import { DEFAULT_DEDUPE_CONFIG, type DedupeConfig } from './types';

interface CacheEntry {
  key: string;
  ts: number;
}

export class LRUDedupeCache {
  private cache: Map<string, CacheEntry> = new Map();
  private config: DedupeConfig;
  
  constructor(config: Partial<DedupeConfig> = {}) {
    this.config = { ...DEFAULT_DEDUPE_CONFIG, ...config };
  }
  
  /**
   * Check if a key is a duplicate (exists and not expired).
   * If not a duplicate, adds it to the cache.
   * Returns true if duplicate (should be skipped).
   */
  public isDuplicate(key: string): boolean {
    const now = Date.now();
    
    // Clean expired entries periodically (every 100 checks)
    if (this.cache.size > 0 && Math.random() < 0.01) {
      this.cleanExpired(now);
    }
    
    const existing = this.cache.get(key);
    
    if (existing) {
      // Check if expired
      if (now - existing.ts > this.config.ttlMs) {
        // Expired, update timestamp and allow
        this.cache.delete(key);
        this.addKey(key, now);
        return false;
      }
      // Not expired, is duplicate
      return true;
    }
    
    // New key, add to cache
    this.addKey(key, now);
    return false;
  }
  
  /**
   * Add a key with timestamp.
   */
  private addKey(key: string, ts: number): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.config.maxKeys) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    
    this.cache.set(key, { key, ts });
  }
  
  /**
   * Remove expired entries.
   */
  private cleanExpired(now: number): void {
    const expiredKeys: string[] = [];
    
    for (const [key, entry] of this.cache) {
      if (now - entry.ts > this.config.ttlMs) {
        expiredKeys.push(key);
      }
    }
    
    for (const key of expiredKeys) {
      this.cache.delete(key);
    }
  }
  
  /**
   * Clear all entries.
   */
  public clear(): void {
    this.cache.clear();
  }
  
  /**
   * Clear entries older than given timestamp.
   */
  public clearOlderThan(ts: number): void {
    const keysToDelete: string[] = [];
    
    for (const [key, entry] of this.cache) {
      if (entry.ts < ts) {
        keysToDelete.push(key);
      }
    }
    
    for (const key of keysToDelete) {
      this.cache.delete(key);
    }
  }
  
  /**
   * Get cache size.
   */
  public get size(): number {
    return this.cache.size;
  }
}
