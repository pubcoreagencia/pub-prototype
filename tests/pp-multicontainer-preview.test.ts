import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import { PostgresPpTaskRepository } from '../src/pp/persistence/task-repository.js';
import { createPpApp } from '../src/pp/api/entry.js';

describe('PP 2.0.1 — Multicontainer Preview Runtime & Boundary', () => {
  let server: Server;
  let baseUrl: string;
  let protoRepo: PostgresPrototypeRepository;
  let taskRepo: PostgresPpTaskRepository;

  beforeEach(async () => {
    const mockPool = {
      query: async () => ({ rows: [] }),
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => {},
      }),
    } as any;

    protoRepo = new PostgresPrototypeRepository(mockPool);
    await protoRepo.initializeSchema();
    taskRepo = new PostgresPpTaskRepository(mockPool);

    const app = createPpApp(mockPool, taskRepo, protoRepo);

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
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

  it('1. Serves index.html, JS and CSS from Postgres checkpoint files when local workspacePath does not exist (Multicontainer Boundary)', async () => {
    const session = await protoRepo.createSession({
      project: 'Multicontainer App',
      repository: 'https://github.com/example/repo',
      branch: 'main',
    });

    const checkpoint = await protoRepo.createCheckpoint({
      sessionId: session.id,
      promptIndex: 1,
      prompt: 'Build multicontainer app',
      commitSha: 'commit-sha-12345',
      previewUrl: `/prototype/sessions/${session.id}/preview/`,
      buildPassed: true,
    });

    await protoRepo.saveCheckpointFiles([
      {
        checkpointId: checkpoint.id,
        sessionId: session.id,
        path: 'index.html',
        content: '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Hello Multicontainer</h1><script src="app.js"></script></body></html>',
        contentType: 'text/html; charset=utf-8',
        sizeBytes: 150,
      },
      {
        checkpointId: checkpoint.id,
        sessionId: session.id,
        path: 'style.css',
        content: 'body { background: red; }',
        contentType: 'text/css; charset=utf-8',
        sizeBytes: 24,
      },
      {
        checkpointId: checkpoint.id,
        sessionId: session.id,
        path: 'app.js',
        content: 'console.log("multicontainer ready");',
        contentType: 'application/javascript; charset=utf-8',
        sizeBytes: 36,
      },
    ]);

    await protoRepo.updateSession(session.id, {
      status: 'READY',
      lastCheckpointSha: 'commit-sha-12345',
      workspacePath: '/tmp/non-existent-worker-disk-' + randomUUID(),
      previewUrl: `/prototype/sessions/${session.id}/preview/`,
    });

    // Request index.html
    const resHtml = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/`);
    expect(resHtml.status).toBe(200);
    expect(resHtml.headers.get('content-type')).toContain('text/html');
    expect(resHtml.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(resHtml.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const textHtml = await resHtml.text();
    expect(textHtml).toContain('<h1>Hello Multicontainer</h1>');

    // Request style.css
    const resCss = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/style.css`);
    expect(resCss.status).toBe(200);
    expect(resCss.headers.get('content-type')).toContain('text/css');
    expect(await resCss.text()).toBe('body { background: red; }');

    // Request app.js
    const resJs = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/app.js`);
    expect(resJs.status).toBe(200);
    expect(resJs.headers.get('content-type')).toContain('application/javascript');
    expect(await resJs.text()).toBe('console.log("multicontainer ready");');
  });

  it('2. Blocks path traversal attempts (../)', async () => {
    const session = await protoRepo.createSession({
      project: 'Secure App',
      repository: 'https://github.com/example/repo',
      branch: 'main',
    });

    await protoRepo.updateSession(session.id, { status: 'READY' });

    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/../../../../etc/passwd`);
    expect([400, 404]).toContain(res.status);
  });

  it('3. FAILED session returns dedicated failure card, NOT false waiting placeholder', async () => {
    const session = await protoRepo.createSession({
      project: 'Failed Project',
      repository: 'https://github.com/example/repo',
      branch: 'main',
    });

    await protoRepo.updateSession(session.id, {
      status: 'FAILED',
    });

    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('FALHA NA COMPILAÇÃO');
    expect(text).not.toContain('O protótipo está sendo preparado ou aguarda a conclusão da tarefa de compilação');
  });

  it('4. READY session with missing files returns clean empty-state card, NOT false waiting placeholder', async () => {
    const session = await protoRepo.createSession({
      project: 'No Files Project',
      repository: 'https://github.com/example/repo',
      branch: 'main',
    });

    await protoRepo.updateSession(session.id, {
      status: 'READY',
      lastCheckpointSha: 'some-sha',
    });

    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('SEM ARQUIVOS DE PREVIEW');
    expect(text).not.toContain('O protótipo está sendo preparado ou aguarda a conclusão da tarefa de compilação');
  });

  it('5. BUILDING or VERIFYING session returns appropriate status indicator', async () => {
    const session = await protoRepo.createSession({
      project: 'Verifying Project',
      repository: 'https://github.com/example/repo',
      branch: 'main',
    });

    await protoRepo.updateSession(session.id, {
      status: 'VERIFYING',
    });

    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('VERIFYING');
    expect(text).toContain('Executando verificação de integridade');
  });

  it('6. Isolates checkpoint files by active checkpoint commitSha', async () => {
    const session = await protoRepo.createSession({
      project: 'Multi-checkpoint App',
      repository: 'https://github.com/example/repo',
      branch: 'main',
    });

    const cp1 = await protoRepo.createCheckpoint({
      sessionId: session.id,
      promptIndex: 1,
      prompt: 'v1',
      commitSha: 'sha-v1',
      buildPassed: true,
    });
    await protoRepo.saveCheckpointFiles([
      {
        checkpointId: cp1.id,
        sessionId: session.id,
        path: 'index.html',
        content: '<h1>Version 1</h1>',
        contentType: 'text/html',
        sizeBytes: 18,
      },
    ]);

    const cp2 = await protoRepo.createCheckpoint({
      sessionId: session.id,
      promptIndex: 2,
      prompt: 'v2',
      commitSha: 'sha-v2',
      buildPassed: true,
    });
    await protoRepo.saveCheckpointFiles([
      {
        checkpointId: cp2.id,
        sessionId: session.id,
        path: 'index.html',
        content: '<h1>Version 2</h1>',
        contentType: 'text/html',
        sizeBytes: 18,
      },
    ]);

    await protoRepo.updateSession(session.id, {
      status: 'READY',
      lastCheckpointSha: 'sha-v2',
    });

    const resV2 = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/`);
    expect(resV2.status).toBe(200);
    expect(await resV2.text()).toBe('<h1>Version 2</h1>');

    await protoRepo.updateSession(session.id, {
      status: 'READY',
      lastCheckpointSha: 'sha-v1',
    });

    const resV1 = await fetch(`${baseUrl}/prototype/sessions/${session.id}/preview/`);
    expect(resV1.status).toBe(200);
    expect(await resV1.text()).toBe('<h1>Version 1</h1>');
  });
});
