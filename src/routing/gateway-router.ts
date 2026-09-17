// src/routing/gateway-router.ts
import type { Task } from '../domain.js';
import type { AgentProvider, ProviderKind, ProviderTaskInput, ProviderTaskResult } from '../providers/types.js';
import type { StreamConsumer } from '../providers/streaming/index.js';
import type { GatewayCandidate, GatewayKind, GatewayProvider } from '../providers/gateway/types.js';
import { OpenRouterGatewayAdapter } from '../providers/gateway/openrouter-gateway.js';
import { RouterGatewayAdapter } from '../providers/gateway/router-gateway.js';
import { assertFreeModel, isFreeModel } from './registry.js';
import { resolveGatewayCandidates, type GatewayCatalogStatus } from './catalog.js';

export interface GatewayRouterOptions {
  openrouter?: GatewayProvider;
  router?: GatewayProvider;
  idleTimeoutMs?: number;
  maxAttempts?: number;
  circuitBreakerCooldownMs?: number;
  primaryGateway?: GatewayKind;
  openRouterModels?: string[];
  routerModels?: string[];
  onEvent?: (event: { name: string; payload: Record<string, unknown> }) => void;
}

export interface ModelFailureHistory {
  failures: number;
  lastFailureTime: number;
  temporarilyUnavailableUntil?: number;
}

export class GatewayRouter implements AgentProvider {
  readonly kind: ProviderKind = 'openrouter';
  readonly model: string | null = null;
  readonly gateways: Record<GatewayKind, GatewayProvider>;
  private readonly modelHistory = new Map<string, ModelFailureHistory>();
  private readonly cooldownMs: number;
  private readonly onEvent?: (event: { name: string; payload: Record<string, unknown> }) => void;
  private readonly primaryGateway: GatewayKind;
  private readonly configuredOpenRouterModels?: string[];
  private readonly configuredRouterModels?: string[];

  constructor(options?: GatewayRouterOptions) {
    this.gateways = {
      openrouter: options?.openrouter ?? new OpenRouterGatewayAdapter(),
      '9router': options?.router ?? new RouterGatewayAdapter(),
    };
    this.cooldownMs = options?.circuitBreakerCooldownMs ?? 5 * 60 * 1000; // 5 minutes default
    this.onEvent = options?.onEvent;
    this.primaryGateway = options?.primaryGateway ?? 'openrouter';
    this.configuredOpenRouterModels = options?.openRouterModels;
    this.configuredRouterModels = options?.routerModels;
  }

  getGateway(kind: GatewayKind): GatewayProvider {
    return this.gateways[kind];
  }

  private emit(name: string, payload: Record<string, unknown>): void {
    if (this.onEvent) {
      try {
        this.onEvent({ name, payload: { ...payload, timestamp: new Date().toISOString() } });
      } catch {
        // Observability listener must not break execution
      }
    }
  }

  isModelAvailable(model: string): boolean {
    const history = this.modelHistory.get(model);
    if (!history || !history.temporarilyUnavailableUntil) return true;
    if (Date.now() > history.temporarilyUnavailableUntil) {
      this.modelHistory.delete(model);
      return true;
    }
    return false;
  }

  recordModelFailure(model: string, statusOrCode: string, httpStatus?: number): void {
    const isModelUnavailable =
      httpStatus === 404 ||
      statusOrCode === 'MODEL_UNAVAILABLE' ||
      statusOrCode === 'NOT_FOUND' ||
      httpStatus === 429;

    const current = this.modelHistory.get(model) || { failures: 0, lastFailureTime: 0 };
    current.failures += 1;
    current.lastFailureTime = Date.now();

    if (isModelUnavailable || current.failures >= 2) {
      current.temporarilyUnavailableUntil = Date.now() + this.cooldownMs;
    }
    this.modelHistory.set(model, current);
  }

  isRetryableError(result: ProviderTaskResult): boolean {
    if (result.status === 'COMPLETED') return false;
    // Non-retryables:
    if (result.errorCode === 'PAID_MODEL_FORBIDDEN') return false;
    if (result.httpStatus === 401 || result.httpStatus === 403) return false;

    // Retryables:
    if (
      result.status === 'TIMED_OUT' ||
      result.status === 'ROUTER_TIMEOUT' ||
      result.status === 'ROUTER_CONNECTION_ERROR' ||
      result.errorCode === 'IDLE_TIMEOUT' ||
      result.errorCode === 'EXECUTION_TIMEOUT' ||
      result.errorCode === 'CONNECTION_TIMEOUT' ||
      result.errorCode === 'NETWORK_ERROR'
    ) {
      return true;
    }

    if (result.httpStatus) {
      if (result.httpStatus === 429 || result.httpStatus >= 500) return true;
      if (result.httpStatus === 404) return true; // Model decommissioned/unavailable upstream
    }

    if (result.status === 'ROUTER_HTTP_ERROR') {
      const code = result.errorCode || '';
      if (code === 'ALL_PROVIDERS_FAILED' || code === 'PROVIDER_UNAVAILABLE' || code === 'RATE_LIMITED') {
        return true;
      }
    }

    return false;
  }

  getCandidates(modelOverride?: string): { candidates: GatewayCandidate[]; catalogReport: Record<GatewayKind, GatewayCatalogStatus> } {
    const { candidates, catalogReport } = resolveGatewayCandidates(this.primaryGateway, {
      modelOverride,
      openRouterModels: this.configuredOpenRouterModels,
      routerModels: this.configuredRouterModels,
    });
    const valid = candidates.filter(c => isFreeModel(c.model) && this.isModelAvailable(c.model));
    return {
      candidates: valid,
      catalogReport,
    };
  }

