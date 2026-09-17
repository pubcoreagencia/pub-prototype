/**
 * Model Routing – Exhaustion Test
 *
 * Scenario: all candidates idle-timeout.
 * Expected: task fails with MODEL_ROUTING_EXHAUSTED event; no infinite retries.
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
  public updates: Array<{ id: string; payload: any }> = [];
  seed(task: any) { this.tasks[task.id] = { ...task }; }
  async claim(workerId: string) {
    const task = Object.values(this.tasks).find(t => t.status === 'QUEUED');
    if (!task) return null;
    task.status = 'EXECUTING'; task.leaseOwner = workerId;
    task.leaseDeadline = new Date(Date.now() + 300_000);
    return { ...task };
  }
  async update(id: string, payload: any) {
    this.updates.push({ id, payload });
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

describe('Model Routing – Exhaustion (all candidates timeout)', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;

  beforeEach(async () => {
    workspace = join('/tmp', `mr-exhaust-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('marks task FAILED and emits MODEL_ROUTING_EXHAUSTED when all candidates timeout', async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskRepo.seed({
      id: taskId, prototypeSessionId: sessionId, status: 'QUEUED',
      prompt: 'Build something', branch: 'main', project: 'test',
      workspacePath: workspace, objective: 'build',
    });
    protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

    let callCount = 0;
    const logLines: string[] = [];
    const originalLog = console.log.bind(console);
    console.log = (...args: any[]) => {
      const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
      logLines.push(msg);
      originalLog(...args);
    };

    // Every call stalls until aborted
    const fakeProvider: AgentProvider = {
      kind: 'mock',
      model: 'openrouter/free',
      async execute(_task, _ws, options): Promise<ProviderTaskResult> {
        callCount++;
        return new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => {
            resolve({
              status: 'TIMED_OUT', provider: 'mock', model: `candidate-${callCount}`,
              exitCode: null, durationMs: 50, stdout: '', stderr: 'Idle timeout',
              changedFiles: [], commit: null, errorCode: 'IDLE_TIMEOUT', errorMessage: 'Idle timeout',
            });
          });
        });
      },
      async health() { return { available: true, details: '' }; },
      capabilities() { return []; },
      metadata() { return {}; },
    };

    const worker = new PrototypeWorker(
      taskRepo as any, protoRepo as any, fakeProvider, events,
      'test-worker', makeFakePreview() as any,
      { idleTimeoutMs: 40, absoluteTimeoutMs: 10_000 }
    );

    try {
      await worker.executeOnce();
    } finally {
      console.log = originalLog;
    }

    // Task must be FAILED
    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('FAILED');

    // Must not retry infinitely: callCount should be bounded
    // (routing engine will provide at most N candidates)
    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(callCount).toBeLessThanOrEqual(20); // sanity ceiling

    // MODEL_ROUTING_EXHAUSTED event should have been logged
    const exhaustedLog = logLines.find(l => l.includes('MODEL_ROUTING_EXHAUSTED'));
    expect(exhaustedLog).toBeTruthy();
  });
});
