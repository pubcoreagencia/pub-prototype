import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { PostgresPrototypeEventPublisher } from '../src/pp/events/events.js';

describe('PostgresPrototypeEventPublisher', () => {
  let pool: Pool;
  let publisher: PostgresPrototypeEventPublisher;

  beforeAll(() => {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      console.log('Skipping: DATABASE_URL not set');
      return;
    }
    pool = new Pool({ connectionString });
    publisher = new PostgresPrototypeEventPublisher(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('persists events to the database', async () => {
    if (!pool) return;

    const sessionId = `test-persist-${Date.now()}`;
    
    // Emit event (now async - awaits INSERT)
    const event = await publisher.emit({
      sessionId,
      type: 'AGENT_STARTED',
      payload: { test: true, taskId: 'task-123' }
    });

    // No need to wait - emit() now awaits the INSERT
    // await new Promise(r => setTimeout(r, 500));

    // Query DB
    const result = await pool.query(
      'SELECT * FROM prototype_events WHERE session_id = $1',
      [sessionId]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].type).toBe('AGENT_STARTED');
    expect(result.rows[0].sequence).toBe(event.sequence);
  });

  it('generates sequential sequence numbers', async () => {
    if (!pool) return;

    const sessionId = `test-sequence-${Date.now()}`;
    
    const e1 = await publisher.emit({ sessionId, type: 'AGENT_STARTED' });
    const e2 = await publisher.emit({ sessionId, type: 'AGENT_OUTPUT' });
    const e3 = await publisher.emit({ sessionId, type: 'BUILD_STARTED' });

    const result = await pool.query(
      'SELECT * FROM prototype_events WHERE session_id = $1 ORDER BY sequence ASC',
      [sessionId]
    );

    expect(result.rows.length).toBe(3);
    expect(result.rows[0].sequence).toBeLessThan(result.rows[1].sequence);
    expect(result.rows[1].sequence).toBeLessThan(result.rows[2].sequence);
  });

  it('isolates events by session', async () => {
    if (!pool) return;

    const sessionA = `test-isolation-a-${Date.now()}`;
    const sessionB = `test-isolation-b-${Date.now()}`;

    await publisher.emit({ sessionId: sessionA, type: 'AGENT_STARTED' });
    await publisher.emit({ sessionId: sessionB, type: 'AGENT_STARTED' });
    await publisher.emit({ sessionId: sessionA, type: 'AGENT_OUTPUT' });

    const resultA = await pool.query(
      'SELECT * FROM prototype_events WHERE session_id = $1',
      [sessionA]
    );
    const resultB = await pool.query(
      'SELECT * FROM prototype_events WHERE session_id = $1',
      [sessionB]
    );

    expect(resultA.rows.length).toBe(2);
    expect(resultB.rows.length).toBe(1);
  });

  it('retrieves events via getEvents()', async () => {
    if (!pool) return;

    const sessionId = `test-getevents-${Date.now()}`;

    await publisher.emit({ sessionId, type: 'AGENT_STARTED' });
    await publisher.emit({ sessionId, type: 'AGENT_OUTPUT' });
    await publisher.emit({ sessionId, type: 'BUILD_STARTED' });

    const events = await publisher.getEvents(sessionId);
    expect(events.length).toBe(3);
    expect(events[0].type).toBe('AGENT_STARTED');
    expect(events[1].type).toBe('AGENT_OUTPUT');
    expect(events[2].type).toBe('BUILD_STARTED');
  });
});
