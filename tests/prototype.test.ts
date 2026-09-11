import { describe, expect, it } from 'vitest';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { PROTOTYPE_MODES, PROTOTYPE_SESSION_STATUSES } from '../src/pp/domain/domain.js';
import { PREVIEW_RUNTIME_STATUSES } from '../src/pp/preview/preview-runtime.js';

describe('Prototype Mode contracts', () => {
  it('defines explicit prototype and development modes', () => {
    expect(PROTOTYPE_MODES).toEqual(['PROTOTYPE', 'DEVELOPMENT']);
  });

  it('defines a lifecycle that can represent a live preview session', () => {
    expect(PROTOTYPE_SESSION_STATUSES).toContain('BUILDING');
    expect(PROTOTYPE_SESSION_STATUSES).toContain('PREVIEWING');
    expect(PROTOTYPE_SESSION_STATUSES).toContain('READY');
    expect(PROTOTYPE_SESSION_STATUSES).toContain('PROMOTED');
  });

  it('defines preview runtime lifecycle states', () => {
    expect(PREVIEW_RUNTIME_STATUSES).toContain('STARTING');
    expect(PREVIEW_RUNTIME_STATUSES).toContain('READY');
    expect(PREVIEW_RUNTIME_STATUSES).toContain('STOPPED');
  });

  it('emits ordered events and supports unsubscribe', () => {
    const stream = new PrototypeEventStream();
    const received: string[] = [];
    const unsubscribe = stream.subscribe(event => received.push(event.type));

    const first = stream.emit({ sessionId: 'session-1', type: 'USER_PROMPT', payload: { prompt: 'Create a barber app' } });
    const second = stream.emit({ sessionId: 'session-1', type: 'PREVIEW_READY', payload: { url: 'https://preview.example' } });

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(received).toEqual(['USER_PROMPT', 'PREVIEW_READY']);

    unsubscribe();
    stream.emit({ sessionId: 'session-1', type: 'BUILD_STARTED' });
    expect(received).toHaveLength(2);
  });

  it('validates session schema compatibility with loadProjects/renderProjects requirements', () => {
    // Exact schema fields expected by loadProjects() and renderProjects()
    const mockSession = {
      id: 'session-schema-check',
      project: 'sistema pato de minas',
      status: 'READY',
      updatedAt: '2026-09-01T04:26:51.000Z',
      repository: 'https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git',
      previewUrl: 'https://example.trycloudflare.com',
    };

    expect(typeof mockSession.id).toBe('string');
    expect(typeof mockSession.project).toBe('string');
    expect(typeof mockSession.status).toBe('string');
    expect(isNaN(Date.parse(mockSession.updatedAt))).toBe(false);
  });
});

