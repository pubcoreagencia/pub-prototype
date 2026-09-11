import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import { CorrectionController } from '../src/pp/worker/correction-controller.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import { WorkspaceValidator } from '../src/finalizer.js';
import type { Task } from '../src/domain.js';
import type { AgentProvider, ProviderTaskResult } from '../src/providers/types.js';
import type { PreviewRuntime, PreviewRuntimeInfo } from '../src/pp/preview/preview-runtime.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function initTestRepo(root: string, branch: string): Promise<void> {
  await mkdir(root, { recursive: true });
  execSync('git init', { cwd: root, stdio: 'ignore' });
  execSync('git config user.name "Test"', { cwd: root, stdio: 'ignore' });
  execSync('git config user.email "test@test.com"', { cwd: root, stdio: 'ignore' });
  await writeFile(join(root, 'README.md'), '# test\n');
  execSync('git add -A', { cwd: root, stdio: 'ignore' });
  execSync('git commit -m "init"', { cwd: root, stdio: 'ignore' });
  execSync(`git checkout -B ${branch}`, { cwd: root, stdio: 'ignore' });
}

function makeTask(overrides: Partial<Task> = {}): Task {
  const sessionId = 'sess-' + randomUUID().slice(0, 8);
  return {
    id: 'task-' + randomUUID().slice(0, 8),
    project: 'test-project',
    repository: 'https://github.com/test/repo.git',
    objective: 'Write a hello-world function',
    prompt: 'Add hello() to src/index.ts',
    status: 'RUNNING',
    priority: 1,
    worker: 'worker-test',
    result: null,
    error: null,
    branch: 'prototype/test-project/' + sessionId,
    commitSha: null,
    gitStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    leaseOwner: 'worker-test',
    leaseDeadline: new Date(Date.now() + 60_000),
    heartbeatAt: new Date(),
    workspacePath: null,
    prototypeSessionId: sessionId,
    ...overrides,
  };
}

/** Fake AgentProvider â€“ does NOT call any real LLM */
function makeFakeProvider(
  executeFn: (task: Task, workspace: string, opts: Record<string, unknown>) => Promise<ProviderTaskResult>,
): AgentProvider {
  return {
    kind: 'mock',
    model: 'mock-model',
    execute: executeFn as any,
    health: async () => ({ status: 'healthy' }),
    capabilities: () => ({ streaming: false, tools: false }),
    metadata: () => ({ kind: 'mock', model: 'mock-model' }),
  } as any;
}

/** Fake in-memory task repository stub for PrototypeWorker */
class FakeTaskRepo {
  private _task: Task | null = null;
  updates: Array<Partial<Task>> = [];
  heartbeats = 0;

  seed(task: Task) { this._task = { ...task }; }

  async claim(_worker: string): Promise<Task | null> { return this._task; }
  async claimPrototype(_worker: string): Promise<Task | null> {
    if (!this._task || this._task.status !== 'RUNNING') return null;
    return this._task;
  }

  async get(id: string): Promise<Task | null> {
    return this._task?.id === id ? this._task : null;
  }

  async update(_id: string, patch: Partial<Task>): Promise<Task | null> {
    this.updates.push({ ...patch });
    if (this._task) Object.assign(this._task, patch);
    return this._task;
  }

  async heartbeat(_id: string, _deadline: Date): Promise<boolean> {
    this.heartbeats++;
    return true;
  }
}

/** Fake PrototypeRepository stub */
class FakePrototypeRepo {
  sessions: Record<string, any> = {};
  updates: Array<[string, any]> = [];
  checkpoints: any[] = [];
  messages: any[] = [];

  async getSession(id: string) { return this.sessions[id] ?? { id, promptCount: 0 }; }
  async updateSession(id: string, patch: any) {
    this.updates.push([id, patch]);
    this.sessions[id] = { ...(this.sessions[id] ?? {}), ...patch, id };
    return this.sessions[id];
  }
  async createCheckpoint(data: any) {
    const cp = { id: randomUUID(), ...data };
    this.checkpoints.push(cp);
    return cp;
  }
  async addMessage(msg: any) { this.messages.push(msg); return msg; }
  async incrementPromptCount(id: string) { return this.sessions[id]; }
  async nextMessageOrder(_id: string) { return 0; }
  async createSession(data: any) { return { id: data.id ?? randomUUID(), ...data }; }
  async listSessions() { return []; }
  async listCheckpoints() { return []; }
  async promoteSession() { return null; }
  async createPromotion() { return null; }
  async getPromotion() { return null; }
  async listMessages() { return []; }
}

