// tests/event-bridge-retry.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OperationalEventBridge } from '../src/pp/events/bridge.js';
import type { PrototypeEventPublisher, PrototypeEventInput } from '../src/pp/events/events.js';

describe('P5.5 — OperationalEventBridge: Retry & Attempt Isolation', () => {
  it('1. correctly separates multiple attempts and emits AGENT_RETRY_STARTED', async () => {
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

    const bridge = new OperationalEventBridge('sess-retry', publisher, { coalesceDeltas: false });

    // Attempt 0 fails
    await bridge.handleEnvelope({
      taskId: 'task-retry-1',
      attempt: 0,
      seq: 0,
      timestamp: new Date().toISOString(),
      type: 'attempt_started',
      payload: { model: 'model-a' },
    });
    await bridge.handleEnvelope({
      taskId: 'task-retry-1',
      attempt: 0,
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'attempt_failed',
      payload: { error: 'Rate limit', retryable: true },
    });

    // Retry transition
    await bridge.handleEnvelope({
      taskId: 'task-retry-1',
      attempt: 1,
      seq: 0,
      timestamp: new Date().toISOString(),
      type: 'retry_started',
      payload: { fromAttempt: 0, toAttempt: 1 },
    });

    // Attempt 1 succeeds
    await bridge.handleEnvelope({
      taskId: 'task-retry-1',
      attempt: 1,
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'attempt_started',
      payload: { model: 'model-b' },
    });
    await bridge.handleEnvelope({
      taskId: 'task-retry-1',
      attempt: 1,
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'text_delta',
      payload: { text: 'Retry success' },
    });
    await bridge.handleEnvelope({
      taskId: 'task-retry-1',
      attempt: 1,
      seq: 3,
      timestamp: new Date().toISOString(),
      type: 'attempt_completed',
      payload: { status: 'COMPLETED', durationMs: 150 },
    });
    await bridge.close();

    const types = emitted.map(e => e.type);
    expect(types).toEqual([
      'AGENT_ATTEMPT_STARTED',
      'AGENT_ATTEMPT_FAILED',
      'AGENT_RETRY_STARTED',
      'AGENT_ATTEMPT_STARTED',
      'AGENT_TEXT_DELTA',
      'AGENT_ATTEMPT_COMPLETED',
    ]);

    expect((emitted[1].payload as any).attempt).toBe(0);
    expect((emitted[2].payload as any).fromAttempt).toBe(0);
    expect((emitted[2].payload as any).toAttempt).toBe(1);
    expect((emitted[3].payload as any).attempt).toBe(1);
  });
});
