import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { AgentProvider, ProviderTaskResult, ProviderTaskInput } from '../src/providers/types.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';

class FakeTaskRepo {
  public tasks: Record<string, any> = {};
  seed(task: any) { this.tasks[task.id] = { ...task }; }
  async claim(workerId: string) {
    const task = Object.values(this.tasks).find(t => t.status === 'QUEUED');
    if (!task) return null;
    task.status = 'EXECUTING';
    task.leaseOwner = workerId;
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
  start: async () => ({ id: 'rt-1', url: 'http://test', port: 3000 }),
  stop: async () => {}, destroy: async () => {}, get: async () => null,
  subscribe: () => () => {},
});

describe('PrototypeWorker – Model Override & Streaming Watchdog', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;

  beforeEach(async () => {
    workspace = join('/tmp', `worker-override-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('proves watchdog resets when streaming activity arrives, and triggers timeout when silent', async () => {
    const taskId = randomUUID();
    const sessionId = randomUUID();
    taskRepo.seed({
      id: taskId,
      prototypeSessionId: sessionId,
      status: 'QUEUED',
      prompt: 'Test prompt',
      branch: 'main',
      project: 'test',
      workspacePath: workspace,
      objective: 'build',
    });
    protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

    const modelsReceivedByProvider: string[] = [];

    const mockProvider: AgentProvider = {
      kind: 'mock',
      model: 'openrouter/free',
      async execute(task: ProviderTaskInput, ws, options): Promise<ProviderTaskResult> {
        modelsReceivedByProvider.push(task.modelOverride || 'none');

        if (task.modelOverride === 'minimax/minimax-m2.7:free') {
          // Candidate 1: completely silent, stalls until abort (simulates idle timeout)
          return new Promise((resolve) => {
            options?.signal?.addEventListener('abort', () => {
              resolve({
                status: 'TIMED_OUT', provider: 'mock', model: task.modelOverride || null,
                exitCode: null, durationMs: 50, stdout: '', stderr: 'Idle timeout',
                changedFiles: [], commit: null, errorCode: 'IDLE_TIMEOUT', errorMessage: 'Idle timeout',
              });
            });
          });
        }

        // Candidate 2: sends streaming activity every 20ms for 80ms (idleTimeout is 50ms)
        // Proves onActivity() prevents the 50ms timeout!
        for (let i = 0; i < 4; i++) {
          await new Promise(r => setTimeout(r, 20));
          options?.consumer?.onActivity?.();
        }

        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(ws, 'index.html'), '<h1>Success</h1>');

        return {
          status: 'COMPLETED', provider: 'mock', model: task.modelOverride || null,
          exitCode: 0, durationMs: 90, stdout: 'Done', stderr: '',
          changedFiles: ['index.html'], commit: null, errorCode: null, errorMessage: null,
        };
      },
      async health() { return { available: true, details: '' }; },
      capabilities() { return []; },
      metadata() { return {}; },
    };

    const worker = new PrototypeWorker(
      taskRepo as any,
      protoRepo as any,
      mockProvider,
      events,
      'test-worker',
      makeFakePreview() as any,
      { idleTimeoutMs: 50, absoluteTimeoutMs: 5000 }
    );

    await worker.executeOnce();

    const task = await taskRepo.get(taskId);
    expect(task.status).toBe('COMPLETED');
    // Verifies candidate 1 was received first, then candidate 2 was passed to provider
    expect(modelsReceivedByProvider[0]).toBe('minimax/minimax-m2.7:free');
    expect(modelsReceivedByProvider[1]).toBe('poolside/laguna-s-2.1-20260720:free');
  });
});
