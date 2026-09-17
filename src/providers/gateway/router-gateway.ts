// src/providers/gateway/router-gateway.ts
import type { Task } from '../../domain.js';
import type { ProviderTaskInput, ProviderTaskResult } from '../types.js';
import type { StreamConsumer } from '../streaming/index.js';
import { RouterProvider } from '../router.js';
import type { GatewayProvider, GatewayKind, GatewayHealthResult, GatewayModelInfo } from './types.js';
import { assertFreeModel } from '../../routing/registry.js';
import { DEFAULT_ROUTER_BASE_URL, normalizeBaseUrl } from '../shared.js';

export class RouterGatewayAdapter implements GatewayProvider {
  readonly kind: GatewayKind = '9router';
  private readonly provider: RouterProvider;
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(provider?: RouterProvider) {
    this.provider = provider ?? new RouterProvider();
    this.baseUrl = this.provider.baseUrl || normalizeBaseUrl(process.env.ROUTER_BASE_URL, DEFAULT_ROUTER_BASE_URL);
    this.apiKey = process.env.ROUTER_API_KEY?.trim() || undefined;
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

      return data.data.map(m => ({
        id: m.id,
        name: m.name || m.id,
        contextLength: m.context_length || 32768,
        free: true, // 9router models designated for PP routing are strictly free
      }));
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
