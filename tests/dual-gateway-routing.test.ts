// tests/dual-gateway-routing.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GatewayRouter } from '../src/routing/gateway-router.js';
import {
  OPENROUTER_VERIFIED_FREE_MODELS,
  ROUTER_VERIFIED_FREE_MODELS,
  ROUTER_KNOWN_MODELS,
  getGatewayCatalogStatus,
  resolveGatewayCandidates,
} from '../src/routing/catalog.js';
import { isFreeModel, assertFreeModel, assertVerifiedFreeModel } from '../src/routing/registry.js';
import type { GatewayProvider, GatewayCandidate } from '../src/providers/gateway/types.js';
import type { ProviderTaskResult } from '../src/providers/types.js';

describe('Dual Gateway Architecture & 20 Verified FREE Models', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('1. 10 Verified FREE Models Per Gateway Catalog', () => {
    it('OpenRouter catalog has exactly 10 verified FREE models with isFreeModel = true', () => {
      expect(OPENROUTER_VERIFIED_FREE_MODELS).toHaveLength(10);
      for (const model of OPENROUTER_VERIFIED_FREE_MODELS) {
        expect(isFreeModel(model)).toBe(true);
        expect(() => assertFreeModel(model)).not.toThrow();
      }
    });

    it('9router catalog distinguishes ROUTER_KNOWN_MODELS (10) from ROUTER_VERIFIED_FREE_MODELS (10 live-verified)', () => {
      expect(ROUTER_KNOWN_MODELS).toHaveLength(10);
      for (const model of ROUTER_KNOWN_MODELS) {
        expect(isFreeModel(model)).toBe(true);
      }
      // Live 9router host verified count is 10
      expect(ROUTER_VERIFIED_FREE_MODELS).toHaveLength(10);
      for (const model of ROUTER_VERIFIED_FREE_MODELS) {
        expect(isFreeModel(model)).toBe(true);
        expect(() => assertFreeModel(model)).not.toThrow();
      }
      const status = getGatewayCatalogStatus('9router');
      expect(status.degraded).toBe(false);
      expect(status.status).toBe('OPTIMAL');
      expect(status.totalModels).toBe(10);
    });

    it('resolveGatewayCandidates returns all 20 verified free candidate models across both gateways', () => {
      const defaultResolution = resolveGatewayCandidates('openrouter');
      expect(defaultResolution.candidates).toHaveLength(20);
      expect(defaultResolution.candidates.every(c => c.free)).toBe(true);
      expect(defaultResolution.candidates.slice(0, 10).every(c => c.gateway === 'openrouter')).toBe(true);
      expect(defaultResolution.candidates.slice(10, 20).every(c => c.gateway === '9router')).toBe(true);
      expect(defaultResolution.catalogReport.openrouter.degraded).toBe(false);
      expect(defaultResolution.catalogReport['9router'].degraded).toBe(false);
    });

    it('detects FREE_CATALOG_DEGRADED when a gateway has < 10 models', () => {
      const degradedStatus = getGatewayCatalogStatus('openrouter', ['nex-agi/nex-n2.5-pro:free']);
      expect(degradedStatus.degraded).toBe(true);
      expect(degradedStatus.status).toBe('FREE_CATALOG_DEGRADED');
      expect(degradedStatus.totalModels).toBe(1);
    });
  });

  describe('2. Paid Model Prohibition Gate', () => {
    it('rejects paid models with PAID_MODEL_FORBIDDEN', () => {
      const paidModels = ['openai/gpt-4o-mini', 'anthropic/claude-3.5-haiku', 'deepseek/deepseek-chat'];
      for (const paid of paidModels) {
        expect(isFreeModel(paid)).toBe(false);
        expect(() => assertFreeModel(paid)).toThrow('PAID_MODEL_FORBIDDEN');
      }
    });

    it('unverified models are excluded from verified catalog and rejected by assertVerifiedFreeModel', () => {
      const unverifiedModels = ['minimax/minimax-m2.7:free', 'minimax/minimax-m3:free', 'unknown/random-model:free'];
      for (const model of unverifiedModels) {
        expect(OPENROUTER_VERIFIED_FREE_MODELS).not.toContain(model);
        expect(ROUTER_VERIFIED_FREE_MODELS).not.toContain(model);
        expect(() => assertVerifiedFreeModel(model)).toThrow('UNVERIFIED_FREE_MODEL_FORBIDDEN');
      }
    });

    it('unverified free modelOverride (minimax/minimax-m2.7:free) throws UNVERIFIED_FREE_MODEL_FORBIDDEN before any network request', async () => {
      const mockOpenRouter: GatewayProvider = {
        kind: 'openrouter',
        model: null,
        baseUrl: 'https://openrouter.ai/api/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: vi.fn(),
      };
      const router = new GatewayRouter({ openrouter: mockOpenRouter });

      await expect(
        router.execute({ id: 't-unverified', objective: 'unverified test', prompt: 'test', modelOverride: 'minimax/minimax-m2.7:free' } as any, '/tmp')
      ).rejects.toThrow('UNVERIFIED_FREE_MODEL_FORBIDDEN');

      expect(mockOpenRouter.execute).not.toHaveBeenCalled();
    });

    it('explicitly configured unverified free models are filtered out from candidates and never executed', async () => {
      const mockOpenRouter: GatewayProvider = {
        kind: 'openrouter',
        model: null,
        baseUrl: 'https://openrouter.ai/api/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: vi.fn(),
      };

      const router = new GatewayRouter({
        openrouter: mockOpenRouter,
        openRouterModels: ['google/gemma-4-26b-a4b-it:free', 'poolside/laguna-s-2.1:free'],
        routerModels: [],
      });

      const { candidates } = router.getCandidates();
      expect(candidates).toHaveLength(0);

      const res = await router.execute({ id: 't-no-cand', objective: 'test', prompt: 'test' }, '/tmp');
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('ROUTING_EXHAUSTED');
      expect(mockOpenRouter.execute).not.toHaveBeenCalled();
    });
  });

  describe('3. GatewayRouter Execution & Cross-Gateway Fallback', () => {
    it('Happy path: executes on primary gateway first candidate and returns COMPLETED', async () => {
      const mockOpenRouter: GatewayProvider = {
        kind: 'openrouter',
        model: null,
        baseUrl: 'https://openrouter.ai/api/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: vi.fn().mockResolvedValue({
          status: 'COMPLETED',
          provider: 'openrouter',
          model: OPENROUTER_VERIFIED_FREE_MODELS[0],
          exitCode: 0,
          durationMs: 100,
          stdout: 'Code generated',
          stderr: '',
          changedFiles: ['index.html'],
          commit: null,
          errorCode: null,
          errorMessage: null,
        } as ProviderTaskResult),
      };

      const mock9router: GatewayProvider = {
        kind: '9router',
        model: null,
        baseUrl: 'http://localhost:20128/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: vi.fn(),
      };

      const router = new GatewayRouter({
        openrouter: mockOpenRouter,
        router: mock9router,
      });

      const res = await router.execute({ id: 't1', objective: 'test', prompt: 'hello' }, '/tmp');
      expect(res.status).toBe('COMPLETED');
      expect(res.model).toBe(OPENROUTER_VERIFIED_FREE_MODELS[0]);
      expect(mockOpenRouter.execute).toHaveBeenCalledTimes(1);
      expect(mock9router.execute).not.toHaveBeenCalled();
    });

    it('Cross-Gateway Fallback: when all OpenRouter models fail with 429/timeout, falls back to 9router', async () => {
      const openRouterExecute = vi.fn().mockResolvedValue({
        status: 'ROUTER_HTTP_ERROR',
        provider: 'openrouter',
        model: 'fail',
        exitCode: 429,
        httpStatus: 429,
        durationMs: 50,
        stdout: '',
        stderr: 'Rate limited',
        changedFiles: [],
        commit: null,
        errorCode: 'RATE_LIMITED',
        errorMessage: 'Rate limited',
      } as ProviderTaskResult);

      const mockOpenRouter: GatewayProvider = {
        kind: 'openrouter',
        model: null,
        baseUrl: 'https://openrouter.ai/api/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: openRouterExecute,
      };

      const routerExecute = vi.fn().mockResolvedValue({
        status: 'COMPLETED',
        provider: '9router',
        model: ROUTER_VERIFIED_FREE_MODELS[0],
        exitCode: 0,
        durationMs: 120,
        stdout: 'Success on 9router fallback',
        stderr: '',
        changedFiles: ['index.html'],
        commit: null,
        errorCode: null,
        errorMessage: null,
      } as ProviderTaskResult);

      const mock9router: GatewayProvider = {
        kind: '9router',
        model: null,
        baseUrl: 'http://localhost:20128/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: routerExecute,
      };

      const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
      const router = new GatewayRouter({
        openrouter: mockOpenRouter,
        router: mock9router,
        routerModels: ROUTER_VERIFIED_FREE_MODELS,
        onEvent: (e) => events.push(e),
      });

      const res = await router.execute({ id: 't2', objective: 'test fallback', prompt: 'test' }, '/tmp');
      expect(res.status).toBe('COMPLETED');
      expect(res.provider).toBe('9router');
      expect(res.model).toBe(ROUTER_VERIFIED_FREE_MODELS[0]);
      // OpenRouter tried all 10 free candidates
      expect(openRouterExecute).toHaveBeenCalledTimes(10);
      // 9router tried first candidate and succeeded
      expect(routerExecute).toHaveBeenCalledTimes(1);
      // Fallback event was emitted
      expect(events.some(e => e.name === 'GATEWAY_FALLBACK_STARTED')).toBe(true);
    });

    it('Cross-Gateway Fallback B -> A: when Gateway B fails with timeout/503, falls back to Gateway A', async () => {
      const routerExecute = vi.fn().mockResolvedValue({
        status: 'ROUTER_HTTP_ERROR',
        provider: '9router',
        model: 'fail',
        exitCode: 503,
        httpStatus: 503,
        durationMs: 50,
        stdout: '',
        stderr: 'Service Unavailable',
        changedFiles: [],
        commit: null,
        errorCode: 'PROVIDER_UNAVAILABLE',
        errorMessage: 'Service Unavailable',
      } as ProviderTaskResult);

      const openRouterExecute = vi.fn().mockResolvedValue({
        status: 'COMPLETED',
        provider: 'openrouter',
        model: OPENROUTER_VERIFIED_FREE_MODELS[0],
        exitCode: 0,
        durationMs: 110,
        stdout: 'Success on OpenRouter fallback',
        stderr: '',
        changedFiles: ['index.html'],
        commit: null,
        errorCode: null,
        errorMessage: null,
      } as ProviderTaskResult);

      const mockOpenRouter: GatewayProvider = {
        kind: 'openrouter',
        model: null,
        baseUrl: 'https://openrouter.ai/api/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: openRouterExecute,
      };

      const mock9router: GatewayProvider = {
        kind: '9router',
        model: null,
        baseUrl: 'http://localhost:20128/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: routerExecute,
      };

      const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
      const router = new GatewayRouter({
        openrouter: mockOpenRouter,
        router: mock9router,
        primaryGateway: '9router',
        onEvent: (e) => events.push(e),
      });

      const res = await router.execute({ id: 't2-b-to-a', objective: 'test B to A fallback', prompt: 'test' }, '/tmp');
      expect(res.status).toBe('COMPLETED');
      expect(res.provider).toBe('openrouter');
      expect(res.model).toBe(OPENROUTER_VERIFIED_FREE_MODELS[0]);
      // 9router tried 10 candidates
      expect(routerExecute).toHaveBeenCalledTimes(10);
      // OpenRouter tried first candidate and succeeded
      expect(openRouterExecute).toHaveBeenCalledTimes(1);
      // Gateway fallback event emitted
      expect(events.some(e => e.name === 'GATEWAY_FALLBACK_STARTED')).toBe(true);
    });

    it('Non-retryable errors: halts fallback immediately on 401, 403, and does not retry next candidates', async () => {
      const openRouterExecute = vi.fn().mockResolvedValue({
        status: 'FAILED',
        provider: 'openrouter',
        model: OPENROUTER_VERIFIED_FREE_MODELS[0],
        exitCode: 401,
        httpStatus: 401,
        durationMs: 30,
        stdout: '',
        stderr: 'Unauthorized',
        changedFiles: [],
        commit: null,
        errorCode: 'AUTHENTICATION_FAILED',
        errorMessage: 'Unauthorized',
      } as ProviderTaskResult);

      const routerExecute = vi.fn();

      const router = new GatewayRouter({
        openrouter: {
          kind: 'openrouter',
          model: null,
          baseUrl: 'https://openrouter.ai/api/v1',
          health: async () => ({ available: true }),
          listModels: async () => [],
          capabilities: () => [],
          metadata: () => ({}),
          execute: openRouterExecute,
        },
        router: {
          kind: '9router',
          model: null,
          baseUrl: 'http://localhost:20128/v1',
          health: async () => ({ available: true }),
          listModels: async () => [],
          capabilities: () => [],
          metadata: () => ({}),
          execute: routerExecute,
        },
      });

      const res = await router.execute({ id: 't-auth', objective: 'test 401 halt', prompt: 'test' }, '/tmp');
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('AUTHENTICATION_FAILED');
      // Exactly 1 attempt made, no fallback to remaining candidates or 9router
      expect(openRouterExecute).toHaveBeenCalledTimes(1);
      expect(routerExecute).not.toHaveBeenCalled();
    });

    it('Exhaustion: when all 20 candidates fail, returns ROUTING_EXHAUSTED', async () => {
      const mockFailProvider = (kind: 'openrouter' | '9router'): GatewayProvider => ({
        kind,
        model: null,
        baseUrl: 'http://test',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: vi.fn().mockResolvedValue({
          status: 'TIMED_OUT',
          provider: kind,
          model: 'fail',
          exitCode: null,
          durationMs: 20,
          stdout: '',
          stderr: 'Idle timeout',
          changedFiles: [],
          commit: null,
          errorCode: 'IDLE_TIMEOUT',
          errorMessage: 'Idle timeout',
        } as ProviderTaskResult),
      });

      const openRouter = mockFailProvider('openrouter');
      const router9 = mockFailProvider('9router');

      const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
      const router = new GatewayRouter({
        openrouter: openRouter,
        router: router9,
        routerModels: ROUTER_VERIFIED_FREE_MODELS,
        onEvent: (e) => events.push(e),
      });

      const res = await router.execute({ id: 't3', objective: 'exhaust', prompt: 'fail all' }, '/tmp');
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('ROUTING_EXHAUSTED');
      expect(res.modelAttempts).toHaveLength(20);
      expect(events.some(e => e.name === 'ROUTING_EXHAUSTED')).toBe(true);
    });

    it('Circuit Breaker: trips on 404 (model decommissioned) and skips model on subsequent call', async () => {
      let callCount = 0;
      const mockOpenRouter: GatewayProvider = {
        kind: 'openrouter',
        model: null,
        baseUrl: 'https://openrouter.ai/api/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: vi.fn().mockImplementation(async (_t, _w, opts) => {
          callCount++;
          if (opts?.modelOverride === OPENROUTER_VERIFIED_FREE_MODELS[0]) {
            return {
              status: 'ROUTER_HTTP_ERROR',
              provider: 'openrouter',
              model: opts.modelOverride,
              exitCode: 404,
              httpStatus: 404,
              durationMs: 10,
              stdout: '',
              stderr: 'Model not found / discontinued upstream',
              changedFiles: [],
              commit: null,
              errorCode: 'MODEL_UNAVAILABLE',
              errorMessage: 'Model not found',
            } as ProviderTaskResult;
          }
          return {
            status: 'COMPLETED',
            provider: 'openrouter',
            model: opts?.modelOverride,
            exitCode: 0,
            durationMs: 10,
            stdout: 'Success',
            stderr: '',
            changedFiles: ['app.js'],
            commit: null,
            errorCode: null,
            errorMessage: null,
          } as ProviderTaskResult;
        }),
      };

      const mock9router: GatewayProvider = {
        kind: '9router',
        model: null,
        baseUrl: 'http://localhost:20128/v1',
        health: async () => ({ available: true, details: 'ok' }),
        listModels: async () => [],
        capabilities: () => ['coding'],
        metadata: () => ({}),
        execute: vi.fn(),
      };

      const router = new GatewayRouter({
        openrouter: mockOpenRouter,
        router: mock9router,
      });

      // Call 1: Model 0 fails with 404, falls back to Model 1 which completes
      const res1 = await router.execute({ id: 't4', objective: 'cb-1', prompt: 'first' }, '/tmp');
      expect(res1.status).toBe('COMPLETED');
      expect(res1.model).toBe(OPENROUTER_VERIFIED_FREE_MODELS[1]);
      expect(router.isModelAvailable(OPENROUTER_VERIFIED_FREE_MODELS[0])).toBe(false);

      // Call 2: Model 0 is skipped by circuit breaker; candidates start directly from Model 1
      const res2 = await router.execute({ id: 't5', objective: 'cb-2', prompt: 'second' }, '/tmp');
      expect(res2.status).toBe('COMPLETED');
      expect(res2.model).toBe(OPENROUTER_VERIFIED_FREE_MODELS[1]);
    });
  });
});
