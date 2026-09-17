// src/routing/catalog.ts
import type { GatewayCandidate, GatewayKind } from '../providers/gateway/types.js';
import { isFreeModel } from './registry.js';

/**
 * 10 Live-Verified FREE models for Gateway A (OpenRouter).
 * Curated with pricing.prompt === "0" && pricing.completion === "0"
 * and verified live via streaming chat completions on OpenRouter API.
 */
export const OPENROUTER_VERIFIED_FREE_MODELS: string[] = [
  'cohere/north-mini-code:free',
  'nex-agi/nex-n2.5-pro:free',
  'qwen/qwen3.8-27b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nex-agi/nex-n2.5-mini:free',
  'z-ai/glm-5.2:free',
  'liquid/lfm-2.5-2.6b:free',
  'openrouter/free',
];

/**
 * Known Architectural Models for Gateway B (9router).
 * NOTE: These models are known from 9router documentation / architecture,
 * but CANNOT be marked as VERIFIED until tested live against an active 9router endpoint.
 */
export const ROUTER_KNOWN_MODELS: string[] = [
  'gemini/gemini-2.5-flash-lite:free',
  'qwen/qwen3.8-coder:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'deepseek/deepseek-chat:free',
  'mistralai/mistral-small-3:free',
  'cohere/command-r-08-2024:free',
  'google/gemma-2-27b-it:free',
  'microsoft/phi-4:free',
  'huggingface/zephyr-orpo-141b:free',
  'router/free-pool',
];

/**
 * Live-verified FREE models for Gateway B (9router).
 * Verified live against https://pub-9router-cloud.onrender.com
 * with streaming SSE enabled, TTFT < 1.5s, valid output chunks, and zero-cost free provider connection.
 */
export const ROUTER_VERIFIED_FREE_MODELS: string[] = [
  'kc/cohere/north-mini-code:free',
  'kc/nvidia/nemotron-3-super-120b-a12b:free',
  'kc/kilo-auto/free',
  'kc/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'kc/dots-studio/dots-3-note-preview:free',
  'kc/inclusionai/ling-3.0-flash-fin:free',
  'kc/nvidia/nemotron-3-ultra-550b-a55b:free',
  'kc/nvidia/nemotron-3.5-lightning:free',
  'kc/nex-agi/nex-n2.5-pro:free',
  'kc/nex-agi/nex-n2.5-mini:free',
];

export interface GatewayCatalogStatus {
  gateway: GatewayKind;
  totalModels: number;
  verifiedFreeModels: string[];
  degraded: boolean;
  status: 'OPTIMAL' | 'FREE_CATALOG_DEGRADED';
}

export function getGatewayCatalogStatus(
  gateway: GatewayKind,
  activeModels?: string[]
): GatewayCatalogStatus {
  const defaultList = gateway === 'openrouter'
    ? OPENROUTER_VERIFIED_FREE_MODELS
    : ROUTER_VERIFIED_FREE_MODELS;

  const candidateList = activeModels && activeModels.length > 0 ? activeModels : defaultList;
  const verified = candidateList.filter(m => isFreeModel(m));

  const degraded = verified.length < 10;
  return {
    gateway,
    totalModels: verified.length,
    verifiedFreeModels: verified,
    degraded,
    status: degraded ? 'FREE_CATALOG_DEGRADED' : 'OPTIMAL',
  };
}

export function resolveGatewayCandidates(
  primaryGateway: GatewayKind = 'openrouter',
  options?: {
    openRouterModels?: string[];
    routerModels?: string[];
    maxRetries?: number;
    modelOverride?: string;
  }
): { candidates: GatewayCandidate[]; catalogReport: Record<GatewayKind, GatewayCatalogStatus> } {
  const orStatus = getGatewayCatalogStatus('openrouter', options?.openRouterModels);
  const routerStatus = getGatewayCatalogStatus('9router', options?.routerModels);

  const retries = options?.maxRetries ?? 1;

  if (options?.modelOverride && isFreeModel(options.modelOverride)) {
    const override = options.modelOverride.trim();
    const isRouter = routerStatus.verifiedFreeModels.includes(override) || override.startsWith('router/');
    const single: GatewayCandidate = {
      gateway: isRouter ? '9router' : 'openrouter',
      model: override,
      free: true,
      tier: 1,
      maxRetries: retries,
    };
    return {
      candidates: [single],
      catalogReport: {
        openrouter: orStatus,
        '9router': routerStatus,
      },
    };
  }

  const orCandidates: GatewayCandidate[] = orStatus.verifiedFreeModels.map((model) => ({
    gateway: 'openrouter',
    model,
    free: true,
    tier: model === 'openrouter/free' ? 2 : 1,
    maxRetries: retries,
  }));

  const routerCandidates: GatewayCandidate[] = routerStatus.verifiedFreeModels.map((model) => ({
    gateway: '9router',
    model,
    free: true,
    tier: model === 'router/free-pool' ? 2 : 1,
    maxRetries: retries,
  }));

  const candidates = primaryGateway === 'openrouter'
    ? [...orCandidates, ...routerCandidates]
    : [...routerCandidates, ...orCandidates];

  return {
    candidates,
    catalogReport: {
      openrouter: orStatus,
      '9router': routerStatus,
    },
  };
}
