// src/routing/engine.ts
import type { Task } from '../domain.js';
import {
  type CandidateModelEntry,
  type ModelRoutingPolicy,
  type TaskRoutingProfile,
} from './types.js';
import { MODEL_REGISTRY, filterCapableModels } from './registry.js';
import { classifyTaskProfile } from './classifier.js';
import { reorderTier1ModelsWithCalibration } from './calibration.js';
import type { SystemObservabilityReport } from './observability.js';

/**
 * Default Curated Tier 1 Free models per task profile.
 */
export const DEFAULT_TIER1_MODELS: Record<TaskRoutingProfile, string[]> = {
  coding: [
    'minimax/minimax-m2.7:free',
    'poolside/laguna-s-2.1-20260720:free',
    'cohere/north-mini-code:free',
  ],
  reasoning: [
    'minimax/minimax-m3:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
  ],
  fast_prototype: [
    'cohere/north-mini-code:free',
    'minimax/minimax-m2.7:free',
  ],
  general: [
    'minimax/minimax-m2.7:free',
    'minimax/minimax-m3:free',
  ],
};

/**
 * Default Tier 3 Paid fallback models.
 */
export const DEFAULT_PAID_MODELS = [
  'openai/gpt-4o-mini',
  'anthropic/claude-3.5-haiku',
  'deepseek/deepseek-chat',
];

/**
 * Build a strongly-typed ModelRoutingPolicy from task and environment variables.
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
    tier1ExplicitFree = envTier1.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    tier1ExplicitFree = [...DEFAULT_TIER1_MODELS[profile]];
  }

  // Tier 2: OpenRouter Free Pool ('openrouter/free') as safety net
  const tier2OpenRouterFreePool = env.OPENROUTER_FREE_POOL_ENABLED !== 'false';

  // Tier 3: Paid Fallback (Strictly guarded, enabled by default when API key is present unless explicitly disabled)
  const hasKey = Boolean(env.OPENROUTER_API_KEY?.trim());
  const paidEnabled = env.OPENROUTER_PAID_FALLBACK_ENABLED === 'true' || (hasKey && env.OPENROUTER_PAID_FALLBACK_ENABLED !== 'false');
  const envTier3 = env.OPENROUTER_PAID_MODELS?.trim();
  let tier3PaidFallback: string[] = [];
  if (paidEnabled) {
    if (envTier3) {
      tier3PaidFallback = envTier3.split(',').map(s => s.trim()).filter(Boolean);
    } else {
      tier3PaidFallback = [...DEFAULT_PAID_MODELS];
    }
  }

  const maxRetriesPerModel = Math.max(1, Number(env.OPENROUTER_MAX_RETRIES ?? 2));
  const maxPaidAttempts = Math.max(0, Number(env.OPENROUTER_PAID_MAX_ATTEMPTS ?? 1));
  const maxCostPerTaskUsd = env.OPENROUTER_MAX_COST_PER_TASK_USD
    ? Number(env.OPENROUTER_MAX_COST_PER_TASK_USD)
    : 0.25;
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
 * 3. Tier 3 Paid Fallback Models (if enabled and guarded)
 */
export function resolveCandidateModels(
  policy: ModelRoutingPolicy,
  legacyModelOverride?: string,
  env: NodeJS.ProcessEnv = process.env,
  observabilityReport?: SystemObservabilityReport
): CandidateModelEntry[] {
  // If a specific explicit model override is requested (e.g., via CLI, test or OPENROUTER_MODEL env), honor it directly
  const explicitModel = legacyModelOverride || (env.OPENROUTER_MODEL && env.OPENROUTER_MODEL !== 'openrouter/free' ? env.OPENROUTER_MODEL : undefined);
  if (explicitModel && explicitModel !== 'openrouter/free') {
    const isFree = explicitModel.includes(':free') || explicitModel.endsWith('/free');
    const result: CandidateModelEntry[] = [
      {
        model: explicitModel,
        tier: isFree ? 1 : 3,
        free: isFree,
        maxRetries: policy.limits.maxRetriesPerModel,
      },
    ];

    // Also append legacy OPENROUTER_FALLBACK_MODELS if provided
    const fallbackRaw = env.OPENROUTER_FALLBACK_MODELS?.trim();
    if (fallbackRaw) {
      const extraFallbacks = fallbackRaw.split(',').map(s => s.trim()).filter(Boolean);
      for (const fb of extraFallbacks) {
        const fbFree = fb.includes(':free') || fb.endsWith('/free');
        result.push({
          model: fb,
          tier: fb === 'openrouter/free' ? 2 : fbFree ? 1 : 3,
          free: fbFree,
          maxRetries: policy.limits.maxRetriesPerModel,
        });
      }
    }

    return result;
  }

  const candidates: CandidateModelEntry[] = [];

  // 1. Tier 1: Filtered curated free models (Safe Empirical Calibration applied if enabled)
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

  // 3. Tier 3: Guarded Paid Fallback
  if (policy.tiers.tier3PaidFallback.length > 0 && policy.limits.maxPaidAttempts > 0) {
    const validTier3 = filterCapableModels(policy.tiers.tier3PaidFallback, {
      requireToolCalling: policy.capabilities.requireToolCalling,
      minContextTokens: policy.capabilities.minContextTokens,
      profile: policy.profile,
    });

    const maxPaid = Math.min(validTier3.length, policy.limits.maxPaidAttempts);
    for (let i = 0; i < maxPaid; i++) {
      candidates.push({
        model: validTier3[i],
        tier: 3,
        free: false,
        maxRetries: 1, // Paid attempts are single-shot by default to protect budget
      });
    }
  }

  return candidates;
}

/**
 * Budget and Paid Fallback Guard.
 * Evaluates whether a paid attempt is permitted based on:
 * 1. Tier 3 paid models being configured and enabled
 * 2. Total paid attempts executed so far being below maxPaidAttempts limit
 * 3. Accumulated spent cost + current estimated cost remaining within maxCostPerTaskUsd budget
 */
export function canUsePaidFallback(
  policy: ModelRoutingPolicy,
  currentPaidAttemptsUsed: number,
  accumulatedCostUsd: number = 0,
  nextEstimatedCostUsd?: number
): boolean {
  if (policy.tiers.tier3PaidFallback.length === 0) return false;
  if (currentPaidAttemptsUsed >= policy.limits.maxPaidAttempts) return false;

  const totalProjectedCost = accumulatedCostUsd + (nextEstimatedCostUsd ?? 0);
  if (
    policy.limits.maxCostPerTaskUsd !== undefined &&
    totalProjectedCost > policy.limits.maxCostPerTaskUsd
  ) {
    return false;
  }
  return true;
}
