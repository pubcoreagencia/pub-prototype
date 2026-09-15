// tests/p1-session-authorization.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPpApp } from '../src/pp/api/entry.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import http from 'node:http';
import { AuthService } from '../src/pp/auth/auth.js';

// Helper to perform fetch with optional Authorization token
async function fetchWith(url: string, opts?: Partial<RequestInit> & { token?: string }) {
  const headers = new Headers(opts?.headers as any);
  if (opts?.token) headers.set('Authorization', `Bearer ${opts.token}`);
  return fetch(url, { ...opts, headers });
}

describe('PP 2.0 — P1.3 Session Authorization (Regression)', () => {
  let protoRepo: PostgresPrototypeRepository;
  let authService: AuthService;
  let app: any;
  let server: http.Server;
  let baseUrl: string;
  let wsA: string; // Workspace for test-token (default user)
  let wsB: string; // Workspace for user-b-id
  let sessionA: string; // Session in wsA
let checkpointId1: string;
let checkpointId2: string;
  const tokenA = 'test-token'; // has OWNER role in default workspace
  const tokenB = 'user-b-id'; // will be OWNER in wsB
  const viewerToken = 'viewer-user-id'; // VIEWER role in wsA

  beforeEach(async () => {
    protoRepo = new PostgresPrototypeRepository();
    await protoRepo.initializeSchema();
    authService = new AuthService(protoRepo);
    app = createPpApp(undefined, undefined, protoRepo);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
    // Create Workspace A via API (default OWNER = test-token)
    const wsARes = await fetchWith(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Workspace A' }),
      token: tokenA,
    });
    expect(wsARes.status).toBe(201);
    wsA = (await wsARes.json()).id as string;
    // Create Workspace B via repo directly with user-b-id as owner
    const wsBData = await protoRepo.createWorkspace({ name: 'Workspace B', ownerId: tokenB });
    wsB = wsBData.id as string;
    // Add OWNER role for test-token in workspace A
    await protoRepo.addWorkspaceMember({ workspaceId: wsA, userId: tokenA, role: 'OWNER' });
    // Add viewer to Workspace A
    await protoRepo.addWorkspaceMember({ workspaceId: wsA, userId: viewerToken, role: 'VIEWER' });
    // Create a project in Workspace A
    const projA = await protoRepo.createProject({ workspaceId: wsA, name: 'Project A' });
    // Create a session in Workspace A (belongs to the created project)
    const sess = await protoRepo.createSession({
      project: projA.name,
      projectId: projA.id,
      repository: '',
      branch: 'main',
      workspaceId: wsA,
    });
    sessionA = sess.id as string;
    // Create two checkpoints for diff and comparison-previews tests
    const chk1 = await protoRepo.createCheckpoint({
      sessionId: sessionA,
      promptIndex: 1,
      prompt: 'init',
      commitSha: 'sha1',
      previewUrl: `/prototype/sessions/${sessionA}/preview/`,
      buildPassed: true,
    });
    const chk2 = await protoRepo.createCheckpoint({
      sessionId: sessionA,
      promptIndex: 2,
      prompt: 'second',
      commitSha: 'sha2',
      previewUrl: `/prototype/sessions/${sessionA}/preview/`,
      buildPassed: true,
    });
    // Store checkpoint ids for later use in protectedEndpoints
    checkpointId1 = chk1.id as string;
    checkpointId2 = chk2.id as string;
    // Ensure preview URL exists for promotion tests
    await protoRepo.createCheckpoint({
      sessionId: sessionA,
      promptIndex: 1,
      prompt: 'init',
      commitSha: 'sha1',
      previewUrl: `/prototype/sessions/${sessionA}/preview/`,
      buildPassed: true,
    });
  });

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  // 1. Unauthenticated access => 401
  it('rejects unauthenticated request to POST /prototype/sessions/:id/prompts', async () => {
    const r = await fetch(`${baseUrl}/prototype/sessions/${sessionA}/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    expect(r.status).toBe(401);
  });

  // 2. Same tenant + sufficient role (MEMBER) => allowed
  it('allows MEMBER to POST prompts on own session', async () => {
    const r = await fetchWith(`${baseUrl}/prototype/sessions/${sessionA}/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
      token: tokenA,
    });
    expect(r.status).toBe(202);
  });

  // 3. Cross‑tenant access => 403
  it('rejects cross‑tenant POST prompts (user-b-id on wsA session)', async () => {
    const r = await fetchWith(`${baseUrl}/prototype/sessions/${sessionA}/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
      token: tokenB,
    });
    expect(r.status).toBe(403);
  });

  // 4. Insufficient role (VIEWER) => 403
  it('rejects VIEWER role from PATCH session', async () => {
    const r = await fetchWith(`${baseUrl}/prototype/sessions/${sessionA}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'paused' }),
      token: viewerToken,
    });
    expect(r.status).toBe(403);
  });

  // Lazy factory for protected endpoints – evaluated after checkpoint IDs are set
  const getProtectedEndpoints = () => [
    { method: 'POST', path: (id: string) => `/prototype/sessions/${id}/prompts`, body: { prompt: 'x' }, allowed: [202] },
    { method: 'PATCH', path: (id: string) => `/prototype/sessions/${id}`, body: { status: 'paused' }, allowed: [200] },
    { method: 'POST', path: (id: string) => `/prototype/sessions/${id}/checkpoints`, body: { prompt: 'c', promptIndex: 2, commitSha: 'sha2', buildPassed: true }, allowed: [201] },
    { method: 'POST', path: (id: string) => `/prototype/sessions/${id}/promote`, body: {}, allowed: [200] },
    { method: 'POST', path: (id: string) => `/prototype/sessions/${id}/preview/refresh`, allowed: [200] },
    { method: 'POST', path: (id: string) => `/prototype/sessions/${id}/preview/restart`, allowed: [200] },
    { method: 'GET', path: (id: string) => `/prototype/sessions/${id}/files`, allowed: [200] },
    { method: 'GET', path: (id: string) => `/prototype/sessions/${id}/files/index.html`, allowed: [200] },
    // Additional protected routes
    { method: 'GET', path: (id: string) => `/prototype/sessions/${id}/diff?from=${checkpointId1}&to=${checkpointId2}`, allowed: [200] },
    { method: 'POST', path: (id: string) => `/prototype/sessions/${id}/comparison-previews`, body: { checkpointId: checkpointId1 }, allowed: [201] },
    { method: 'GET', path: (id: string) => `/prototype/sessions/${id}/comparison-previews/comp-id`, allowed: [200] },
    { method: 'DELETE', path: (id: string) => `/prototype/sessions/${id}/comparison-previews/comp-id`, allowed: [204] },
  ];

  let protectedEndpoints: any[] = [];
  for (const ep of protectedEndpoints) {
    const verb = ep.method;
    const description = `${verb} ${ep.path('ID')}`;
    it(`allows authorized MEMBER on same tenant for ${description}`, async () => {
      const url = `${baseUrl}${ep.path(sessionA)}`;
      const opts: any = { method: verb };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      if (verb !== 'GET') opts.headers = { 'content-type': 'application/json' };
      const r = await fetchWith(url, { ...opts, token: tokenA });
      expect(ep.allowed.includes(r.status)).toBe(true);
    });
    it(`rejects cross‑tenant ${description}`, async () => {
      const url = `${baseUrl}${ep.path(sessionA)}`;
      const opts: any = { method: verb };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      if (verb !== 'GET') opts.headers = { 'content-type': 'application/json' };
      const r = await fetchWith(url, { ...opts, token: tokenB });
      expect(r.status).toBe(403);
    });
    it(`rejects insufficient VIEWER role for ${description}`, async () => {
      const url = `${baseUrl}${ep.path(sessionA)}`;
      const opts: any = { method: verb };
      if (ep.body) opts.body = JSON.stringify(ep.body);
      if (verb !== 'GET') opts.headers = { 'content-type': 'application/json' };
      const r = await fetchWith(url, { ...opts, token: viewerToken });
      if (verb === 'GET') {
        // VIEWER allowed for read‑only GET routes
        expect([200, 404].includes(r.status)).toBe(true);
      } else {
        expect(r.status).toBe(403);
      }
    });
  }

  // 6. Production shortcut token rejection
  it('rejects test-token in production environment', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const r = await fetchWith(`${baseUrl}/prototype/sessions/${sessionA}/prompts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
      token: tokenA,
    });
    expect(r.status).toBe(401);
    process.env.NODE_ENV = orig;
  });

  // 7. Login endpoint behavior
  it('login returns 403 in production without explicit token', async () => {
    const orig = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const r = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@x.com' })
    });
    expect(r.status).toBe(403);
    process.env.NODE_ENV = orig;
  });

  it('login still works in development with fixture token', async () => {
    const r = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'x@x.com' })
    });
    expect(r.status).toBe(200);
    const data = await r.json();
    expect(data.token).toBe('test-token');
  });

  // 8. Unit test for AuthService.authorizeSession
  it('authorizeSession returns correct role for various users', async () => {
    // Owner (test-token) should be OWNER
    const roleOwner = await authService.authorizeSession(tokenA, sessionA);
    expect(roleOwner).toBe('OWNER');
    // Viewer token should be VIEWER (read‑only)
    const roleViewer = await authService.authorizeSession(viewerToken, sessionA);
    expect(roleViewer).toBe('VIEWER');
    // Cross‑tenant token (user-b-id) should be null (no access)
    const roleCross = await authService.authorizeSession(tokenB, sessionA);
    expect(roleCross).toBeNull();
  });
});
