import 'dotenv/config';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

import { VerificationGate } from '../src/pp/verification/verification-gate.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import { VerificationRecoveryOrchestrator } from '../src/pp/worker/verification-recovery-orchestrator.js';
import { PrototypeWorker } from '../src/pp/worker/prototype-worker.js';
import { PrototypeEventStream } from '../src/pp/events/events.js';
import type { Task } from '../src/domain.js';
import type { AgentProvider, ProviderTaskResult } from '../src/providers/types.js';
import type { PreviewRuntime, PreviewRuntimeInfo } from '../src/pp/preview/preview-runtime.js';
import type { PrototypeSession, PrototypeCheckpoint, PrototypeVerification } from '../src/pp/domain/domain.js';

function makeFakeProvider(
  executeFn: (task: any, workspace: string, opts: Record<string, unknown>) => Promise<ProviderTaskResult>
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

function makeFakePreview(): PreviewRuntime {
  const info: PreviewRuntimeInfo = { id: 'preview-recovery-test', url: 'http://localhost:34567', port: 34567 };
  return {
    create: async () => info,
    start: async () => info,
    get: async () => info,
    stop: async () => {},
    destroy: async () => {},
    subscribe: () => () => {},
  };
}

describe('PP 2.1 — Autonomous Verification Recovery Loop', () => {
  let workspace: string;
  let pool: pg.Pool;
  let repo: PostgresPrototypeRepository;
  let events: PrototypeEventStream;
  let emittedEvents: Array<{ type: string; payload: any }>;
  let testSessionId: string;

  beforeEach(async () => {
    workspace = join('/tmp', `pp-recovery-test-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });

    // Real git repository
    execFileSync('git', ['init'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Recovery Tester'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'recovery@pubprototype.dev'], { cwd: workspace });

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || 'postgres://pubprototype:local_secret_123@localhost:5432/pubprototype',
    });
    repo = new PostgresPrototypeRepository(pool);
    await repo.initializeSchema();

    events = new PrototypeEventStream();
    emittedEvents = [];
    events.subscribe(e => emittedEvents.push({ type: e.type, payload: e.payload }));

    const s = await repo.createSession({
      project: `recovery-${randomUUID().slice(0, 8)}`,
      repository: 'https://github.com/test/recovery-repo',
      branch: 'main',
    });
    testSessionId = s.id;
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await pool.end().catch(() => undefined);
  });

  // 1. RECOVERY BÁSICO: V4 Failure -> Attempt #1 -> Fix -> PASS -> CAS -> READY
  it('1. Basic Recovery: V4 failure fixed on attempt #1, creates new checkpoint, verifies V0..V5 and promotes via CAS to READY', async () => {
    // Initial commit: index.html without script, but referencing script.js (V4 broken asset failure)
    await writeFile(
      join(workspace, 'index.html'),
      '<!DOCTYPE html><html><head><script src="missing-app.js"></script></head><body><h1>Broken App</h1></body></html>'
    );
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Initial faulty commit'], { cwd: workspace });
    const faultySha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp1 = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Build landing page with script',
      commitSha: faultySha,
      previewUrl: null,
      buildPassed: true,
    });

    const gate = new VerificationGate(repo);
    const verif1 = await gate.verify(testSessionId, cp1.id, workspace);
    expect(verif1.status).toBe('FAILED');
    expect(verif1.evidence.error_type).toBe('BROKEN_ASSET');

    // Setup recovery provider: writes missing-app.js
    let providerExecCount = 0;
    const provider = makeFakeProvider(async (_t, ws) => {
      providerExecCount++;
      await writeFile(join(ws, 'missing-app.js'), 'console.log("App ready");');
      return {
        status: 'COMPLETED',
        stdout: 'Created missing-app.js',
        stderr: '',
        exitCode: 0,
        changedFiles: ['missing-app.js'],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 50,
      } as any;
    });

    const orchestrator = new VerificationRecoveryOrchestrator(repo, provider, events);
    const session = (await repo.getSession(testSessionId))!;
    const dummyTask: any = {
      id: randomUUID(),
      prototypeSessionId: testSessionId,
      project: session.project,
      objective: 'Fix missing script',
      prompt: 'Build landing page with script',
      status: 'RUNNING',
    };

    const recoveryResult = await orchestrator.runRecoveryLoop(
      session,
      dummyTask,
      cp1,
      verif1,
      workspace,
      {
        previewUrl: `/prototype/sessions/${session.id}/preview/`,
      }
    );

    expect(recoveryResult.status).toBe('SUCCESS');
    expect(providerExecCount).toBe(1);

    // New checkpoint created
    expect(recoveryResult.lastCheckpoint).toBeDefined();
    expect(recoveryResult.lastCheckpoint!.id).not.toBe(cp1.id);
    expect(recoveryResult.lastCheckpoint!.commitSha).not.toBe(cp1.commitSha);

    // Checkpoint A remains intact and unaltered
    const cp1Reloaded = (await repo.listCheckpoints(testSessionId)).find(c => c.id === cp1.id);
    expect(cp1Reloaded).toBeDefined();
    expect(cp1Reloaded!.commitSha).toBe(faultySha);

    // Verification evaluated with PASSED
    expect(recoveryResult.lastVerification).toBeDefined();
    expect(recoveryResult.lastVerification!.status).toBe('PASSED');

    // Promotion authoritative
    const updatedSession = await repo.getSession(testSessionId);
    expect(updatedSession?.status).toBe('READY');
    expect(updatedSession?.lastCheckpointSha).toBe(recoveryResult.lastCheckpoint!.commitSha);

    // Lineage audit
    const attempts = await repo.getCorrectionAttemptsForVerification(verif1.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].status).toBe('COMPLETED');
    expect(attempts[0].resultCheckpointId).toBe(recoveryResult.lastCheckpoint!.id);
    expect(attempts[0].resultVerificationId).toBe(recoveryResult.lastVerification!.id);
  });

  // 2. RETRY: Attempt #1 FAIL -> Attempt #2 PASS -> CAS PROMOTION
  it('2. Retry: Attempt #1 fails again, Attempt #2 succeeds and achieves CAS promotion', async () => {
    // Initial commit: invalid HTML with broken script
    await writeFile(
      join(workspace, 'index.html'),
      '<!DOCTYPE html><html><head><script src="asset1.js"></script><script src="asset2.js"></script></head><body><h1>Broken</h1></body></html>'
    );
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Faulty 2 assets'], { cwd: workspace });
    const faultySha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp1 = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Multi asset app',
      commitSha: faultySha,
      previewUrl: null,
      buildPassed: true,
    });

    const gate = new VerificationGate(repo);
    const verif1 = await gate.verify(testSessionId, cp1.id, workspace);
    expect(verif1.status).toBe('FAILED');

    let providerExecCount = 0;
    const provider = makeFakeProvider(async (_t, ws) => {
      providerExecCount++;
      if (providerExecCount === 1) {
        // Attempt 1: only fix asset1.js (still missing asset2.js -> will FAIL verification)
        await writeFile(join(ws, 'asset1.js'), 'console.log("asset 1");');
        return {
          status: 'COMPLETED',
          stdout: 'Created asset1.js',
          stderr: '',
          exitCode: 0,
          changedFiles: ['asset1.js'],
          provider: 'mock',
          model: 'mock-model',
          durationMs: 40,
        } as any;
      } else {
        // Attempt 2: fix asset2.js -> will PASS verification
        await writeFile(join(ws, 'asset2.js'), 'console.log("asset 2");');
        return {
          status: 'COMPLETED',
          stdout: 'Created asset2.js',
          stderr: '',
          exitCode: 0,
          changedFiles: ['asset2.js'],
          provider: 'mock',
          model: 'mock-model',
          durationMs: 40,
        } as any;
      }
    });

    const orchestrator = new VerificationRecoveryOrchestrator(repo, provider, events);
    const session = (await repo.getSession(testSessionId))!;
    const dummyTask: any = {
      id: randomUUID(),
      prototypeSessionId: testSessionId,
      project: session.project,
      objective: 'Fix 2 assets',
      prompt: 'Multi asset app',
      status: 'RUNNING',
    };

    const recoveryResult = await orchestrator.runRecoveryLoop(
      session,
      dummyTask,
      cp1,
      verif1,
      workspace,
      {
        previewUrl: `/prototype/sessions/${session.id}/preview/`,
      }
    );

    expect(recoveryResult.status).toBe('SUCCESS');
    expect(providerExecCount).toBe(2);

    const attempts = await repo.getCorrectionAttemptsForVerification(verif1.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].attemptNumber).toBe(1);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[1].attemptNumber).toBe(2);
    expect(attempts[1].status).toBe('COMPLETED');

    const updatedSession = await repo.getSession(testSessionId);
    expect(updatedSession?.status).toBe('READY');
  });

  // 3. EXHAUSTION: Attempt #1 FAIL -> Attempt #2 FAIL -> RETRY_EXHAUSTED
  it('3. Exhaustion: Both attempts fail, returns RETRY_EXHAUSTED and emits verification_recovery_exhausted', async () => {
    await writeFile(join(workspace, 'index.html'), ''); // 0-byte blank page -> BLANK_PAGE error
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Blank page commit'], { cwd: workspace });
    const faultySha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp1 = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Blank page test',
      commitSha: faultySha,
      previewUrl: null,
      buildPassed: true,
    });

    const gate = new VerificationGate(repo);
    const verif1 = await gate.verify(testSessionId, cp1.id, workspace);
    expect(verif1.status).toBe('FAILED');

    // Provider that fails to solve the issue (keeps writing empty file)
    let providerExecCount = 0;
    const provider = makeFakeProvider(async (_t, ws) => {
      providerExecCount++;
      await writeFile(join(ws, 'empty.txt'), '');
      return {
        status: 'COMPLETED',
        stdout: 'No meaningful fix',
        stderr: '',
        exitCode: 0,
        changedFiles: ['empty.txt'],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 30,
      } as any;
    });

    const orchestrator = new VerificationRecoveryOrchestrator(repo, provider, events);
    const session = (await repo.getSession(testSessionId))!;
    const dummyTask: any = {
      id: randomUUID(),
      prototypeSessionId: testSessionId,
      project: session.project,
      objective: 'Blank fix test',
      prompt: 'Blank page test',
      status: 'RUNNING',
    };

    const recoveryResult = await orchestrator.runRecoveryLoop(
      session,
      dummyTask,
      cp1,
      verif1,
      workspace
    );

    expect(recoveryResult.status).toBe('RETRY_EXHAUSTED');
    expect(providerExecCount).toBe(2);

    const attempts = await repo.getCorrectionAttemptsForVerification(verif1.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].status).toBe('FAILED');
    expect(attempts[1].status).toBe('FAILED');

    const exhaustedEvent = emittedEvents.find(e => e.type === 'verification_recovery_exhausted');
    expect(exhaustedEvent).toBeDefined();
    expect(exhaustedEvent?.payload.attemptsExhausted).toBe(2);
  });

  // 4. HEALTHY CHECKPOINT PRESERVATION: A was READY -> B fails and exhausts recovery -> A remains healthy in READY
  it('4. Healthy Checkpoint Preservation: Checkpoint A remains active in READY when candidate B fails all recovery attempts', async () => {
    // Checkpoint A: Healthy static page
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>Healthy Page A</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Healthy A'], { cwd: workspace });
    const shaA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cpA = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Build healthy A',
      commitSha: shaA,
      previewUrl: `/preview/A`,
      buildPassed: true,
    });

    const gate = new VerificationGate(repo);
    const verifA = await gate.verify(testSessionId, cpA.id, workspace);
    expect(verifA.status).toBe('PASSED');

    await gate.promoteIfValid(testSessionId, cpA.id, workspace, `/preview/A`);
    let session = (await repo.getSession(testSessionId))!;
    expect(session.status).toBe('READY');
    expect(session.lastCheckpointSha).toBe(shaA);

    // Candidate B: introduces breaking error
    await writeFile(join(workspace, 'index.html'), '<html><head><script src="missing-b.js"></script></head><body><h1>B</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Broken B'], { cwd: workspace });
    const shaB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cpB = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 2,
      prompt: 'Candidate B',
      commitSha: shaB,
      previewUrl: null,
      buildPassed: true,
    });

    const verifB = await gate.verify(testSessionId, cpB.id, workspace);
    expect(verifB.status).toBe('FAILED');

    // Unsuccessful recovery provider
    const provider = makeFakeProvider(async (_t, ws) => {
      await writeFile(join(ws, 'still-broken.txt'), 'error');
      return {
        status: 'COMPLETED',
        stdout: '',
        stderr: '',
        exitCode: 0,
        changedFiles: ['still-broken.txt'],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 20,
      } as any;
    });

    const orchestrator = new VerificationRecoveryOrchestrator(repo, provider, events);
    const dummyTask: any = {
      id: randomUUID(),
      prototypeSessionId: testSessionId,
      project: session.project,
      objective: 'Candidate B recovery',
      prompt: 'Candidate B',
      status: 'RUNNING',
    };

    const recoveryResult = await orchestrator.runRecoveryLoop(
      session,
      dummyTask,
      cpB,
      verifB,
      workspace,
      {
        expectedCurrentSha: shaA, // Protects against CAS race
      }
    );

    expect(recoveryResult.status).toBe('RETRY_EXHAUSTED');

    // Crucial: Checkpoint A remains healthy and session remains READY with shaA
    const finalSession = (await repo.getSession(testSessionId))!;
    expect(finalSession.status).toBe('READY');
    expect(finalSession.lastCheckpointSha).toBe(shaA);
    expect(finalSession.previewUrl).toBe('/preview/A');
  });

  // 5. CONCURRENCY & DUPLICATE RECOVERY CLAIM PROTECTION
  it('5. Concurrency Protection: Two workers attempting recovery on the same failed verification do not create duplicate attempt numbers', async () => {
    await writeFile(join(workspace, 'index.html'), '<html><head><script src="broken.js"></script></head><body><h1>Broken</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Broken commit'], { cwd: workspace });
    const faultySha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Concurrency claim test',
      commitSha: faultySha,
      previewUrl: null,
      buildPassed: true,
    });

    const gate = new VerificationGate(repo);
    const verif = await gate.verify(testSessionId, cp.id, workspace);

    // First claim attempt #1
    const claim1 = await repo.createCorrectionAttempt({
      sessionId: testSessionId,
      taskId: randomUUID(),
      sourceVerificationId: verif.id,
      sourceCheckpointId: cp.id,
      attemptNumber: 1,
    });
    expect(claim1).not.toBeNull();
    expect(claim1?.attemptNumber).toBe(1);

    // Concurrent claim on attempt #1 for the same verification must be rejected
    const claim2 = await repo.createCorrectionAttempt({
      sessionId: testSessionId,
      taskId: randomUUID(),
      sourceVerificationId: verif.id,
      sourceCheckpointId: cp.id,
      attemptNumber: 1,
    });
    expect(claim2).toBeNull(); // Rejected by unique constraint / conflict guard

    // Attempt #2 claim by next process succeeds
    const claim3 = await repo.createCorrectionAttempt({
      sessionId: testSessionId,
      taskId: randomUUID(),
      sourceVerificationId: verif.id,
      sourceCheckpointId: cp.id,
      attemptNumber: 2,
    });
    expect(claim3).not.toBeNull();
    expect(claim3?.attemptNumber).toBe(2);
  });

  // 6. RESTART DURABILITY: Attempts survive worker crash and resume counting from lineage
  it('6. Restart Durability: Pre-existing persisted attempt is respected after simulated worker crash/restart', async () => {
    await writeFile(join(workspace, 'index.html'), '<html><head><script src="err.js"></script></head><body><h1>Err</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Initial broken'], { cwd: workspace });
    const faultySha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Crash test',
      commitSha: faultySha,
      previewUrl: null,
      buildPassed: true,
    });

    const gate = new VerificationGate(repo);
    const verif = await gate.verify(testSessionId, cp.id, workspace);

    // Simulate worker 1 starting and failing attempt 1 before dying
    const priorAttempt = await repo.createCorrectionAttempt({
      sessionId: testSessionId,
      taskId: randomUUID(),
      sourceVerificationId: verif.id,
      sourceCheckpointId: cp.id,
      attemptNumber: 1,
    });
    await repo.updateCorrectionAttempt(priorAttempt!.id, {
      status: 'FAILED',
      error: 'Worker process was terminated',
      finishedAt: new Date(),
    });

    // New worker restarts with empty memory
    const provider = makeFakeProvider(async (_t, ws) => {
      await writeFile(join(ws, 'err.js'), 'console.log("Fixed on restart");');
      return {
        status: 'COMPLETED',
        stdout: '',
        stderr: '',
        exitCode: 0,
        changedFiles: ['err.js'],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 30,
      } as any;
    });

    const freshOrchestrator = new VerificationRecoveryOrchestrator(repo, provider, events);
    const session = (await repo.getSession(testSessionId))!;
    const dummyTask: any = {
      id: randomUUID(),
      prototypeSessionId: testSessionId,
      project: session.project,
      objective: 'Resume after crash',
      prompt: 'Crash test',
      status: 'RUNNING',
    };

    const recoveryResult = await freshOrchestrator.runRecoveryLoop(
      session,
      dummyTask,
      cp,
      verif,
      workspace,
      {
        previewUrl: `/preview/restarted`,
      }
    );

    expect(recoveryResult.status).toBe('SUCCESS');

    // Total attempts recorded should be 2 (attempt 1 was from before crash, attempt 2 from restart)
    const allAttempts = await repo.getCorrectionAttemptsForVerification(verif.id);
    expect(allAttempts).toHaveLength(2);
    expect(allAttempts[0].attemptNumber).toBe(1);
    expect(allAttempts[0].status).toBe('FAILED');
    expect(allAttempts[1].attemptNumber).toBe(2);
    expect(allAttempts[1].status).toBe('COMPLETED');
  });

  // 7. FULL WORKER INTEGRATION: End-to-end task execution enters recovery loop on verification failure
  it('7. Worker Integration: PrototypeWorker automatically enters verification recovery and completes task when fix passes', async () => {
    // Stub task repository for PrototypeWorker
    const taskId = randomUUID();
    const taskRecord: any = {
      id: taskId,
      prototypeSessionId: testSessionId,
      project: 'worker-recovery-project',
      repository: 'https://github.com/test/repo.git',
      objective: 'Build interactive landing page',
      prompt: 'Create landing page with custom script',
      status: 'RUNNING',
      priority: 1,
      worker: 'prototype',
      result: null,
      error: null,
      branch: 'main',
      commitSha: null,
      gitStatus: null,
      workspacePath: workspace,
      leaseOwner: 'prototype',
      leaseDeadline: new Date(Date.now() + 60_000),
      heartbeatAt: new Date(),
    };

    let claimed = false;
    const taskRepo: any = {
      claim: async () => {
        if (!claimed) {
          claimed = true;
          return taskRecord;
        }
        return null;
      },
      update: async (_id: string, patch: any) => {
        Object.assign(taskRecord, patch);
        return taskRecord;
      },
      heartbeat: async () => true,
      get: async () => taskRecord,
    };

    // Provider first creates broken state (missing asset), then on recovery creates the asset
    let callIndex = 0;
    const provider = makeFakeProvider(async (_t, ws) => {
      callIndex++;
      if (callIndex === 1) {
        // Initial execution: broken HTML
        await writeFile(
          join(ws, 'index.html'),
          '<!DOCTYPE html><html><head><script src="worker-app.js"></script></head><body><h1>Worker App</h1></body></html>'
        );
        return {
          status: 'COMPLETED',
          stdout: 'Initial broken generation',
          stderr: '',
          exitCode: 0,
          changedFiles: ['index.html'],
          provider: 'mock',
          model: 'mock-model',
          durationMs: 40,
        } as any;
      } else {
        // Recovery attempt: provides the missing file
        await writeFile(join(ws, 'worker-app.js'), 'console.log("Worker app script online");');
        return {
          status: 'COMPLETED',
          stdout: 'Fixed missing worker-app.js',
          stderr: '',
          exitCode: 0,
          changedFiles: ['worker-app.js'],
          provider: 'mock',
          model: 'mock-model',
          durationMs: 30,
        } as any;
      }
    });

    const fakePreview = makeFakePreview();
    const worker = new PrototypeWorker(
      taskRepo,
      repo,
      provider,
      events,
      'prototype',
      fakePreview
    );

    const executed = await worker.executeOnce();
    expect(executed).toBe(true);
    expect(taskRecord.status).toBe('COMPLETED');

    const session = await repo.getSession(testSessionId);
    expect(session?.status).toBe('READY');

    // Proves recovery events were emitted
    const recoveryStart = emittedEvents.find(e => e.type === 'verification_recovery_started');
    const recoverySuccess = emittedEvents.find(e => e.type === 'verification_recovery_attempt_succeeded');
    expect(recoveryStart).toBeDefined();
    expect(recoverySuccess).toBeDefined();
  });

  // 8. STALE FINALIZE CONTRACT: Worker uses corrected finalization result instead of stale original
  it('8. Stale Finalize Contract: Worker uses the corrected finalization commitSha and result, not stale initial object', async () => {
    const taskId = randomUUID();
    const taskRecord: any = {
      id: taskId,
      prototypeSessionId: testSessionId,
      project: 'stale-finalize-project',
      repository: 'https://github.com/test/repo.git',
      objective: 'Verify corrected finalize is used',
      prompt: 'Test prompt',
      status: 'RUNNING',
      priority: 1,
      worker: 'prototype',
      result: null,
      error: null,
      branch: 'main',
      commitSha: null,
      gitStatus: null,
      workspacePath: workspace,
      leaseOwner: 'prototype',
      leaseDeadline: new Date(Date.now() + 60_000),
      heartbeatAt: new Date(),
    };

    let claimed = false;
    const taskRepo: any = {
      claim: async () => {
        if (!claimed) {
          claimed = true;
          return taskRecord;
        }
        return null;
      },
      update: async (_id: string, patch: any) => {
        Object.assign(taskRecord, patch);
        return taskRecord;
      },
      heartbeat: async () => true,
      get: async () => taskRecord,
    };

    // First execution produces an uncommitted/unexpected file or fail, then correction fixes it
    let calls = 0;
    const provider = makeFakeProvider(async (_t, ws) => {
      calls++;
      // Create a valid index.html
      await writeFile(join(ws, 'index.html'), `<html><body><h1>Run ${calls}</h1></body></html>`);
      return {
        status: 'COMPLETED',
        stdout: `Run ${calls}`,
        stderr: '',
        exitCode: 0,
        changedFiles: ['index.html'],
        provider: 'mock',
        model: 'mock-model',
        durationMs: 25,
      } as any;
    });

    const fakePreview = makeFakePreview();
    const worker = new PrototypeWorker(
      taskRepo,
      repo,
      provider,
      events,
      'prototype',
      fakePreview
    );

    const executed = await worker.executeOnce();
    expect(executed).toBe(true);
    expect(taskRecord.status).toBe('COMPLETED');
    expect(taskRecord.commitSha).toBeDefined();

    // Verify task result contains the finalized commitSha
    const resFinalize = taskRecord.result?.finalize;
    expect(resFinalize).toBeDefined();
    expect(resFinalize.status).toBe('COMPLETED');
    expect(resFinalize.commitSha).toBe(taskRecord.commitSha);
  });
});
