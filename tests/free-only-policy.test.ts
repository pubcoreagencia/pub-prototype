import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  isFreeModel,
  assertFreeModel,
  isVerifiedFreeModel,
  assertVerifiedFreeModel,
  isVerifiedFreeModelForGateway,
  assertVerifiedFreeModelForGateway,
} from '../src/routing/registry.js';
import { buildRoutingPolicy, resolveCandidateModels } from '../src/routing/engine.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import type { ProviderTaskInput } from '../src/providers/types.js';

describe('PP Free-Only Policy Enforcement', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. isFreeModel, isVerifiedFreeModel & assertion gates', () => {
    it('accepts explicit :free models in isFreeModel syntax', () => {
      expect(isFreeModel('cohere/north-mini-code:free')).toBe(true);
      expect(isFreeModel('minimax/minimax-m2.7:free')).toBe(true);
      expect(isFreeModel('poolside/laguna-s-2.1-20260720:free')).toBe(true);
      expect(() => assertFreeModel('cohere/north-mini-code:free')).not.toThrow();
    });

    it('distinguishes verified free models from unverified free models', () => {
      // Verified active models
      expect(isVerifiedFreeModel('cohere/north-mini-code:free')).toBe(true);
      expect(isVerifiedFreeModel('nex-agi/nex-n2.5-pro:free')).toBe(true);
      expect(isVerifiedFreeModel('openrouter/free')).toBe(true);
      expect(isVerifiedFreeModel('router/free-pool')).toBe(true);
      expect(isVerifiedFreeModel('kc/cohere/north-mini-code:free')).toBe(true);
      expect(() => assertVerifiedFreeModel('cohere/north-mini-code:free')).not.toThrow();

      // Unverified / disabled / removed free models
      expect(isVerifiedFreeModel('minimax/minimax-m2.7:free')).toBe(false);
      expect(isVerifiedFreeModel('minimax/minimax-m3:free')).toBe(false);
      expect(isVerifiedFreeModel('unknown/random-model:free')).toBe(false);
      // Models present in MODEL_REGISTRY (even if enabled: true) but NOT in verified catalogs
      expect(isFreeModel('google/gemma-4-26b-a4b-it:free')).toBe(true);
      expect(isVerifiedFreeModel('google/gemma-4-26b-a4b-it:free')).toBe(false);
      expect(() => assertVerifiedFreeModel('google/gemma-4-26b-a4b-it:free')).toThrow('UNVERIFIED_FREE_MODEL_FORBIDDEN');

      expect(isFreeModel('poolside/laguna-s-2.1:free')).toBe(true);
      expect(isVerifiedFreeModel('poolside/laguna-s-2.1:free')).toBe(false);
      expect(() => assertVerifiedFreeModel('poolside/laguna-s-2.1:free')).toThrow('UNVERIFIED_FREE_MODEL_FORBIDDEN');

      expect(() => assertVerifiedFreeModel('minimax/minimax-m2.7:free')).toThrow('UNVERIFIED_FREE_MODEL_FORBIDDEN');
    });

    it('enforces gateway-scoped verified free models strictly (isVerifiedFreeModelForGateway)', () => {
      // 1. OpenRouter model -> OpenRouter: PASS
      expect(isVerifiedFreeModelForGateway('cohere/north-mini-code:free', 'openrouter')).toBe(true);
      expect(isVerifiedFreeModelForGateway('openrouter/free', 'openrouter')).toBe(true);
      expect(() => assertVerifiedFreeModelForGateway('cohere/north-mini-code:free', 'openrouter')).not.toThrow();

      // 2. 9router model -> 9router: PASS
      expect(isVerifiedFreeModelForGateway('kc/cohere/north-mini-code:free', '9router')).toBe(true);
      expect(isVerifiedFreeModelForGateway('router/free-pool', '9router')).toBe(true);
      expect(() => assertVerifiedFreeModelForGateway('kc/cohere/north-mini-code:free', '9router')).not.toThrow();

      // 3. OpenRouter model -> 9router: BLOCKED
      expect(isVerifiedFreeModelForGateway('cohere/north-mini-code:free', '9router')).toBe(false);
      expect(isVerifiedFreeModelForGateway('openrouter/free', '9router')).toBe(false);
      expect(() => assertVerifiedFreeModelForGateway('cohere/north-mini-code:free', '9router')).toThrow('UNVERIFIED_FREE_MODEL_FORBIDDEN');

      // 4. 9router model -> OpenRouter: BLOCKED
      expect(isVerifiedFreeModelForGateway('kc/cohere/north-mini-code:free', 'openrouter')).toBe(false);
      expect(isVerifiedFreeModelForGateway('router/free-pool', 'openrouter')).toBe(false);
      expect(() => assertVerifiedFreeModelForGateway('kc/cohere/north-mini-code:free', 'openrouter')).toThrow('UNVERIFIED_FREE_MODEL_FORBIDDEN');
    });

    it('accepts openrouter/free community pool', () => {
      expect(isFreeModel('openrouter/free')).toBe(true);
      expect(isVerifiedFreeModel('openrouter/free')).toBe(true);
      expect(() => assertFreeModel('openrouter/free')).not.toThrow();
      expect(() => assertVerifiedFreeModel('openrouter/free')).not.toThrow();
    });

    it('rejects paid models', () => {
      expect(isFreeModel('openai/gpt-4o-mini')).toBe(false);
      expect(isVerifiedFreeModel('openai/gpt-4o-mini')).toBe(false);
      expect(isFreeModel('anthropic/claude-3.5-haiku')).toBe(false);
      expect(isFreeModel('deepseek/deepseek-chat')).toBe(false);
      expect(() => assertFreeModel('openai/gpt-4o-mini')).toThrow('PAID_MODEL_FORBIDDEN');
      expect(() => assertVerifiedFreeModel('openai/gpt-4o-mini')).toThrow('PAID_MODEL_FORBIDDEN');
      expect(() => assertVerifiedFreeModelForGateway('openai/gpt-4o-mini', 'openrouter')).toThrow('PAID_MODEL_FORBIDDEN');
      expect(() => assertVerifiedFreeModelForGateway('openai/gpt-4o-mini', '9router')).toThrow('PAID_MODEL_FORBIDDEN');
    });
  });

  describe('2. Routing Engine free-only candidate resolution', () => {
    it('never resolves paid models even when OPENROUTER_API_KEY is present', () => {
      const env = { OPENROUTER_API_KEY: 'sk-test-real-key-with-balance' } as any;
      const policy = buildRoutingPolicy({ prompt: 'Build a complex app' }, env, 'coding');
      const candidates = resolveCandidateModels(policy, undefined, env);

      expect(candidates.length).toBeGreaterThan(0);
      for (const candidate of candidates) {
        expect(candidate.free).toBe(true);
        expect(isFreeModel(candidate.model)).toBe(true);
        expect(candidate.model).not.toBe('openai/gpt-4o-mini');
      }
    });

    it('rejects paid model in legacyModelOverride', () => {
      const env = { OPENROUTER_API_KEY: 'sk-test' } as any;
      const policy = buildRoutingPolicy({ prompt: 'Test' }, env);
      const candidates = resolveCandidateModels(policy, 'openai/gpt-4o-mini', env);

      for (const candidate of candidates) {
        expect(candidate.free).toBe(true);
        expect(isFreeModel(candidate.model)).toBe(true);
        expect(candidate.model).not.toBe('openai/gpt-4o-mini');
      }
    });

    it('proves that no environment variable or escape hatch can enable paid fallback', () => {
      const hostileEnv = {
        OPENROUTER_API_KEY: 'sk-test',
        OPENROUTER_PAID_FALLBACK_ENABLED: 'true',
        PP_ALLOW_PAID_MODELS: 'true',
        OPENROUTER_PAID_MODELS: 'openai/gpt-4o-mini,anthropic/claude-3.5-haiku',
        OPENROUTER_PAID_MAX_ATTEMPTS: '5',
      } as any;

      const policy = buildRoutingPolicy({ prompt: 'Test' }, hostileEnv, 'coding');
      expect(policy.tiers.tier3PaidFallback).toEqual([]);
      expect(policy.limits.maxPaidAttempts).toBe(0);

      const candidates = resolveCandidateModels(policy, undefined, hostileEnv);
      expect(candidates.every(c => c.free && isFreeModel(c.model))).toBe(true);
      expect(candidates.map(c => c.model)).not.toContain('openai/gpt-4o-mini');
    });


    it('filters out paid models if present in OPENROUTER_FALLBACK_MODELS', () => {
      const env = {
        OPENROUTER_FALLBACK_MODELS: 'cohere/north-mini-code:free,openai/gpt-4o-mini,openrouter/free',
      } as any;
      const policy = buildRoutingPolicy({ prompt: 'Test' }, env);
      const candidates = resolveCandidateModels(policy, 'minimax/minimax-m2.7:free', env);

      const modelNames = candidates.map(c => c.model);
      expect(modelNames).toContain('cohere/north-mini-code:free');
      expect(modelNames).toContain('openrouter/free');
      expect(modelNames).not.toContain('openai/gpt-4o-mini');
    });
  });

  describe('3. OpenRouterProvider policy gate', () => {
    it('rejects paid modelOverride without sending any network request', async () => {
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const provider = new OpenRouterProvider(
        undefined,
        'sk-test-key',
        5000,
        'openrouter/free',
        true
      );

      const task: ProviderTaskInput = {
        id: 'test-paid-task',
        objective: 'test',
        prompt: 'Hello',
        modelOverride: 'openai/gpt-4o-mini', // PAID
      };

      const res = await provider.execute(task, '/tmp');
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('PAID_MODEL_FORBIDDEN');
      expect(res.errorMessage).toContain('PAID_MODEL_FORBIDDEN');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('rejects unverified free modelOverride (minimax/minimax-m2.7:free) without sending any network request', async () => {
      const fetchSpy = vi.fn();
      global.fetch = fetchSpy;

      const provider = new OpenRouterProvider(
        undefined,
        'sk-test-key',
        5000,
        'openrouter/free',
        true
      );

      const task: ProviderTaskInput = {
        id: 'test-unverified-task',
        objective: 'test',
        prompt: 'Hello',
        modelOverride: 'minimax/minimax-m2.7:free', // UNVERIFIED / REMOVED FREE MODEL
      };

      const res = await provider.execute(task, '/tmp');
      expect(res.status).toBe('FAILED');
      expect(res.errorCode).toBe('UNVERIFIED_FREE_MODEL_FORBIDDEN');
      expect(res.errorMessage).toContain('UNVERIFIED_FREE_MODEL_FORBIDDEN');
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('permits free modelOverride and sends request', async () => {
      let requestedModel = '';
      global.fetch = vi.fn().mockImplementation(async (_url, init) => {
        const body = JSON.parse(init.body as string);
        requestedModel = body.model;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: 'OK' } }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      });

      const provider = new OpenRouterProvider(
        undefined,
        'sk-test-key',
        5000,
        'openrouter/free',
        false
      );

      const task: ProviderTaskInput = {
        id: 'test-free-task',
        objective: 'test',
        prompt: 'Hello',
        modelOverride: 'cohere/north-mini-code:free', // FREE
      };

      const res = await provider.execute(task, '/tmp');
      expect(res.status).toBe('COMPLETED');
      expect(requestedModel).toBe('cohere/north-mini-code:free');
    });
  });
});
