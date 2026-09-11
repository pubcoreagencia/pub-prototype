import { describe, expect, it } from 'vitest';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { PrototypeSseBroker } from '../src/pp/events/sse.js';

class FakeResponse {
  headers = new Map<string, string>();
  chunks: string[] = [];
  statusCode = 200;
  headersSent = false;

  status(code: number) {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string) {
    this.headers.set(name, value);
    return this;
  }

  flushHeaders() {
    this.headersSent = true;
  }

  write(value: string) {
    this.chunks.push(value);
    return true;
  }
}

describe('Prototype SSE transport', () => {
  it('keeps browser-facing stream format stable', () => {
    const broker = new PrototypeSseBroker();
    const events = new PrototypeEventStream();
    const response = new FakeResponse();

    broker.subscribe('session-1', response as never);
    events.subscribe(event => broker.publish(event));

    events.emit({
      sessionId: 'session-1',
      type: 'USER_PROMPT',
      payload: { prompt: 'Create a barber system', promptIndex: 1 },
    });

    expect(response.chunks[0]).toMatch(/^event: USER_PROMPT\nid: 1\ndata: /);
    expect(response.chunks[0]).toContain('Create a barber system');
  });
});
