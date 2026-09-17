import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import { PostgresPpTaskRepository } from '../src/pp/persistence/task-repository.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { signAccessToken } from '../src/pp/auth/sovereign/jwt.js';
import { createPpApp } from '../src/pp/api/entry.js';
import http from 'node:http';

describe('PROMPT_CHARACTER_LIMIT = NONE (Phase 4 Prompt Length Audit)', () => {
  let protoRepo: PostgresPrototypeRepository;
  let taskRepo: PostgresPpTaskRepository;
  let keyManager: KeyManager;
  let app: any;
  let server: http.Server;
  let baseUrl: string;
  const sovereignUserId = 'b7234851-40e1-4566-a36c-21a48c69d854';
  let sovereignToken: string;

  beforeEach(async () => {
    protoRepo = new PostgresPrototypeRepository();
    await protoRepo.initializeSchema();
    taskRepo = new PostgresPpTaskRepository((protoRepo as any).pool);
    keyManager = new KeyManager();

    sovereignToken = signAccessToken(keyManager, {
      userId: sovereignUserId,
      sessionId: 'sess-prompt-len-1',
    });

    app = createPpApp((protoRepo as any).pool, taskRepo, protoRepo, undefined, keyManager);

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

  const promptSizes = [1_000, 10_000, 50_000, 100_000];

  for (const size of promptSizes) {
    it(`accepts, persists, and does not truncate a prompt of ${size.toLocaleString()} characters`, async () => {
      const prefix = `[START-${size}]`;
      const suffix = `[END-${size}]`;
      const fillLength = size - prefix.length - suffix.length;
      expect(fillLength).toBeGreaterThan(0);
      const generatedPrompt = prefix + 'A'.repeat(fillLength) + suffix;
      expect(generatedPrompt.length).toBe(size);

      // 1. Create workspace, project, session owned by sovereign user
      const ws = await protoRepo.createWorkspace({
        name: `WS Prompt ${size}`,
        ownerId: sovereignUserId,
      });

      const project = await protoRepo.createProject({
        workspaceId: ws.id,
        name: `Project Prompt ${size}`,
      });

      const session = await protoRepo.createSession({
        workspaceId: ws.id,
        projectId: project.id,
        project: project.name,
        repository: 'test/repo',
        branch: 'main',
      });

      // 2. Post prompt to API
      const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/prompts`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${sovereignToken}`,
        },
        body: JSON.stringify({ prompt: generatedPrompt }),
      });

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.session.id).toBe(session.id);
      expect(data.task.id).toBeDefined();

      // 3. Verify task persistence has exact length and intact boundaries
      const persistedTasks = await taskRepo.list(session.id);
      const matchedTask = persistedTasks.find((t) => t.id === data.task.id);
      expect(matchedTask).toBeDefined();
      expect(matchedTask?.prompt.length).toBe(size);
      expect(matchedTask?.prompt.startsWith(prefix)).toBe(true);
      expect(matchedTask?.prompt.endsWith(suffix)).toBe(true);
      expect(matchedTask?.prompt).toBe(generatedPrompt);

      // 4. Verify checkpoint persistence when created with large prompt
      const cp = await protoRepo.createCheckpoint({
        sessionId: session.id,
        promptIndex: 1,
        prompt: generatedPrompt,
        commitSha: 'sha-test-large-prompt',
        previewUrl: `/prototype/sessions/${session.id}/preview/`,
        buildPassed: true,
      });
      expect(cp.prompt.length).toBe(size);
      expect(cp.prompt.startsWith(prefix)).toBe(true);
      expect(cp.prompt.endsWith(suffix)).toBe(true);
      expect(cp.prompt).toBe(generatedPrompt);

      const listedCheckpoints = await protoRepo.listCheckpoints(session.id);
      const matchedCp = listedCheckpoints.find((c) => c.id === cp.id);
      expect(matchedCp?.prompt.length).toBe(size);
      expect(matchedCp?.prompt).toBe(generatedPrompt);
    });
  }

  it('rejects empty or whitespace-only prompt with 400', async () => {
    const ws = await protoRepo.createWorkspace({
      name: 'WS Empty Prompt',
      ownerId: sovereignUserId,
    });

    const project = await protoRepo.createProject({
      workspaceId: ws.id,
      name: 'Project Empty Prompt',
    });

    const session = await protoRepo.createSession({
      workspaceId: ws.id,
      projectId: project.id,
      project: project.name,
      repository: 'test/repo',
      branch: 'main',
    });

    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/prompts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${sovereignToken}`,
      },
      body: JSON.stringify({ prompt: '   ' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('prompt is required');
  });
});
