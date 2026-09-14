import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPpApp } from '../src/pp/api/entry.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import http from 'node:http';

describe('PP 2.0 — Native Preview & Recovery', () => {
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

  it('serves native preview index.html directly from Postgres checkpoint files', async () => {
    // 1. Create session
    const session = await protoRepo.createSession({
      project: 'Restaurante Sabor',
      repository: 'https://github.com/test/sabor.git',
      branch: 'prototype/restaurante-sabor',
    });

    // 2. Create checkpoint & store files
    const cp = await protoRepo.createCheckpoint({
      sessionId: session.id,
      promptIndex: 1,
      prompt: 'Crie cardápio online',
      commitSha: 'sha-sabor-1',
      previewUrl: `/prototype/sessions/${session.id}/preview/`,
      buildPassed: true,
    });

    await protoRepo.saveCheckpointFiles([
      {
        sessionId: session.id,
        checkpointId: cp.id,
        path: 'index.html',
        content: '<html><body><h1>Cardapio Restaurante Sabor</h1></body></html>',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 60,
      },
      {
        sessionId: session.id,
        checkpointId: cp.id,
        path: 'styles.css',
        content: 'body { background: #111; color: #fff; }',
        contentType: 'text/css; charset=utf-8',
        sizeBytes: 37,
      },
    ]);

    // 3. GET /prototype/sessions/:id/preview
    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Cardapio Restaurante Sabor');

    // 4. GET /prototype/sessions/:id/preview/styles.css
    const resCss = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/styles.css`);
    expect(resCss.status).toBe(200);
    expect(resCss.headers.get('content-type')).toContain('text/css');
    const css = await resCss.text();
    expect(css).toContain('background: #111');
  });

  it('serves graceful placeholder when session is ready but files are not yet generated', async () => {
    const session = await protoRepo.createSession({
      project: 'Barbearia Vintage',
      repository: 'https://github.com/test/vintage.git',
      branch: 'prototype/vintage',
    });

    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Barbearia Vintage');
    expect(html).toContain('O protótipo está sendo preparado');
  });

  it('handles POST /prototype/sessions/:id/preview/refresh and /restart with native fallback', async () => {
    const session = await protoRepo.createSession({
      project: 'Sagaz Farm Recovery',
      repository: 'https://github.com/test/sagaz.git',
      branch: 'prototype/sagaz',
    });

    const cp = await protoRepo.createCheckpoint({
      sessionId: session.id,
      promptIndex: 1,
      prompt: 'Setup farm OS',
      commitSha: 'sha-sagaz-1',
      previewUrl: `/prototype/sessions/${session.id}/preview/`,
      buildPassed: true,
    });

    await protoRepo.saveCheckpointFiles([
      {
        sessionId: session.id,
        checkpointId: cp.id,
        path: 'index.html',
        content: '<div id="farm-root">SAGAZ FARM OS ONLINE</div>',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 46,
      },
    ]);

    // POST /refresh
    const refreshRes = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/refresh`, {
      method: 'POST',
    });
    expect(refreshRes.status).toBe(200);
    const refreshData = await refreshRes.json();
    expect(refreshData.ok).toBe(true);
    expect(refreshData.previewUrl).toBe(`/prototype/sessions/${session.id}/preview/`);
    expect(refreshData.mode).toBe('native');
    expect(refreshData.filesCount).toBe(1);

    // POST /restart
    const restartRes = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/restart`, {
      method: 'POST',
    });
    expect(restartRes.status).toBe(200);
    const restartData = await restartRes.json();
    expect(restartData.ok).toBe(true);
    expect(restartData.previewUrl).toBe(`/prototype/sessions/${session.id}/preview/`);
  });

  it('lists session files and inspects individual file content via /prototype/sessions/:id/files', async () => {
    const session = await protoRepo.createSession({
      project: 'Code Inspector Test',
      repository: 'https://github.com/test/inspector.git',
      branch: 'prototype/inspector',
    });

    const cp = await protoRepo.createCheckpoint({
      sessionId: session.id,
      promptIndex: 1,
      prompt: 'Initial build',
      commitSha: 'sha-insp-1',
      previewUrl: `/prototype/sessions/${session.id}/preview/`,
      buildPassed: true,
    });

    await protoRepo.saveCheckpointFiles([
      {
        sessionId: session.id,
        checkpointId: cp.id,
        path: 'src/main.ts',
        content: 'console.log("Inspector active");',
        contentType: 'text/plain; charset=utf-8',
        sizeBytes: 31,
      },
      {
        sessionId: session.id,
        checkpointId: cp.id,
        path: 'package.json',
        content: '{"name":"inspector-app"}',
        contentType: 'application/json; charset=utf-8',
        sizeBytes: 25,
      },
    ]);

    // List files
    const listRes = await fetch(`${baseUrl}/prototype/sessions/${session.id}/files`);
    expect(listRes.status).toBe(200);
    const listData = await listRes.json();
    expect(listData.files.length).toBe(2);
    expect(listData.files.map((f: any) => f.path)).toContain('src/main.ts');
    expect(listData.files.map((f: any) => f.path)).toContain('package.json');

    // Inspect single file
    const fileRes = await fetch(`${baseUrl}/prototype/sessions/${session.id}/files/src/main.ts`);
    expect(fileRes.status).toBe(200);
    const fileData = await fileRes.json();
    expect(fileData.path).toBe('src/main.ts');
    expect(fileData.content).toBe('console.log("Inspector active");');
  });
});
