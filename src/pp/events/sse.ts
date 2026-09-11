import type { Response } from 'express';
import type { PrototypeEvent } from '../domain/domain.js';

/**
 * Session-scoped SSE broker.
 * Keeps transport concerns outside the prototype domain/event contract.
 */
export class PrototypeSseBroker {
  private readonly subscribers = new Map<string, Set<Response>>();

  subscribe(sessionId: string, res: Response): () => void {
    const set = this.subscribers.get(sessionId) ?? new Set<Response>();
    set.add(res);
    this.subscribers.set(sessionId, set);

    return () => {
      const current = this.subscribers.get(sessionId);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) this.subscribers.delete(sessionId);
    };
  }

  publish(event: PrototypeEvent): void {
    const subscribers = this.subscribers.get(event.sessionId);
    if (!subscribers?.size) return;

    const payload = `event: ${event.type}\nid: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(payload);
      } catch {
        // Connection cleanup is handled by the request close listener.
      }
    }
  }

  heartbeat(sessionId: string): void {
    const subscribers = this.subscribers.get(sessionId);
    if (!subscribers?.size) return;
    for (const res of subscribers) {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        // Connection cleanup is handled by the request close listener.
      }
    }
  }
}