  async execute(
    task: Task | ProviderTaskInput,
    workspace: string,
    options?: {
      signal?: AbortSignal;
      consumer?: StreamConsumer;
      onAttemptStart?: (candidate: GatewayCandidate, attemptIdx: number) => void;
      onAttemptEnd?: (candidate: GatewayCandidate, attemptIdx: number, result: ProviderTaskResult) => void;
      onFallback?: (from: GatewayCandidate, to: GatewayCandidate) => void;
    }
  ): Promise<ProviderTaskResult> {
    const modelOverride = ('modelOverride' in task && typeof task.modelOverride === 'string' && task.modelOverride.trim())
      ? task.modelOverride.trim()
      : undefined;

    if (modelOverride) {
      assertFreeModel(modelOverride);
    }

    const { candidates, catalogReport } = this.getCandidates(modelOverride);

    // Check catalog status and notify if degraded
    for (const [gateway, status] of Object.entries(catalogReport)) {
      if (status.degraded) {
        this.emit('FREE_CATALOG_DEGRADED', {
          gateway,
          count: status.totalModels,
          required: 10,
        });
      }
    }

    if (candidates.length === 0) {
      const errMsg = 'ROUTING_EXHAUSTED: No available FREE models across Dual Gateways';
      return {
        status: 'FAILED',
        provider: 'openrouter',
        model: null,
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: errMsg,
        changedFiles: [],
        commit: null,
        errorCode: 'ROUTING_EXHAUSTED',
        errorMessage: errMsg,
        toolCalls: 0,
        toolRounds: 0,
      };
    }

    let lastResult!: ProviderTaskResult;
    const attemptedModels: string[] = [];
    let activeGateway = candidates[0].gateway;
    this.emit('GATEWAY_SELECTED', { gateway: activeGateway, model: candidates[0].model });

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];

      // ABSOLUTE SECURITY GATE
      assertFreeModel(candidate.model);

      if (options?.signal?.aborted) {
        return {
          status: 'TIMED_OUT',
          provider: candidate.gateway,
          model: candidate.model,
          exitCode: null,
          durationMs: 0,
          stdout: '',
          stderr: 'Execution aborted prior to attempt',
          changedFiles: [],
          commit: null,
          errorCode: 'ABORTED',
          errorMessage: 'Execution aborted prior to attempt',
        };
      }

      if (candidate.gateway !== activeGateway) {
        this.emit('GATEWAY_FALLBACK_STARTED', {
          fromGateway: activeGateway,
          toGateway: candidate.gateway,
          attemptIdx: i,
          model: candidate.model,
        });
        activeGateway = candidate.gateway;
      }

      if (i > 0 && options?.onFallback) {
        options.onFallback(candidates[i - 1], candidate);
      }

      options?.onAttemptStart?.(candidate, i);
      attemptedModels.push(candidate.model);

      const provider = this.gateways[candidate.gateway];
      const attemptStart = Date.now();

      try {
        lastResult = await provider.execute(task, workspace, {
          signal: options?.signal,
          consumer: options?.consumer,
          modelOverride: candidate.model,
        });
      } catch (err: any) {
        lastResult = {
          status: 'TIMED_OUT',
          provider: candidate.gateway,
          model: candidate.model,
          exitCode: null,
          durationMs: Date.now() - attemptStart,
          stdout: '',
          stderr: err?.message || String(err),
          changedFiles: [],
          commit: null,
          errorCode: 'EXECUTION_EXCEPTION',
          errorMessage: err?.message || String(err),
        };
      }

      options?.onAttemptEnd?.(candidate, i, lastResult);

      if (lastResult.status === 'COMPLETED') {
        return {
          ...lastResult,
          modelAttempts: attemptedModels,
        };
      }

      this.recordModelFailure(candidate.model, lastResult.errorCode || lastResult.status, lastResult.httpStatus);

      const hasMutableEffects = (lastResult.changedFiles && lastResult.changedFiles.length > 0) ||
                                (typeof lastResult.toolCalls === 'number' && lastResult.toolCalls > 0);
      if (hasMutableEffects) {
        return {
          ...lastResult,
          status: 'FAILED',
          errorCode: 'PARTIAL_EXECUTION_REQUIRES_REVIEW',
          errorMessage: `Model produced effects before failure. Halting fallback to prevent workspace corruption.`,
          modelAttempts: attemptedModels,
        };
      }

      if (!this.isRetryableError(lastResult)) {
        return {
          ...lastResult,
          modelAttempts: attemptedModels,
        };
      }
    }

    this.emit('ROUTING_EXHAUSTED', {
      totalCandidates: candidates.length,
      attempted: attemptedModels,
    });

    return {
      ...lastResult,
      status: 'FAILED',
      errorCode: 'ROUTING_EXHAUSTED',
      errorMessage: `All ${candidates.length} candidate models across Dual Gateways failed.`,
      modelAttempts: attemptedModels,
    };
  }

  async health() {
    const orHealth = await this.gateways.openrouter.health();
    if (orHealth.available) return orHealth;
    return this.gateways['9router'].health();
  }

  capabilities(): string[] {
    return ['coding', 'planning', 'routing', 'tool-calling', 'dual-gateway'];
  }

  metadata(): Record<string, string | null> {
    return {
      provider: 'dual-gateway',
      openrouter: this.gateways.openrouter.baseUrl ?? null,
      '9router': this.gateways['9router'].baseUrl ?? null,
    };
  }
}
