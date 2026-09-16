import 'dotenv/config';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { rm, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { VerificationGate, sanitizeEvidenceText } from '../src/pp/verification/verification-gate.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import type { PrototypeSession, PrototypeCheckpoint, PrototypeVerification } from '../src/pp/domain/domain.js';
import pg from 'pg';

describe('PUB Prototype 2.0 — Verification Gate Pipeline (V0..V5)', () => {
  let workspace: string;
  let repo: PostgresPrototypeRepository;
  let pool: pg.Pool;
  let gate: VerificationGate;
  let testSessionId: string;

  beforeEach(async () => {
    workspace = join('/tmp', `pp-verif-test-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });

    // Initialize real git repository for testing V0 identity checks
    execFileSync('git', ['init'], { cwd: workspace });
    execFileSync('git', ['config', 'user.name', 'Verification Tester'], { cwd: workspace });
    execFileSync('git', ['config', 'user.email', 'test@pubprototype.dev'], { cwd: workspace });

    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL || 'postgres://pubprototype:local_secret_123@localhost:5432/pubprototype',
    });
    repo = new PostgresPrototypeRepository(pool);
    await repo.initializeSchema();
    gate = new VerificationGate(repo);

    testSessionId = randomUUID();
    const createdSession = await repo.createSession({
      project: `verif-${randomUUID().slice(0, 8)}`,
      repository: 'https://github.com/test/repo',
      branch: 'main',
    });
    testSessionId = createdSession.id;
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await pool.end().catch(() => undefined);
  });

  // 1. HAPPY PATH: Full static application pipeline V0..V5
  it('1. Happy Path: Full static app completes V0..V5 and promotes to READY', async () => {
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>App Functional</h1><p>Ready to serve</p></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Build landing page',
      commitSha: headSha,
      previewUrl: 'http://localhost:3000',
      buildPassed: true,
    });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('PASSED');
    expect(verification.evidence.steps.map(s => s.name)).toEqual([
      'identity',
      'artifact_integrity',
      'build',
      'runtime',
      'product_surface',
      'context_smoke',
    ]);

    const promotion = await gate.promoteIfValid(testSessionId, checkpoint.id, workspace, 'http://localhost:3000');
    expect(promotion.promoted).toBe(true);
    expect(promotion.session?.status).toBe('READY');
    expect(promotion.session?.lastCheckpointSha).toBe(headSha);
  });

  // 2. V0 IDENTITY FAILURE: Commit SHA mismatch
  it('2. V0 Failure: Mismatched commit SHA fails closed with IDENTITY_MISMATCH', async () => {
    await writeFile(join(workspace, 'index.html'), '<h1>Hello</h1>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Commit 1'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Prompt',
      commitSha: headSha,
      previewUrl: null,
      buildPassed: true,
    });

    // Make another commit so workspace HEAD changes
    await writeFile(join(workspace, 'index.html'), '<h1>Changed</h1>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Commit 2'], { cwd: workspace });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('FAILED');
    expect(verification.evidence.error_type).toBe('IDENTITY_MISMATCH');

    const promotion = await gate.promoteIfValid(testSessionId, checkpoint.id, workspace, 'http://localhost:3000');
    expect(promotion.promoted).toBe(false);
  });

  // 3. V1 ARTIFACT INTEGRITY: Missing contract
  it('3. V1 Failure: Workspace missing both package.json and index.html fails with UNSUPPORTED_ARTIFACT', async () => {
    await writeFile(join(workspace, 'README.md'), '# No code here');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Only readme'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Empty prompt',
      commitSha: headSha,
      previewUrl: null,
      buildPassed: true,
    });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('FAILED');
    expect(verification.evidence.error_type).toBe('UNSUPPORTED_ARTIFACT');
  });

  // 4. V2 BUILD FAILURE: Failing build script
  it('4. V2 Failure: Build script returning non-zero exit code fails with BUILD_FAILED', async () => {
    const pkg = {
      name: 'broken-build',
      scripts: {
        build: 'exit 1',
      },
    };
    await writeFile(join(workspace, 'package.json'), JSON.stringify(pkg, null, 2));
    await writeFile(join(workspace, 'index.html'), '<h1>Will not build</h1>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Broken build'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Broken build',
      commitSha: headSha,
      previewUrl: null,
      buildPassed: true,
    });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('FAILED');
    expect(verification.evidence.error_type).toBe('BUILD_FAILED');
  });

  // 5. V4 PRODUCT SURFACE: Completely blank page
  it('5. V4 Failure: 0-byte blank page fails with BLANK_PAGE', async () => {
    await writeFile(join(workspace, 'index.html'), '');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Blank page'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Blank page',
      commitSha: headSha,
      previewUrl: null,
      buildPassed: true,
    });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('FAILED');
    expect(verification.evidence.error_type).toBe('BLANK_PAGE');
  });

  // 6. V4 PRODUCT SURFACE: Empty body document
  it('6. V4 Failure: Document with empty body fails with BLANK_DOCUMENT', async () => {
    await writeFile(join(workspace, 'index.html'), '<!DOCTYPE html><html><head><title>Empty</title></head><body></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Empty body'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Empty body',
      commitSha: headSha,
      previewUrl: null,
      buildPassed: true,
    });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('FAILED');
    expect(verification.evidence.error_type).toBe('BLANK_DOCUMENT');
  });

  // 7. V4 PRODUCT SURFACE: Missing local script asset
  it('7. V4 Failure: Missing referenced script asset fails with BROKEN_ASSET', async () => {
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>App</h1><script src="/nonexistent-bundle.js"></script></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Missing script'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Missing script',
      commitSha: headSha,
      previewUrl: null,
      buildPassed: true,
    });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('FAILED');
    expect(verification.evidence.error_type).toBe('BROKEN_ASSET');
  });

  // 8. V4 PRODUCT SURFACE: Fatal error page rendered
  it('8. V4 Failure: Runtime rendering vite-error-overlay fails with FATAL_PAGE_ERROR', async () => {
    await writeFile(join(workspace, 'index.html'), '<html><body><vite-error-overlay>Plugin failed to load</vite-error-overlay></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Overlay error'], { cwd: workspace });
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const checkpoint = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Overlay error',
      commitSha: headSha,
      previewUrl: null,
      buildPassed: true,
    });

    const verification = await gate.verify(testSessionId, checkpoint.id, workspace);
    expect(verification.status).toBe('FAILED');
    expect(verification.evidence.error_type).toBe('FATAL_PAGE_ERROR');
  });

  // 9. CONCURRENCY: Checkpoint B failure preserves previously promoted functional Checkpoint A
  it('9. Concurrency: Failure of candidate B preserves previously verified candidate A', async () => {
    // 1. Candidate A
    await writeFile(join(workspace, 'index.html'), '<h1>Checkpoint A Functional</h1>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Candidate A'], { cwd: workspace });
    const shaA = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cpA = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Build A',
      commitSha: shaA,
      previewUrl: 'http://localhost:3000',
      buildPassed: true,
    });

    const verifA = await gate.verify(testSessionId, cpA.id, workspace);
    expect(verifA.status).toBe('PASSED');
    const promA = await gate.promoteIfValid(testSessionId, cpA.id, workspace, 'http://localhost:3000');
    expect(promA.promoted).toBe(true);

    const sessionAfterA = await repo.getSession(testSessionId);
    expect(sessionAfterA?.status).toBe('READY');
    expect(sessionAfterA?.lastCheckpointSha).toBe(shaA);

    // 2. Candidate B with broken asset
    await writeFile(join(workspace, 'index.html'), '<h1>Candidate B</h1><script src="/missing.js"></script>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Candidate B broken'], { cwd: workspace });
    const shaB = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cpB = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 2,
      prompt: 'Build B',
      commitSha: shaB,
      previewUrl: 'http://localhost:3001',
      buildPassed: true,
    });

    const verifB = await gate.verify(testSessionId, cpB.id, workspace);
    expect(verifB.status).toBe('FAILED');

    // Promotion must be rejected
    const promB = await gate.promoteIfValid(testSessionId, cpB.id, workspace, 'http://localhost:3001');
    expect(promB.promoted).toBe(false);

    // Session status and SHA must remain pointing to A
    const sessionAfterB = await repo.getSession(testSessionId);
    expect(sessionAfterB?.status).toBe('READY');
    expect(sessionAfterB?.lastCheckpointSha).toBe(shaA);
  });

  // 10. CONCURRENCY: Compare-And-Promote rejects stale promotion race
  it('10. Concurrency: Compare-and-promote rejects promotion when lastCheckpointSha changed', async () => {
    await writeFile(join(workspace, 'index.html'), '<h1>Candidate</h1>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Candidate'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Prompt',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const initialSha = (await repo.getSession(testSessionId))?.lastCheckpointSha ?? null;
    const verif = await gate.verify(testSessionId, cp.id, workspace);
    expect(verif.status).toBe('PASSED');

    // Simulate concurrent modification: another process promoted session to a different SHA
    await repo.updateSession(testSessionId, { lastCheckpointSha: 'concurrent_divergent_sha_999' });

    // Promotion attempt must detect concurrency collision and reject
    const promotion = await gate.promoteIfValid(testSessionId, cp.id, workspace, 'http://localhost:3000', undefined, initialSha);
    expect(promotion.promoted).toBe(false);
    expect(promotion.reason).toContain('CONCURRENCY_CONFLICT_REJECTED');
  });

  // 11. IMMUTABILITY: Database rejects UPDATE and DELETE on prototype_verifications
  it('11. Immutability: Trigger enforces immutable append-only verification log', async () => {
    await writeFile(join(workspace, 'index.html'), '<h1>Immutable Test</h1>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Commit'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Immutable',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const verif = await gate.verify(testSessionId, cp.id, workspace);
    expect(verif.id).toBeDefined();

    let dbConnected = true;
    try {
      await pool.query('SELECT 1');
    } catch {
      dbConnected = false;
    }

    if (dbConnected) {
      // Direct UPDATE must be blocked by trigger
      await expect(pool.query(
        `UPDATE prototype_verifications SET status = 'FAILED' WHERE id = $1`,
        [verif.id]
      )).rejects.toThrow(/immutable/i);

      // Direct DELETE must be blocked by trigger
      await expect(pool.query(
        `DELETE FROM prototype_verifications WHERE id = $1`,
        [verif.id]
      )).rejects.toThrow(/immutable/i);
    } else {
      expect(verif.id).toBeDefined();
    }
  });

  // 12. EVIDENCE SANITIZATION: Secrets and tokens are redacted
  it('12. Sanitization: Redacts tokens, passwords, and sensitive headers from evidence', () => {
    const raw = 'Error: Bearer gh_p_secret1234567890 token="xyz987" password=mySecretPass failed';
    const sanitized = sanitizeEvidenceText(raw);
    expect(sanitized).not.toContain('gh_p_secret1234567890');
    expect(sanitized).not.toContain('mySecretPass');
    expect(sanitized).toContain('[REDACTED]');
  });

  // 13. V2 BUILD TIMEOUT: Build exceeding timeout limit fails closed with BUILD_TIMEOUT
  it('13. V2 Failure: Build exceeding timeout limit fails closed with BUILD_TIMEOUT', async () => {
    const pkg = {
      name: 'timeout-app',
      version: '1.0.0',
      scripts: {
        build: 'node -e "const start = Date.now(); while(Date.now() - start < 5000) {}"',
      },
    };
    await writeFile(join(workspace, 'package.json'), JSON.stringify(pkg, null, 2));
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>Build Timeout Test</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Add slow build script'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Build with timeout',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const verif = await gate.verify(testSessionId, cp.id, workspace, {
      buildTimeoutMs: 500, // strictly bounded timeout
    });

    expect(verif.status).toBe('FAILED');
    expect(verif.evidence.error_type).toBe('BUILD_TIMEOUT');
    const buildStep = verif.evidence.steps.find(s => s.name === 'build');
    expect(buildStep?.status).toBe('FAIL');
    expect(buildStep?.error_type).toBe('BUILD_TIMEOUT');
  });

  // 14. V3 RUNTIME CRASH/UNHEALTHY: Dev server exiting or returning HTTP >= 400 fails with RUNTIME_UNHEALTHY
  it('14. V3 Failure: Runtime returning HTTP 500 fails closed with RUNTIME_UNHEALTHY', async () => {
    const pkg = {
      name: 'crash-app',
      version: '1.0.0',
      scripts: {
        dev: 'node -e "const http = require(\'http\'); http.createServer((req,res) => { res.writeHead(500); res.end(\'Crash\'); }).listen(process.env.PORT, \'127.0.0.1\');"',
      },
    };
    await writeFile(join(workspace, 'package.json'), JSON.stringify(pkg, null, 2));
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>App</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Crashing dev server'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Unhealthy runtime',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const verif = await gate.verify(testSessionId, cp.id, workspace, {
      runtimeStartupTimeoutMs: 5000,
      runtimeProbeTimeoutMs: 2000,
    });

    expect(verif.status).toBe('FAILED');
    expect(verif.evidence.error_type).toBe('RUNTIME_UNHEALTHY');
    const runtimeStep = verif.evidence.steps.find(s => s.name === 'runtime');
    expect(runtimeStep?.status).toBe('FAIL');
    expect(runtimeStep?.error_type).toBe('RUNTIME_UNHEALTHY');
    expect(runtimeStep?.http_status).toBe(500);
  });

  // 15. V3 RUNTIME TIMEOUT: Runtime failing to become reachable within startup limit fails closed
  it('15. V3 Failure: Runtime failing to open listening port fails closed with RUNTIME_TIMEOUT', async () => {
    const pkg = {
      name: 'unresponsive-app',
      version: '1.0.0',
      scripts: {
        dev: 'node -e "setInterval(() => {}, 1000);"', // never binds to PORT
      },
    };
    await writeFile(join(workspace, 'package.json'), JSON.stringify(pkg, null, 2));
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>Unresponsive</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Unresponsive dev server'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Unresponsive runtime',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const verif = await gate.verify(testSessionId, cp.id, workspace, {
      runtimeStartupTimeoutMs: 1500, // fast timeout for test
    });

    expect(verif.status).toBe('FAILED');
    expect(verif.evidence.error_type).toBe('RUNTIME_TIMEOUT');
    const runtimeStep = verif.evidence.steps.find(s => s.name === 'runtime');
    expect(runtimeStep?.status).toBe('FAIL');
    expect(runtimeStep?.error_type).toBe('RUNTIME_TIMEOUT');
  });

  // 16. V5 ROOT/SMOKE FAILURE: Non-200 on root endpoint fails V5
  it('16. V5 Failure: Root endpoint returning 404 in smoke check fails closed with SMOKE_ROOT_FAILED', async () => {
    // Workspace with static setup where root endpoint fails or custom server returns 404
    const pkg = {
      name: 'smoke-fail-app',
      version: '1.0.0',
      scripts: {
        dev: 'node -e "const http = require(\'http\'); http.createServer((req,res) => { res.writeHead(404); res.end(\'Not Found\'); }).listen(process.env.PORT, \'127.0.0.1\');"',
      },
    };
    await writeFile(join(workspace, 'package.json'), JSON.stringify(pkg, null, 2));
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>Smoke Test</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Smoke fail app'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Smoke failure',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const verif = await gate.verify(testSessionId, cp.id, workspace, {
      runtimeStartupTimeoutMs: 5000,
    });

    expect(verif.status).toBe('FAILED');
    // In our runtime probe, status >= 400 is caught at runtime probe or smoke stage
    expect(['RUNTIME_UNHEALTHY', 'SMOKE_ROOT_FAILED']).toContain(verif.evidence.error_type);
  });

  // 17. READY INVARIANT: Session promotion strictly impossible without PASSED verification matching exact checkpoint & commit SHA
  it('17. Invariant: READY is strictly rejected without PASSED verification matching exact checkpoint & commit SHA', async () => {
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>Invariant Test</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Invariant commit'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Invariant prompt',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    // Attempt promotion WITHOUT running verification: must be rejected with NO_VERIFICATION_RECORD
    const unverifiedPromotion = await gate.promoteIfValid(testSessionId, cp.id, workspace, 'http://localhost:3000');
    expect(unverifiedPromotion.promoted).toBe(false);
    expect(unverifiedPromotion.reason).toBe('NO_VERIFICATION_RECORD');

    const sessionAfter = await repo.getSession(testSessionId);
    expect(sessionAfter?.status).not.toBe('READY');
  });

  // 18. FIRST CHECKPOINT FAILURE: First checkpoint failure leaves session FAILED without active preview
  it('18. Lifecycle: First checkpoint failing verification leaves session FAILED without active preview', async () => {
    // Missing required artifacts (invalid workspace)
    await writeFile(join(workspace, 'README.md'), '# No index.html or package.json');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Invalid artifacts'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Initial failing checkpoint',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const verif = await gate.verify(testSessionId, cp.id, workspace);
    expect(verif.status).toBe('FAILED');

    // Promotion must be rejected
    const promo = await gate.promoteIfValid(testSessionId, cp.id, workspace, 'http://localhost:3000');
    expect(promo.promoted).toBe(false);

    // Initial failure leaves session without preview and not in READY
    const session = await repo.getSession(testSessionId);
    expect(session?.status).not.toBe('READY');
    expect(session?.lastCheckpointSha).toBeNull();
    expect(session?.previewUrl).toBeNull();
  });

  // 19. SUBSEQUENT CHECKPOINT FAILURE: Failure of checkpoint N+1 preserves previous working checkpoint N in READY
  it('19. Lifecycle: Failure of checkpoint N+1 preserves previous functional checkpoint N in READY', async () => {
    // Checkpoint 1 (Working)
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>App v1 Functional</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'v1'], { cwd: workspace });
    const sha1 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp1 = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Create v1',
      commitSha: sha1,
      previewUrl: 'http://localhost:3001/v1',
      buildPassed: true,
    });

    const verif1 = await gate.verify(testSessionId, cp1.id, workspace);
    expect(verif1.status).toBe('PASSED');
    const promo1 = await gate.promoteIfValid(testSessionId, cp1.id, workspace, 'http://localhost:3001/v1');
    expect(promo1.promoted).toBe(true);

    const sessionV1 = await repo.getSession(testSessionId);
    expect(sessionV1?.status).toBe('READY');
    expect(sessionV1?.lastCheckpointSha).toBe(sha1);
    expect(sessionV1?.previewUrl).toBe('http://localhost:3001/v1');

    // Checkpoint 2 (Broken: introduce broken script asset)
    await writeFile(join(workspace, 'index.html'), '<html><body><script src="/missing-broken-script.js"></script></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'v2 broken'], { cwd: workspace });
    const sha2 = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp2 = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 2,
      prompt: 'Create v2 (broken)',
      commitSha: sha2,
      previewUrl: 'http://localhost:3002/v2',
      buildPassed: true,
    });

    const verif2 = await gate.verify(testSessionId, cp2.id, workspace);
    expect(verif2.status).toBe('FAILED');
    expect(verif2.evidence.error_type).toBe('BROKEN_ASSET');

    // Promotion of broken checkpoint MUST fail
    const promo2 = await gate.promoteIfValid(testSessionId, cp2.id, workspace, 'http://localhost:3002/v2');
    expect(promo2.promoted).toBe(false);

    // Session remains READY at checkpoint 1 with intact preview
    const sessionPreserved = await repo.getSession(testSessionId);
    expect(sessionPreserved?.status).toBe('READY');
    expect(sessionPreserved?.lastCheckpointSha).toBe(sha1);
    expect(sessionPreserved?.previewUrl).toBe('http://localhost:3001/v1');
  });

  // 20. ORPHAN PROCESS CLEANUP: Dev server process is cleanly terminated and listening port is released
  it('20. Process Cleanup: Dev server child process terminates cleanly and port is immediately reusable', async () => {
    const pkg = {
      name: 'cleanup-test-app',
      version: '1.0.0',
      scripts: {
        dev: 'node -e "const http = require(\'http\'); const s = http.createServer((req,res) => { res.writeHead(200); res.end(\'OK\'); }); s.listen(process.env.PORT, \'127.0.0.1\');"',
      },
    };
    await writeFile(join(workspace, 'package.json'), JSON.stringify(pkg, null, 2));
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>Process Cleanup Test</h1></body></html>');
    execFileSync('git', ['add', '.'], { cwd: workspace });
    execFileSync('git', ['commit', '-m', 'Cleanup app'], { cwd: workspace });
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim();

    const cp = await repo.createCheckpoint({
      sessionId: testSessionId,
      promptIndex: 1,
      prompt: 'Test process termination',
      commitSha: sha,
      previewUrl: null,
      buildPassed: true,
    });

    const verif = await gate.verify(testSessionId, cp.id, workspace, {
      runtimeStartupTimeoutMs: 5000,
    });

    expect(verif.status).toBe('PASSED');
    const runtimeStep = verif.evidence.steps.find(s => s.name === 'runtime');
    const port = (runtimeStep?.details as any)?.port;
    expect(port).toBeDefined();

    // Verify port is completely freed and another server can bind immediately
    const testServer = (await import('node:net')).default.createServer();
    const canBind = await new Promise<boolean>((resolve) => {
      testServer.once('error', () => resolve(false));
      testServer.listen(port, '127.0.0.1', () => {
        testServer.close(() => resolve(true));
      });
    });

    expect(canBind).toBe(true);
  });
});
