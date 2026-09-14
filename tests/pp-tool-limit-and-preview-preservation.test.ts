import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { AgentProvider } from '../src/providers/types.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';

class FakeTaskRepo {
  public tasks: Record<string, any> = {};
  public updates: Array<{ id: string; payload: any }> = [];

  seed(task: any) {
    this.tasks[task.id] = { ...task };
  }

  async claim(workerId: string) {
    const task = Object.values(this.tasks).find(t => t.status === 'QUEUED');
    if (task) {
      task.status = 'EXECUTING';
      task.leaseOwner = workerId;
      task.leaseDeadline = new Date(Date.now() + 300000);
      return { ...task };
    }
    return null;
  }

  async update(id: string, payload: any) {
    this.updates.push({ id, payload });
    if (this.tasks[id]) {
      Object.assign(this.tasks[id], payload);
    }
  }

  async get(id: string) {
    return this.tasks[id] ? { ...this.tasks[id] } : null;
  }
}

class FakeProtoRepo {
  public sessions: Record<string, any> = {};
  public sessionUpdates: Array<{ id: string; payload: any }> = [];
  public checkpoints: Array<{ sessionId: string; commitSha: string }> = [];

  async getSession(id: string) {
    return this.sessions[id] ? { ...this.sessions[id] } : null;
  }

  async updateSession(id: string, payload: any) {
    this.sessionUpdates.push({ id, payload });
    if (this.sessions[id]) {
      Object.assign(this.sessions[id], payload);
    }
  }

  async createCheckpoint(payload: any) {
    const cp = { checkpointId: `cp-${randomUUID()}`, ...payload };
    this.checkpoints.push(cp);
    return cp;
  }
}

const makeFakePreview = (destroyedRuntimes: string[] = []) => ({
  create: async () => ({ id: 'rt-1', url: 'https://test-preview.trycloudflare.com', port: 3000 }),
  start: async () => ({ id: 'rt-1', url: 'https://test-preview.trycloudflare.com', port: 3000 }),
  stop: async () => {},
  destroy: async (runtimeId: string) => { destroyedRuntimes.push(runtimeId); },
  get: async (id: string) => ({ id, status: 'READY', url: 'https://test-preview.trycloudflare.com', port: 3000 }),
  subscribe: () => () => {},
});

