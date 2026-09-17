import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import { StreamEventSink } from '../src/providers/streaming/index.js';
import type { ProviderTaskInput } from '../src/providers/types.js';

describe('OpenRouterProvider – modelOverride & Streaming Contract', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('1. sends exact candidate model specified in task.modelOverride even if OPENROUTER_MODEL is configured', async () => {
    let capturedBody: any = null;

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    // Provider instantiated with default model openrouter/free
    const provider = new OpenRouterProvider(
      undefined,
      'sk-test-key',
      5000,
      'openrouter/free',
      false
    );

    const task: ProviderTaskInput = {
      id: 'task-1',
      objective: 'test',
      prompt: 'Hello',
      modelOverride: 'qwen/qwen3.8-27b:free',
    };

    const res = await provider.execute(task, '/tmp');
    expect(res.status).toBe('COMPLETED');
    expect(capturedBody).not.toBeNull();
    expect(capturedBody.model).toBe('qwen/qwen3.8-27b:free');
  });


  it('2. task.modelOverride executes ONLY the requested candidate without duplicate routing', async () => {
    const modelsAttempted: string[] = [];

    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.body) {
        const body = JSON.parse(init.body as string);
        modelsAttempted.push(body.model);
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });

    const provider = new OpenRouterProvider(
      undefined,
      'sk-test-key',
      5000,
      'openrouter/free',
      false
    );

    const task: ProviderTaskInput = {
      id: 'task-2',
      objective: 'test',
      prompt: 'Hello',
      modelOverride: 'cohere/north-mini-code:free',
    };

    await provider.execute(task, '/tmp');
    // Must execute strictly the single requested candidate
    expect(modelsAttempted).toEqual(['cohere/north-mini-code:free']);
  });

  it('3. streaming=true emits text_delta and invokes onActivity()', async () => {
    let activityCount = 0;
    const receivedDeltas: string[] = [];

    const sink = new StreamEventSink({
      onEvent: (e) => {
        if (e.type === 'text_delta') receivedDeltas.push(e.text);
      },
      onActivity: () => {
        activityCount++;
      },
    });

    const sseStream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" World"}}]}\n\n'));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    global.fetch = vi.fn().mockImplementation(async () => {
      return new Response(sseStream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    });

    const provider = new OpenRouterProvider(
      undefined,
      'sk-test-key',
      5000,
      'openrouter/free',
      true, // enableStream
      sink
    );

    const task: ProviderTaskInput = {
      id: 'task-3',
      objective: 'test',
      prompt: 'Hello',
      modelOverride: 'cohere/north-mini-code:free',
    };


    const res = await provider.execute(task, '/tmp', { consumer: sink });
    expect(res.status).toBe('COMPLETED');
    expect(res.stdout).toBe('Hello World');
    expect(receivedDeltas).toEqual(['Hello', ' World']);
    expect(activityCount).toBeGreaterThanOrEqual(2);
  });
});
