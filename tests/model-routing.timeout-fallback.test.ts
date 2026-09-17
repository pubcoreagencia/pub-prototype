/**
 * Model Routing – Timeout Fallback Test
 *
 * Scenario: first candidate idles-out, second candidate succeeds.
 * Expected: task completes successfully; fallback event is logged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir, writeFile } from 'node:fs/promises';
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

describe('Model Routing – Timeout Fallback', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;

  beforeEach(async () => {
    workspace = join('/tmp', `mr-fallback-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('falls back to candidate-2 when candidate-1 idles-out, task succeeds', async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskRepo.seed({
      id: taskId, prototypeSessionId: sessionId, status: 'QUEUED',
      prompt: 'Build a landing page', branch: 'main', project: 'test',
      workspacePath: workspace, objective: 'landing page',
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

    const fakeProvider: AgentProvider = {
      kind: 'mock',
      model: 'openrouter/free',
      async execute(_task, ws, options): Promise<ProviderTaskResult> {
        callCount++;
        if (callCount === 1) {
          return new Promise((resolve) => {
            options?.signal?.addEventListener('abort', () => {
              resolve({
                status: 'TIMED_OUT', provider: 'mock', model: 'candidate-1',
                exitCode: null, durationMs: 50, stdout: '', stderr: 'Idle timeout',
                changedFiles: [], commit: null, errorCode: 'IDLE_TIMEOUT', errorMessage: 'Idle timeout',
              });
            });
          });
        }
        await writeFile(join(ws, 'index.html'), '<h1>Success</h1>');
        return {
          status: 'COMPLETED', provider: 'mock', model: 'candidate-2',
          exitCode: 0, durationMs: 20, stdout: 'Done', stderr: '',
          changedFiles: ['index.html'], commit: null, errorCode: null, errorMessage: null,
        };
      },
      async health() { return { available: true, details: '' }; },
      capabilities() { return []; },
      metadata() { return {}; },
    };

    const worker = new PrototypeWorker(
      taskRepo as any, protoRepo as any, fakeProvider, events,
      'test-worker', makeFakePreview() as any,
      { idleTimeoutMs: 40, absoluteTimeoutMs: 5000 }
    );

    try {
      await worker.executeOnce();
    } finally {
      console.log = originalLog;
    }

    expect(callCount).toBeGreaterThanOrEqual(2);
    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('COMPLETED');

    const hasFallbackLog = logLines.some(l =>
      l.includes('MODEL_FALLBACK_STARTED') ||
      (l.includes('MODEL_ATTEMPT_FAILED') && l.includes('"willFallback":true'))
    );
    expect(hasFallbackLog).toBe(true);
  });
});
