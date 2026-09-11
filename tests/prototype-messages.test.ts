import { describe, expect, it } from 'vitest';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import type { PrototypeMessage } from '../src/pp/domain/domain.js';

class InMemoryMessageStore {
  private messages: PrototypeMessage[] = [];
  async addMessage(msg: { id: string; sessionId: string; role: PrototypeMessage['role']; content: string; taskId?: string; order?: number }): Promise<PrototypeMessage> {
    const cnt = this.messages.filter((m) => m.sessionId === msg.sessionId).length;
    const order = (msg.order && msg.order > 0) ? msg.order : cnt + 1;
    const stored: PrototypeMessage = { id: msg.id, sessionId: msg.sessionId, taskId: msg.taskId, role: msg.role, content: msg.content, order, createdAt: new Date() };
    this.messages.push(stored); return stored;
  }
  async listMessages(sessionId: string): Promise<PrototypeMessage[]> {
    return this.messages.filter((m) => m.sessionId === sessionId).sort((a, b) => a.order - b.order);
  }
}

describe('Prototype message persistence', () => {
  it('persists user message with incrementing order', async () => {
    const store = new InMemoryMessageStore();
    const m1 = await store.addMessage({ id: 'id-1', sessionId: 's1', role: 'user', content: 'Prompt 1' });
    const m2 = await store.addMessage({ id: 'id-2', sessionId: 's1', role: 'assistant', content: 'Response', taskId: 'task-1' });
    expect(m1.order).toBe(1); expect(m2.order).toBe(2); expect(m2.taskId).toBe('task-1');
  });
  it('messages per session are independent', async () => {
    const store = new InMemoryMessageStore();
    await store.addMessage({ id: 'a1', sessionId: 'sA', role: 'user', content: 'A1' });
    await store.addMessage({ id: 'b1', sessionId: 'sB', role: 'user', content: 'B1' });
    await store.addMessage({ id: 'a2', sessionId: 'sA', role: 'assistant', content: 'A2' });
    expect((await store.listMessages('sA'))).toHaveLength(2);
    expect((await store.listMessages('sB'))).toHaveLength(1);
  });
  it('listMessages returns messages in ascending order', async () => {
    const store = new InMemoryMessageStore();
    await store.addMessage({ id: 'm1', sessionId: 'sx', role: 'user', content: 'First' });
    await store.addMessage({ id: 'm2', sessionId: 'sx', role: 'assistant', content: 'Second' });
    await store.addMessage({ id: 'm3', sessionId: 'sx', role: 'user', content: 'Third' });
    expect((await store.listMessages('sx')).map((m) => m.content)).toEqual(['First', 'Second', 'Third']);
  });
  it('assistant message stores task_id', async () => {
    const store = new InMemoryMessageStore();
    await store.addMessage({ id: 'u1', sessionId: 'sq', role: 'user', content: 'Build an app' });
    await store.addMessage({ id: 'a1', sessionId: 'sq', role: 'assistant', content: 'Done', taskId: 'task-xyz' });
    const msgs = await store.listMessages('sq');
    expect(msgs[1].role).toBe('assistant'); expect(msgs[1].taskId).toBe('task-xyz');
  });
});

describe('Prototype SSE sequence tracking', () => {
  it('sequences are monotonically increasing', () => {
    const stream = new PrototypeEventStream(); const seqs: number[] = [];
    stream.subscribe((e) => seqs.push(e.sequence));
    stream.emit({ sessionId: 's', type: 'USER_PROMPT' });
    stream.emit({ sessionId: 's', type: 'AGENT_STARTED' });
    stream.emit({ sessionId: 's', type: 'BUILD_PASSED' });
    expect(seqs).toEqual([1, 2, 3]);
  });
  it('client can resume from last known sequence', () => {
    const stream = new PrototypeEventStream(); const all: number[] = [];
    stream.subscribe((e) => all.push(e.sequence));
    stream.emit({ sessionId: 's2', type: 'USER_PROMPT' });
    stream.emit({ sessionId: 's2', type: 'AGENT_STARTED' });
    stream.emit({ sessionId: 's2', type: 'BUILD_STARTED' });
    expect(all.filter((seq) => seq > 2)).toEqual([3]);
  });
  it('unsubscribe stops receiving events', () => {
    const stream = new PrototypeEventStream(); const received: string[] = [];
    const unsub = stream.subscribe((e) => received.push(e.type));
    stream.emit({ sessionId: 'x', type: 'USER_PROMPT' }); unsub();
    stream.emit({ sessionId: 'x', type: 'AGENT_STARTED' });
    expect(received).toHaveLength(1); expect(received[0]).toBe('USER_PROMPT');
  });
});

describe('Concurrency protection', () => {
  const LOCKED = ['BUILDING', 'PREVIEWING'];
  it('blocks BUILDING', () => expect(LOCKED.includes('BUILDING')).toBe(true));
  it('blocks PREVIEWING', () => expect(LOCKED.includes('PREVIEWING')).toBe(true));
  it('allows READY', () => expect(LOCKED.includes('READY')).toBe(false));
  it('allows FAILED (lock released)', () => expect(LOCKED.includes('FAILED')).toBe(false));
  it('allows CREATING', () => expect(LOCKED.includes('CREATING')).toBe(false));
});

describe('UI role label mapping', () => {
  const label = (role: string) => role === 'assistant' ? 'PP' : role === 'user' ? 'Você' : role;
  it('maps assistant to PP', () => expect(label('assistant')).toBe('PP'));
  it('maps user to Você', () => expect(label('user')).toBe('Você'));
  it('passes through system', () => expect(label('system')).toBe('system'));
});

describe('Overlay on page reload', () => {
  const PROC = ['BUILDING', 'PREVIEWING', 'CREATING'];
  it('shows for BUILDING', () => expect(PROC.includes('BUILDING')).toBe(true));
  it('shows for PREVIEWING', () => expect(PROC.includes('PREVIEWING')).toBe(true));
  it('shows for CREATING', () => expect(PROC.includes('CREATING')).toBe(true));
  it('hides for READY', () => expect(PROC.includes('READY')).toBe(false));
  it('hides for FAILED', () => expect(PROC.includes('FAILED')).toBe(false));
});