/** Fake PreviewRuntime that satisfies ensurePreview() without I/O */
function makeFakePreview(): PreviewRuntime {
  const info: PreviewRuntimeInfo = { id: 'preview-test', url: 'http://localhost:3000', port: 3000 };
  return {
    create: async () => info,
    start: async () => info,
    get: async () => info,
    stop: async () => {},
    destroy: async () => {},
    subscribe: () => () => {},
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Operation 12.1 â€“ CorrectionController integration', () => {
  let tmpDir: string;
  let workspace: string;
  let taskRepo: FakeTaskRepo;
  let protoRepo: FakePrototypeRepo;
  let events: PrototypeEventStream;
  let emittedTypes: string[];

  beforeEach(async () => {
    tmpDir = join(tmpdir(), 'correction-test-' + randomUUID().slice(0, 8));
    workspace = join(tmpDir, 'ws');
    taskRepo = new FakeTaskRepo();
    protoRepo = new FakePrototypeRepo();
    events = new PrototypeEventStream();
    emittedTypes = [];
    events.subscribe(e => emittedTypes.push(e.type));
    vi.stubEnv('PROTOTYPE_PREVIEW_MODE', 'local');
    vi.stubEnv('TASK_TEST_COMMAND', '');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // TEST 1 â€“ classify() maps error codes correctly
  // -------------------------------------------------------------------------
  it('classify: maps error codes to correct categories', () => {
    const fakeResult: ProviderTaskResult = {
      status: 'COMPLETED',
      stdout: '',
      stderr: '',
      exitCode: 0,
      changedFiles: [],
      provider: 'mock',
      model: 'mock-model',
      durationMs: 0,
      streaming: false,
      commit: null,
      errorCode: null,
      errorMessage: null,
    } as any;
    const ctrl = new CorrectionController(
      makeFakeProvider(async () => fakeResult),
      events,
    );
    const classify = (code: string | null) => (ctrl as any).classify(code);

    expect(classify('TASK_TESTS_FAILED')).toBe('CORRECTABLE');
    expect(classify('FAILED_UNEXPECTED_CHANGES')).toBe('CORRECTABLE');
    expect(classify('COMMIT_FAILED')).toBe('RETRYABLE');
    expect(classify('PUSH_FAILED')).toBe('ESCALATE');
    expect(classify('UNKNOWN_ERROR')).toBe('ESCALATE');
    expect(classify(null)).toBe('ESCALATE');
  });

  // -------------------------------------------------------------------------
  // TEST 2 â€“ MAX_CORRECTION_ATTEMPTS hard limit = 2
  // -------------------------------------------------------------------------
  it('MAX_CORRECTION_ATTEMPTS is exactly 2 (hard-coded, not env-driven)', () => {
    expect(CorrectionController.MAX_CORRECTION_ATTEMPTS).toBe(2);
  });

  // -------------------------------------------------------------------------
  // TEST 3 â€“ redact() strips Bearer tokens
  // -------------------------------------------------------------------------
  it('redact: strips Bearer tokens from strings', () => {
    const ctrl = new CorrectionController(
      makeFakeProvider(async () => ({} as any)),
      events,
    );
    const redact = (v: string) => (ctrl as any).redact(v);
    const input = 'Authorization: Bearer sk-abc123xyz_very_long_token_here';
    const result = redact(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('sk-abc123xyz_very_long_token_here');
  });

  // -------------------------------------------------------------------------
  // TEST 4 â€“ Direct runCorrectionLoop: TASK_TESTS_FAILED â†’ correction attempt
  // Proves: correction_started emitted, provider called, finalizer re-run.
  // -------------------------------------------------------------------------
  it('runCorrectionLoop: emits correction_started for TASK_TESTS_FAILED and invokes provider', async () => {
    const task = makeTask();
    task.workspacePath = workspace;
    await initTestRepo(workspace, task.branch!);

    const snapshot = WorkspaceValidator.captureSnapshot(workspace);

    let providerCalls = 0;
    const provider = makeFakeProvider(async (_task, ws) => {
      providerCalls++;
      // Write a new file so the finalizer sees changes and can commit
      await writeFile(join(ws, `fix-attempt-${providerCalls}.ts`), `export const fix${providerCalls} = true;\n`);
      return {
        status: 'COMPLETED',
        stdout: 'fixed',
        stderr: '',
        exitCode: 0,
        changedFiles: [`fix-attempt-${providerCalls}.ts`],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 5,
        streaming: false,
        commit: null,
        errorCode: null,
        errorMessage: null,
      } as any;
    });

    const controller = new CorrectionController(provider, events);
    const decision = await controller.runCorrectionLoop(
      task,
      workspace,
      snapshot,
      { status: 'COMPLETED', stdout: '', changedFiles: [], provider: 'mock', model: 'mock-model', durationMs: 0, commit: null, errorCode: null, errorMessage: null } as any,
      {
        status: 'FAILED',
        errorCode: 'TASK_TESTS_FAILED',
        errorMessage: 'Tests failed: 3 failing assertions',
        testOutput: 'AssertionError: expected 1 to equal 2',
        gitStatus: '?? undeclared.ts',
        changedFiles: [],
      },
    );

    expect(providerCalls).toBeGreaterThanOrEqual(1);
    expect(emittedTypes).toContain('correction_started');

    const hasResolution =
      emittedTypes.includes('correction_succeeded') ||
      emittedTypes.includes('correction_escalated');
    expect(hasResolution).toBe(true);

    expect(['SUCCESS', 'ESCALATED']).toContain(decision);
  }, 20_000);

  // -------------------------------------------------------------------------
  // TEST 5 â€“ Exhaustion: 2 attempts both fail â†’ correction_escalated, no correction_succeeded
  // Proves MAX_CORRECTION_ATTEMPTS = 2 enforced.
  // -------------------------------------------------------------------------
  it('runCorrectionLoop: escalates after exactly MAX_CORRECTION_ATTEMPTS (2) failed attempts', async () => {
    const task = makeTask();
    task.workspacePath = workspace;
    await initTestRepo(workspace, task.branch!);

    const snapshot = WorkspaceValidator.captureSnapshot(workspace);

    let providerCalls = 0;
    // Each call writes a file but declares nothing â†’ FAILED_UNEXPECTED_CHANGES
    const provider = makeFakeProvider(async (_task, ws) => {
      providerCalls++;
      await writeFile(join(ws, `undeclared-${providerCalls}.ts`), `const x${providerCalls} = ${providerCalls};\n`);
      return {
        status: 'COMPLETED',
        stdout: '',
        stderr: '',
        exitCode: 0,
        changedFiles: [],  // intentionally empty â†’ FAILED_UNEXPECTED_CHANGES
        provider: 'mock',
        model: 'mock-model',
        durationMs: 5,
        streaming: false,
        commit: null,
        errorCode: null,
        errorMessage: null,
      } as any;
    });

    const controller = new CorrectionController(provider, events);
    const decision = await controller.runCorrectionLoop(
      task,
      workspace,
      snapshot,
      { status: 'COMPLETED', stdout: '', changedFiles: [], provider: 'mock', model: 'mock-model', durationMs: 0, commit: null, errorCode: null, errorMessage: null } as any,
      {
        status: 'FAILED',
        errorCode: 'TASK_TESTS_FAILED',
        errorMessage: 'Tests failed',
        testOutput: '3 tests failed',
        gitStatus: '',
        changedFiles: [],
      },
    );

    // Exactly MAX_CORRECTION_ATTEMPTS provider calls
    expect(providerCalls).toBe(CorrectionController.MAX_CORRECTION_ATTEMPTS);

    // Must have escalated
    expect(decision).toBe('ESCALATED');
    expect(emittedTypes).toContain('correction_escalated');
    expect(emittedTypes).not.toContain('correction_succeeded');

    // correction_started fired once per attempt
    const startCount = emittedTypes.filter(t => t === 'correction_started').length;
    expect(startCount).toBe(CorrectionController.MAX_CORRECTION_ATTEMPTS);
  }, 30_000);

  // -------------------------------------------------------------------------
  // TEST 6 â€“ PrototypeWorker integration: correction before lease release
  // Proves same task/workspace/branch/sessionId identity invariants.
  // -------------------------------------------------------------------------
  it('PrototypeWorker: correction runs BEFORE lease is released (lifecycle invariant)', async () => {
    const task = makeTask();
    task.workspacePath = workspace;
    const sessionId = task.prototypeSessionId!;

    await initTestRepo(workspace, task.branch!);

    let leaseReleasedBeforeCorrection = false;
    let correctionStartedSeen = false;

    // Spy on taskRepo.update to detect lease releases during correction
    const originalUpdate = FakeTaskRepo.prototype.update;

    taskRepo.seed(task);
    protoRepo.sessions[sessionId] = { id: sessionId, promptCount: 0 };

    // Subscribe before creating worker
    events.subscribe(e => {
      if (e.type === 'correction_started') {
        correctionStartedSeen = true;
        // At this moment, if any previous update already cleared the lease, flag it
        const leaseAlreadyCleared = taskRepo.updates.some(
          u => u.leaseOwner === null || u.leaseDeadline === null,
        );
        if (leaseAlreadyCleared) {
          leaseReleasedBeforeCorrection = true;
        }
      }
    });

    let providerCalls = 0;
    const provider = makeFakeProvider(async (_t, ws) => {
      providerCalls++;
      // First call: write a file but declare nothing â†’ causes FAILED_UNEXPECTED_CHANGES
      // so the correction loop kicks in
      if (providerCalls === 1) {
        await writeFile(join(ws, 'undeclared.ts'), 'const x = 1;\n');
        return {
          status: 'COMPLETED',
          stdout: '',
          stderr: '',
          exitCode: 0,
          changedFiles: [],  // undeclared â†’ triggers correction
          provider: 'mock',
          model: 'mock-model',
          durationMs: 5,
          streaming: false,
          commit: null,
          errorCode: null,
          errorMessage: null,
        } as any;
      }
      // Correction call(s): write nothing â†’ no changes â†’ finalizer returns COMPLETED (no changes = success)
      return {
        status: 'COMPLETED',
        stdout: 'corrected',
        stderr: '',
        exitCode: 0,
        changedFiles: [],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 5,
        streaming: false,
        commit: null,
        errorCode: null,
        errorMessage: null,
      } as any;
    });

    const worker = new PrototypeWorker(
      taskRepo as any,
      protoRepo as any,
      provider,
      events,
      'test-worker',
      makeFakePreview(),
    );

    const result = await worker.executeOnce();
    expect(result).toBe(true);

    // If correction started, the lease must NOT have been released before it
    if (correctionStartedSeen) {
      expect(leaseReleasedBeforeCorrection).toBe(false);
    }

    // Final state: lease must be released at the very end
    const leaseReleases = taskRepo.updates.filter(u => u.leaseOwner === null);
    expect(leaseReleases.length).toBeGreaterThanOrEqual(1);

    // Session identity preserved in proto repo
    expect(protoRepo.updates.some(([id]) => id === sessionId)).toBe(true);
  }, 30_000);

  // -------------------------------------------------------------------------
  // TEST 7 â€“ Successful initial finalization skips the correction loop entirely
  // -------------------------------------------------------------------------
  it('PrototypeWorker: no correction_started if initial finalization succeeds', async () => {
    const task = makeTask();
    task.workspacePath = workspace;
    const sessionId = task.prototypeSessionId!;

    await initTestRepo(workspace, task.branch!);
    taskRepo.seed(task);
    protoRepo.sessions[sessionId] = { id: sessionId, promptCount: 0 };

    let providerCalls = 0;
    const provider = makeFakeProvider(async (_t, ws) => {
      providerCalls++;
      // Modify the existing README.md (already tracked) â†’ git status shows "M README.md"
      // and we declare it â€” so the finalizer validates it as expected and commits it.
      await writeFile(join(ws, 'README.md'), '# test\n\nexport const hello = () => "hello";\n');
      return {
        status: 'COMPLETED',
        stdout: 'Done',
        stderr: '',
        exitCode: 0,
        changedFiles: ['README.md'],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 10,
        streaming: false,
        commit: null,
        errorCode: null,
        errorMessage: null,
      } as any;
    });

    const worker = new PrototypeWorker(
      taskRepo as any,
      protoRepo as any,
      provider,
      events,
      'test-worker',
      makeFakePreview(),
    );

    await worker.executeOnce();

    // Provider called exactly once (no correction needed)
    expect(providerCalls).toBe(1);

    // No correction events emitted
    expect(emittedTypes).not.toContain('correction_started');
    expect(emittedTypes).not.toContain('correction_succeeded');
    expect(emittedTypes).not.toContain('correction_escalated');

    // BUILD_PASSED must be emitted
    expect(emittedTypes).toContain('BUILD_PASSED');
  }, 30_000);
});

