/**
 * Model Routing – Auth Error No-Fallback Test
 *
 * Scenario: provider returns ROUTER_HTTP_ERROR with httpStatus 401.
 * Expected: no fallback attempted; task fails immediately.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { AgentProvider, ProviderTaskResult } from '../src/providers/types.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';

class FakeTaskRepo {
  public tasks: Record<string, any> = {};
  seed(task: any) { this.tasks[task.id] = { ...task }; }
  async claim(workerId: string) {
    const task = Object.values(this.tasks).find(t => t.status === 'QUEUED');
    if (!task) return null;
    task.status = 'EXECUTING'; task.leaseOwner = workerId;
    task.leaseDeadline = new Date(Date.now() + 300_000);
    return { ...task };
  }
  async update(id: string, payload: any) {
    if (this.tasks[id]) Object.assign(this.tasks[id], payload);
  }
  async get(id: string) { return this.tasks[id] ? { ...this.tasks[id] } : null; }
  async heartbeat() { return true; }
}

class FakeProtoRepo {
  public sessions: Record<string, any> = {};
  async getSession(id: string) { return this.sessions[id] ? { ...this.sessions[id] } : null; }
  async updateSession(id: string, payload: any) {
    if (this.sessions[id]) Object.assign(this.sessions[id], payload);
  }
  async createCheckpoint(payload: any) {
    return { checkpointId: `cp-${randomUUID()}`, id: `cp-${randomUUID()}`, ...payload };
  }
}

const makeFakePreview = () => ({
  create: async () => ({ id: 'rt-1', url: 'http://test', port: 3000 }),
  start:  async () => ({ id: 'rt-1', url: 'http://test', port: 3000 }),
  stop: async () => {}, destroy: async () => {}, get: async () => null,
  subscribe: () => () => {},
});

describe('Model Routing – Auth Error (no fallback on 401)', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;

  beforeEach(async () => {
    workspace = join('/tmp', `mr-auth-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('does not fall back on 401 authentication error', async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskRepo.seed({
      id: taskId, prototypeSessionId: sessionId, status: 'QUEUED',
      prompt: 'Build something', branch: 'main', project: 'test',
      workspacePath: workspace, objective: 'build',
    });
    protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

    let callCount = 0;

    const fakeProvider: AgentProvider = {
      kind: 'mock',
      model: 'openrouter/free',
      async execute(_task, _ws, _options): Promise<ProviderTaskResult> {
        callCount++;
        return {
          status: 'ROUTER_HTTP_ERROR',
          provider: 'mock', model: 'candidate-1',
          exitCode: null, durationMs: 5,
          stdout: '', stderr: 'Unauthorized',
          changedFiles: [], commit: null,
          errorCode: 'AUTH_ERROR', errorMessage: 'Unauthorized',
          httpStatus: 401,
        };
      },
      async health() { return { available: true, details: '' }; },
      capabilities() { return []; },
      metadata() { return {}; },
    };

    const worker = new PrototypeWorker(
      taskRepo as any, protoRepo as any, fakeProvider, events,
      'test-worker', makeFakePreview() as any,
      { idleTimeoutMs: 5000, absoluteTimeoutMs: 30_000 }
    );

    await worker.executeOnce();

    // 401 must not trigger fallback – only one call
    expect(callCount).toBe(1);

    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('FAILED');
  });

  it('does fall back on 429 rate-limit error', async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskRepo.seed({
      id: taskId, prototypeSessionId: sessionId, status: 'QUEUED',
      prompt: 'Build something', branch: 'main', project: 'test',
      workspacePath: workspace, objective: 'build',
    });
    protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

    let callCount = 0;

    const fakeProvider: AgentProvider = {
      kind: 'mock',
      model: 'openrouter/free',
      async execute(_task, ws, _options): Promise<ProviderTaskResult> {
        callCount++;
        if (callCount === 1) {
          return {
            status: 'ROUTER_HTTP_ERROR',
            provider: 'mock', model: 'candidate-1',
            exitCode: null, durationMs: 5,
            stdout: '', stderr: 'Rate limited',
            changedFiles: [], commit: null,
            errorCode: 'RATE_LIMIT', errorMessage: 'Rate limited',
            httpStatus: 429,
          };
        }
        // Second candidate succeeds
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(ws, 'index.html'), '<h1>Ok</h1>');
        return {
          status: 'COMPLETED', provider: 'mock', model: 'candidate-2',
          exitCode: 0, durationMs: 10, stdout: 'Done', stderr: '',
          changedFiles: ['index.html'], commit: null,
          errorCode: null, errorMessage: null,
        };
      },
      async health() { return { available: true, details: '' }; },
      capabilities() { return []; },
      metadata() { return {}; },
    };

    const worker = new PrototypeWorker(
      taskRepo as any, protoRepo as any, fakeProvider, events,
      'test-worker', makeFakePreview() as any,
      { idleTimeoutMs: 5000, absoluteTimeoutMs: 30_000 }
    );

    await worker.executeOnce();

    // 429 IS retryable, so we expect at least 2 calls
    expect(callCount).toBeGreaterThanOrEqual(2);

    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('COMPLETED');
  });
});
