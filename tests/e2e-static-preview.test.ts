import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Task } from '../src/domain.js';
import type { PrototypeSession, PrototypeCheckpoint } from '../src/pp/domain/domain.js';
import type { AgentProvider, ProviderTaskResult } from '../src/providers/types.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { LocalPreviewRuntime } from '../src/pp/preview/local-preview-runtime.js';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { TaskRepository, PrototypeRepository } from '../src/pp/persistence/repository.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function createMockTaskRepo(taskStore: Map<string, Task>, sessionStore: Map<string, PrototypeSession>, checkpointStore: PrototypeCheckpoint[]) {
  const mockTasks = {
    async claim(worker: string): Promise<Task | null> { return this.claimPrototype(worker); },
    async claimPrototype(worker: string): Promise<Task | null> {
      for (const t of taskStore.values()) {
        if (t.status === 'QUEUED' && t.prototypeSessionId) {
          t.status = 'ASSIGNED';
          t.worker = worker;
          return { ...t };
        }
      }
      return null;
    },
    async update(id: string, patch: Partial<Task>): Promise<Task | null> {
      const t = taskStore.get(id);
      if (!t) return null;
      Object.assign(t, patch);
      return { ...t };
    },
    async heartbeat() { return true; },
  } as unknown as TaskRepository;
  return mockTasks;
}

