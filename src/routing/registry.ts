// src/routing/registry.ts
import type { ModelCapabilityDefinition, TaskRoutingProfile } from './types.js';

/**
 * Centralized Model Capability Registry.
 * Contains curated metadata, supported capabilities, context windows, and profiles.
 *
 * Tier 1: Curated Free models
 * Tier 2: OpenRouter Free Pool ('openrouter/free')
 * Tier 3: Guarded Paid models (e.g., gpt-4o-mini, claude-3-5-haiku, deepseek-chat)
 */
export const MODEL_REGISTRY: ModelCapabilityDefinition[] = [
  // --- TIER 1: CURATED FREE MODELS ---
  {
    model: 'minimax/minimax-m2.7:free',
    profiles: ['coding', 'fast_prototype', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 131072,
    enabled: true,
    vendor: 'minimax',
    notes: 'High-capability curated free model for coding and multi-file projects',
  },
  {
    model: 'poolside/laguna-s-2.1-20260720:free',
    profiles: ['coding'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 32768,
    enabled: true,
    vendor: 'poolside',
    notes: 'Coding-focused agent model',
  },
  {
    model: 'cohere/north-mini-code:free',
    profiles: ['coding', 'fast_prototype'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 32768,
    enabled: true,
    vendor: 'cohere',
    notes: 'Specialized code completion and tool execution',
  },
  {
    model: 'minimax/minimax-m3:free',
    profiles: ['reasoning', 'general'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 131072,
    enabled: true,
    vendor: 'minimax',
    notes: 'Deep reasoning, architecture analysis, and multi-step planning',
  },
  {
    model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    profiles: ['reasoning'],
    tier: 1,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 32768,
    enabled: true,
    vendor: 'nvidia',
    notes: 'Large parameter reasoning model',
  },

  // --- TIER 2: OPENROUTER FREE POOL SAFETY NET ---
  {
    model: 'openrouter/free',
    profiles: ['coding', 'reasoning', 'fast_prototype', 'general'],
    tier: 2,
    free: true,
    toolCalling: true,
    systemPrompt: true,
    contextWindow: 32768,
    enabled: true,
    vendor: 'openrouter',
    notes: 'Dynamic free router pool across available community endpoints',
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
    // Dynamic openrouter/free is treated as capable by default
    if (modelId.toLowerCase() === 'openrouter/free') return true;

    const cap = getModelCapability(modelId);
    if (!cap) {
      // If not in registry, allow it only if it is an explicit custom override
      return true;
    }

    if (!cap.enabled) return false;
    if (requireTool && !cap.toolCalling) return false;
    if (cap.contextWindow < minContext) return false;
    if (options.profile && !cap.profiles.includes(options.profile)) {
      // If profile is specified, verify compatibility unless general model
      if (!cap.profiles.includes('general')) return false;
    }

    return true;
  });
}

/**
 * Checks whether a given model identifier corresponds strictly to a FREE model.
 * 
 * Rules:
 * 1. Model contains ':free' or ends with '/free' (e.g. 'cohere/north-mini-code:free', 'openrouter/free')
 * 2. Or model is explicitly registered in MODEL_REGISTRY with free === true
 * 3. All other models (including any paid models like 'openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', etc.) return false.
 */
export function isFreeModel(modelName?: string | null): boolean {
  if (!modelName || typeof modelName !== 'string') return false;
  const trimmed = modelName.trim().toLowerCase();
  if (trimmed === 'openrouter/free') return true;
  if (trimmed.includes(':free') || trimmed.endsWith('/free')) return true;

  const cap = getModelCapability(trimmed);
  if (cap && cap.free === true) return true;

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

