import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPpApp } from '../src/pp/api/entry.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import { AuthService } from '../src/pp/auth/auth.js';
import http from 'node:http';

async function fetchWith(url: string, opts?: Partial<RequestInit> & { token?: string }) {
  const headers = new Headers(opts?.headers as any);
  if (opts?.token) headers.set('Authorization', `Bearer ${opts.token}`);
  return fetch(url, { ...opts, headers });
}

async function createWorkspaceViaApi(baseUrl: string, name: string, token: string) {
  return fetchWith(`${baseUrl}/api/workspaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }), token });
}

async function createWorkspaceViaRepo(protoRepo: PostgresPrototypeRepository, name: string, ownerId: string) {
  return protoRepo.createWorkspace({ name, ownerId });
}

async function addWorkspaceMember(protoRepo: PostgresPrototypeRepository, workspaceId: string, userId: string, role: 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER') {
  await protoRepo.addWorkspaceMember({ workspaceId, userId, role });
}

describe('PP 2.0 — P1.1 Tenancy Enforcement (Final)', () => {
  let protoRepo: PostgresPrototypeRepository;
  let authService: AuthService;
  let app: any;
  let server: http.Server;
  let baseUrl: string;
  let wsA: string, wsB: string;
  let userAId = 'test-user-id';
  let userBId = 'user-b-id';
  let viewerId = 'viewer-user-id';

  beforeEach(async () => {
    protoRepo = new PostgresPrototypeRepository();
    await protoRepo.initializeSchema();
    authService = new AuthService(protoRepo);
    app = createPpApp(undefined, undefined, protoRepo);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => { const addr = server.address() as any; baseUrl = `http://127.0.0.1:${addr.port}`; resolve(); });
    });
    const rA = await createWorkspaceViaApi(baseUrl, 'Workspace A', 'test-token');
    expect(rA.status).toBe(201);
    wsA = (await rA.json()).id as string;
    const wsBData = await createWorkspaceViaRepo(protoRepo, 'Workspace B', userBId);
    wsB = wsBData.id as string;
    await addWorkspaceMember(protoRepo, wsB, userBId, 'ADMIN');
    await addWorkspaceMember(protoRepo, wsA, viewerId, 'VIEWER');
  });

  afterEach(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); });

  describe('Auth enforcement', () => {
    it('GET /api/projects returns 401 without Authorization header', async () => {
      const r = await fetch(`${baseUrl}/api/projects`);
      expect(r.status).toBe(401);
    });
    it('GET /api/projects returns 401 when Authorization header is empty', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects`, { token: '' });
      expect(r.status).toBe(401);
    });
    it('GET /api/projects returns 401 when Authorization is "Bearer" (no token)', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects`, { token: 'Bearer' });
      expect(r.status).toBe(401);
    });
    it('GET /api/projects returns 401 when Authorization is "Bearer unknown-token"', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects`, { token: 'Bearer unknown-token' });
      expect(r.status).toBe(401);
    });
    it('GET /api/projects returns 200 with valid test-token', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects`, { token: 'test-token' });
      expect(r.status).toBe(200);
    });
    it('POST /api/workspaces/:w/projects returns 201 with valid test-token', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Test' }), token: 'test-token' });
      expect(r.status).toBe(201);
    });
  });

  describe('Workspace listing respects membership', () => {
    it('User A (test-token) can list workspaces', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces`, { token: 'test-token' });
      expect(r.status).toBe(200);
      const ws = await r.json() as any[];
      expect(ws.some((w: any) => w.id === wsA)).toBe(true);
    });
    it('User B (user-b-id) can list workspaces', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces`, { token: 'user-b-id' });
      expect(r.status).toBe(200);
      const ws = await r.json() as any[];
      expect(ws.some((w: any) => w.id === wsB)).toBe(true);
    });
    it('Viewer (viewer-user-id) can list workspaces', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces`, { token: 'viewer-user-id' });
      expect(r.status).toBe(200);
      const ws = await r.json() as any[];
      expect(ws.some((w: any) => w.id === wsA)).toBe(true);
    });
  });

  describe('Project isolation — create', () => {
    it('User A creates project in Workspace A', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project A' }), token: 'test-token' });
      expect(r.status).toBe(201);
    });
    it('User A CANNOT create project in Workspace B', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsB}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project A' }), token: 'test-token' });
      expect(r.status).toBe(403);
    });
    it('User B creates project in Workspace B', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsB}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project B' }), token: 'user-b-id' });
      expect(r.status).toBe(201);
    });
    it('Viewer cannot create project in Workspace A', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Viewer Project' }), token: 'viewer-user-id' });
      expect(r.status).toBe(403);
    });
  });

  describe('Project isolation — read', () => {
    let projectAId: string;
    let projectBId: string;
    beforeEach(async () => {
      const rA = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project A' }), token: 'test-token' });
      projectAId = (await rA.json()).id as string;
      const rB = await fetchWith(`${baseUrl}/api/workspaces/${wsB}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project B' }), token: 'user-b-id' });
      projectBId = (await rB.json()).id as string;
    });
    it('User A can list Workspace A projects', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { token: 'test-token' });
      expect(r.status).toBe(200);
    });
    it('User A CANNOT list Workspace B projects', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsB}/projects`, { token: 'test-token' });
      expect(r.status).toBe(403);
    });
    it('User B can list Workspace B projects', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsB}/projects`, { token: 'user-b-id' });
      expect(r.status).toBe(200);
    });
    it('User A can read Project A', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectAId}`, { token: 'test-token' });
      expect(r.status).toBe(200);
    });
    it('User A CANNOT read Project B', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectBId}`, { token: 'test-token' });
      expect(r.status).toBe(403);
    });
    it('User B can read Project B', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectBId}`, { token: 'user-b-id' });
      expect(r.status).toBe(200);
    });
    it('Viewer can read Project A', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectAId}`, { token: 'viewer-user-id' });
      expect(r.status).toBe(200);
    });
    it('Viewer CANNOT read Project B', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectBId}`, { token: 'viewer-user-id' });
      expect(r.status).toBe(403);
    });
  });

  describe('Project isolation — update', () => {
    let projectAId: string;
    beforeEach(async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project A' }), token: 'test-token' });
      projectAId = (await r.json()).id as string;
    });
    it('User A can update Project A', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectAId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }), token: 'test-token' });
      expect(r.status).toBe(200);
    });
    it('User A CANNOT update Project B', async () => {
      const rB = await fetchWith(`${baseUrl}/api/workspaces/${wsB}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project B' }), token: 'user-b-id' });
      expect(rB.status).toBe(201);
      const pB = await rB.json();
      const r = await fetchWith(`${baseUrl}/api/projects/${pB.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Hacked' }), token: 'test-token' });
      expect(r.status).toBe(403);
    });
    it('Viewer CANNOT update Project A', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectAId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }), token: 'viewer-user-id' });
      expect(r.status).toBe(403);
    });
  });

  describe('Project isolation — delete', () => {
    let projectAId: string;
    beforeEach(async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project A' }), token: 'test-token' });
      projectAId = (await r.json()).id as string;
    });
    it('User A can delete Project A', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectAId}`, { method: 'DELETE', token: 'test-token' });
      expect(r.status).toBe(200);
    });
    it('User A CANNOT delete Project B', async () => {
      const rB = await fetchWith(`${baseUrl}/api/workspaces/${wsB}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project B' }), token: 'user-b-id' });
      expect(rB.status).toBe(201);
      const pB = await rB.json();
      const r = await fetchWith(`${baseUrl}/api/projects/${pB.id}`, { method: 'DELETE', token: 'test-token' });
      expect(r.status).toBe(403);
    });
    it('Viewer CANNOT delete Project A', async () => {
      const r = await fetchWith(`${baseUrl}/api/projects/${projectAId}`, { method: 'DELETE', token: 'viewer-user-id' });
      expect(r.status).toBe(403);
    });
  });

  describe('RBAC — VIEWER restrictions', () => {
    it('VIEWER cannot create a project', async () => {
      const r = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'No Create' }), token: 'viewer-user-id' });
      expect(r.status).toBe(403);
    });
    it('VIEWER cannot update a project', async () => {
      const rA = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project A' }), token: 'test-token' });
      expect(rA.status).toBe(201);
      const pA = await rA.json();
      const r = await fetchWith(`${baseUrl}/api/projects/${pA.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }), token: 'viewer-user-id' });
      expect(r.status).toBe(403);
    });
    it('VIEWER cannot delete a project', async () => {
      const rA = await fetchWith(`${baseUrl}/api/workspaces/${wsA}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Project A' }), token: 'test-token' });
      expect(rA.status).toBe(201);
      const pA = await rA.json();
      const r = await fetchWith(`${baseUrl}/api/projects/${pA.id}`, { method: 'DELETE', token: 'viewer-user-id' });
      expect(r.status).toBe(403);
    });
  });
});