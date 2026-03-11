/**
 * ExchangeRegistry — singleton that manages exchange adapter instances.
 * The trading engine uses this to get the active exchange adapter.
 *
 * Events:
 * - 'adapter:registered'       → { id: string }
 * - 'adapter:removed'          → { id: string }
 * - 'adapter:default-changed'  → { id: string }
 */

import { EventEmitter } from 'events';
import { Logger } from '../core/logger';
import { IExchangeAdapter } from './types';

export class ExchangeRegistry extends EventEmitter {
  private adapters: Map<string, IExchangeAdapter> = new Map();
  private defaultAdapterId: string | null = null;
  private logger: Logger;

  constructor(logger: Logger) {
    super();
    this.logger = logger;
  }

  /**
   * Register an exchange adapter.
   * @throws if an adapter with the same ID is already registered
   */
  register(adapter: IExchangeAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Exchange adapter '${adapter.id}' is already registered`);
    }
    this.adapters.set(adapter.id, adapter);
    this.logger.info(`Exchange adapter registered: ${adapter.id} (${adapter.name})`);

    if (!this.defaultAdapterId) {
      this.defaultAdapterId = adapter.id;
      this.logger.info(`Default exchange set to: ${adapter.id}`);
      this.emit('adapter:default-changed', { id: adapter.id });
    }

    this.emit('adapter:registered', { id: adapter.id });
  }

  /**
   * Get an adapter by ID.
   * @throws if adapter not found
   */
  get(exchangeId: string): IExchangeAdapter {
    const adapter = this.adapters.get(exchangeId);
    if (!adapter) {
      throw new Error(
        `Exchange adapter '${exchangeId}' not found. Registered: [${Array.from(this.adapters.keys()).join(', ')}]`,
      );
    }
    return adapter;
  }

  /**
   * Get the default exchange adapter.
   * @throws if no default is set
   */
  getDefault(): IExchangeAdapter {
    if (!this.defaultAdapterId) {
      throw new Error('No default exchange adapter set');
    }
    return this.get(this.defaultAdapterId);
  }

  /**
   * Set the default exchange adapter.
   * @throws if adapter not registered
   */
  setDefault(exchangeId: string): void {
    if (!this.adapters.has(exchangeId)) {
      throw new Error(`Cannot set default: adapter '${exchangeId}' not registered`);
    }
    this.defaultAdapterId = exchangeId;
    this.logger.info(`Default exchange changed to: ${exchangeId}`);
    this.emit('adapter:default-changed', { id: exchangeId });
  }

  /** Get all registered adapters */
  getAll(): Map<string, IExchangeAdapter> {
    return new Map(this.adapters);
  }

  /** Check if an adapter is registered */
  has(exchangeId: string): boolean {
    return this.adapters.has(exchangeId);
  }

  /** Get the default adapter ID (or null if none set) */
  getDefaultId(): string | null {
    return this.defaultAdapterId;
  }

  /**
   * Remove an adapter from the registry.
   * If it was the default, clears the default.
   */
  remove(exchangeId: string): void {
    if (!this.adapters.has(exchangeId)) {
      this.logger.warn(`Cannot remove: adapter '${exchangeId}' not found`);
      return;
    }
    this.adapters.delete(exchangeId);
    if (this.defaultAdapterId === exchangeId) {
      this.defaultAdapterId = null;
      this.logger.warn('Default exchange cleared (removed adapter was the default)');
    }
    this.logger.info(`Exchange adapter removed: ${exchangeId}`);
    this.emit('adapter:removed', { id: exchangeId });
  }

  /**
   * Gracefully shut down all registered adapters.
   */
  async shutdown(): Promise<void> {
    this.logger.info(`Shutting down ${this.adapters.size} exchange adapter(s)...`);
    const shutdowns = Array.from(this.adapters.values()).map(async (adapter) => {
      try {
        await adapter.shutdown();
        this.logger.info(`Adapter '${adapter.id}' shut down successfully`);
      } catch (error) {
        this.logger.error(`Error shutting down adapter '${adapter.id}':`, error);
      }
    });
    await Promise.allSettled(shutdowns);
    this.adapters.clear();
    this.defaultAdapterId = null;
    this.logger.info('All exchange adapters shut down');
  }
}
