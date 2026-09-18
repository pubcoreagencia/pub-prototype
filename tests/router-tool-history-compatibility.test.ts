import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RouterProvider } from '../src/providers/router.js';
import type { ProviderTaskInput } from '../src/providers/types.js';

describe('9router tool-history compatibility', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('serializes assistant tool-call turns with empty-string content', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'pp-router-tool-history-'));
    const requests: Record<string, unknown>[] = [];

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)));

      if (requests.length === 1) {
        return new Response(JSON.stringify({
          id: 'chatcmpl-test-1',
          object: 'chat.completion',
          model: 'kc/cohere/north-mini-code:free',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{
                id: 'call_write_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({
                    path: 'index.html',
                    content: '<h1>ok</h1>',
                  }),
                },
              }],
            },
          }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      return new Response(JSON.stringify({
        id: 'chatcmpl-test-2',
        object: 'chat.completion',
        model: 'kc/cohere/north-mini-code:free',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'PP_9ROUTER_TOOL_COMPAT_OK',
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = new RouterProvider(
      'https://9router.test/v1',
      'test-key',
      5000,
      'kc/cohere/north-mini-code:free',
      false,
    );

    const task: ProviderTaskInput = {
      id: 'task-router-compat',
      project: 'compat',
      objective: 'create file',
      prompt: 'Create index.html using the write_file tool exactly once.',
      workspacePath: workspace,
      branch: 'main',
      modelOverride: 'kc/cohere/north-mini-code:free',
    };

    const result = await provider.execute(task, workspace);
    console.log('ROUTER_COMPAT_DIAGNOSTIC', JSON.stringify({ status: result.status, errorCode: result.errorCode, errorMessage: result.errorMessage, requests: requests.map(r => ({ model: r.model, messages: r.messages })) }));

    expect(result.status).toBe('COMPLETED');
    expect(requests).toHaveLength(2);

    const second = requests[1] as {
      messages: Array<{
        role: string;
        content?: unknown;
        tool_calls?: unknown[];
        tool_call_id?: string;
      }>
    };

    const assistantToolMessage = second.messages.find(
      message => message.role === 'assistant' && Array.isArray(message.tool_calls)
    );
    expect(assistantToolMessage).toBeDefined();
    expect(assistantToolMessage?.content).toBe('');

    const toolResult = second.messages.find(
      message => message.role === 'tool' && message.tool_call_id === 'call_write_1'
    );
    expect(toolResult).toBeDefined();

    await rm(workspace, { recursive: true, force: true });
  });
});
