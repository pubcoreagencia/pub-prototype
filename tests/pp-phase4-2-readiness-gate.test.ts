import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { signAccessToken, verifyAccessToken } from '../src/pp/auth/sovereign/jwt.js';
import { SovereignSessionManager } from '../src/pp/auth/sovereign/refresh.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';
import { AuthService } from '../src/pp/auth/auth.js';
import { extractRefreshTokenFromCookie, setRefreshCookie, clearRefreshCookie, REFRESH_COOKIE_NAME } from '../src/pp/auth/http.js';
import type { Response } from 'express';

// In-memory mock PostgreSQL pool to test session lifecycle, rotation, and CAS concurrency
class MockPostgresPool {
  private sessions: Map<string, any> = new Map();
  private users: Map<string, any> = new Map();
  private workspaces: Map<string, any> = new Map();
  private members: Map<string, any> = new Map();

  async query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }> {
    const trimmed = sql.trim();

    // 1. INSERT INTO auth_sessions
    if (trimmed.startsWith('INSERT INTO auth_sessions')) {
      const [id, user_id, refresh_token_hash, user_agent, ip_address, expires_at, family_id, rotated_from] = params!;
      const row = {
        id,
        user_id,
        refresh_token_hash,
        user_agent,
        ip_address,
        expires_at,
        revoked_at: null,
        created_at: new Date(),
        last_active_at: new Date(),
        family_id,
        rotated_from,
      };
      this.sessions.set(id, row);
      return { rows: [row], rowCount: 1 };
    }

    // 2. SELECT * FROM auth_sessions WHERE refresh_token_hash = $1
    if (trimmed.includes('FROM auth_sessions WHERE refresh_token_hash = $1')) {
      const hash = params![0];
      const found = Array.from(this.sessions.values()).find(s => s.refresh_token_hash === hash);
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }

    // 3. UPDATE auth_sessions SET revoked_at = now(), last_active_at = now() WHERE id = $1 AND revoked_at IS NULL (CAS rotation)
    if (trimmed.includes('UPDATE auth_sessions SET revoked_at = now()') && trimmed.includes('WHERE id = $1 AND revoked_at IS NULL')) {
      const id = params![0];
      const sess = this.sessions.get(id);
      if (sess && sess.revoked_at === null) {
        sess.revoked_at = new Date();
        sess.last_active_at = new Date();
        return { rows: [sess], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 4. UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL
    if (trimmed.includes('WHERE family_id = $1 AND revoked_at IS NULL')) {
      const familyId = params![0];
      let count = 0;
      for (const sess of this.sessions.values()) {
        if (sess.family_id === familyId && sess.revoked_at === null) {
          sess.revoked_at = new Date();
          count++;
        }
      }
      return { rows: [], rowCount: count };
    }

    // 5. UPDATE auth_sessions SET revoked_at = now() WHERE id = $1
    if (trimmed.includes('WHERE id = $1 AND revoked_at IS NULL')) {
      const id = params![0];
      const sess = this.sessions.get(id);
      if (sess && sess.revoked_at === null) {
        sess.revoked_at = new Date();
        return { rows: [sess], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // Default empty
    return { rows: [], rowCount: 0 };
  }
}

describe('PP Phase 4.2 · Sovereign Auth Production Readiness Gate', () => {
  let mockPool: MockPostgresPool;
  let keyManager: KeyManager;
  let sessionManager: SovereignSessionManager;
  let sovereignProvider: SovereignAuthProvider;

  beforeEach(() => {
    mockPool = new MockPostgresPool();
    keyManager = new KeyManager();
    sessionManager = new SovereignSessionManager(mockPool as unknown as Pool, keyManager);
    sovereignProvider = new SovereignAuthProvider(mockPool as unknown as Pool, keyManager);
  });

  // 1. PHASE 4.2B & JWKS
  describe('Gate 1 · Cryptographic Key Management & JWKS', () => {
    it('generates a valid Ed25519 key pair with stable kid and exports compliant JWKS without private keys', () => {
      const signingKey = keyManager.getCurrentSigningKey();
      expect(signingKey.kid).toMatch(/^pp-key-/);
      expect(signingKey.publicKey.asymmetricKeyType).toBe('ed25519');

      const jwks = keyManager.getJWKS();
      expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
      const currentJwk = jwks.keys.find(k => k.kid === signingKey.kid);
      expect(currentJwk).toBeDefined();
      expect(currentJwk?.kty).toBe('OKP');
      expect(currentJwk?.crv).toBe('Ed25519');
      expect(currentJwk?.alg).toBe('EdDSA');
      expect(currentJwk?.use).toBe('sig');
      expect(currentJwk?.x).toBeDefined();

      // Zero private key exposure in JWKS
      const serialized = JSON.stringify(jwks);
      expect((jwks.keys[0] as any).d).toBeUndefined(); // 'd' parameter represents private key in OKP JWK
      expect(serialized).not.toContain('PRIVATE KEY');
    });

    it('proves key persistence from PP_AUTH_PRIVATE_KEY_PEM environment variable across restarts', () => {
      // Generate standard test Ed25519 PKCS#8 PEM
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

      const originalEnv = process.env.PP_AUTH_PRIVATE_KEY_PEM;
      try {
        process.env.PP_AUTH_PRIVATE_KEY_PEM = pem;

        // Instance 1 (before restart)
        const km1 = new KeyManager();
        const kid1 = km1.getCurrentSigningKey().kid;
        const token1 = signAccessToken(km1, { userId: 'u-persist', sessionId: 's-persist' });

        // Instance 2 (simulating process restart with same env)
        const km2 = new KeyManager();
        const kid2 = km2.getCurrentSigningKey().kid;

        expect(kid1).toBe(kid2);
        const verified = verifyAccessToken(km2, token1);
        expect(verified.valid).toBe(true);
        if (verified.valid) {
          expect(verified.claims.sub).toBe('u-persist');
        }
      } finally {
        if (originalEnv !== undefined) {
          process.env.PP_AUTH_PRIVATE_KEY_PEM = originalEnv;
        } else {
          delete process.env.PP_AUTH_PRIVATE_KEY_PEM;
        }
      }
    });
  });

  // 2. PHASE 4.2D: COOKIE CONTRACT
  describe('Gate 2 · Cookie Contract & Isolation', () => {
    it('extracts refresh token securely from Cookie header and verifies settings', () => {
      const rawHeader = 'some_cookie=abc; pp_refresh_token=rt_secret_token_12345; other=xyz';
      const extracted = extractRefreshTokenFromCookie(rawHeader);
      expect(extracted).toBe('rt_secret_token_12345');

      // Test cookie response options
      let setCookieArgs: any = null;
      const mockRes: Partial<Response> = {
        cookie: (name: string, val: string, options: any) => {
          setCookieArgs = { name, val, options };
          return mockRes as any;
        },
      };

      setRefreshCookie(mockRes as Response, 'rt_secret_token_12345');
      expect(setCookieArgs.name).toBe(REFRESH_COOKIE_NAME);
      expect(setCookieArgs.val).toBe('rt_secret_token_12345');
      expect(setCookieArgs.options.httpOnly).toBe(true);
      expect(setCookieArgs.options.sameSite).toBe('lax');
      expect(setCookieArgs.options.path).toBe('/prototype/auth');
    });
  });

  // 3. PHASE 4.2E, 4.2F, 4.2G: SESSION LIFECYCLE, ROTATION, REUSE, CONCURRENCY & REVOCATION
  describe('Gate 3 · Session Lifecycle, Rotation, Concurrency & Revocation', () => {
    it('executes atomic refresh rotation: invalidates old refresh token and issues new pair', async () => {
      const issued = await sessionManager.createSession({ userId: 'user-001' });
      expect(issued.refreshToken).toMatch(/^rt_/);
      expect(issued.accessToken).toBeDefined();

      const rotated = await sessionManager.rotateRefreshToken(issued.refreshToken);
      expect(rotated.success).toBe(true);
      expect(rotated.tokens).toBeDefined();
      expect(rotated.tokens?.refreshToken).not.toBe(issued.refreshToken);

      // Verifies old refresh token is rejected as reuse
      const reuseAttempt = await sessionManager.rotateRefreshToken(issued.refreshToken);
      expect(reuseAttempt.success).toBe(false);
      expect(reuseAttempt.error).toBe('REUSE_DETECTED');
    });

    it('handles high concurrency (5 simultaneous refresh requests): exactly 1 succeeds, remaining safely rejected', async () => {
      const initial = await sessionManager.createSession({ userId: 'user-concurrent' });

      // Fire 5 simultaneous rotateRefreshToken calls with the same token
      const promises = [
        sessionManager.rotateRefreshToken(initial.refreshToken),
        sessionManager.rotateRefreshToken(initial.refreshToken),
        sessionManager.rotateRefreshToken(initial.refreshToken),
        sessionManager.rotateRefreshToken(initial.refreshToken),
        sessionManager.rotateRefreshToken(initial.refreshToken),
      ];

      const results = await Promise.all(promises);
      const successes = results.filter(r => r.success);
      const failures = results.filter(r => !r.success);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(4);
      failures.forEach(f => {
        expect(['REUSE_DETECTED', 'NOT_FOUND']).toContain(f.error);
      });
    });

    it('revokes session on logout and prevents subsequent refresh recovery', async () => {
      const session = await sessionManager.createSession({ userId: 'user-logout' });
      expect(session.sessionId).toBeDefined();

      // Logout / Revoke
      await sessionManager.revokeSession(session.sessionId);

      // Attempt to refresh
      const refreshResult = await sessionManager.rotateRefreshToken(session.refreshToken);
      expect(refreshResult.success).toBe(false);
      expect(refreshResult.error).toBe('REUSE_DETECTED'); // Revoked token presentation treated as family invalidation
    });
  });

  // 4. PHASE 4.2H: RESTART SURVIVAL (DATABASE PERSISTENCE)
  describe('Gate 4 · Process Restart Survival', () => {
    it('persists session in database pool so a new process instance can rotate the session seamlessly', async () => {
      // Process 1: issue session
      const issued = await sessionManager.createSession({ userId: 'user-restart-test' });
      const refreshToken = issued.refreshToken;

      // Simulate process crash / restart: instantiate brand new session manager with new memory space
      const newProcessKeyManager = new KeyManager();
      const newProcessSessionManager = new SovereignSessionManager(mockPool as unknown as Pool, newProcessKeyManager);

      // Process 2: rotates session using the persisted database record
      const rotated = await newProcessSessionManager.rotateRefreshToken(refreshToken);
      expect(rotated.success).toBe(true);
      expect(rotated.tokens?.accessToken).toBeDefined();

      // Verify claims on new access token
      const claims = verifyAccessToken(newProcessKeyManager, rotated.tokens!.accessToken);
      expect(claims.valid).toBe(true);
      if (claims.valid) {
        expect(claims.claims.sub).toBe('user-restart-test');
      }
    });
  });

  // 5. PHASE 4.2I & 4.2J: WORKSPACE ISOLATION & DYNAMIC RBAC
  describe('Gate 5 · Multi-Tenant Workspace Isolation & Dynamic RBAC', () => {
    it('strictly enforces workspace isolation and dynamic RBAC from database truth', async () => {
      const mockProtoRepo: any = {
        getWorkspace: vi.fn(async (id: string) => {
          if (id === 'ws-alpha') return { id: 'ws-alpha', ownerId: 'user-alpha' };
          if (id === 'ws-beta') return { id: 'ws-beta', ownerId: 'user-beta' };
          return null;
        }),
        getWorkspaceMembership: vi.fn(async (userId: string, workspaceId: string) => {
          if (workspaceId === 'ws-alpha' && userId === 'user-alpha') return { role: 'OWNER' };
          if (workspaceId === 'ws-alpha' && userId === 'user-member') return { role: 'MEMBER' };
          if (workspaceId === 'ws-alpha' && userId === 'user-viewer') return { role: 'VIEWER' };
          return null; // All others denied
        }),
      };

      const authService = new AuthService(mockProtoRepo);

      // User Alpha in Workspace Alpha -> ALLOW OWNER
      expect(await authService.authorizeWorkspace('user-alpha', 'ws-alpha')).toBe('OWNER');

      // User Alpha in Workspace Beta -> DENY null
      expect(await authService.authorizeWorkspace('user-alpha', 'ws-beta')).toBeNull();

      // User Member in Workspace Alpha -> MEMBER
      expect(await authService.authorizeWorkspace('user-member', 'ws-alpha')).toBe('MEMBER');

      // User Viewer in Workspace Alpha -> VIEWER
      expect(await authService.authorizeWorkspace('user-viewer', 'ws-alpha')).toBe('VIEWER');

      // Role hierarchy checks
      expect(authService.hasRole('OWNER', 'ADMIN')).toBe(true);
      expect(authService.hasRole('MEMBER', 'ADMIN')).toBe(false);
      expect(authService.hasRole('VIEWER', 'MEMBER')).toBe(false);
      expect(authService.hasRole('VIEWER', 'VIEWER')).toBe(true);
    });
  });
});
