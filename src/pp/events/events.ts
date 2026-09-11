import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { PrototypeEvent, PrototypeEventType } from '../domain/domain.js';

export interface PrototypeEventInput<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  sessionId: string;
  type: PrototypeEventType;
  payload?: TPayload;
}

export interface PrototypeEventPublisher {
  emit<TPayload extends Record<string, unknown>>(
    input: PrototypeEventInput<TPayload>,
  ): Promise<PrototypeEvent<TPayload>> | PrototypeEvent<TPayload>;
  subscribe(listener: (event: PrototypeEvent) => void): () => void;
}

export class PrototypeEventStream implements PrototypeEventPublisher {
  private sequence = 0;
  private readonly listeners = new Set<(event: PrototypeEvent) => void>();

  emit<TPayload extends Record<string, unknown>>(
    input: PrototypeEventInput<TPayload>,
  ): PrototypeEvent<TPayload> {
    const event: PrototypeEvent<TPayload> = {
      id: randomUUID(),
      sessionId: input.sessionId,
      type: input.type,
      sequence: ++this.sequence,
      timestamp: new Date(),
      payload: input.payload ?? ({} as TPayload),
    };
    this.receive(event);
    return event;
  }

  /** Inject an event received from another process/transport. */
  receive(event: PrototypeEvent): void {
    this.sequence = Math.max(this.sequence, event.sequence);
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: PrototypeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Worker-side publisher. Persists events and broadcasts them via PostgreSQL
 * NOTIFY so a separate API process can fan them out to SSE clients.
 */
export class PostgresPrototypeEventPublisher implements PrototypeEventPublisher {
  private sequence: number | null = null;
  private readonly listeners = new Set<(event: PrototypeEvent) => void>();
  private readonly channel = 'prototype_events';

  constructor(private readonly pool: Pool) {}

  private async getNextSequence(sessionId: string): Promise<number> {
    if (this.sequence === null) {
      const res = await this.pool.query(
        `SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM prototype_events WHERE session_id = $1`,
        [sessionId]
      );
      this.sequence = Number(res.rows[0]?.max_seq ?? 0);
    }
    this.sequence += 1;
    return this.sequence;
  }

  async emit<TPayload extends Record<string, unknown>>(
    input: PrototypeEventInput<TPayload>,
  ): Promise<PrototypeEvent<TPayload>> {
    const seq = await this.getNextSequence(input.sessionId);
    const event: PrototypeEvent<TPayload> = {
      id: randomUUID(),
      sessionId: input.sessionId,
      type: input.type,
      sequence: seq,
      timestamp: new Date(),
      payload: input.payload ?? ({} as TPayload),
    };

    // Await INSERT with ON CONFLICT DO NOTHING to ensure restart-safe persistent idempotency
    const insertResult = await this.pool.query(
      `INSERT INTO prototype_events (id, session_id, type, sequence, payload, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (session_id, (payload->>'taskId'), ((payload->>'attempt')::int), ((payload->>'operationalSeq')::bigint), type)
       WHERE (payload->>'taskId') IS NOT NULL
         AND (payload->>'attempt') IS NOT NULL
         AND (payload->>'operationalSeq') IS NOT NULL
       DO NOTHING
       RETURNING id`,
      [event.id, event.sessionId, event.type, event.sequence, JSON.stringify(event.payload), event.timestamp],
    );

    // If row was ignored because it's a duplicate, do not notify listeners
    if (insertResult.rowCount === 0) {
      return event;
    }

    for (const listener of this.listeners) listener(event);

    // Only send NOTIFY after successful INSERT
    await this.pool.query(`SELECT pg_notify($1, $2)`, [this.channel, JSON.stringify(event)]).catch(() => undefined);

    return event;
  }

  /**
   * Retrieve persisted events for a session — useful for testing and diagnostics.
   */
  async getEvents(sessionId: string, afterSequence = 0): Promise<PrototypeEvent[]> {
    const result = await this.pool.query(
      `SELECT * FROM prototype_events WHERE session_id = $1 AND sequence > $2 ORDER BY sequence ASC`,
      [sessionId, afterSequence],
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      sessionId: row.session_id,
      type: row.type,
      sequence: Number(row.sequence),
      timestamp: row.created_at,
      payload: row.payload,
    }));
  }

  subscribe(listener: (event: PrototypeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** API-side bridge from PostgreSQL NOTIFY into the local SSE event stream. */
export class PostgresPrototypeEventBridge {
  private client: import('pg').PoolClient | null = null;

  constructor(private readonly pool: Pool, private readonly target: PrototypeEventStream) {}

  async start(): Promise<void> {
    if (this.client) return;
    const client = await this.pool.connect();
    this.client = client;
    client.on('notification', msg => {
      if (!msg.payload) return;
      try {
        this.target.receive(JSON.parse(msg.payload) as PrototypeEvent);
      } catch {
        // Ignore malformed external events.
      }
    });
    client.on('error', () => {
      this.client = null;
    });
    await client.query('LISTEN prototype_events');
  }

  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    await client.query('UNLISTEN prototype_events').catch(() => undefined);
    client.release();
  }
}
