// tests/event-bridge-sequencing.test.ts
import { describe, it, expect, vi } from 'vitest';
import { OperationalEventBridge } from '../src/pp/events/bridge.js';
import type { PrototypeEventPublisher, PrototypeEventInput } from '../src/pp/events/events.js';
import type { OperationalEventEnvelope } from '../src/providers/streaming/types.js';

describe('P5.5 — OperationalEventBridge: Sequencing, Idempotency & Replay', () => {
  function createMockPublisher() {
    let globalSequence = 100;
    const emitted: any[] = [];
    const publisher: PrototypeEventPublisher = {
      emit: vi.fn(async (input: PrototypeEventInput) => {
        const evt = {
          id: 'evt-' + (++globalSequence),
          sessionId: input.sessionId,
          type: input.type,
          sequence: globalSequence,
          timestamp: new Date(),
          payload: input.payload || {},
        };
        emitted.push(evt);
        return evt;
      }),
      subscribe: vi.fn(() => () => {}),
    };
    return { publisher, emitted };
  }

  it('1. keeps operationalSeq per attempt while sequence increments monotonically globally', async () => {
    const { publisher, emitted } = createMockPublisher();
    const bridge = new OperationalEventBridge('sess-10', publisher, { coalesceDeltas: false });

    // Attempt 0
    await bridge.handleEnvelope({
      taskId: 'task-1',
      attempt: 0,
      seq: 0,
      timestamp: new Date().toISOString(),
      type: 'attempt_started',
      payload: { model: 'model-a' },
    });
    await bridge.handleEnvelope({
      taskId: 'task-1',
      attempt: 0,
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'text_delta',
      payload: { text: 'chunk 0' },
    });

    // Attempt 1 (after retry)
    await bridge.handleEnvelope({
      taskId: 'task-1',
      attempt: 1,
      seq: 0, // Reset to 0 for attempt 1
      timestamp: new Date().toISOString(),
      type: 'attempt_started',
      payload: { model: 'model-b' },
    });
    await bridge.handleEnvelope({
      taskId: 'task-1',
      attempt: 1,
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'text_delta',
      payload: { text: 'chunk 1' },
    });
    await bridge.close();

    expect(emitted.length).toBe(4);
    // Global sequence increases continuously: 101, 102, 103, 104
    expect(emitted.map(e => e.sequence)).toEqual([101, 102, 103, 104]);

    // Operational seq is preserved per attempt: (att 0, seq 0), (att 0, seq 1), (att 1, seq 0), (att 1, seq 1)
    expect(emitted[0].payload.attempt).toBe(0);
    expect(emitted[0].payload.operationalSeq).toBe(0);
    expect(emitted[1].payload.attempt).toBe(0);
    expect(emitted[1].payload.operationalSeq).toBe(1);

    expect(emitted[2].payload.attempt).toBe(1);
    expect(emitted[2].payload.operationalSeq).toBe(0);
    expect(emitted[3].payload.attempt).toBe(1);
    expect(emitted[3].payload.operationalSeq).toBe(1);
  });

  it('2. deduplicates identical operational envelopes (idempotency)', async () => {
    const { publisher, emitted } = createMockPublisher();
    const bridge = new OperationalEventBridge('sess-10', publisher, { coalesceDeltas: false });

    const envelope: OperationalEventEnvelope = {
      taskId: 'task-1',
      attempt: 0,
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'usage',
      payload: { totalTokens: 50 },
    };

    // Send the same envelope 3 times
    await bridge.handleEnvelope(envelope);
    await bridge.handleEnvelope(envelope);
    await bridge.handleEnvelope(envelope);
    await bridge.close();

    expect(emitted.length).toBe(1);
  });
});
