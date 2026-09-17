import { describe, it, expect, vi, afterEach } from 'vitest';
import { isFreeModel, assertFreeModel } from '../src/routing/registry.js';
import { buildRoutingPolicy, resolveCandidateModels } from '../src/routing/engine.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import type { ProviderTaskInput } from '../src/providers/types.js';

describe('PP Free-Only Policy Enforcement', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('1. isFreeModel & assertFreeModel gates', () => {
    it('accepts explicit :free models', () => {
      expect(isFreeModel('cohere/north-mini-code:free')).toBe(true);
      expect(isFreeModel('minimax/minimax-m2.7:free')).toBe(true);
      expect(isFreeModel('poolside/laguna-s-2.1-20260720:free')).toBe(true);
      expect(() => assertFreeModel('cohere/north-mini-code:free')).not.toThrow();
    });

    it('accepts openrouter/free community pool', () => {
      expect(isFreeModel('openrouter/free')).toBe(true);
      expect(() => assertFreeModel('openrouter/free')).not.toThrow();
    });

    it('rejects paid models', () => {
      expect(isFreeModel('openai/gpt-4o-mini')).toBe(false);
      expect(isFreeModel('anthropic/claude-3.5-haiku')).toBe(false);
      expect(isFreeModel('deepseek/deepseek-chat')).toBe(false);
      expect(() => assertFreeModel('openai/gpt-4o-mini')).toThrow('PAID_MODEL_FORBIDDEN');
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
