// src/routing/types.ts
/**
 * PUB AI MODEL ROUTING POLICY CONTRACT
 * Shared specification designed to be reusable across PUB DEV LOOP, Hermes, and OpenClaw.
 */

export type TaskRoutingProfile =
  | 'coding'
  | 'reasoning'
  | 'fast_prototype'
  | 'general';

export type ModelTier = 1 | 2 | 3;

export type FallbackType = 'retry' | 'model_switch' | 'tier_escalation';

export interface ModelCapabilityDefinition {
  /** Model identifier as expected by OpenRouter or OpenAI-compatible endpoint */
  model: string;
  /** Compatible task profiles */
  profiles: TaskRoutingProfile[];
  /** Model tier classification (1 = Curated Free, 2 = Free Pool, 3 = Paid Fallback) */
  tier: ModelTier;
  /** Whether the model is free of cost */
  free: boolean;
  /** Whether the model supports OpenAI-standard tool / function calling */
  toolCalling: boolean;
  /** Whether the model supports system prompt instructions */
  systemPrompt: boolean;
  /** Total context window in tokens */
  contextWindow: number;
  /** Whether the model is actively enabled for routing */
  enabled: boolean;
  /** Optional vendor identifier (e.g., 'minimax', 'poolside', 'openai') */
  vendor?: string;
  /** Optional notes or warnings (e.g. known tool formatting caveats) */
  notes?: string;
}

export interface ModelRoutingPolicy {
  /** The determined or assigned task profile */
  profile: TaskRoutingProfile;

  tiers: {
    /** Tier 1: Explicitly selected and curated free models in priority order */
    tier1ExplicitFree: string[];
    /** Tier 2: OpenRouter free pool safety net ('openrouter/free') */
    tier2OpenRouterFreePool: boolean;
    /** Tier 3: Guarded paid fallback models in priority order */
    tier3PaidFallback: string[];
  };

  limits: {
    /** Maximum retries per individual model (e.g., on 429 or 5xx) */
    maxRetriesPerModel: number;
    /** Maximum number of paid model attempts allowed per task */
    maxPaidAttempts: number;
    /** Maximum estimated cost in USD per task execution (safety ceiling) */
    maxCostPerTaskUsd?: number;
    /** Base delay in ms for exponential backoff */
    baseDelayMs: number;
  };

  capabilities: {
    /** Mandatory tool calling support */
    requireToolCalling: boolean;
    /** Minimum context window in tokens required for candidate models */
    minContextTokens: number;
  };
}

export interface CandidateModelEntry {
  model: string;
  tier: ModelTier;
  free: boolean;
  maxRetries: number;
}
