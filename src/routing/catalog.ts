// src/routing/catalog.ts
import type { GatewayCandidate, GatewayKind } from '../providers/gateway/types.js';
import { isFreeModel, isVerifiedFreeModel } from './registry.js';
import {
  OPENROUTER_VERIFIED_FREE_MODELS,
  ROUTER_KNOWN_MODELS,
  ROUTER_VERIFIED_FREE_MODELS,
} from './catalog-models.js';

export {
  OPENROUTER_VERIFIED_FREE_MODELS,
  ROUTER_KNOWN_MODELS,
  ROUTER_VERIFIED_FREE_MODELS,
};

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

  const candidateList = activeModels !== undefined ? activeModels : defaultList;
  const verified = candidateList.filter((m: string) => isVerifiedFreeModel(m));

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

  if (options?.modelOverride && isVerifiedFreeModel(options.modelOverride)) {
    const override = options.modelOverride.trim();
    const isRouter = routerStatus.verifiedFreeModels.includes(override) || override.startsWith('kc/') || override.startsWith('router/');
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
