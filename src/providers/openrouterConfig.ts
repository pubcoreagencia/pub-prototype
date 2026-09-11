// src/providers/openrouterConfig.ts
import type { Task } from '../domain.js';
import type { ProviderTaskInput } from './types.js';
import {
  type ModelRoutingPolicy,
  type CandidateModelEntry,
  buildRoutingPolicy,
  resolveCandidateModels,
} from '../routing/index.js';

/**
 * Centralized loader for OpenRouter provider configuration.
 * Reads environment variables and provides strongly-typed defaults,
 * while utilizing the Model Routing Policy Engine.
 */
export interface OpenRouterConfig {
  primaryModel: string;
  fallbackModels: string[];
  maxRetries: number;
  baseDelayMs: number;
  policy?: ModelRoutingPolicy;
  candidateModels?: CandidateModelEntry[];
}

export function loadOpenRouterConfig(
  modelOverride?: string,
  task?: Partial<Task> | ProviderTaskInput,
  env: NodeJS.ProcessEnv = process.env
): OpenRouterConfig {
  const profileHint = task && 'routingProfile' in task ? task.routingProfile : undefined;
  const policy = buildRoutingPolicy(task, env, profileHint as any);
  const candidates = resolveCandidateModels(policy, modelOverride, env);

  // If candidate models were resolved via policy engine:
  if (candidates.length > 0) {
    const [first, ...rest] = candidates;
    return {
      primaryModel: first.model,
      fallbackModels: rest.map(c => c.model),
      maxRetries: policy.limits.maxRetriesPerModel,
      baseDelayMs: policy.limits.baseDelayMs,
      policy,
      candidateModels: candidates,
    };
  }

  // Fallback / legacy compatibility
  const primary = modelOverride?.trim() || env.OPENROUTER_MODEL?.trim() || 'openrouter/free';
  const fallbackRaw = env.OPENROUTER_FALLBACK_MODELS?.trim() ?? '';
  const fallbackModels = fallbackRaw
    ? fallbackRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const maxRetries = Number(env.OPENROUTER_MAX_RETRIES ?? 2);
  const baseDelayMs = Number(env.OPENROUTER_RETRY_BASE_DELAY_MS ?? 500);

  return {
    primaryModel: primary,
    fallbackModels,
    maxRetries: Math.max(1, maxRetries),
    baseDelayMs: Math.max(0, baseDelayMs),
    policy,
  };
}


