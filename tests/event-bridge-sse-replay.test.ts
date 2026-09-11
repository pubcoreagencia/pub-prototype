// tests/event-bridge-sse-replay.test.ts
import { describe, it, expect } from 'vitest';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { OperationalEventBridge } from '../src/pp/events/bridge.js';

describe('P5.5 — Event Bridge: SSE Replay & Last-Event-ID Semantics', () => {
  it('1. correctly replays stored events past Last-Event-ID threshold without duplicate or loss', async () => {
    const stream = new PrototypeEventStream();
    const bridge = new OperationalEventBridge('sess-replay-1', stream, { coalesceDeltas: false });

    const capturedByClientA: any[] = [];
    const unsubscribeA = stream.subscribe((event) => {
      capturedByClientA.push(event);
    });

    // Emit 5 events
    for (let i = 1; i <= 5; i++) {
      await bridge.handleEnvelope({
        taskId: 'task-rep',
        attempt: 0,
        seq: i,
        timestamp: new Date().toISOString(),
        type: 'text_delta',
        payload: { text: `token_${i}` },
      });
    }
    await bridge.close();

    expect(capturedByClientA.length).toBe(5);
    expect(capturedByClientA.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5]);

    // Client disconnects at sequence 3
    unsubscribeA();
    const lastEventId = 3;

    // Simulate Reconnect reader filtering sequence > lastEventId
    const replayedForClientB = capturedByClientA.filter(e => e.sequence > lastEventId);
    expect(replayedForClientB.length).toBe(2);
    expect(replayedForClientB.map(e => e.sequence)).toEqual([4, 5]);
    expect(replayedForClientB[0].payload.operationalSeq).toBe(4);
    expect(replayedForClientB[1].payload.operationalSeq).toBe(5);
  });
});
