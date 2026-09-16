import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createSovereignAuthRouter, normalizeEmail, validatePassword, extractRefreshTokenFromCookie } from '../src/pp/auth/http.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';
import { hashPassword } from '../src/pp/auth/sovereign/password.js';
import { signAccessToken, verifyAccessToken } from '../src/pp/auth/sovereign/jwt.js';

describe('PP Sovereign Auth — HTTP Contract (Phase 3)', () => {
  let mockUsers: any[];
  let mockSessions: any[];
  let mockMemberships: any[];
  let mockWorkspaces: any[];
  let mockPool: any;
  let keyManager: KeyManager;
  let sovereignProvider: SovereignAuthProvider;
  let app: express.Express;

  beforeEach(async () => {
    mockUsers = [];
    mockSessions = [];
    mockMemberships = [];
    mockWorkspaces = [];
    keyManager = new KeyManager();

    mockPool = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        const s = sql.trim();

        // 1. SELECT users WHERE email = $1
        if (s.includes('FROM users WHERE email = $1')) {
          const u = mockUsers.find(x => x.email === params[0]);
          return { rows: u ? [u] : [] };
        }

        // 2. SELECT users WHERE id = $1
        if (s.includes('FROM users WHERE id = $1')) {
          const u = mockUsers.find(x => x.id === params[0]);
          return { rows: u ? [u] : [] };
        }

        // 3. INSERT INTO users
        if (s.startsWith('INSERT INTO users')) {
          const newUser = {
            id: 'u-' + Math.random().toString(36).slice(2, 9),
            email: params[0],
            name: params[1],
            password_hash: params[2],
            status: 'ACTIVE',
            created_at: new Date(),
            updated_at: new Date(),
          };
          mockUsers.push(newUser);
          return { rows: [newUser] };
        }

        // 4. INSERT INTO auth_sessions
        if (s.startsWith('INSERT INTO auth_sessions')) {
          const newSession = {
            id: params[0],
            user_id: params[1],
            refresh_token_hash: params[2],
            user_agent: params[3],
            ip_address: params[4],
            expires_at: params[5],
            revoked_at: null,
            created_at: new Date(),
            last_active_at: new Date(),
            family_id: params[6],
            rotated_from: params[7],
          };
          mockSessions.push(newSession);
          return { rows: [newSession] };
        }

        // 5. SELECT * FROM auth_sessions WHERE refresh_token_hash = $1
        if (s.includes('FROM auth_sessions WHERE refresh_token_hash = $1')) {
          const found = mockSessions.find(x => x.refresh_token_hash === params[0]);
          return { rows: found ? [found] : [] };
        }

        // 6. SELECT user_id FROM auth_sessions WHERE id = $1
        if (s.includes('FROM auth_sessions WHERE id = $1')) {
          const found = mockSessions.find(x => x.id === params[0]);
          return { rows: found ? [found] : [] };
        }

        // 7. UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
        if (s.includes('UPDATE auth_sessions SET revoked_at') && s.includes('WHERE id = $1 AND revoked_at IS NULL')) {
          const sess = mockSessions.find(x => x.id === params[0] && x.revoked_at === null);
          if (sess) {
            sess.revoked_at = new Date();
            return { rowCount: 1, rows: [sess] };
          }
          return { rowCount: 0, rows: [] };
        }

        // 8. UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1
        if (s.includes('UPDATE auth_sessions SET revoked_at') && s.includes('WHERE family_id = $1')) {
          let count = 0;
          for (const sess of mockSessions) {
            if (sess.family_id === params[0] && sess.revoked_at === null) {
              sess.revoked_at = new Date();
              count++;
            }
          }
          return { rowCount: count, rows: [] };
        }

        // 9. SELECT workspace_members
        if (s.includes('FROM workspace_members wm')) {
          const userId = params[0];
          const members = mockMemberships.filter(m => m.user_id === userId);
          const rows = members.map(m => {
            const w = mockWorkspaces.find(x => x.id === m.workspace_id) || {};
            return {
              workspace_id: m.workspace_id,
              role: m.role,
              workspace_name: w.name || 'Test Workspace',
              workspace_slug: w.slug || 'test-ws',
            };
          });
          return { rows };
        }

        return { rows: [] };
      }),
    };

    sovereignProvider = new SovereignAuthProvider(mockPool, keyManager);

    app = express();
    app.use(express.json());
    const router = createSovereignAuthRouter({
      pool: mockPool,
      sovereignProvider,
      keyManager,
    });
    app.use('/prototype/auth', router);
  });

  // Helper for supertest-like invocation using node fetch via express server
  async function makeRequest(path: string, options: { method: string; body?: any; headers?: Record<string, string> }) {
    return new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address() as any;
          const url = `http://127.0.0.1:${addr.port}${path}`;
          const headers: Record<string, string> = {
            'content-type': 'application/json',
            ...(options.headers || {}),
          };

          const res = await fetch(url, {
            method: options.method,
            headers,
            body: options.body ? JSON.stringify(options.body) : undefined,
          });

          const rawText = await res.text();
          let jsonBody: any = null;
          try {
            jsonBody = JSON.parse(rawText);
          } catch {
            jsonBody = rawText;
          }

          const resHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            resHeaders[k.toLowerCase()] = v;
          });

          resolve({ status: res.status, body: jsonBody, headers: resHeaders });
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
  }

  describe('1. Signup Endpoint (POST /prototype/auth/signup)', () => {
    it('successfully creates an account, returns access token, sets HttpOnly refresh cookie', async () => {
      const res = await makeRequest('/prototype/auth/signup', {
        method: 'POST',
        body: { email: 'NewUser@PubPrototype.com', password: 'ValidPassword123!', name: 'New User' },
      });

      expect(res.status).toBe(201);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.tokenType).toBe('Bearer');
      expect(res.body.user.email).toBe('newuser@pubprototype.com');
      expect(res.body.user.name).toBe('New User');
      expect(res.body.user.password_hash).toBeUndefined(); // never expose hash
      expect(res.body.refreshToken).toBeUndefined(); // never expose in body

      // Cookie check
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('pp_refresh_token=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Lax');
      expect(setCookie).toContain('Path=/prototype/auth');

      // Check DB
      expect(mockUsers.length).toBe(1);
      expect(mockUsers[0].email).toBe('newuser@pubprototype.com');
      expect(mockUsers[0].password_hash).not.toBe('ValidPassword123!');
      expect(mockSessions.length).toBe(1);
    });

    it('rejects duplicate accounts with 409 ACCOUNT_EXISTS without revealing details', async () => {
      mockUsers.push({
        id: 'u-existing',
        email: 'existing@pubprototype.com',
        status: 'ACTIVE',
        password_hash: 'somehash',
      });

      const res = await makeRequest('/prototype/auth/signup', {
        method: 'POST',
        body: { email: 'Existing@PubPrototype.com', password: 'ValidPassword123!' },
      });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'ACCOUNT_EXISTS' });
    });

    it('rejects malformed email format', async () => {
      const res = await makeRequest('/prototype/auth/signup', {
        method: 'POST',
        body: { email: 'not-an-email', password: 'ValidPassword123!' },
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'INVALID_REQUEST' });
    });

    it('rejects weak/short password (< 8 chars)', async () => {
      const res = await makeRequest('/prototype/auth/signup', {
        method: 'POST',
        body: { email: 'user@test.com', password: 'short' },
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'INVALID_REQUEST' });
    });
  });

  describe('2. Login Endpoint (POST /prototype/auth/login)', () => {
    beforeEach(async () => {
      const hash = await hashPassword('CorrectPassword123!');
      mockUsers.push({
        id: 'u-login-test',
        email: 'user@login.com',
        name: 'Login Tester',
        avatar_url: null,
        status: 'ACTIVE',
        password_hash: hash,
        created_at: new Date(),
        updated_at: new Date(),
      });
    });

    it('successfully logs in with valid credentials and sets refresh cookie', async () => {
      const res = await makeRequest('/prototype/auth/login', {
        method: 'POST',
        body: { email: 'User@Login.com', password: 'CorrectPassword123!' },
      });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.user.email).toBe('user@login.com');
      expect(res.body.user.password_hash).toBeUndefined();
      expect(res.body.refreshToken).toBeUndefined();

      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toContain('pp_refresh_token=');
      expect(setCookie).toContain('HttpOnly');
    });

    it('fails closed on incorrect password with uniform UNAUTHORIZED', async () => {
      const res = await makeRequest('/prototype/auth/login', {
        method: 'POST',
        body: { email: 'user@login.com', password: 'WrongPassword999!' },
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
      expect(res.headers['set-cookie']).toBeUndefined();
    });

    it('fails closed on nonexistent user with uniform UNAUTHORIZED (anti-enumeration)', async () => {
      const res = await makeRequest('/prototype/auth/login', {
        method: 'POST',
        body: { email: 'nonexistent@nowhere.com', password: 'AnyPassword123!' },
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
    });

    it('rejects inactive or suspended accounts with ACCOUNT_INACTIVE', async () => {
      mockUsers.push({
        id: 'u-suspended',
        email: 'suspended@pubprototype.com',
        status: 'SUSPENDED',
        password_hash: await hashPassword('ValidPass123!'),
      });

      const res = await makeRequest('/prototype/auth/login', {
        method: 'POST',
        body: { email: 'suspended@pubprototype.com', password: 'ValidPass123!' },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'ACCOUNT_INACTIVE' });
    });
  });

  describe('3. Refresh Endpoint (POST /prototype/auth/refresh)', () => {
    it('successfully rotates refresh token via cookie and issues new tokens', async () => {
      const session = await sovereignProvider.issueSession('u-refresh-test');

      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.refreshToken).toBeUndefined(); // not in body

      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('pp_refresh_token=');
      expect(setCookie).not.toContain(session.refreshToken); // new rotated token
    });

    it('rejects refresh request missing the HttpOnly cookie', async () => {
      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
    });

    it('detects refresh token reuse and invalidates the entire session family', async () => {
      const session = await sovereignProvider.issueSession('u-reuse-test');

      // First rotation succeeds
      const res1 = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });
      expect(res1.status).toBe(200);

      // Replaying the old token must trigger REUSE_DETECTED
      const res2 = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });
      expect(res2.status).toBe(401);
      expect(res2.body).toEqual({ error: 'REUSE_DETECTED' });

      // Entire family should now be revoked in DB
      const family = mockSessions.filter(s => s.family_id === mockSessions[0].family_id);
      expect(family.every(s => s.revoked_at !== null)).toBe(true);
    });
  });

  describe('4. Logout Endpoint (POST /prototype/auth/logout)', () => {
    it('revokes session in database and clears the refresh cookie', async () => {
      const session = await sovereignProvider.issueSession('u-logout-test');

      const res = await makeRequest('/prototype/auth/logout', {
        method: 'POST',
        headers: {
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });

      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      // Clearing cookie sets expires to past / max-age=0
      expect(setCookie).toMatch(/pp_refresh_token=;|Max-Age=0|expires=/i);

      // Subsequent refresh with same token fails
      const resRefresh = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });
      expect(resRefresh.status).toBe(401);
    });

    it('logout is idempotent even without cookie or with invalid token', async () => {
      const res = await makeRequest('/prototype/auth/logout', {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('5. Profile Endpoint (GET /prototype/auth/me)', () => {
    beforeEach(() => {
      mockUsers.push({
        id: 'u-me-user',
        email: 'me@pubprototype.com',
        name: 'Me User',
        avatar_url: 'https://avatar.com/me.png',
        status: 'ACTIVE',
        created_at: new Date('2026-09-01T00:00:00Z'),
        updated_at: new Date('2026-09-01T00:00:00Z'),
      });

      mockWorkspaces.push({
        id: 'ws-1',
        name: 'Workspace Alpha',
        slug: 'workspace-alpha',
      });

      mockMemberships.push({
        user_id: 'u-me-user',
        workspace_id: 'ws-1',
        role: 'OWNER',
      });
    });

    it('returns real user profile and dynamic database memberships with valid Bearer token', async () => {
      const token = signAccessToken(keyManager, {
        userId: 'u-me-user',
        sessionId: 'sess-me',
      });

      const res = await makeRequest('/prototype/auth/me', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe('u-me-user');
      expect(res.body.user.email).toBe('me@pubprototype.com');
      expect(res.body.user.name).toBe('Me User');
      expect(res.body.user.avatarUrl).toBe('https://avatar.com/me.png');
      expect(res.body.user.password_hash).toBeUndefined();

      expect(res.body.workspaces).toEqual([
        {
          id: 'ws-1',
          name: 'Workspace Alpha',
          slug: 'workspace-alpha',
          role: 'OWNER',
        },
      ]);
    });

    it('rejects request with missing or invalid token with 401 UNAUTHORIZED', async () => {
      const res = await makeRequest('/prototype/auth/me', {
        method: 'GET',
      });
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
    });
  });

  describe('6. JWKS Endpoint (GET /prototype/auth/.well-known/jwks.json)', () => {
    it('returns strictly public keys and never exposes private keys', async () => {
      const res = await makeRequest('/prototype/auth/.well-known/jwks.json', {
        method: 'GET',
      });

      expect(res.status).toBe(200);
      expect(res.body.keys).toBeDefined();
      expect(res.body.keys.length).toBeGreaterThan(0);

      const firstKey = res.body.keys[0];
      expect(firstKey.kty).toBe('OKP');
      expect(firstKey.crv).toBe('Ed25519');
      expect(firstKey.x).toBeDefined();
      expect(firstKey.kid).toBeDefined();
      expect((firstKey as any).d).toBeUndefined(); // Private key component must NEVER exist

      expect(res.headers['cache-control']).toContain('public');
    });
  });
});
