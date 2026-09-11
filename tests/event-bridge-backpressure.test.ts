// tests/event-bridge-backpressure.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OperationalEventBridge } from '../src/pp/events/bridge.js';
import type { PrototypeEventPublisher, PrototypeEventInput } from '../src/pp/events/events.js';
import type { OperationalEventEnvelope } from '../src/providers/streaming/types.js';

describe('P5.5 — OperationalEventBridge: Backpressure & Micro-Batching', () => {
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

  it('1. coalesces rapid text_delta events while preserving startSeq, endSeq and content order', async () => {
    const { publisher, emitted } = createMockPublisher();
    const bridge = new OperationalEventBridge('sess-fast', publisher, {
      coalesceDeltas: true,
      flushIntervalMs: 50,
    });

    const words = ['Hello ', 'from ', 'high-speed ', 'streaming ', 'bridge!'];
    for (let i = 0; i < words.length; i++) {
      const envelope: OperationalEventEnvelope = {
        taskId: 'task-stream-1',
        attempt: 0,
        seq: i + 1,
        timestamp: new Date().toISOString(),
        type: 'text_delta',
        payload: { text: words[i] },
      };
      await bridge.handleEnvelope(envelope);
    }

    // Before flush timer or non-delta arrives, emitted is empty
    expect(emitted.length).toBe(0);

    // Flush manually via close
    await bridge.close();

    expect(emitted.length).toBe(1);
    expect(emitted[0].type).toBe('AGENT_TEXT_DELTA');
    const p = emitted[0].payload as any;
    expect(p.text).toBe('Hello from high-speed streaming bridge!');
    expect(p.operationalSeqStart).toBe(1);
    expect(p.operationalSeq).toBe(5);
  });

  it('2. flushes pending text_delta immediately when a non-text_delta event arrives', async () => {
    const { publisher, emitted } = createMockPublisher();
    const bridge = new OperationalEventBridge('sess-fast', publisher, {
      coalesceDeltas: true,
      flushIntervalMs: 500,
    });

    await bridge.handleEnvelope({
      taskId: 'task-1',
      attempt: 0,
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'text_delta',
      payload: { text: 'Some tokens' },
    });

    // An usage event arrives -> must trigger immediate flush of the buffered text_delta first
    await bridge.handleEnvelope({
      taskId: 'task-1',
      attempt: 0,
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'usage',
      payload: { totalTokens: 25 },
    });
    await bridge.close();

    expect(emitted.length).toBe(2);
    expect(emitted[0].type).toBe('AGENT_TEXT_DELTA');
    expect((emitted[0].payload as any).text).toBe('Some tokens');
    expect(emitted[1].type).toBe('AGENT_USAGE');
    expect((emitted[1].payload as any).totalTokens).toBe(25);
  });
});
