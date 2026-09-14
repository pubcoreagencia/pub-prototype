import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { AgentProvider } from '../src/providers/types.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { parseOpenAISSEStream, StreamEventSink } from '../src/providers/streaming/index.js';
import type { StreamEvent } from '../src/providers/streaming/types.js';

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

const makeFakePreview = () => ({
  create: async () => ({ id: 'rt-1', url: 'http://test', port: 3000 }),
  start: async () => ({ id: 'rt-1', url: 'http://test', port: 3000 }),
  stop: async () => {},
  destroy: async () => {},
  get: async () => null,
  subscribe: () => () => {},
});

function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('PP Free Liveness & Two-Tier Timeout Tests', () => {
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakeProtoRepo;
  let events: PrototypeEventStream;

  beforeEach(async () => {
    workspace = join('/tmp', `pp-liveness-test-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakeProtoRepo();
    events = new PrototypeEventStream();
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('SSE Parser & Sink Activity', () => {
    it('recognizes delta.reasoning without creating public operational envelopes', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"role":"assistant","content":"","reasoning":"Analyzing requirements"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning":" and drafting solution"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"<h1>Done</h1>"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const stream = createReadableStream(sseChunks);
      const capturedEvents: StreamEvent[] = [];
      const capturedEnvelopes: any[] = [];
      let activityCount = 0;

      const sink = new StreamEventSink(
        {
          onEnvelope: (envelope) => capturedEnvelopes.push(envelope),
          onActivity: () => { activityCount++; },
        },
        { taskId: 'test-task', attempt: 0 }
      );

      const result = await parseOpenAISSEStream(
        stream,
        undefined,
        (e) => {
          capturedEvents.push(e);
          sink.onEvent(e);
        }
      );

      expect(result.fullText).toBe('<h1>Done</h1>');
      // Verify reasoning_delta was emitted
      const reasoningEvents = capturedEvents.filter(e => e.type === 'reasoning_delta');
      expect(reasoningEvents.length).toBe(2);
      expect(reasoningEvents[0].text).toBe('Analyzing requirements');
      expect(reasoningEvents[1].text).toBe(' and drafting solution');

      // Verify onActivity was triggered for reasoning + content + stream_completed
      expect(activityCount).toBeGreaterThanOrEqual(3);

      // Verify NO operational envelope was emitted for reasoning_delta (only text_delta, stream_completed)
      const reasoningEnvelopes = capturedEnvelopes.filter(env => env.type === 'reasoning_delta');
      expect(reasoningEnvelopes.length).toBe(0);
      expect(capturedEnvelopes.some(env => env.type === 'text_delta')).toBe(true);
    });

    it('recognizes various reasoning flavors (delta.thought, delta.reasoning_content, delta.reasoning_details)', async () => {
      const sseChunks = [
        'data: {"choices":[{"delta":{"reasoning_content":"Thought from deepseek"}}]}\n\n',
        'data: {"choices":[{"delta":{"thought":"Thought from qwen"}}]}\n\n',
        'data: {"choices":[{"delta":{"reasoning_details":[{"type":"text","text":"Thought from details"}]}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const stream = createReadableStream(sseChunks);
      const capturedEvents: StreamEvent[] = [];

      await parseOpenAISSEStream(stream, undefined, (e) => capturedEvents.push(e));

      const reasoningEvents = capturedEvents.filter(e => e.type === 'reasoning_delta');
      expect(reasoningEvents.length).toBe(3);
      expect(reasoningEvents[0].text).toBe('Thought from deepseek');
      expect(reasoningEvents[1].text).toBe('Thought from qwen');
      expect(reasoningEvents[2].text).toBe('Thought from details');
    });

    it('H. MALFORMED/EMPTY SSE: does not crash and does not emit spurious events', async () => {
      const sseChunks = [
        ': ping\n\n',
        'data: \n\n',
        'data: { invalid json\n\n',
        'data: {"choices":[]}\n\n',
        'data: {"choices":[{"delta":{}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      const stream = createReadableStream(sseChunks);
      const capturedEvents: StreamEvent[] = [];

      const result = await parseOpenAISSEStream(stream, undefined, (e) => capturedEvents.push(e));
      expect(result.fullText).toBe('');
      // Only stream_completed should be emitted
      expect(capturedEvents.filter(e => e.type === 'text_delta').length).toBe(0);
      expect(capturedEvents.filter(e => e.type === 'reasoning_delta').length).toBe(0);
    });
  });

  describe('Two-Tier Worker Timeout Lifecycle', () => {
    it('A. CONTENT: Provider continuously emits content -> SUCCESS', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Build app',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      const fakeProvider: AgentProvider = {
        kind: 'mock',
        model: 'openrouter/free',
        async execute(task, ws, options) {
          // Emit text delta chunks every 20ms for 3 iterations
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 20));
            options?.consumer?.onEvent?.({ type: 'text_delta', text: `Chunk ${i} ` });
          }
          await writeFile(join(ws, 'index.html'), '<h1>Content Success</h1>');
          return {
            status: 'COMPLETED',
            provider: 'mock',
            model: 'openrouter/free',
            exitCode: 0,
            durationMs: 70,
            stdout: 'Chunk 0 Chunk 1 Chunk 2 ',
            stderr: '',
            changedFiles: ['index.html'],
            commit: null,
            errorCode: null,
            errorMessage: null,
          };
        },
        async health() { return { available: true, details: '' }; },
        capabilities() { return []; },
        metadata() { return {}; },
      };

      // Set short idle timeout (50ms) and absolute timeout (500ms)
      // Total duration ~70ms with activity every 20ms -> idle timer (50ms) never fires!
      const worker = new PrototypeWorker(
        taskRepo as any,
        protoRepo as any,
        fakeProvider,
        events,
        'test-worker',
        makeFakePreview(),
        { idleTimeoutMs: 50, absoluteTimeoutMs: 500 }
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('COMPLETED');
    });

    it('B. REASONING ONLY: Provider emits reasoning for > idle timeout -> DOES NOT timeout while active', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Complex reasoning prompt',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      const fakeProvider: AgentProvider = {
        kind: 'mock',
        model: 'openrouter/free',
        async execute(task, ws, options) {
          // Total duration ~120ms with reasoning emitted every 25ms
          // Idle timeout is 50ms, so without liveness it would have timed out at 50ms
          for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 25));
            options?.consumer?.onEvent?.({ type: 'reasoning_delta', text: `Thinking step ${i}` });
          }
          await writeFile(join(ws, 'index.html'), '<h1>Reasoning Succeeded</h1>');
          return {
            status: 'COMPLETED',
            provider: 'mock',
            model: 'openrouter/free',
            exitCode: 0,
            durationMs: 120,
            stdout: 'Success after reasoning',
            stderr: '',
            changedFiles: ['index.html'],
            commit: null,
            errorCode: null,
            errorMessage: null,
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
        makeFakePreview(),
        { idleTimeoutMs: 50, absoluteTimeoutMs: 500 }
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('COMPLETED');
    });

    it('C. REASONING -> CONTENT: Provider emits reasoning then content -> SUCCESS', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Reasoning then content',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      const fakeProvider: AgentProvider = {
        kind: 'mock',
        model: 'openrouter/free',
        async execute(task, ws, options) {
          // 1. Reasoning
          await new Promise(r => setTimeout(r, 20));
          options?.consumer?.onEvent?.({ type: 'reasoning_delta', text: 'Drafting logic' });
          // 2. Content
          await new Promise(r => setTimeout(r, 20));
          options?.consumer?.onEvent?.({ type: 'text_delta', text: '<h1>Final Component</h1>' });

          await writeFile(join(ws, 'index.html'), '<h1>Final Component</h1>');
          return {
            status: 'COMPLETED',
            provider: 'mock',
            model: 'openrouter/free',
            exitCode: 0,
            durationMs: 50,
            stdout: '<h1>Final Component</h1>',
            stderr: '',
            changedFiles: ['index.html'],
            commit: null,
            errorCode: null,
            errorMessage: null,
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
        makeFakePreview(),
        { idleTimeoutMs: 50, absoluteTimeoutMs: 500 }
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('COMPLETED');
    });

    it('D. TOOL CALL: Provider triggers tool calls resetting idle timer -> SUCCESS', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Tool execution prompt',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      const fakeProvider: AgentProvider = {
        kind: 'mock',
        model: 'openrouter/free',
        async execute(task, ws, options) {
          // Emits tool delta and triggers onActivity
          for (let i = 0; i < 3; i++) {
            await new Promise(r => setTimeout(r, 25));
            options?.consumer?.onActivity?.();
          }
          await writeFile(join(ws, 'index.html'), '<h1>Tool Success</h1>');
          return {
            status: 'COMPLETED',
            provider: 'mock',
            model: 'openrouter/free',
            exitCode: 0,
            durationMs: 80,
            stdout: 'Tools executed',
            stderr: '',
            changedFiles: ['index.html'],
            commit: null,
            errorCode: null,
            errorMessage: null,
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
        makeFakePreview(),
        { idleTimeoutMs: 50, absoluteTimeoutMs: 500 }
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('COMPLETED');
    });

    it('E. IDLE TIMEOUT: Provider stops emitting events -> Fails by IDLE_TIMEOUT', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Stalling prompt',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      let aborted = false;

      const fakeProvider: AgentProvider = {
        kind: 'mock',
        model: 'openrouter/free',
        async execute(task, ws, options) {
          // Emit one initial event, then stall indefinitely
          options?.consumer?.onEvent?.({ type: 'text_delta', text: 'Start...' });
          return new Promise((resolve) => {
            options?.signal?.addEventListener('abort', () => {
              aborted = true;
              resolve({
                status: 'TIMED_OUT',
                provider: 'mock',
                model: 'openrouter/free',
                exitCode: null,
                durationMs: 60,
                stdout: '',
                stderr: 'Aborted due to idle timeout',
                changedFiles: [],
                commit: null,
                errorCode: 'IDLE_TIMEOUT',
                errorMessage: 'Aborted due to idle timeout',
              });
            });
          });
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
        makeFakePreview(),
        { idleTimeoutMs: 40, absoluteTimeoutMs: 500 }
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);
      expect(aborted).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('FAILED');
      expect(task.error).toContain('idle timeout exceeded');
    });

    it('F. ABSOLUTE TIMEOUT: Provider emits reasoning indefinitely past absolute limit -> Fails by ABSOLUTE TIMEOUT', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Infinite reasoning prompt',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      let aborted = false;

      const fakeProvider: AgentProvider = {
        kind: 'mock',
        model: 'openrouter/free',
        async execute(task, ws, options) {
          return new Promise((resolve) => {
            const interval = setInterval(() => {
              // Keep emitting reasoning every 15ms so idle timer (50ms) never fires!
              options?.consumer?.onEvent?.({ type: 'reasoning_delta', text: 'Looping...' });
            }, 15);

            options?.signal?.addEventListener('abort', () => {
              clearInterval(interval);
              aborted = true;
              resolve({
                status: 'TIMED_OUT',
                provider: 'mock',
                model: 'openrouter/free',
                exitCode: null,
                durationMs: 120,
                stdout: '',
                stderr: 'Absolute timeout fired',
                changedFiles: [],
                commit: null,
                errorCode: 'EXECUTION_TIMEOUT',
                errorMessage: 'Absolute timeout fired',
              });
            });
          });
        },
        async health() { return { available: true, details: '' }; },
        capabilities() { return []; },
        metadata() { return {}; },
      };

      // idleTimeoutMs: 50ms, absoluteTimeoutMs: 80ms
      const worker = new PrototypeWorker(
        taskRepo as any,
        protoRepo as any,
        fakeProvider,
        events,
        'test-worker',
        makeFakePreview(),
        { idleTimeoutMs: 50, absoluteTimeoutMs: 80 }
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);
      expect(aborted).toBe(true);

      const task = await taskRepo.get(taskId);
      expect(task.status).toBe('FAILED');
      expect(task.error).toContain('absolute timeout exceeded');
    });

    it('G. COMPLETION RACE: Provider finishes right as timeout fires -> Single clean final status', async () => {
      const taskId = randomUUID();
      const sessionId = randomUUID();
      taskRepo.seed({
        id: taskId,
        prototypeSessionId: sessionId,
        status: 'QUEUED',
        prompt: 'Race prompt',
        branch: 'main',
        project: 'test',
        workspacePath: workspace,
      });
      protoRepo.sessions[sessionId] = { id: sessionId, status: 'READY', promptCount: 1 };

      const fakeProvider: AgentProvider = {
        kind: 'mock',
        model: 'openrouter/free',
        async execute(task, ws, options) {
          // Resolve exactly around timeout boundary (~40ms)
          await new Promise(r => setTimeout(r, 40));
          await writeFile(join(ws, 'index.html'), '<h1>Race Content</h1>');
          return {
            status: 'COMPLETED',
            provider: 'mock',
            model: 'openrouter/free',
            exitCode: 0,
            durationMs: 40,
            stdout: 'Race finished',
            stderr: '',
            changedFiles: ['index.html'],
            commit: null,
            errorCode: null,
            errorMessage: null,
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
        makeFakePreview(),
        { idleTimeoutMs: 40, absoluteTimeoutMs: 500 }
      );

      const result = await worker.executeOnce();
      expect(result).toBe(true);

      const task = await taskRepo.get(taskId);
      // Status must be either COMPLETED or FAILED, never in-between or null lease
      expect(['COMPLETED', 'FAILED']).toContain(task.status);
      expect(task.leaseOwner).toBeNull();
    });
  });
});