describe('PUB Prototype E2E: Static Workspace', () => {
  let templateDir: string;
  let workspaceRootDir: string;
  const runningWorkspaces: string[] = [];

  beforeEach(async () => {
    templateDir = await mkdtemp(join(tmpdir(), 'e2e-static-template-'));
    workspaceRootDir = await mkdtemp(join(tmpdir(), 'e2e-static-workspaces-'));
    runningWorkspaces.push(templateDir, workspaceRootDir);

    git(['init', '-b', 'main'], templateDir);
    git(['config', 'user.name', 'PUB E2E Test'], templateDir);
    git(['config', 'user.email', 'e2e@test.pub'], templateDir);
  });

  afterEach(async () => {
    for (const dir of runningWorkspaces) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('STATIC: creates a preview from a static workspace with index.html, styles.css, script.js', async () => {
    process.env.PROTOTYPE_WORKSPACES_ROOT = workspaceRootDir;
    process.env.PROTOTYPE_PREVIEW_MODE = 'local';

    const taskStore = new Map<string, Task>();
    const sessionStore = new Map<string, PrototypeSession>();
    const checkpointStore: PrototypeCheckpoint[] = [];
    const emittedEvents: string[] = [];

    const mockTasks = createMockTaskRepo(taskStore, sessionStore, checkpointStore);

    const mockPrototypes = {
      async getSession(id: string): Promise<PrototypeSession | null> {
        return sessionStore.get(id) ?? null;
      },
      async updateSession(id: string, patch: Partial<PrototypeSession>): Promise<PrototypeSession | null> {
        const s = sessionStore.get(id);
        if (!s) return null;
        Object.assign(s, patch);
        return { ...s };
      },
      async createCheckpoint(input: Omit<PrototypeCheckpoint, 'id' | 'createdAt'>): Promise<PrototypeCheckpoint> {
        const cp: PrototypeCheckpoint = {
          id: `cp-${checkpointStore.length + 1}`,
          sessionId: input.sessionId,
          promptIndex: input.promptIndex,
          prompt: input.prompt,
          commitSha: input.commitSha,
          previewUrl: input.previewUrl,
          buildPassed: input.buildPassed,
          createdAt: new Date(),
        };
        checkpointStore.push(cp);
        return cp;
      },
    } as unknown as PrototypeRepository;

    const events = new PrototypeEventStream();
    events.subscribe(e => emittedEvents.push(e.type));

    // Mock provider creates a static workspace: index.html, styles.css, script.js
    const mockProvider: AgentProvider = {
      kind: 'mock',
      model: 'mock-model',
      async execute(_task: Task, workspace: string): Promise<ProviderTaskResult> {
        await writeFile(join(workspace, 'index.html'), '<html><head><link rel="stylesheet" href="styles.css"></head><body><h1>Static Landing</h1><script src="script.js"></script></body></html>', 'utf8');
        await writeFile(join(workspace, 'styles.css'), 'body{color:red}', 'utf8');
        await writeFile(join(workspace, 'script.js'), 'console.log("loaded")', 'utf8');
        return {
          status: 'COMPLETED',
          provider: 'mock',
          model: 'mock-model',
          exitCode: 0,
          durationMs: 100,
          stdout: 'Created static files',
          stderr: '',
          changedFiles: ['index.html', 'styles.css', 'script.js'],
          commit: null,
          errorCode: null,
          errorMessage: null,
        };
      },
      async health() { return { available: true, details: 'ok' }; },
      capabilities() { return ['mock']; },
      metadata() { return { provider: 'mock' }; },
    };

    const localPreviewRuntime = new LocalPreviewRuntime();
    const worker = new PrototypeWorker(mockTasks, mockPrototypes, mockProvider, events, 'prototype-e2e-static-worker', localPreviewRuntime);

    const sessionId = 'e2e-static-session';
    const session: PrototypeSession = {
      id: sessionId,
      project: 'static-landing-app',
      repository: templateDir,
      branch: 'prototype/static-landing-app/e2e-static-session',
      mode: 'PROTOTYPE',
      status: 'BUILDING',
      previewUrl: null,
      previewRuntime: null,
      workspacePath: join(workspaceRootDir, sessionId),
      lastCheckpointSha: null,
      promptCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    sessionStore.set(sessionId, session);

    const task: Task = {
      id: 'task-e2e-static',
      project: 'static-landing-app',
      repository: templateDir,
      objective: 'Create static landing page',
      prompt: 'Create a static HTML landing page with index.html, styles.css and script.js. Do not use Node, Vite or package.json.',
      status: 'QUEUED',
      priority: 10,
      worker: null,
      result: null,
      error: null,
      branch: session.branch,
      commitSha: null,
      gitStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      workspacePath: session.workspacePath,
      prototypeSessionId: sessionId,
    };
    taskStore.set(task.id, task);

    const worked = await worker.executeOnce();
    expect(worked).toBe(true);

    // Validate task COMPLETED
    expect(task.status).toBe('COMPLETED');
    expect(task.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Validate session READY with previewUrl
    const sessionAfter = sessionStore.get(sessionId)!;
    expect(sessionAfter.status).toBe('READY');
    expect(sessionAfter.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sessionAfter.lastCheckpointSha).toBe(task.commitSha);
    expect(sessionAfter.workspacePath).toBeTruthy();

    // Validate GET previewUrl â†’ HTTP 200
    const response = await fetch(sessionAfter.previewUrl!);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Static Landing');
    expect(html).toContain('styles.css');
    expect(html).toContain('script.js');

    // Validate files in workspace
    expect(existsSync(join(sessionAfter.workspacePath!, 'index.html'))).toBe(true);
    expect(existsSync(join(sessionAfter.workspacePath!, 'styles.css'))).toBe(true);
    expect(existsSync(join(sessionAfter.workspacePath!, 'script.js'))).toBe(true);
    expect(existsSync(join(sessionAfter.workspacePath!, 'package.json'))).toBe(false);

    // Validate checkpoint
    expect(checkpointStore).toHaveLength(1);
    expect(checkpointStore[0].commitSha).toBe(task.commitSha);
    expect(checkpointStore[0].buildPassed).toBe(true);

    // Validate SSE events
    expect(emittedEvents).toContain('AGENT_STARTED');
    expect(emittedEvents).toContain('BUILD_PASSED');
    expect(emittedEvents).toContain('CHECKPOINT_CREATED');
    expect(emittedEvents).toContain('PREVIEW_READY');

    await localPreviewRuntime.stop(sessionAfter.previewRuntime!);
  }, 30000);
});

