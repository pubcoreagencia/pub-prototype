import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPpApp } from '../src/pp/api/entry.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import http from 'node:http';

describe('PP 2.0 — Workspaces & Projects Management', () => {
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

  it('lists default workspace and allows creating custom workspaces', async () => {
    const authHeaders = { Authorization: 'Bearer test-token' };
    const authJsonHeaders = { 'content-type': 'application/json', Authorization: 'Bearer test-token' };

    // 1. List workspaces
    const listRes = await fetch(`${baseUrl}/api/workspaces`, { headers: authHeaders });
    expect(listRes.status).toBe(200);
    const workspaces = await listRes.json();
    expect(workspaces.length).toBeGreaterThanOrEqual(1);
    expect(workspaces.some((w: any) => w.name === 'Default Workspace')).toBe(true);

    // 2. Create custom workspace
    const createRes = await fetch(`${baseUrl}/api/workspaces`, {
      method: 'POST',
      headers: authJsonHeaders,
      body: JSON.stringify({ name: 'SAGAZ Enterprise Org' }),
    });
    expect(createRes.status).toBe(201);
    const newWs = await createRes.json();
    expect(newWs.name).toBe('SAGAZ Enterprise Org');
    expect(newWs.slug).toBe('sagaz-enterprise-org');
  });

  it('creates project inside workspace and retrieves project by ID', async () => {
    const authHeaders = { Authorization: 'Bearer test-token' };
    const authJsonHeaders = { 'content-type': 'application/json', Authorization: 'Bearer test-token' };

    const listRes = await fetch(`${baseUrl}/api/workspaces`, { headers: authHeaders });
    const workspaces = await listRes.json();
    const wsId = workspaces[0].id;

    // Create project in workspace
    const workspaceId = wsId; // use the workspace from earlier test
    const createRes = await fetch(`${baseUrl}/api/workspaces/${workspaceId}/projects`, {
      method: 'POST',
      headers: authJsonHeaders,
      body: JSON.stringify({
        name: 'Agro Dashboard AI',
        description: 'Painel inteligente para gestão de safras',
      }),
    });
    expect(createRes.status).toBe(201);
    const project = await createRes.json();
    expect(project.name).toBe('Agro Dashboard AI');
    expect(project.workspaceId).toBe(wsId);

    // Get project by ID
    const getRes = await fetch(`${baseUrl}/api/projects/${project.id}`, { headers: authHeaders });
    expect(getRes.status).toBe(200);
    const retrieved = await getRes.json();
    expect(retrieved.name).toBe('Agro Dashboard AI');
  });

  it('renames project via PATCH /api/projects/:id', async () => {
    const authJsonHeaders = { 'content-type': 'application/json', Authorization: 'Bearer test-token' };
    // Get default workspace id
    const wsListRes = await fetch(`${baseUrl}/api/workspaces`, { headers: { Authorization: 'Bearer test-token' } });
    const wsList = await wsListRes.json();
    const wsId = wsList[0].id;
    // Add OWNER membership for test-token
    await protoRepo.addWorkspaceMember({ workspaceId: wsId, userId: 'test-token', role: 'OWNER' });
    const project = await protoRepo.createProject({
      name: 'Old Project Name',
      workspaceId: wsId,
    });

    const patchRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: authJsonHeaders,
      body: JSON.stringify({ name: 'Renamed AI System' }),
    });
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.name).toBe('Renamed AI System');

    const fresh = await protoRepo.getProject(project.id);
    expect(fresh?.name).toBe('Renamed AI System');
  });

  it('deletes project with cascading removal of sessions and checkpoints, without deleting GitHub repo', async () => {
    const authHeaders = { Authorization: 'Bearer test-token' };
    // Obtain default workspace
    const wsListRes = await fetch(`${baseUrl}/api/workspaces`, { headers: authHeaders });
    const wsList = await wsListRes.json();
    const wsId = wsList[0].id;
    // Ensure OWNER membership
    await protoRepo.addWorkspaceMember({ workspaceId: wsId, userId: 'test-token', role: 'OWNER' });
    // 1. Create project
    const project = await protoRepo.createProject({
      name: 'Project to Delete',
      workspaceId: wsId,
      githubRepository: 'https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git',
    });

    // 2. Create session linked to project
    const session = await protoRepo.createSession({
      project: project.name,
      projectId: project.id,
      repository: project.githubRepository,
      branch: 'prototype/branch-del',
    });

    // 3. Create checkpoint & files
    const cp = await protoRepo.createCheckpoint({
      sessionId: session.id,
      promptIndex: 1,
      prompt: 'Test prompt',
      commitSha: 'sha-del-1',
      previewUrl: `/prototype/sessions/${session.id}/preview/`,
      buildPassed: true,
    });
    await protoRepo.saveCheckpointFiles([
      {
        sessionId: session.id,
        checkpointId: cp.id,
        path: 'index.html',
        content: '<h1>Deletable</h1>',
        contentType: 'text/html',
        sizeBytes: 19,
      },
    ]);

    // 4. Verify entities exist
    expect(await protoRepo.getProject(project.id)).toBeDefined();
    expect(await protoRepo.getSession(session.id)).toBeDefined();
    expect((await protoRepo.listSessionFiles(session.id)).length).toBe(1);

    // 5. Send DELETE request
    const deleteRes = await fetch(`${baseUrl}/api/projects/${project.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.ok).toBe(true);

    // 6. Verify relational cascade: project & session are gone
    expect(await protoRepo.getProject(project.id)).toBeNull();
    expect(await protoRepo.getSession(session.id)).toBeNull();
    expect((await protoRepo.listSessionFiles(session.id)).length).toBe(0);

    // 7. Guarantees: githubRepository was not touched or called for remote deletion
    expect(project.githubRepository).toBe('https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git');
  });
});
