/**
 * Wrapped Anthropic API client with token accounting and cost tracking.
 *
 * Reads ANTHROPIC_API_KEY from process.env at runtime — never logged or
 * committed. All calls flow through `callModel()` which records token usage
 * in the CostTracker before returning the response.
 */

import { Logger } from '../core/logger';
import type { AgenticComponent, TokenUsage } from './types';
import type { CostTracker } from './cost-tracker';

/** Minimal message shape matching the Anthropic Messages API. */
export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  /** Prompt caching: prefix blocks to cache. */
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicResponse {
  id: string;
  content: Array<{ type: string; text: string }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

export interface AnthropicBatchRequest {
  custom_id: string;
  params: AnthropicRequest;
}

export interface AnthropicBatchResponse {
  id: string;
  type: string;
  processing_status: string;
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  ended_at: string | null;
  results_url: string | null;
}

/**
 * Low-level HTTP call to the Anthropic Messages API.
 * Extracted so tests can mock it without replacing the entire client.
 */
export interface AnthropicTransport {
  createMessage(request: AnthropicRequest): Promise<AnthropicResponse>;
  createBatch(requests: AnthropicBatchRequest[]): Promise<AnthropicBatchResponse>;
  getBatch(batchId: string): Promise<AnthropicBatchResponse>;
  getBatchResults(resultsUrl: string): Promise<Array<{
    custom_id: string;
    result: { type: string; message?: AnthropicResponse; error?: { type: string; message: string } };
  }>>;
}

/**
 * Production transport that calls the Anthropic REST API.
 * Requires ANTHROPIC_API_KEY in process.env.
 */
export function createHttpTransport(): AnthropicTransport {
  const getApiKey = (): string => {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY is not set');
    return key;
  };

  const headers = () => ({
    'x-api-key': getApiKey(),
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  });

  const BASE_URL = 'https://api.anthropic.com/v1';

  return {
    async createMessage(request: AnthropicRequest): Promise<AnthropicResponse> {
      const resp = await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(request),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Anthropic API error ${resp.status}: ${body}`);
      }
      return resp.json() as Promise<AnthropicResponse>;
    },

    async createBatch(requests: AnthropicBatchRequest[]): Promise<AnthropicBatchResponse> {
      const resp = await fetch(`${BASE_URL}/messages/batches`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ requests }),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Anthropic Batch API error ${resp.status}: ${body}`);
      }
      return resp.json() as Promise<AnthropicBatchResponse>;
    },

    async getBatch(batchId: string): Promise<AnthropicBatchResponse> {
      const resp = await fetch(`${BASE_URL}/messages/batches/${batchId}`, {
        method: 'GET',
        headers: headers(),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Anthropic Batch API error ${resp.status}: ${body}`);
      }
      return resp.json() as Promise<AnthropicBatchResponse>;
    },

    async getBatchResults(resultsUrl: string): Promise<Array<{
      custom_id: string;
      result: { type: string; message?: AnthropicResponse; error?: { type: string; message: string } };
    }>> {
      const resp = await fetch(resultsUrl, {
        method: 'GET',
        headers: headers(),
      });
      if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`Anthropic Batch results error ${resp.status}: ${body}`);
      }
      const text = await resp.text();
      return text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    },
  };
}

/**
 * High-level client that wraps every call with cost tracking.
 */
export class AnthropicClient {
  constructor(
    private readonly transport: AnthropicTransport,
    private readonly costTracker: CostTracker,
    private readonly logger: Logger,
  ) {}

  /**
   * Send a Messages API request and record token usage.
   * Returns null if the monthly cost cap has been reached.
   */
  async callModel(
    component: AgenticComponent,
    request: AnthropicRequest,
  ): Promise<AnthropicResponse | null> {
    if (this.costTracker.isCapReached()) {
      this.logger.warn('Agentic monthly cost cap reached; skipping call', { component });
      return null;
    }

    const start = Date.now();
    let response: AnthropicResponse;
    try {
      response = await this.transport.createMessage(request);
    } catch (err) {
      const duration = Date.now() - start;
      await this.costTracker.recordCall({
        component,
        model: request.model,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        durationMs: duration,
        isBatch: false,
        error: (err as Error).message,
      });
      throw err;
    }

    const duration = Date.now() - start;
    const usage: TokenUsage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_input_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens: response.usage.cache_creation_input_tokens ?? 0,
    };

    await this.costTracker.recordCall({
      component,
      model: request.model,
      usage,
      durationMs: duration,
      isBatch: false,
    });

    return response;
  }

  /**
   * Submit a batch request (50% cost discount, up to 24h processing).
   */
  async submitBatch(
    component: AgenticComponent,
    requests: AnthropicBatchRequest[],
  ): Promise<AnthropicBatchResponse | null> {
    if (this.costTracker.isCapReached()) {
      this.logger.warn('Agentic monthly cost cap reached; skipping batch', { component });
      return null;
    }

    return this.transport.createBatch(requests);
  }

  async getBatchStatus(batchId: string): Promise<AnthropicBatchResponse> {
    return this.transport.getBatch(batchId);
  }

  async getBatchResults(resultsUrl: string): Promise<Array<{
    custom_id: string;
    result: { type: string; message?: AnthropicResponse; error?: { type: string; message: string } };
  }>> {
    return this.transport.getBatchResults(resultsUrl);
  }
}
