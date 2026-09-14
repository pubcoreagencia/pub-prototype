import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPpApp } from '../src/pp/api/entry.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import http from 'node:http';

describe('P0 Preview Security & Contract', () => {
  let app: any;
  let protoRepo: PostgresPrototypeRepository;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    protoRepo = new PostgresPrototypeRepository();
    await protoRepo.initializeSchema();
    app = createPpApp(undefined, undefined, protoRepo);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('404 for unknown session', async () => {
    const res = await fetch(`${baseUrl}/prototype/sessions/nonexistent/preview`);
    expect(res.status).toBe(404);
  });

  it('404 for missing asset file', async () => {
    const session = await protoRepo.createSession({ project: 'Sec', repository: 'r', branch: 'b' });
    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/nonexistent.js`);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('not found');
  });

  it('returns placeholder 200 for ready session with no checkpoint files', async () => {
    const session = await protoRepo.createSession({ project: 'P', repository: 'r', branch: 'b' });
    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('O protótipo está sendo preparado');
  });
});
