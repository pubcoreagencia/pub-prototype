// tests/event-bridge-compatibility.test.ts
import { describe, it, expect, vi } from 'vitest';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { OperationalEventBridge } from '../src/pp/events/bridge.js';

describe('P5.5 — Event Bridge: Legacy Compatibility & Non-Streaming Fallback', () => {
  it('1. coexists cleanly with direct legacy event emissions on PrototypeEventStream', async () => {
    const stream = new PrototypeEventStream();
    const bridge = new OperationalEventBridge('sess-compat-1', stream, { coalesceDeltas: false });

    const allEmitted: any[] = [];
    stream.subscribe((event) => {
      allEmitted.push(event);
    });

    // 1. Direct legacy event
    stream.emit({
      sessionId: 'sess-compat-1',
      type: 'AGENT_STARTED',
      payload: { taskId: 'task-compat-1' },
    });

    // 2. Streamed operational event via Bridge
    await bridge.handleEnvelope({
      taskId: 'task-compat-1',
      attempt: 0,
      seq: 0,
      timestamp: new Date().toISOString(),
      type: 'text_delta',
      payload: { text: 'chunk from stream' },
    });

    // 3. Direct legacy final output
    stream.emit({
      sessionId: 'sess-compat-1',
      type: 'AGENT_OUTPUT',
      payload: { summary: 'Full summary text', changedFiles: [] },
    });

    // 4. Direct build events
    stream.emit({
      sessionId: 'sess-compat-1',
      type: 'BUILD_PASSED',
      payload: { commitSha: 'abc1234' },
    });

    await bridge.close();

    expect(allEmitted.length).toBe(4);
    expect(allEmitted.map(e => e.type)).toEqual([
      'AGENT_STARTED',
      'AGENT_TEXT_DELTA',
      'AGENT_OUTPUT',
      'BUILD_PASSED',
    ]);
    expect(allEmitted.map(e => e.sequence)).toEqual([1, 2, 3, 4]);
  });

  it('2. persistent idempotency: prevents duplicate database insertion across process instances', async () => {
    const { PostgresPrototypeEventPublisher } = await import('../src/pp/events/events.js');
    const insertedRows: any[] = [];
    const uniqueKeys = new Set<string>();

    const mockPool: any = {
      query: vi.fn(async (sql: string, params: any[]) => {
        if (sql.includes('MAX(sequence)')) {
          const maxSeq = insertedRows.reduce((m, r) => Math.max(m, r.sequence), 0);
          return { rows: [{ max_seq: maxSeq }] };
        }
        if (sql.includes('INSERT INTO prototype_events')) {
          const [id, sessionId, type, sequence, payloadStr, createdAt] = params;
          const payload = JSON.parse(payloadStr);
          const taskId = payload.taskId;
          const attempt = payload.attempt;
          const operationalSeq = payload.operationalSeq;

          if (taskId !== undefined && attempt !== undefined && operationalSeq !== undefined) {
            const key = `${sessionId}:${taskId}:${attempt}:${operationalSeq}:${type}`;
            if (uniqueKeys.has(key)) {
              return { rowCount: 0, rows: [] };
            }
            uniqueKeys.add(key);
          }

          insertedRows.push({ id, sessionId, type, sequence, payload, createdAt });
          return { rowCount: 1, rows: [{ id }] };
        }
        if (sql.includes('pg_notify')) {
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };

    const sessionId = 'session-idempotency-1';
    const taskId = 'task-idempotency-1';

    const envelope = {
      seq: 1,
      type: 'attempt_started' as const,
      attempt: 0,
      timestamp: new Date().toISOString(),
      taskId,
      payload: { model: 'test-model' },
    };

    // Instance 1 emits envelope
    const publisher1 = new PostgresPrototypeEventPublisher(mockPool);
    const bridge1 = new OperationalEventBridge(sessionId, publisher1);
    await bridge1.handleEnvelope(envelope);

    expect(insertedRows.length).toBe(1);
    expect(insertedRows[0].type).toBe('AGENT_ATTEMPT_STARTED');
    expect(insertedRows[0].sequence).toBe(1);

    // Instance 2 (simulating worker restart/redeploy) receives the same event
    const publisher2 = new PostgresPrototypeEventPublisher(mockPool);
    const bridge2 = new OperationalEventBridge(sessionId, publisher2);
    await bridge2.handleEnvelope(envelope);

    // Database row count must stay 1
    expect(insertedRows.length).toBe(1);
    expect(uniqueKeys.size).toBe(1);
  });
});
