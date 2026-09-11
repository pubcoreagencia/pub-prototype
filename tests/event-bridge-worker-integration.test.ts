import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { AgentProvider, ProviderTaskResult } from '../src/providers/types.js';
import type { PrototypeEventPublisher, PrototypeEventInput } from '../src/pp/events/events.js';
import type { Task } from '../src/domain.js';


describe('P5.5 â€” PrototypeWorker: Streaming Bridge Integration', () => {
  it('1. delivers streamed operational events to PrototypeEventPublisher while executing task', async () => {
    const emittedEvents: PrototypeEventInput[] = [];
    const mockPublisher: PrototypeEventPublisher = {
      emit: vi.fn(async (input: PrototypeEventInput) => {
        emittedEvents.push(input);
        return {
          id: 'mock-id',
          sessionId: input.sessionId,
          type: input.type,
          sequence: emittedEvents.length,
          timestamp: new Date(),
          payload: input.payload || {},
        };
      }),
      subscribe: vi.fn(() => () => {}),
    };

    const mockTasks: any = {
      update: vi.fn(async () => ({})),
      heartbeat: vi.fn(async () => true),
      get: vi.fn(async () => null),
    };

    const mockPrototypes: any = {
      updateSession: vi.fn(async () => ({})),
      getSession: vi.fn(async () => ({ id: 'sess-p55-123', promptCount: 1, previewRuntime: null })),
      createCheckpoint: vi.fn(async () => ({ id: 'cp-1', commitSha: 'abc', previewUrl: 'http://preview' })),
    };


    const mockProvider: AgentProvider = {
      kind: 'openrouter',
      execute: vi.fn(async (task: Task, workspace: string, options?: any) => {
        const consumer = options?.consumer;
        if (consumer?.onEvent) {
          consumer.onEvent({ type: 'text_delta', text: 'Streaming chunk 1' });
          consumer.onEvent({ type: 'text_delta', text: 'Streaming chunk 2' });
          consumer.onEvent({ type: 'usage', usage: { totalTokens: 42 } });
          consumer.onEvent({ type: 'finish_reason', finishReason: 'stop' });
          consumer.onEvent({ type: 'stream_completed' });
        }
        return {
          status: 'COMPLETED',
          provider: 'openrouter',
          model: 'openrouter/free',
          exitCode: 0,
          durationMs: 120,
          stdout: 'Final output from agent',
          stderr: '',
          changedFiles: [],
          commit: null,
          totalTokens: 42,
        } as ProviderTaskResult;
      }),
    };

    const worker = new PrototypeWorker(
      mockTasks,
      mockPrototypes,
      mockProvider,
      mockPublisher
    );

    const tempRepo = await (await import('node:fs/promises')).mkdtemp(path.join((await import('node:os')).tmpdir(), 'pdl-p55-test-'));
    const { execSync } = await import('node:child_process');
    execSync('git init', { cwd: tempRepo, stdio: 'ignore' });
    execSync('git config user.name Tester', { cwd: tempRepo, stdio: 'ignore' });
    execSync('git config user.email test@pdl.internal', { cwd: tempRepo, stdio: 'ignore' });
    execSync('git commit --allow-empty -m init', { cwd: tempRepo, stdio: 'ignore' });

    const task: Task = {
      id: 'task-test-p55',
      project: 'test-project',
      repository: tempRepo,
      objective: 'Verify PrototypeWorker Streaming Bridge',
      prompt: 'Do stream',
      status: 'QUEUED',
      priority: 0,
      worker: null,
      result: null,
      error: null,
      branch: 'prototype/test',
      commitSha: null,
      gitStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      leaseOwner: null,
      leaseDeadline: null,
      heartbeatAt: null,
      workspacePath: tempRepo,
      prototypeSessionId: 'sess-p55-123',
    };

    mockTasks.claimPrototype = vi.fn(async () => task);
    mockTasks.claim = vi.fn(async () => task);

    // Execute provider directly through executeOnce
    await worker.executeOnce();

    try {
      await (await import('node:fs/promises')).rm(tempRepo, { recursive: true, force: true });
    } catch {}

    const types = emittedEvents.map(e => e.type);
    expect(types).toContain('AGENT_STARTED');
    expect(types).toContain('AGENT_ATTEMPT_STARTED');
    expect(types).toContain('AGENT_TEXT_DELTA');
    expect(types).toContain('AGENT_USAGE');
    expect(types).toContain('AGENT_ATTEMPT_COMPLETED');
    expect(types).toContain('AGENT_OUTPUT');

    const textDeltaEvent = emittedEvents.find(e => e.type === 'AGENT_TEXT_DELTA');
    expect(textDeltaEvent).toBeDefined();
    expect((textDeltaEvent?.payload as any).text).toBe('Streaming chunk 1Streaming chunk 2');
  });
});

