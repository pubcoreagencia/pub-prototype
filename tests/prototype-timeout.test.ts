import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { AgentProvider } from '../src/providers/types.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';

class FakeTaskRepo {
  public tasks: Record<string, any> = {};
  public updates: any[] = [];
  seed(task: any) { this.tasks[task.id] = { ...task }; }
  async claim(workerId: string) {
    const task = Object.values(this.tasks).find(t => t.status === 'QUEUED');
    if (task) {
      task.status = 'EXECUTING';
      task.leaseOwner = workerId;
      task.leaseDeadline = new Date(Date.now() + 300000);
      return task;
    }
    return null;
  }
  async update(id: string, payload: any) {
    this.updates.push(payload);
    Object.assign(this.tasks[id], payload);
  }
  async get(id: string) { return this.tasks[id]; }
}

class FakeProtoRepo {
  public sessions: Record<string, any> = {};
  async getSession(id: string) { return this.sessions[id]; }
  async updateSession(id: string, payload: any) { Object.assign(this.sessions[id], payload); }
  async createCheckpoint() { return { commitSha: '123' }; }
}

const makeFakePreview = () => ({
  create: async () => ({ id: 'rt-1', url: 'http://test', port: 3000 }),
  start: async () => ({ id: 'rt-1', url: 'http://test', port: 3000 }),
  stop: async () => {},
  destroy: async () => {},
  get: async () => null,
  subscribe: () => () => {},
});

describe('Prototype Worker - Real Execution Cancellation', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;
  let realSetTimeout: any;

  beforeEach(async () => {
    workspace = join('/tmp', `pp-test-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
    
    realSetTimeout = global.setTimeout;
    const fastSetTimeout = ((cb: any, ms: number) => {
      if (ms === 120000) return realSetTimeout(cb, 10);
      return realSetTimeout(cb, ms);
    }) as any;
    global.setTimeout = fastSetTimeout;
  });

  afterEach(async () => {
    global.setTimeout = realSetTimeout;
    await rm(workspace, { recursive: true, force: true });
  });

  it('TEST 1: Provider responds normally before 120s -> COMPLETED', async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskRepo.seed({ id: taskId, prototypeSessionId: sessionId, status: 'QUEUED', prompt: 'hi', branch: 'main', project: 'test', workspacePath: workspace });
    protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

    const fakeProvider: AgentProvider = {
      kind: 'mock', model: null,
      async execute(task, ws, options) {
        return { status: 'COMPLETED', provider: 'mock', model: null, exitCode: 0, durationMs: 10, stdout: 'Done', stderr: '', changedFiles: [], commit: null, errorCode: null, errorMessage: null };
      },
      async health() { return { available: true, details: '' }; },
      capabilities() { return []; },
      metadata() { return {}; }
    };

    const worker = new PrototypeWorker(taskRepo as any, protoRepo as any, fakeProvider, events, 'test-worker', makeFakePreview());
    const result = await worker.executeOnce();
    
    expect(result).toBe(true);
    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('COMPLETED');
  });

  it('TEST 2 & 3: Provider terminates safely, late results discarded, task lease released', async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskRepo.seed({ id: taskId, prototypeSessionId: sessionId, status: 'QUEUED', prompt: 'hi', branch: 'main', project: 'test', workspacePath: workspace });
    protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

    let abortCalled = false;
    let lateResultProcessed = false;

    const fakeProvider: AgentProvider = {
      kind: 'mock', model: null,
      async execute(task, ws, options) {
        return new Promise((resolve) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              abortCalled = true;
              resolve({ status: 'TIMED_OUT', provider: 'mock', model: null, exitCode: null, durationMs: 0, stdout: '', stderr: 'Aborted', changedFiles: [], commit: null, errorCode: 'EXECUTION_TIMEOUT', errorMessage: 'Aborted' });
            });
          }
          realSetTimeout(() => {
            if (!abortCalled) resolve({ status: 'COMPLETED', provider: 'mock', model: null, exitCode: 0, durationMs: 10, stdout: 'Late', stderr: '', changedFiles: [], commit: null, errorCode: null, errorMessage: null });
            else lateResultProcessed = true;
          }, 50); // resolving after our fake fast timeout (10ms)
        });
      },
      async health() { return { available: true, details: '' }; },
      capabilities() { return []; },
      metadata() { return {}; }
    };

    const worker = new PrototypeWorker(taskRepo as any, protoRepo as any, fakeProvider, events, 'test-worker', makeFakePreview());
    const result = await worker.executeOnce();
    
    expect(result).toBe(true);
    expect(abortCalled).toBe(true);
    
    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('FAILED');
    expect(task.error).toContain('time'); // "execution timed out"
    expect(task.leaseOwner).toBeNull(); // TEST 5: Lease remains consistent/released

    // Wait slightly to ensure late result doesn't crash anything (TEST 3)
    await new Promise(r => realSetTimeout(r, 60));
    expect(lateResultProcessed).toBe(true);
  });
});
