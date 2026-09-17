/**
 * Model Routing – Non-Retryable Error Test
 *
 * Scenario: provider returns a deterministic non-retryable FAILED result.
 * Expected: no fallback attempted; task fails immediately after first call.
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

describe('Model Routing – Non-Retryable Error (no fallback)', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;

  beforeEach(async () => {
    workspace = join('/tmp', `mr-nonretryable-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('does not attempt fallback when provider returns a deterministic FAILED result', async () => {
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
        // Return a deterministic FAILED (not TIMED_OUT, not HTTP 429/5xx)
        return {
          status: 'FAILED',
          provider: 'mock', model: 'candidate-1',
          exitCode: 1, durationMs: 10,
          stdout: '', stderr: 'Content policy violation',
          changedFiles: [], commit: null,
          errorCode: 'CONTENT_POLICY', errorMessage: 'Content policy violation',
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

    // Only one call – no fallback for deterministic FAILED
    expect(callCount).toBe(1);

    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('FAILED');
  });
});
