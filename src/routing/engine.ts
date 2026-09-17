// src/routing/engine.ts
import type { Task } from '../domain.js';
import {
  type CandidateModelEntry,
  type ModelRoutingPolicy,
  type TaskRoutingProfile,
} from './types.js';
import { MODEL_REGISTRY, filterCapableModels, isFreeModel } from './registry.js';
import { classifyTaskProfile } from './classifier.js';
import { reorderTier1ModelsWithCalibration } from './calibration.js';
import type { SystemObservabilityReport } from './observability.js';

/**
 * Default Curated Tier 1 Free models per task profile.
 * Maintained with high-availability verified models.
 */
export const DEFAULT_TIER1_MODELS: Record<TaskRoutingProfile, string[]> = {
  coding: [
    'cohere/north-mini-code:free',
    'nex-agi/nex-n2.5-pro:free',
    'qwen/qwen3.8-27b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
    'nex-agi/nex-n2.5-mini:free',
    'z-ai/glm-5.2:free',
  ],
  reasoning: [
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'qwen/qwen3.8-27b:free',
    'nex-agi/nex-n2.5-pro:free',
    'z-ai/glm-5.2:free',
  ],
  fast_prototype: [
    'cohere/north-mini-code:free',
    'nex-agi/nex-n2.5-mini:free',
    'nex-agi/nex-n2.5-pro:free',
    'liquid/lfm-2.5-2.6b:free',
  ],
  general: [
    'cohere/north-mini-code:free',
    'nex-agi/nex-n2.5-pro:free',
    'qwen/qwen3.8-27b:free',
    'nvidia/nemotron-3-super-120b-a12b:free',
  ],
};

/**
 * Default Tier 3 Paid fallback models.
 * NOTE: In PUB Prototype production, execution is strictly 100% FREE.
 * Paid models are NEVER used for automatic fallback or task execution.
 */
export const DEFAULT_PAID_MODELS: string[] = [];

/**
 * Build a strongly-typed ModelRoutingPolicy from task and environment variables.
 * Enforces PP_COST_POLICY: 100% FREE execution. Paid fallback is disabled.
 */
export function buildRoutingPolicy(
  task?: Partial<Task> | { routingProfile?: TaskRoutingProfile; [key: string]: unknown },
  env: NodeJS.ProcessEnv = process.env,
  profileOverride?: TaskRoutingProfile
): ModelRoutingPolicy {
  const profile = profileOverride || (task ? classifyTaskProfile(task) : 'general');

  // Custom Tier 1 overrides from env (e.g., OPENROUTER_TIER1_MODELS or legacy OPENROUTER_FALLBACK_MODELS)
  const envTier1 = env.OPENROUTER_TIER1_MODELS?.trim();
  let tier1ExplicitFree: string[];
  if (envTier1) {
    tier1ExplicitFree = envTier1.split(',').map(s => s.trim()).filter(m => Boolean(m) && isFreeModel(m));
  } else {
    tier1ExplicitFree = [...DEFAULT_TIER1_MODELS[profile]].filter(isFreeModel);
  }

  // Tier 2: OpenRouter Free Pool ('openrouter/free') as safety net
  const tier2OpenRouterFreePool = env.OPENROUTER_FREE_POOL_ENABLED !== 'false';

  // Tier 3: Paid Fallback is PERMANENTLY FORBIDDEN by PP policy (100% FREE ONLY).
  const tier3PaidFallback: string[] = [];

  const maxRetriesPerModel = Math.max(1, Number(env.OPENROUTER_MAX_RETRIES ?? 2));
  const maxPaidAttempts = 0; // Strictly 0: No paid attempts are ever permitted
  const maxCostPerTaskUsd = 0; // Strictly 0: Budget for paid models is permanently $0.00
  const baseDelayMs = Math.max(0, Number(env.OPENROUTER_RETRY_BASE_DELAY_MS ?? 500));
  const minContextTokens = Number(env.OPENROUTER_MIN_CONTEXT_TOKENS ?? 32768);

  return {
    profile,
    tiers: {
      tier1ExplicitFree,
      tier2OpenRouterFreePool,
      tier3PaidFallback,
    },
    limits: {
      maxRetriesPerModel,
      maxPaidAttempts,
      maxCostPerTaskUsd,
      baseDelayMs,
    },
    capabilities: {
      requireToolCalling: true,
      minContextTokens,
    },
  };
}

/**
 * Resolve concrete candidate models in priority sequence based on policy.
 *
 * Sequence:
 * 1. Tier 1 Curated Free Models (filtered by capability)
 * 2. Tier 2 OpenRouter Free Pool (if enabled)
 *
 * ALL candidates returned MUST be FREE models.
 */
export function resolveCandidateModels(
  policy: ModelRoutingPolicy,
  legacyModelOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
  observabilityReport?: SystemObservabilityReport
): CandidateModelEntry[] {
  // If a specific explicit model override is requested, enforce that it is FREE
  const explicitModel = legacyModelOverride || (env.OPENROUTER_MODEL && env.OPENROUTER_MODEL !== 'openrouter/free' ? env.OPENROUTER_MODEL : undefined);
  if (explicitModel && explicitModel !== 'openrouter/free') {
    if (!isFreeModel(explicitModel)) {
      console.warn(`[RoutingPolicy] Rejected paid model override '${explicitModel}': PP execution is strictly 100% FREE.`);
    } else {
      const result: CandidateModelEntry[] = [
        {
          model: explicitModel,
          tier: 1,
          free: true,
          maxRetries: policy.limits.maxRetriesPerModel,
        },
      ];

      const fallbackRaw = env.OPENROUTER_FALLBACK_MODELS?.trim();
      if (fallbackRaw) {
        const extraFallbacks = fallbackRaw.split(',').map(s => s.trim()).filter(Boolean);
        for (const fb of extraFallbacks) {
          if (isFreeModel(fb)) {
            result.push({
              model: fb,
              tier: fb === 'openrouter/free' ? 2 : 1,
              free: true,
              maxRetries: policy.limits.maxRetriesPerModel,
            });
          }
        }
      }

      return result;
    }
  }

  const candidates: CandidateModelEntry[] = [];

  // 1. Tier 1: Filtered curated free models
  const capableTier1 = filterCapableModels(policy.tiers.tier1ExplicitFree, {
    requireToolCalling: policy.capabilities.requireToolCalling,
    minContextTokens: policy.capabilities.minContextTokens,
    profile: policy.profile,
  });

  const calibratedTier1 = reorderTier1ModelsWithCalibration(
    capableTier1,
    policy.profile,
    observabilityReport,
    {
      enabled: env.OPENROUTER_CALIBRATION_ENABLED === 'true',
      minSampleSize: Number(env.OPENROUTER_CALIBRATION_MIN_SAMPLES ?? 10),
    }
  );

  for (const m of calibratedTier1) {
    candidates.push({
      model: m,
      tier: 1,
      free: true,
      maxRetries: policy.limits.maxRetriesPerModel,
    });
  }

  // 2. Tier 2: OpenRouter Free Pool Safety Net
  if (policy.tiers.tier2OpenRouterFreePool) {
    candidates.push({
      model: 'openrouter/free',
      tier: 2,
      free: true,
      maxRetries: policy.limits.maxRetriesPerModel,
    });
  }

  return candidates.filter(c => c.free && isFreeModel(c.model));
}

export function canUsePaidFallback(
  _policy?: ModelRoutingPolicy,
  _currentPaidAttemptsUsed?: number,
  _accumulatedCostUsd: number = 0,
  _nextEstimatedCostUsd?: number
): boolean {
  return false;
}
