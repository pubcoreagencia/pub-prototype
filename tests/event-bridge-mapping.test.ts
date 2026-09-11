// tests/event-bridge-mapping.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OperationalEventBridge, OPERATIONAL_TO_PROTOTYPE_EVENT_MAP } from '../src/pp/events/bridge.js';
import type { PrototypeEventPublisher, PrototypeEventInput } from '../src/pp/events/events.js';
import type { OperationalEventEnvelope } from '../src/providers/streaming/types.js';

describe('P5.5 — OperationalEventBridge: Mapping & Sanitization', () => {
  function createMockPublisher() {
    const emitted: PrototypeEventInput[] = [];
    const publisher: PrototypeEventPublisher = {
      emit: vi.fn(async (input: PrototypeEventInput) => {
        emitted.push(input);
        return {
          id: 'test-id',
          sessionId: input.sessionId,
          type: input.type,
          sequence: emitted.length,
          timestamp: new Date(),
          payload: input.payload || {},
        };
      }),
      subscribe: vi.fn(() => () => {}),
    };
    return { publisher, emitted };
  }

  it('1. maps all 11 operational event types to corresponding prototype event types', async () => {
    const { publisher, emitted } = createMockPublisher();
    const bridge = new OperationalEventBridge('sess-1', publisher, { coalesceDeltas: false });

    const types: Array<keyof typeof OPERATIONAL_TO_PROTOTYPE_EVENT_MAP> = [
      'attempt_started',
      'text_delta',
      'tool_call_delta',
      'tool_call_completed',
      'usage',
      'finish_reason',
      'stream_completed',
      'attempt_completed',
      'attempt_failed',
      'retry_started',
      'task_cancelled',
    ];

    let seq = 0;
    for (const t of types) {
      const envelope: OperationalEventEnvelope = {
        taskId: 'task-1',
        attempt: 0,
        seq: seq++,
        timestamp: new Date().toISOString(),
        type: t as any,
        payload: { sample: 'value', text: 'delta text' },
      };
      await bridge.handleEnvelope(envelope);
    }
    await bridge.close();

    expect(emitted.length).toBe(11);
    expect(emitted.map(e => e.type)).toEqual([
      'AGENT_ATTEMPT_STARTED',
      'AGENT_TEXT_DELTA',
      'AGENT_TOOL_CALL_DELTA',
      'AGENT_TOOL_CALL_COMPLETED',
      'AGENT_USAGE',
      'AGENT_FINISH_REASON',
      'AGENT_STREAM_COMPLETED',
      'AGENT_ATTEMPT_COMPLETED',
      'AGENT_ATTEMPT_FAILED',
      'AGENT_RETRY_STARTED',
      'TASK_CANCELLED',
    ]);
  });

  it('2. sanitizes sensitive credentials and secrets in payloads', async () => {
    const { publisher, emitted } = createMockPublisher();
    const bridge = new OperationalEventBridge('sess-1', publisher, { coalesceDeltas: false });

    const envelope: OperationalEventEnvelope = {
      taskId: 'task-1',
      attempt: 0,
      seq: 0,
      timestamp: new Date().toISOString(),
      type: 'tool_call_completed',
      payload: {
        toolCall: {
          id: 'call-1',
          type: 'function',
          function: {
            name: 'run_command',
            arguments: JSON.stringify({ command: 'git clone' }),
          },
        },
        apiKey: 'sk-secret-key-12345',
        github_token: 'ghp_secretToken',
        nested: {
          authorization: 'Bearer secret-bearer',
          publicInfo: 'safe',
        },
      },
    };

    await bridge.handleEnvelope(envelope);
    await bridge.close();

    expect(emitted.length).toBe(1);
    const p = emitted[0].payload as any;
    expect(p.apiKey).toBe('[REDACTED]');
    expect(p.github_token).toBe('[REDACTED]');
    expect(p.nested.authorization).toBe('[REDACTED]');
    expect(p.nested.publicInfo).toBe('safe');
  });

  it('3. preserves taskId, attempt, and operationalSeq in mapped prototype event payload', async () => {
    const { publisher, emitted } = createMockPublisher();
    const bridge = new OperationalEventBridge('sess-99', publisher, { coalesceDeltas: false });

    const envelope: OperationalEventEnvelope = {
      taskId: 'task-abc',
      attempt: 2,
      seq: 7,
      timestamp: '2026-09-01T12:00:00.000Z',
      type: 'usage',
      payload: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
    };

    await bridge.handleEnvelope(envelope);
    await bridge.close();

    expect(emitted[0].sessionId).toBe('sess-99');
    expect(emitted[0].type).toBe('AGENT_USAGE');
    const p = emitted[0].payload as any;
    expect(p.taskId).toBe('task-abc');
    expect(p.attempt).toBe(2);
    expect(p.operationalSeq).toBe(7);
    expect(p.timestamp).toBe('2026-09-01T12:00:00.000Z');
    expect(p.totalTokens).toBe(150);
  });
});
