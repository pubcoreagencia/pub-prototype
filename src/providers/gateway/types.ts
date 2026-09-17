// src/providers/gateway/types.ts
import type { Task } from '../../domain.js';
import type { ProviderTaskInput, ProviderTaskResult } from '../types.js';
import type { StreamConsumer } from '../streaming/index.js';

export type GatewayKind = 'openrouter' | '9router';

export interface GatewayCandidate {
  gateway: GatewayKind;
  model: string;
  free: true;
  tier?: number;
  contextTokens?: number;
  maxRetries?: number;
}

export interface GatewayHealthResult {
  available: boolean;
  details: string;
}

export interface GatewayModelInfo {
  id: string;
  name?: string;
  contextLength?: number;
  free: boolean;
  pricing?: {
    prompt: string | number;
    completion: string | number;
  };
}

export interface GatewayProvider {
  readonly kind: GatewayKind;
  readonly model: string | null;
  readonly baseUrl: string;

  execute(
    task: Task | ProviderTaskInput,
    workspace: string,
    options?: { signal?: AbortSignal; consumer?: StreamConsumer; modelOverride?: string }
  ): Promise<ProviderTaskResult>;

  health(): Promise<GatewayHealthResult>;

  listModels(): Promise<GatewayModelInfo[]>;

  capabilities(): string[];

  metadata(): Record<string, string | null | undefined>;
}
