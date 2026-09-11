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
});
