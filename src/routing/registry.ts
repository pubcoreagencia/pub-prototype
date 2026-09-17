// src/routing/registry.ts
import type { ModelCapabilityDefinition, TaskRoutingProfile } from './types.js';

/**
 * Centralized Model Capability Registry.
 * Contains curated metadata, supported capabilities, context windows, and profiles.
 *
 * Tier 1: Curated Free models
 * Tier 2: Free Router Pool ('openrouter/free', 'router/free-pool')
 * Tier 3: Guarded Paid models (PERMANENTLY DISABLED in PP: 100% FREE ONLY)
 */
export const MODEL_REGISTRY: ModelCapabilityDefinition[] = [
  // --- TIER 1: OPENROUTER CURATED FREE MODELS ---
  {
    model: 'google/gemma-4-26b-a4b-it:free',
    profiles: ['coding', 'fast_prototype', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'google',
    notes: 'Curated free high-context coding model',
  },
  {
    model: 'google/gemma-4-31b-it:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'google',
    notes: 'Curated free high-context reasoning and coding model',
  },
  {
    model: 'poolside/laguna-s-2.1:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'poolside',
    notes: 'Coding-focused agent model',
  },
  {
    model: 'poolside/laguna-s-2.1-20260720:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'poolside',
    notes: 'Coding-focused agent model legacy alias',
  },
  {
    model: 'cohere/north-mini-code:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 256000,
    enabled: true,
    vendor: 'cohere',
    notes: 'Specialized code completion and tool execution',
  },
  {
    model: 'nex-agi/nex-n2.5-pro:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'nex-agi',
    notes: 'High-capability multi-task model',
  },
  {
    model: 'nex-agi/nex-n2.5-mini:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'nex-agi',
    notes: 'Fast prototyping model',
  },
  {
    model: 'qwen/qwen3.8-27b:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'qwen',
    notes: 'Qwen reasoning and code instruction model',
  },
  {
    model: 'thinkingmachines/inkling:free',
    profiles: ['reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 1000000,
    enabled: true,
    vendor: 'thinkingmachines',
    notes: '1M context reasoning model',
  },
  {
    model: 'nvidia/nemotron-3.5-lightning:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 1000000,
    enabled: true,
    vendor: 'nvidia',
    notes: 'Fast 1M context code and reasoning model',
  },
  {
    model: 'minimax/minimax-m2.7:free',
    profiles: ['coding', 'fast_prototype', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 131072,
    enabled: false, // REMOVED FROM ACTIVE CATALOG: Upstream 404
    vendor: 'minimax',
    notes: 'Curated free model (upstream currently unavailable)',
  },
  {
    model: 'minimax/minimax-m3:free',
    profiles: ['reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 131072,
    enabled: false,
    vendor: 'minimax',
    notes: 'Deep reasoning, architecture analysis, and multi-step planning',
  },
  {
    model: 'nvidia/nemotron-3-super-120b-a12b:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'nvidia',
    notes: 'Live-verified high speed coding & reasoning free model',
  },
  {
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 1000000,
    enabled: true,
    vendor: 'nvidia',
    notes: 'Live-verified 1M context ultra reasoning model',
  },
  {
    model: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    profiles: ['coding', 'reasoning'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 256000,
    enabled: true,
    vendor: 'nvidia',
    notes: 'Live-verified fast reasoning model',
  },
  {
    model: 'z-ai/glm-5.2:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 32768,
    enabled: true,
    vendor: 'z-ai',
    notes: 'Live-verified GLM free model',
  },
  {
    model: 'liquid/lfm-2.5-2.6b:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 65536,
    enabled: true,
    vendor: 'liquid',
    notes: 'Live-verified lightweight model',
  },

  // --- TIER 1: 9ROUTER LIVE-VERIFIED FREE MODELS ---
  {
    model: 'kc/cohere/north-mini-code:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 256000,
    enabled: true,
    vendor: 'cohere',
    notes: '9router live-verified free Cohere code model',
  },
  {
    model: 'kc/nvidia/nemotron-3-super-120b-a12b:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'nvidia',
    notes: '9router live-verified free Nemotron super model',
  },
  {
    model: 'kc/kilo-auto/free',
    profiles: ['coding', 'fast_prototype', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 131072,
    enabled: true,
    vendor: '9router',
    notes: '9router live-verified free auto model pool',
  },
  {
    model: 'kc/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    profiles: ['coding', 'reasoning'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 256000,
    enabled: true,
    vendor: 'nvidia',
    notes: '9router live-verified free Nemotron nano reasoning model',
  },
  {
    model: 'kc/dots-studio/dots-3-note-preview:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 512000,
    enabled: true,
    vendor: 'dots-studio',
    notes: '9router live-verified free 512k context model',
  },
  {
    model: 'kc/inclusionai/ling-3.0-flash-fin:free',
    profiles: ['coding', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'inclusionai',
    notes: '9router live-verified free Ling flash model',
  },
  {
    model: 'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 1000000,
    enabled: true,
    vendor: 'nvidia',
    notes: '9router live-verified free Nemotron 3 Ultra 550B model',
  },
  {
    model: 'kc/nvidia/nemotron-3.5-lightning:free',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 1000000,
    enabled: true,
    vendor: 'nvidia',
    notes: '9router live-verified free Nemotron 3.5 1M context model',
  },
  {
    model: 'kc/nex-agi/nex-n2.5-pro:free',
    profiles: ['coding', 'fast_prototype', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'nex-agi',
    notes: '9router live-verified free Nex Pro model',
  },
  {
    model: 'kc/nex-agi/nex-n2.5-mini:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 262144,
    enabled: true,
    vendor: 'nex-agi',
    notes: '9router live-verified free Nex Mini model',
  },

  // --- TIER 2: FREE ROUTER POOLS ---
  {
    model: 'openrouter/free',
    profiles: ['coding', 'reasoning', 'fast_prototype', 'general'],
    tier: 2,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 200000,
    enabled: true,
    vendor: 'openrouter',
    notes: 'Dynamic free router pool across available community endpoints',
  },
  {
    model: 'router/free-pool',
    profiles: ['coding', 'reasoning', 'fast_prototype', 'general'],
    tier: 2,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 131072,
    enabled: true,
    vendor: '9router',
    notes: '9router dynamic free model pool',
  },

  // --- HISTORICAL PAID MODELS (PERMANENTLY DISABLED IN PP: 100% FREE ONLY) ---
  {
    model: 'openai/gpt-4o-mini',
    profiles: ['coding', 'reasoning', 'fast_prototype', 'general'],
    tier: 3,
    free: false,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 128000,
    enabled: false, // PERMANENTLY DISABLED: PP is strictly 100% FREE
    vendor: 'openai',
    notes: 'Paid model permanently forbidden in PP production',
  },
  {
    model: 'anthropic/claude-3.5-haiku',
    profiles: ['coding', 'reasoning', 'fast_prototype', 'general'],
    tier: 3,
    free: false,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 200000,
    enabled: false, // PERMANENTLY DISABLED: PP is strictly 100% FREE
    vendor: 'anthropic',
    notes: 'Paid model permanently forbidden in PP production',
  },
  {
    model: 'deepseek/deepseek-chat',
    profiles: ['coding', 'reasoning', 'general'],
    tier: 3,
    free: false,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 64000,
    enabled: false, // PERMANENTLY DISABLED: PP is strictly 100% FREE
    vendor: 'deepseek',
    notes: 'Paid model permanently forbidden in PP production',
  },
];

/**
 * Find model capabilities by identifier.
 */
export function getModelCapability(modelName: string): ModelCapabilityDefinition | undefined {
  const norm = modelName.trim().toLowerCase();
  return MODEL_REGISTRY.find(m => m.model.toLowerCase() === norm);
}

/**
 * Filter models that satisfy capability requirements (toolCalling, context window, enabled status).
 */
export function filterCapableModels(
  models: string[],
  options: {
    requireToolCalling?: boolean;
    minContextTokens?: number;
    profile?: TaskRoutingProfile;
  } = {}
): string[] {
  const requireTool = options.requireToolCalling ?? true;
  const minContext = options.minContextTokens ?? 32768;

  return models.filter(modelId => {
    if (modelId.toLowerCase() === 'openrouter/free' || modelId.toLowerCase() === 'router/free-pool') return true;

    const cap = getModelCapability(modelId);
    if (!cap) {
      return true;
    }

    if (!cap.enabled) return false;
    if (requireTool && !cap.toolCalling) return false;
    if (cap.contextWindow < minContext) return false;
    if (options.profile && !cap.profiles.includes(options.profile)) {
      if (!cap.profiles.includes('general')) return false;
    }

    return true;
  });
}

/**
 * Checks whether a given model identifier corresponds to a FREE model (by syntax, pool, or capability).
 */
export function isFreeModel(modelName?: string | null): boolean {
  if (!modelName || typeof modelName !== 'string') return false;
  const trimmed = modelName.trim().toLowerCase();
  if (trimmed === 'openrouter/free' || trimmed === 'router/free-pool') return true;
  if (trimmed.includes(':free') || trimmed.endsWith('/free')) return true;
  // Allow test / mock models in test environment or mock prefix
  if (trimmed === 'mock-model' || trimmed.startsWith('mock-') || trimmed.startsWith('candidate-')) return true;

  const cap = getModelCapability(trimmed);
  if (cap && cap.free === true) return true;

  return false;
}

/**
 * Checks whether a given model identifier is live-verified in the active PP catalog
 * or belongs to a dynamic free pool / mock test harness.
 */
export function isVerifiedFreeModel(modelName?: string | null): boolean {
  if (!modelName || typeof modelName !== 'string') return false;
  const trimmed = modelName.trim().toLowerCase();

  // Test / mock fixtures always allowed in test environment
  if (trimmed === 'mock-model' || trimmed.startsWith('mock-') || trimmed.startsWith('candidate-')) return true;

  // Dynamic router pools
  if (trimmed === 'openrouter/free' || trimmed === 'router/free-pool') return true;

  // Curated active models in registry that are free AND enabled
  const cap = getModelCapability(trimmed);
  if (cap) {
    return cap.free === true && cap.enabled === true;
  }

  return false;
}

/**
 * Asserts that a model identifier is FREE.
 * Throws an Error with code PAID_MODEL_FORBIDDEN if the model is not free.
 */
export function assertFreeModel(modelName?: string | null): void {
  if (!isFreeModel(modelName)) {
    const err = new Error(`PAID_MODEL_FORBIDDEN: PP execution is strictly 100% FREE. Model '${modelName}' is not free.`);
    (err as any).code = 'PAID_MODEL_FORBIDDEN';
    throw err;
  }
}

/**
 * Asserts that a model identifier is both FREE and VERIFIED in the PP catalog.
 * Throws PAID_MODEL_FORBIDDEN if the model is paid.
 * Throws UNVERIFIED_FREE_MODEL_FORBIDDEN if the model is free but not verified in the active catalog.
 */
export function assertVerifiedFreeModel(modelName?: string | null): void {
  assertFreeModel(modelName);

  if (!isVerifiedFreeModel(modelName)) {
    const err = new Error(
      `UNVERIFIED_FREE_MODEL_FORBIDDEN: Model '${modelName}' is not in the active verified FREE catalog. PP strictly rejects unverified models prior to network execution.`
    );
    (err as any).code = 'UNVERIFIED_FREE_MODEL_FORBIDDEN';
    throw err;
  }
}
