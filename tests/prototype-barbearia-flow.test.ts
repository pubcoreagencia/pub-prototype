import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Task, CreateTask } from '../src/domain.js';
import type { PrototypeSession, CreatePrototypeSession, PrototypeCheckpoint } from '../src/pp/domain/domain.js';
import type { AgentProvider, ProviderTaskResult } from '../src/providers/types.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { LocalPreviewRuntime } from '../src/pp/preview/local-preview-runtime.js';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import type { PpTaskRepository } from '../src/pp/persistence/task-repository.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

describe('PUB Prototype â€” End-to-End Barbearia Multi-Prompt Flow', () => {
  let templateDir: string;
  let workspaceRootDir: string;
  const runningWorkspaces: string[] = [];

  beforeEach(async () => {
    templateDir = await mkdtemp(join(tmpdir(), 'barbearia-template-'));
    workspaceRootDir = await mkdtemp(join(tmpdir(), 'barbearia-workspaces-'));
    runningWorkspaces.push(templateDir, workspaceRootDir);

    // Initialize template git repo
    git(['init', '-b', 'main'], templateDir);
    git(['config', 'user.name', 'PUB Prototype Test'], templateDir);
    git(['config', 'user.email', 'test@pub-dev-loop.internal'], templateDir);

    // Minimal Node server that serves public/index.html on PORT
    const serverCode = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.env.PORT || 3000);
const server = http.createServer((req, res) => {
  const filePath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(filePath)) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(filePath, 'utf8'));
  } else {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('Template Ready');
  }
});
server.listen(port, '127.0.0.1', () => console.log('Listening on ' + port));
`;
    await mkdir(join(templateDir, 'public'), { recursive: true });
    await writeFile(join(templateDir, 'server.cjs'), serverCode, 'utf8');
    await writeFile(join(templateDir, 'public', 'index.html'), '<h1>Template Barbearia</h1>', 'utf8');

    git(['add', '.'], templateDir);
    git(['commit', '-m', 'initial template commit'], templateDir);
  });

  afterEach(async () => {
    for (const dir of runningWorkspaces) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('executes Prompt 1 (initial MVP) â†’ Preview â†’ Prompt 2 (agenda) â†’ same workspace updated', async () => {
    process.env.PROTOTYPE_WORKSPACES_ROOT = workspaceRootDir;
    process.env.PROTOTYPE_PREVIEW_MODE = 'local';
    process.env.PROTOTYPE_PREVIEW_COMMAND = process.execPath;
    process.env.PROTOTYPE_PREVIEW_ARGS = 'server.cjs';
    process.env.PROTOTYPE_PREVIEW_STARTUP_TIMEOUT_MS = '10000';

    // In-memory mock repositories
    const taskStore = new Map<string, Task>();
    const sessionStore = new Map<string, PrototypeSession>();
    const checkpointStore: PrototypeCheckpoint[] = [];

    const mockTasks = {
      async claim(worker: string): Promise<Task | null> {
        for (const t of taskStore.values()) {
          if (t.status === 'QUEUED') {
            t.status = 'ASSIGNED';
            t.worker = worker;
            return { ...t };
          }
        }
        return null;
      },
      async claimPrototype(worker: string): Promise<Task | null> {
        return this.claim(worker);
      },
      async update(id: string, patch: Partial<Task>): Promise<Task | null> {
        const t = taskStore.get(id);
        if (!t) return null;
        Object.assign(t, patch);
        return { ...t };
      },
      async heartbeat() { return true; },
    } as unknown as PpTaskRepository;

    const mockPrototypes = {
      async getSession(id: string): Promise<PrototypeSession | null> {
        const s = sessionStore.get(id);
        return s ? { ...s } : null;
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
    } as unknown as PostgresPrototypeRepository;

    const events = new PrototypeEventStream();
    const emittedEvents: string[] = [];
    events.subscribe(e => emittedEvents.push(e.type));

    let promptIteration = 1;
    const mockProvider: AgentProvider = {
      kind: 'mock',
      model: 'mock-model',
      async execute(task: Task, workspace: string): Promise<ProviderTaskResult> {
        const indexPath = join(workspace, 'public', 'index.html');
        if (promptIteration === 1) {
          await writeFile(indexPath, '<h1>Barbearia do Matheus - MVP</h1><p>Cortes clÃ¡ssicos e barba</p>', 'utf8');
        } else {
          await writeFile(indexPath, '<h1>Barbearia do Matheus - MVP</h1><p>Cortes clÃ¡ssicos e barba</p><div id="agenda">Agenda Semanal DisponÃ­vel</div>', 'utf8');
        }
        return {
          status: 'COMPLETED',
          provider: 'mock',
          model: 'mock-model',
          exitCode: 0,
          durationMs: 150,
          stdout: 'Files modified successfully',
          stderr: '',
          changedFiles: ['public/index.html'],
          commit: null,
          errorCode: null,
          errorMessage: null,
        };
      },
      async health() { return { available: true, details: 'ok' }; },
      capabilities() { return ['mock']; },
      metadata() { return {}; },
    };

    const localPreviewRuntime = new LocalPreviewRuntime();
    const worker = new PrototypeWorker(mockTasks, mockPrototypes, mockProvider, events, 'prototype-test-worker', localPreviewRuntime);

    // --- PROMPT 1: Create Barbearia MVP ---
    const sessionId = 'barber-session-001';
    const session: PrototypeSession = {
      id: sessionId,
      project: 'barber-app',
      repository: templateDir,
      branch: 'prototype/barber-app/barber-session-001',
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

    const task1: Task = {
      id: 'task-prompt-1',
      project: 'barber-app',
      repository: templateDir,
      objective: 'Criar MVP Barbearia',
      prompt: 'Monte um sistema para gerenciamento de uma barbearia',
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
    taskStore.set(task1.id, task1);

    const worked1 = await worker.executeOnce();
    expect(worked1).toBe(true);

    if (task1.status === 'FAILED') console.error('Task1 failed with:', task1.error, task1.result);
    expect(task1.status).toBe('COMPLETED');
    expect(task1.commitSha).toMatch(/^[0-9a-f]{40}$/);

    // Verify session updated with preview
    const sessionAfterPrompt1 = sessionStore.get(sessionId)!;
    expect(sessionAfterPrompt1.status).toBe('READY');
    expect(sessionAfterPrompt1.previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    // Verify live preview output for prompt 1
    const res1 = await fetch(sessionAfterPrompt1.previewUrl!);
    expect(res1.status).toBe(200);
    const html1 = await res1.text();
    expect(html1).toContain('Barbearia do Matheus - MVP');

    // Verify checkpoint 1
    expect(checkpointStore).toHaveLength(1);
    expect(checkpointStore[0].promptIndex).toBe(1);
    expect(checkpointStore[0].commitSha).toBe(task1.commitSha);
    expect(checkpointStore[0].buildPassed).toBe(true);

    // --- PROMPT 2: Add Agenda Semanal on SAME workspace ---
    promptIteration = 2;
    sessionAfterPrompt1.status = 'BUILDING';
    sessionAfterPrompt1.promptCount = 2;

    const task2: Task = {
      id: 'task-prompt-2',
      project: 'barber-app',
      repository: templateDir,
      objective: 'Adicionar agenda semanal',
      prompt: 'Adicione uma agenda semanal com horÃ¡rios disponÃ­veis',
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
    taskStore.set(task2.id, task2);

    const worked2 = await worker.executeOnce();
    expect(worked2).toBe(true);

    // Verify task2 completed
    expect(task2.status).toBe('COMPLETED');
    expect(task2.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(task2.commitSha).not.toBe(task1.commitSha); // New commit on same branch

    // Verify checkpoint 2
    expect(checkpointStore).toHaveLength(2);
    expect(checkpointStore[1].promptIndex).toBe(2);
    expect(checkpointStore[1].commitSha).toBe(task2.commitSha);

    // Verify live preview output for prompt 2 has the new agenda
    const res2 = await fetch(sessionAfterPrompt1.previewUrl!);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    expect(html2).toContain('Barbearia do Matheus - MVP');
    expect(html2).toContain('Agenda Semanal DisponÃ­vel');

    // Verify emitted event sequence
    expect(emittedEvents).toContain('AGENT_STARTED');
    expect(emittedEvents).toContain('BUILD_PASSED');
    expect(emittedEvents).toContain('CHECKPOINT_CREATED');
    expect(emittedEvents).toContain('PREVIEW_READY');
  }, 30000);

  it('validates task isolation between Development and Prototype workers', async () => {
    const taskStore = new Map<string, Task>();

    const devTask: Task = {
      id: 'dev-task-1',
      project: 'core-backend',
      repository: templateDir,
      objective: 'Fix bug',
      prompt: 'Fix security issue',
      status: 'QUEUED',
      priority: 5,
      worker: null,
      result: null,
      error: null,
      branch: 'main',
      commitSha: null,
      gitStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      prototypeSessionId: null, // DEVELOPMENT TASK
    };
    taskStore.set(devTask.id, devTask);

    const protoTask: Task = {
      id: 'proto-task-1',
      project: 'barber-app',
      repository: templateDir,
      objective: 'Create prototype',
      prompt: 'Create prototype',
      status: 'QUEUED',
      priority: 5,
      worker: null,
      result: null,
      error: null,
      branch: 'prototype/barber-app/session-1',
      commitSha: null,
      gitStatus: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      prototypeSessionId: 'session-1', // PROTOTYPE TASK
    };
    taskStore.set(protoTask.id, protoTask);

    const mockTasks = {
      async claim(worker: string): Promise<Task | null> { for (const t of taskStore.values()) { if (t.status === 'QUEUED' && t.prototypeSessionId) { t.status = 'ASSIGNED'; t.worker = worker; return { ...t }; } } return null; },
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
      async claim(worker: string): Promise<Task | null> {
        for (const t of taskStore.values()) {
          if (t.status === 'QUEUED' && !t.prototypeSessionId) {
            t.status = 'ASSIGNED';
            t.worker = worker;
            return { ...t };
          }
        }
        return null;
      },
    } as unknown as PpTaskRepository;

    // Prototype worker claims ONLY protoTask
    const protoClaimed = await mockTasks.claimPrototype('proto-worker');
    expect(protoClaimed?.id).toBe('proto-task-1');

    // No more prototype tasks
    const protoClaimedAgain = await mockTasks.claimPrototype('proto-worker');
    expect(protoClaimedAgain).toBeNull();

    // Dev worker claims ONLY devTask
    const devClaimed = await mockTasks.claim('dev-worker');
    expect(devClaimed?.id).toBe('dev-task-1');

    // No more dev tasks
    const devClaimedAgain = await mockTasks.claim('dev-worker');
    expect(devClaimedAgain).toBeNull();
  });

  it('preserves task processing and workspace status across simulated UI disconnects (F5 Recovery)', async () => {
    process.env.PROTOTYPE_WORKSPACES_ROOT = workspaceRootDir;
    process.env.PROTOTYPE_PREVIEW_MODE = 'local';
    process.env.PROTOTYPE_PREVIEW_COMMAND = process.execPath;
    process.env.PROTOTYPE_PREVIEW_ARGS = 'server.cjs';
    process.env.PROTOTYPE_PREVIEW_STARTUP_TIMEOUT_MS = '10000';

    const taskStore = new Map<string, Task>();
    const sessionStore = new Map<string, PrototypeSession>();
    const checkpointStore: PrototypeCheckpoint[] = [];

    const mockTasks = {
      async claim(worker: string): Promise<Task | null> { for (const t of taskStore.values()) { if (t.status === 'QUEUED' && t.prototypeSessionId) { t.status = 'ASSIGNED'; t.worker = worker; return { ...t }; } } return null; },
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
    } as unknown as PpTaskRepository;

    const mockPrototypes = {
      async getSession(id: string): Promise<PrototypeSession | null> {
        const s = sessionStore.get(id);
        return s ? { ...s } : null;
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
    } as unknown as PostgresPrototypeRepository;

    const events = new PrototypeEventStream();
    const mockProvider: AgentProvider = {
      kind: 'mock',
      model: 'mock-model',
      async execute(task: Task, workspace: string): Promise<ProviderTaskResult> {
        await writeFile(join(workspace, 'public', 'index.html'), '<h1>Barbearia</h1>', 'utf8');
        return {
          status: 'COMPLETED',
          provider: 'mock',
          model: 'mock-model',
          exitCode: 0,
          durationMs: 150,
          stdout: 'ok',
          stderr: '',
          changedFiles: ['public/index.html'],
          commit: null,
          errorCode: null,
          errorMessage: null,
        };
      },
      async health() { return { available: true, details: 'ok' }; },
      capabilities() { return ['mock']; },
      metadata() { return {}; },
    };

    const localPreviewRuntime = new LocalPreviewRuntime();
    const worker = new PrototypeWorker(mockTasks, mockPrototypes, mockProvider, events, 'prototype-test-worker', localPreviewRuntime);

    const sessionId = 'f5-recovery-session';
    const session: PrototypeSession = {
      id: sessionId,
      project: 'f5-recovery-app',
      repository: templateDir,
      branch: 'prototype/f5-recovery-app/f5-recovery-session',
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
      id: 'task-f5',
      project: 'f5-recovery-app',
      repository: templateDir,
      objective: 'F5 testing',
      prompt: 'Verify background preservation',
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

    // 1. Simulate UI trigger sending prompt
    // 2. Simulate UI EventSource disconnection (F5 / Refresh)
    // 3. Worker continues executeOnce in background independently
    const executePromise = worker.executeOnce();

    // Verify task status is immediately ASSIGNED/RUNNING
    const claimedTask = taskStore.get(task.id)!;
    expect(['ASSIGNED', 'RUNNING']).toContain(claimedTask.status);

    // Verify background workspace is intact
    await executePromise;

    // Verify completion independent of client
    const finishedTask = taskStore.get(task.id)!;
    expect(finishedTask.status).toBe('COMPLETED');
    expect(finishedTask.commitSha).toBeTruthy();

    const recoveredSession = sessionStore.get(sessionId)!;
    expect(recoveredSession.status).toBe('READY');
    expect(recoveredSession.previewUrl).toBeTruthy();
  });
});


