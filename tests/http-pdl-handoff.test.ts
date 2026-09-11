import { describe, it, expect, vi } from 'vitest';
import { HttpPdlTaskIngestionPort } from '../src/pp/handoff/http-client.js';
import type { PdlTaskIngestionRequest } from '../src/pp/handoff/handoff.js';

describe('HttpPdlTaskIngestionPort', () => {
  const sampleRequest: PdlTaskIngestionRequest = {
    project: 'test-project',
    repository: 'https://github.com/pubcoreagencia/test-repo.git',
    branch: 'prototype/test-project/session-1',
    checkpointSha: 'sha-checkpoint-12345',
    promotionId: 'promo-uuid-1',
    prototypeSessionId: 'session-uuid-1',
    objective: 'Test handoff objective',
    prompt: 'Test handoff prompt',
    priority: 2,
  };

  it('1. Serializes request correctly to POST /tasks/ingest with application/json', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    const mockFetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        id: 'pdl-task-1',
        taskId: 'pdl-task-1',
        status: 'QUEUED',
        branch: sampleRequest.branch,
        repository: sampleRequest.repository,
        prototypeSessionId: sampleRequest.prototypeSessionId,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new HttpPdlTaskIngestionPort('http://localhost:3000', { fetchFn: mockFetch });
    const result = await client.ingest(sampleRequest);

    expect(capturedUrl).toBe('http://localhost:3000/tasks/ingest');
    expect(capturedInit?.method).toBe('POST');
    expect((capturedInit?.headers as any)['Content-Type']).toBe('application/json');

    const sentBody = JSON.parse(String(capturedInit?.body));
    expect(sentBody.promotionId).toBe('promo-uuid-1');
    expect(sentBody.prototypeSessionId).toBe('session-uuid-1');
    expect(sentBody.checkpointSha).toBe('sha-checkpoint-12345');

    expect(result.id).toBe('pdl-task-1');
    expect(result.taskId).toBe('pdl-task-1');
    expect(result.status).toBe('QUEUED');
  });

  it('2. Fails closed with structured error when PDL returns HTTP 400/422 error', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        error: 'Validation failed',
        details: ['Missing required field'],
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new HttpPdlTaskIngestionPort('http://localhost:3000', { fetchFn: mockFetch });

    await expect(client.ingest(sampleRequest)).rejects.toThrow(/PDL_HANDOFF_FAILED: Validation failed/);
  });

  it('3. Fails closed when PDL times out', async () => {
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      // Simulate abort triggered by signal
      const signal = init?.signal as AbortSignal;
      return new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const client = new HttpPdlTaskIngestionPort('http://localhost:3000', {
      timeoutMs: 10,
      fetchFn: mockFetch,
    });

    await expect(client.ingest(sampleRequest)).rejects.toThrow(/PDL_HANDOFF_TIMEOUT/);
  });

  it('4. PrototypeHandoffService seamlessly promotes and handoffs via HttpPdlTaskIngestionPort', async () => {
    let capturedBody: any = null;
    const mockFetch = vi.fn(async (_url: any, init: any) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'pdl-task-promoted-10',
        taskId: 'pdl-task-promoted-10',
        status: 'QUEUED',
        branch: capturedBody.branch,
        repository: capturedBody.repository,
        prototypeSessionId: capturedBody.prototypeSessionId,
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const httpPort = new HttpPdlTaskIngestionPort('http://localhost:3000', { fetchFn: mockFetch });

    const mockPrototypes: any = {
      getSession: async (id: string) => ({
        id,
        project: 'app-test',
        repository: 'https://github.com/pubcoreagencia/app-test.git',
        branch: 'prototype/app-test/session-99',
        lastCheckpointSha: 'sha-final-mvp',
        status: 'READY',
        mode: 'PROTOTYPE',
      }),
      promoteSession: async (id: string) => ({
        id,
        project: 'app-test',
        repository: 'https://github.com/pubcoreagencia/app-test.git',
        branch: 'prototype/app-test/session-99',
        lastCheckpointSha: 'sha-final-mvp',
        status: 'PROMOTED',
        mode: 'DEVELOPMENT',
      }),
      createPromotion: async (p: any) => ({ id: 'promo-auto-1', ...p }),
    };

    const mockEvents: any = { emit: vi.fn() };
    const { PrototypeHandoffService } = await import('../src/pp/handoff/handoff.js');
    const service = new PrototypeHandoffService(httpPort, mockPrototypes, mockEvents);

    const result = await service.execute({ sessionId: 'session-99' });

    expect(result.session.status).toBe('PROMOTED');
    expect(result.session.mode).toBe('DEVELOPMENT');
    expect(result.promotion.id).toBe('promo-auto-1');
    expect(result.task.id).toBe('pdl-task-promoted-10');
    expect(capturedBody.promotionId).toBe('promo-auto-1');
    expect(capturedBody.checkpointSha).toBe('sha-final-mvp');
    expect(mockEvents.emit).toHaveBeenCalledWith(expect.objectContaining({
      type: 'PROMOTED_TO_DEVELOPMENT',
    }));
  });

  it('5. FailClosedPdlTaskIngestionPort throws PDL_HANDOFF_NOT_CONFIGURED when PDL_API_URL is missing', async () => {
    const { FailClosedPdlTaskIngestionPort } = await import('../src/pp/handoff/http-client.js');
    const client = new FailClosedPdlTaskIngestionPort();

    await expect(client.ingest(sampleRequest)).rejects.toThrow(/PDL_HANDOFF_NOT_CONFIGURED/);
  });

  it('6. Fails closed with HTTP 500 error from PDL', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({
        error: 'Internal PDL ingestion crash',
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = new HttpPdlTaskIngestionPort('http://localhost:3000', { fetchFn: mockFetch });

    await expect(client.ingest(sampleRequest)).rejects.toThrow(/PDL_HANDOFF_FAILED: Internal PDL ingestion crash/);
  });

  it('7. Standalone PP API without PDL_API_URL fails closed on POST /prototype/sessions/:id/promote', async () => {
    const originalEnv = process.env.PDL_API_URL;
    delete process.env.PDL_API_URL;

    try {
      const { createPpApp } = await import('../src/pp/api/entry.js');
      const mockPrototypes: any = {
        getSession: async (id: string) => ({
          id,
          project: 'fail-closed-proj',
          repository: 'https://github.com/test/test.git',
          branch: 'prototype/branch',
          lastCheckpointSha: 'sha-abc',
          status: 'READY',
          mode: 'PROTOTYPE',
        }),
        promoteSession: async (id: string) => ({
          id,
          project: 'fail-closed-proj',
          repository: 'https://github.com/test/test.git',
          branch: 'prototype/branch',
          lastCheckpointSha: 'sha-abc',
          status: 'PROMOTED',
          mode: 'DEVELOPMENT',
        }),
        createPromotion: async (p: any) => ({ id: 'promo-fail', ...p }),
      };

      const app = createPpApp(undefined, undefined, mockPrototypes);

      // Make a synthetic request to express app
      const req = {
        method: 'POST',
        url: '/prototype/sessions/sess-123/promote',
        headers: { 'content-type': 'application/json' },
        body: {},
        params: { id: 'sess-123' },
      };

      let responseStatus = 0;
      let responseBody: any = null;
      const res: any = {
        status(code: number) {
          responseStatus = code;
          return this;
        },
        json(data: any) {
          responseBody = data;
          return this;
        },
        sendStatus(code: number) {
          responseStatus = code;
          return this;
        },
      };

      // Find route handler directly
      const router = (app as any)._router ?? (app as any).router;
      const route = router.stack.find((layer: any) => layer.route?.path === '/prototype/sessions/:id/promote')?.route;
      expect(route).toBeDefined();

      const handler = route.stack[0].handle;
      await handler(req, res, (err: any) => { if (err) throw err; });

      expect(responseStatus).toBe(503);
      expect(responseBody.code).toBe('PDL_HANDOFF_NOT_CONFIGURED');
    } finally {
      if (originalEnv) process.env.PDL_API_URL = originalEnv;
    }
  });

  it('8. Duplicate promotion is idempotent and succeeds with existing promotion record', async () => {
    let ingestCallCount = 0;
    const mockHandoffPort = {
      async ingest(req: any) {
        ingestCallCount++;
        return {
          id: 'pdl-task-idempotent-1',
          taskId: 'pdl-task-idempotent-1',
          status: 'QUEUED',
          branch: req.branch,
          repository: req.repository,
          prototypeSessionId: req.prototypeSessionId,
        };
      },
    };

    const existingPromotion = {
      id: 'promo-idempotent-1',
      sessionId: 'sess-idem',
      fromMode: 'PROTOTYPE',
      toMode: 'DEVELOPMENT',
      repository: 'https://github.com/pubcoreagencia/test-repo.git',
      branch: 'prototype/branch',
      checkpointSha: 'sha-idem',
      promotedAt: new Date(),
    };

    let sessionStatus = 'READY';
    const mockPrototypes: any = {
      getSession: async () => ({
        id: 'sess-idem',
        project: 'idem-proj',
        repository: 'https://github.com/pubcoreagencia/test-repo.git',
        branch: 'prototype/branch',
        lastCheckpointSha: 'sha-idem',
        status: sessionStatus,
        mode: sessionStatus === 'PROMOTED' ? 'DEVELOPMENT' : 'PROTOTYPE',
      }),
      promoteSession: async () => {
        if (sessionStatus === 'PROMOTED') return null;
        sessionStatus = 'PROMOTED';
        return {
          id: 'sess-idem',
          project: 'idem-proj',
          repository: 'https://github.com/pubcoreagencia/test-repo.git',
          branch: 'prototype/branch',
          lastCheckpointSha: 'sha-idem',
          status: 'PROMOTED',
          mode: 'DEVELOPMENT',
        };
      },
      createPromotion: async () => existingPromotion,
      getPromotion: async () => existingPromotion,
    };

    const mockEvents: any = { emit: vi.fn() };
    const { PrototypeHandoffService } = await import('../src/pp/handoff/handoff.js');
    const service = new PrototypeHandoffService(mockHandoffPort as any, mockPrototypes, mockEvents);

    // First promotion
    const firstResult = await service.execute({ sessionId: 'sess-idem' });
    expect(firstResult.session.status).toBe('PROMOTED');
    expect(firstResult.promotion.id).toBe('promo-idempotent-1');

    // Second promotion (duplicate)
    const secondResult = await service.execute({ sessionId: 'sess-idem' });
    expect(secondResult.session.status).toBe('PROMOTED');
    expect(secondResult.promotion.id).toBe('promo-idempotent-1');
    expect(secondResult.task.id).toBe('pdl-task-idempotent-1');
  });
});
