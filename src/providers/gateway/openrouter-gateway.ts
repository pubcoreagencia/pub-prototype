// src/providers/gateway/openrouter-gateway.ts
import type { Task } from '../../domain.js';
import type { ProviderTaskInput, ProviderTaskResult } from '../types.js';
import type { StreamConsumer } from '../streaming/index.js';
import { OpenRouterProvider } from '../openrouter.js';
import type { GatewayProvider, GatewayKind, GatewayHealthResult, GatewayModelInfo } from './types.js';
import { assertFreeModel } from '../../routing/registry.js';
import { DEFAULT_OPENROUTER_BASE_URL, normalizeBaseUrl, resolveOpenRouterApiKey } from '../shared.js';

export class OpenRouterGatewayAdapter implements GatewayProvider {
  readonly kind: GatewayKind = 'openrouter';
  private readonly provider: OpenRouterProvider;
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(provider?: OpenRouterProvider) {
    this.provider = provider ?? new OpenRouterProvider();
    this.baseUrl = this.provider.baseUrl || normalizeBaseUrl(process.env.OPENROUTER_BASE_URL, DEFAULT_OPENROUTER_BASE_URL);
    this.apiKey = resolveOpenRouterApiKey(process.env.OPENROUTER_API_KEY);
  }

  get model(): string | null {
    return this.provider.model;
  }

  async execute(
    task: Task | ProviderTaskInput,
    workspace: string,
    options?: { signal?: AbortSignal; consumer?: StreamConsumer; modelOverride?: string }
  ): Promise<ProviderTaskResult> {
    const effectiveModel = options?.modelOverride ?? (task as any).modelOverride ?? this.model;
    if (effectiveModel) {
      assertFreeModel(effectiveModel);
    }
    const taskInput: ProviderTaskInput = {
      ...task,
      ...(effectiveModel ? { modelOverride: effectiveModel } : {}),
    };
    return this.provider.execute(taskInput, workspace, {
      signal: options?.signal,
      consumer: options?.consumer,
    });
  }

  async health(): Promise<GatewayHealthResult> {
    return this.provider.health();
  }

  async listModels(): Promise<GatewayModelInfo[]> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['authorization'] = `Bearer ${this.apiKey}`;
      }
      const response = await fetch(`${this.baseUrl}/models`, { headers });
      if (!response.ok) {
        return [];
      }
      const data = await response.json() as { data?: Array<any> };
      if (!Array.isArray(data?.data)) return [];

      return data.data.map(m => {
        const promptPrice = m.pricing?.prompt;
        const completionPrice = m.pricing?.completion;
        const isFree = (promptPrice === '0' || promptPrice === 0) && (completionPrice === '0' || completionPrice === 0);
        return {
          id: m.id,
          name: m.name,
          contextLength: m.context_length,
          free: isFree,
          pricing: {
            prompt: promptPrice,
            completion: completionPrice,
          },
        };
      });
    } catch {
      return [];
    }
  }

  capabilities(): string[] {
    return this.provider.capabilities();
  }

  metadata(): Record<string, string | null | undefined> {
    return {
      ...this.provider.metadata(),
      gatewayKind: this.kind,
    };
  }
}
