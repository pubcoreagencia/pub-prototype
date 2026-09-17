import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { signAccessToken } from '../src/pp/auth/sovereign/jwt.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';
import { getAuthProvider } from '../src/pp/auth/factory.js';
import { AuthService } from '../src/pp/auth/auth.js';
import { createPpApp } from '../src/pp/api/entry.js';
import http from 'node:http';

describe('Dual / Composite Auth Verification (Phase 4.4.2 Parallel Operation)', () => {
  let protoRepo: PostgresPrototypeRepository;
  let keyManager: KeyManager;
  let app: any;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    protoRepo = new PostgresPrototypeRepository();
    await protoRepo.initializeSchema();
    keyManager = new KeyManager();

    // Default factory creates CompositeAuthProvider when AUTH_PROVIDER is supabase (or unset)
    const authProvider = getAuthProvider({ pool: (protoRepo as any).pool, keyManager });
    const authService = new AuthService(protoRepo, authProvider);

    app = createPpApp((protoRepo as any).pool, undefined, protoRepo, undefined, keyManager);

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

  it('verifies a Sovereign Ed25519 JWT through AuthService when AUTH_PROVIDER is supabase', async () => {
    const authProvider = getAuthProvider({ pool: (protoRepo as any).pool, keyManager });
    const authService = new AuthService(protoRepo, authProvider);

    const sovereignToken = signAccessToken(keyManager, {
      userId: 'a3b90f42-45e6-42bc-86db-589cf24a0d9b',
      sessionId: 'sess-dual-auth-1',
    });

    const user = await authService.verifyToken(`Bearer ${sovereignToken}`);
    expect(user).not.toBeNull();
    expect(user?.id).toBe('a3b90f42-45e6-42bc-86db-589cf24a0d9b');
  });

  it('allows a Sovereign-authenticated user to post prompts to a session in their workspace', async () => {
    const sovereignUserId = 'a3b90f42-45e6-42bc-86db-589cf24a0d9b';
    const sovereignToken = signAccessToken(keyManager, {
      userId: sovereignUserId,
      sessionId: 'sess-dual-auth-2',
    });

    // Create workspace owned by the Sovereign user
    const ws = await protoRepo.createWorkspace({
      name: 'Fixture Workspace',
      ownerId: sovereignUserId,
    });

    // Create project and session
    const project = await protoRepo.createProject({
      workspaceId: ws.id,
      name: 'Fixture Project',
    });

    const session = await protoRepo.createSession({
      workspaceId: ws.id,
      projectId: project.id,
      project: project.name,
      repository: 'test/repo',
      branch: 'main',
    });

    // Send POST /prototype/sessions/:id/prompts with Sovereign JWT
    const res = await fetch(`${baseUrl}/prototype/sessions/${session.id}/prompts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${sovereignToken}`,
      },
      body: JSON.stringify({ prompt: 'Generate landing page' }),
    });

    // Must NOT be 401 Unauthorized, returns 202 Accepted
    expect(res.status).not.toBe(401);
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.mode).toBe('PROTOTYPE');
    expect(data.task.objective).toBe('Prototype MVP iteration');
  });

  it('strictly rejects invalid or tampered Sovereign JWT with 401', async () => {
    const res = await fetch(`${baseUrl}/prototype/sessions/any-session/prompts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer eyJhbGciOiJFZERTQSI...tampered.jwt',
      },
      body: JSON.stringify({ prompt: 'malicious prompt' }),
    });

    expect(res.status).toBe(401);
    const err = await res.json();
    expect(err.error).toBe('Unauthorized: Invalid or expired authentication token');
  });
});
