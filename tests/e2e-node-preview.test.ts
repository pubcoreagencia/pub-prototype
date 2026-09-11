import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
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

function createMockTaskRepo(taskStore: Map<string, Task>) {
  return {
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
}

describe('PUB Prototype E2E: Node Workspace', () => {
  let templateDir: string;
  let workspaceRootDir: string;
  const runningWorkspaces: string[] = [];

  beforeEach(async () => {
    templateDir = await mkdtemp(join(tmpdir(), 'e2e-node-template-'));
    workspaceRootDir = await mkdtemp(join(tmpdir(), 'e2e-node-workspaces-'));
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

  it('NODE: creates a preview from a Node workspace with package.json + dev script', async () => {
    process.env.PROTOTYPE_WORKSPACES_ROOT = workspaceRootDir;
    process.env.PROTOTYPE_PREVIEW_MODE = 'local';
    process.env.PROTOTYPE_PREVIEW_COMMAND = process.execPath;
    process.env.PROTOTYPE_PREVIEW_ARGS = 'server.cjs';
    process.env.PROTOTYPE_PREVIEW_STARTUP_TIMEOUT_MS = '10000';

    const taskStore = new Map<string, Task>();
    const sessionStore = new Map<string, PrototypeSession>();
    const checkpointStore: PrototypeCheckpoint[] = [];
    const emittedEvents: string[] = [];

    const mockTasks = createMockTaskRepo(taskStore);

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

    const mockProvider: AgentProvider = {
      kind: 'mock',
      model: 'mock-model',
      async execute(_task: Task, workspace: string): Promise<ProviderTaskResult> {
        const serverCode = `
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<h1>Node App Ready</h1>');
}).listen(port, '127.0.0.1', () => console.log('SERVER_LISTENING'));
`;
        await writeFile(join(workspace, 'server.cjs'), serverCode, 'utf8');
        await writeFile(join(workspace, 'package.json'), JSON.stringify({
          name: 'node-app',
          version: '1.0.0',
          scripts: { dev: 'node server.cjs', start: 'node server.cjs' },
        }, null, 2), 'utf8');
        return {
          status: 'COMPLETED',
          provider: 'mock',
          model: 'mock-model',
          exitCode: 0,
          durationMs: 100,
          stdout: 'Created Node app',
          stderr: '',
          changedFiles: ['server.cjs', 'package.json'],
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
    const worker = new PrototypeWorker(mockTasks, mockPrototypes, mockProvider, events, 'prototype-e2e-node-worker', localPreviewRuntime);

    const sessionId = 'e2e-node-session';
    const session: PrototypeSession = {
      id: sessionId,
      project: 'node-app',
      repository: templateDir,
      branch: 'prototype/node-app/e2e-node-session',
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
      id: 'task-e2e-node',
      project: 'node-app',
      repository: templateDir,
      objective: 'Create a Node.js app with dev server',
      prompt: 'Create a Node.js app with package.json and a dev script using node:http',
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

    expect(task.status).toBe('COMPLETED');
    expect(task.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const sessionAfter = sessionStore.get(sessionId)!;
    expect(sessionAfter.status).toBe('READY');
    expect(sessionAfter.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(sessionAfter.lastCheckpointSha).toBe(task.commitSha);
    expect(sessionAfter.workspacePath).toBeTruthy();

    const response = await fetch(sessionAfter.previewUrl!);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Node App Ready');

    expect(checkpointStore).toHaveLength(1);
    expect(checkpointStore[0].commitSha).toBe(task.commitSha);
    expect(checkpointStore[0].buildPassed).toBe(true);

    expect(emittedEvents).toContain('AGENT_STARTED');
    expect(emittedEvents).toContain('BUILD_PASSED');
    expect(emittedEvents).toContain('CHECKPOINT_CREATED');
    expect(emittedEvents).toContain('PREVIEW_READY');

    await localPreviewRuntime.stop(sessionAfter.previewRuntime!);
  }, 30000);
});

