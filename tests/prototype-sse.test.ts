import { describe, expect, it } from 'vitest';
import { PrototypeSseBroker } from '../src/pp/events/sse.js';

class FakeResponse {
  chunks: string[] = [];
  write(value: string) {
    this.chunks.push(value);
    return true;
  }
}

describe('PrototypeSseBroker', () => {
  it('publishes session-scoped SSE events and heartbeats', () => {
    const broker = new PrototypeSseBroker();
    const response = new FakeResponse();
    const unsubscribe = broker.subscribe('session-1', response as never);

    broker.publish({
      id: 'evt-1',
      sessionId: 'session-1',
      type: 'PREVIEW_READY',
      sequence: 7,
      timestamp: new Date('2026-08-19T14:00:00Z'),
      payload: { url: 'http://127.0.0.1:3000' },
    });
    broker.heartbeat('session-1');

    expect(response.chunks[0]).toContain('event: PREVIEW_READY');
    expect(response.chunks[0]).toContain('"url":"http://127.0.0.1:3000"');
    expect(response.chunks[1]).toBe(': heartbeat\n\n');

    unsubscribe();
    broker.publish({
      id: 'evt-2',
      sessionId: 'session-1',
      type: 'BUILD_STARTED',
      sequence: 8,
      timestamp: new Date(),
      payload: {},
    });

    expect(response.chunks).toHaveLength(2);
  });
});