describe('PP Tool Limit and Preview Preservation Tests', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;
  let destroyedRuntimes: string[];

  beforeEach(async () => {
    workspace = join('/tmp', `pp-tool-preservation-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
    destroyedRuntimes = [];
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('OpenRouterProvider Tool Rounds Limit', () => {
    it('2 & 3 & 4. Provider reaches maxToolRounds -> returns TOOL_LOOP_LIMIT, preserves changedFiles, toolCalls and toolRounds', async () => {
      const prevLimit = process.env.OPENROUTER_MAX_TOOL_ROUNDS;
      process.env.OPENROUTER_MAX_TOOL_ROUNDS = '2';

      try {
        const provider = new OpenRouterProvider(undefined, 'test-key', 5000, 'openrouter/free', false);

        let round = 0;
        vi.spyOn(global, 'fetch').mockImplementation(async () => {
          round++;
          return new Response(JSON.stringify({
            id: `gen-${round}`,
            model: 'cohere/north-mini-code:free',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: `tc-${round}`,
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: `file${round}.txt`, content: `hello ${round}` }),
                      },
                    },
                  ],
                },
              },
            ],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const task = {
          id: 'test-task',
          objective: 'Test loop limit',
          prompt: 'Do deep audit',
        };

        const result = await provider.execute(task, workspace);

        expect(result.status).toBe('TOOL_LOOP_LIMIT');
        expect(result.errorCode).toBe('TOOL_LOOP_LIMIT');
        expect(result.errorMessage).toContain('Exceeded max tool rounds (2)');
        expect(result.stderr).not.toBe('All configured OpenRouter models failed');
        expect(result.toolRounds).toBe(2);
        expect(result.toolCalls).toBe(2);
        expect(result.changedFiles).toContain('file1.txt');
        expect(result.changedFiles).toContain('file2.txt');
      } finally {
        if (prevLimit !== undefined) {
          process.env.OPENROUTER_MAX_TOOL_ROUNDS = prevLimit;
        } else {
          delete process.env.OPENROUTER_MAX_TOOL_ROUNDS;
        }
      }
    });

    it('1. Provider HTTP error -> fallback to next candidate model continues working', async () => {
      const prevFallback = process.env.OPENROUTER_FALLBACK_MODELS;
      process.env.OPENROUTER_FALLBACK_MODELS = 'fallback-model:free';

      try {
        const provider = new OpenRouterProvider(undefined, 'test-key', 5000, 'primary-model:free', false);

        vi.spyOn(global, 'fetch').mockImplementation(async (_url, opts: any) => {
          const body = JSON.parse(opts.body);
          if (body.model === 'primary-model:free') {
            return new Response(JSON.stringify({ error: { message: 'Primary unavailable' } }), { status: 500 });
          }
          return new Response(JSON.stringify({
            id: 'gen-fallback',
            model: 'fallback-model:free',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: 'Fallback success',
                },
              },
            ],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const task = {
          id: 'fallback-task',
          objective: 'Fallback test',
          prompt: 'Hello',
        };

        const result = await provider.execute(task, workspace);

        expect(result.status).toBe('COMPLETED');
        expect(result.model).toBe('fallback-model:free');
        expect(result.stdout).toBe('Fallback success');
      } finally {
        if (prevFallback !== undefined) {
          process.env.OPENROUTER_FALLBACK_MODELS = prevFallback;
        } else {
          delete process.env.OPENROUTER_FALLBACK_MODELS;
        }
      }
    });

    it('4. Provider reaching maxToolRounds does NOT attempt secondary fallback models', async () => {
      const prevLimit = process.env.OPENROUTER_MAX_TOOL_ROUNDS;
      const prevFallback = process.env.OPENROUTER_FALLBACK_MODELS;
      process.env.OPENROUTER_MAX_TOOL_ROUNDS = '1';
      process.env.OPENROUTER_FALLBACK_MODELS = 'unwanted-fallback:free';

      try {
        const provider = new OpenRouterProvider(undefined, 'test-key', 5000, 'primary-model:free', false);
        const modelsCalled: string[] = [];

        vi.spyOn(global, 'fetch').mockImplementation(async (_url, opts: any) => {
          const body = JSON.parse(opts.body);
          modelsCalled.push(body.model);
          return new Response(JSON.stringify({
            id: 'gen-primary',
            model: 'primary-model:free',
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      id: 'tc-1',
                      type: 'function',
                      function: {
                        name: 'write_file',
                        arguments: JSON.stringify({ path: 'test.txt', content: 'hello' }),
                      },
                    },
                  ],
                },
              },
            ],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        });

        const task = { id: 'no-fallback-task', objective: 'Test', prompt: 'Do work' };
        const result = await provider.execute(task, workspace);

        expect(result.status).toBe('TOOL_LOOP_LIMIT');
        expect(result.model).toBe('primary-model:free');
        expect(modelsCalled).toEqual(['primary-model:free']);
        expect(modelsCalled).not.toContain('unwanted-fallback:free');
      } finally {
        if (prevLimit !== undefined) {
          process.env.OPENROUTER_MAX_TOOL_ROUNDS = prevLimit;
        } else {
          delete process.env.OPENROUTER_MAX_TOOL_ROUNDS;
        }
        if (prevFallback !== undefined) {
          process.env.OPENROUTER_FALLBACK_MODELS = prevFallback;
        } else {
          delete process.env.OPENROUTER_FALLBACK_MODELS;
        }
      }
    });
  });

  describe('PrototypeWorker Tool Limit & Preview Preservation', () => {
    it('5. Task with TOOL_LOOP_LIMIT + functional workspace -> successfully finalizes, generates checkpoint and updates preview', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Build landing page',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      const fakeProvider: AgentProvider = {
        kind: 'openrouter',
        model: 'cohere/north-mini-code:free',
        async execute(task, ws) {
          await writeFile(join(ws, 'index.html'), '<h1>Recovered Landing Page</h1>');
          return {
            status: 'TOOL_LOOP_LIMIT',
            provider: 'openrouter',
            model: 'cohere/north-mini-code:free',
            exitCode: null,
            durationMs: 50,
            stdout: 'Updated landing page before reaching limit',
            stderr: 'Exceeded max tool rounds (20)',
            changedFiles: ['index.html'],
            commit: null,
            errorCode: 'TOOL_LOOP_LIMIT',
            errorMessage: 'Exceeded max tool rounds (20)',
            toolCalls: 20,
            toolRounds: 20,
          };
        },
        async health() { return { available: true, details: '' }; },
        capabilities() { return []; },
        metadata() { return {}; },
      };

      const worker = new PrototypeWorker(
        taskRepo as any,
        protoRepo as any,
        fakeProvider,
        events,
        'test-worker',
        makeFakePreview(destroyedRuntimes)
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('COMPLETED');
      expect(task.commitSha).toBeDefined();

      const session = await protoRepo.getSession(sessionId);
      expect(session.status).toBe('READY');
      expect(session.previewUrl).toBe('https://test-preview.trycloudflare.com');
      expect(protoRepo.checkpoints.length).toBe(1);
    });

    it('6. Task with TOOL_LOOP_LIMIT + no changes -> fails correctly and preserves prior preview', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Audit without changing files',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });

      const priorPreviewUrl = 'https://existing-stable-preview.trycloudflare.com';
      protoRepo.sessions[sessionId] = {
        id: sessionId,
        status: 'READY',
        promptCount: 2,
        previewUrl: priorPreviewUrl,
        lastCheckpointSha: 'sha-existing',
        previewRuntime: 'rt-stable-1',
      };

      const limitNoChangesProvider: AgentProvider = {
        kind: 'openrouter',
        model: 'cohere/north-mini-code:free',
        async execute() {
          return {
            status: 'TOOL_LOOP_LIMIT',
            provider: 'openrouter',
            model: 'cohere/north-mini-code:free',
            exitCode: null,
            durationMs: 50,
            stdout: 'Looked at files without editing',
            stderr: 'Exceeded max tool rounds (20)',
            changedFiles: [],
            commit: null,
            errorCode: 'TOOL_LOOP_LIMIT',
            errorMessage: 'Exceeded max tool rounds (20)',
            toolCalls: 20,
            toolRounds: 20,
          };
        },
        async health() { return { available: true, details: '' }; },
        capabilities() { return []; },
        metadata() { return {}; },
      };

      const worker = new PrototypeWorker(
        taskRepo as any,
        protoRepo as any,
        limitNoChangesProvider,
        events,
        'test-worker',
        makeFakePreview(destroyedRuntimes)
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('FAILED');
      expect(task.error).toContain('Exceeded max tool rounds (20)');

      // Prior preview preserved!
      const session = await protoRepo.getSession(sessionId);
      expect(session.status).toBe('READY');
      expect(session.previewUrl).toBe(priorPreviewUrl);
      expect(destroyedRuntimes).not.toContain('rt-stable-1');
    });

    it('7. Task fails when prior functional preview exists -> prior preview and session READY are preserved', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Failing prompt after good preview',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });

      // Session already had a functional checkpoint and preview!
      const priorPreviewUrl = 'https://existing-stable-preview.trycloudflare.com';
      const priorSha = 'aabbcc11223344';
      protoRepo.sessions[sessionId] = {
        id: sessionId,
        status: 'READY',
        promptCount: 2,
        previewUrl: priorPreviewUrl,
        lastCheckpointSha: priorSha,
        previewRuntime: 'rt-stable-1',
      };

      const failingProvider: AgentProvider = {
        kind: 'openrouter',
        model: 'cohere/north-mini-code:free',
        async execute() {
          return {
            status: 'FAILED',
            provider: 'openrouter',
            model: 'cohere/north-mini-code:free',
            exitCode: 500,
            durationMs: 30,
            stdout: '',
            stderr: 'Some provider failure',
            changedFiles: [],
            commit: null,
            errorCode: 'ALL_PROVIDERS_FAILED',
            errorMessage: 'Some provider failure',
          };
        },
        async health() { return { available: true, details: '' }; },
        capabilities() { return []; },
        metadata() { return {}; },
      };

      const worker = new PrototypeWorker(
        taskRepo as any,
        protoRepo as any,
        failingProvider,
        events,
        'test-worker',
        makeFakePreview(destroyedRuntimes)
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      // Task is marked FAILED
      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('FAILED');
      expect(task.error).toContain('Some provider failure');

      // Session is preserved as READY with prior preview URL intact!
      const session = await protoRepo.getSession(sessionId);
      expect(session.status).toBe('READY');
      expect(session.previewUrl).toBe(priorPreviewUrl);

      // Verify preview runtime was NOT destroyed immediately!
      expect(destroyedRuntimes).not.toContain('rt-stable-1');
    });

    it('8. Task fails when NO prior preview exists -> fails cleanly and resources are cleaned up', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'First task that fails immediately',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });

      // Fresh session without any prior preview or checkpoint
      protoRepo.sessions[sessionId] = {
        id: sessionId,
        status: 'READY',
        promptCount: 1,
        previewUrl: null,
        lastCheckpointSha: null,
        previewRuntime: null,
      };

      const failingProvider: AgentProvider = {
        kind: 'openrouter',
        model: 'cohere/north-mini-code:free',
        async execute() {
          return {
            status: 'FAILED',
            provider: 'openrouter',
            model: 'cohere/north-mini-code:free',
            exitCode: 500,
            durationMs: 30,
            stdout: '',
            stderr: 'Initial prompt failure',
            changedFiles: [],
            commit: null,
            errorCode: 'ALL_PROVIDERS_FAILED',
            errorMessage: 'Initial prompt failure',
          };
        },
        async health() { return { available: true, details: '' }; },
        capabilities() { return []; },
        metadata() { return {}; },
      };

      const worker = new PrototypeWorker(
        taskRepo as any,
        protoRepo as any,
        failingProvider,
        events,
        'test-worker',
        makeFakePreview(destroyedRuntimes)
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('FAILED');

      // Session is marked FAILED because there was no prior state to preserve
      const session = await protoRepo.getSession(sessionId);
      expect(session.status).toBe('FAILED');
    });
  });
});
