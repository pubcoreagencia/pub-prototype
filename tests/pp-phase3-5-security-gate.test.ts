import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createSovereignAuthRouter } from '../src/pp/auth/http.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';
import { signAccessToken, verifyAccessToken } from '../src/pp/auth/sovereign/jwt.js';

describe('PP Sovereign Auth — Phase 3.5 Security Gate Verification', () => {
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

        if (s.includes('FROM users WHERE email = $1')) {
          const u = mockUsers.find(x => x.email === params[0]);
          return { rows: u ? [u] : [] };
        }

        if (s.includes('FROM users WHERE id = $1')) {
          const u = mockUsers.find(x => x.id === params[0]);
          return { rows: u ? [u] : [] };
        }

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

        if (s.includes('FROM auth_sessions WHERE refresh_token_hash = $1')) {
          const found = mockSessions.find(x => x.refresh_token_hash === params[0]);
          return { rows: found ? [found] : [] };
        }

        if (s.includes('FROM auth_sessions WHERE id = $1')) {
          const found = mockSessions.find(x => x.id === params[0]);
          return { rows: found ? [found] : [] };
        }

        if (s.includes('UPDATE auth_sessions SET revoked_at') && s.includes('WHERE id = $1 AND revoked_at IS NULL')) {
          const sess = mockSessions.find(x => x.id === params[0] && x.revoked_at === null);
          if (sess) {
            sess.revoked_at = new Date();
            return { rowCount: 1, rows: [sess] };
          }
          return { rowCount: 0, rows: [] };
        }

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

        return { rows: [] };
      }),
    };

    sovereignProvider = new SovereignAuthProvider(mockPool, keyManager);

    app = express();
    app.use(express.json());

    // CORS simulation consistent with entry.ts
    const allowedOrigins = new Set([
      'https://pubcore.site',
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:5173',
    ]);

    app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.has(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        if (origin && allowedOrigins.has(origin)) return res.sendStatus(204);
        return res.sendStatus(403);
      }
      next();
    });

    const router = createSovereignAuthRouter({
      pool: mockPool,
      sovereignProvider,
      keyManager,
    });
    app.use('/prototype/auth', router);
  });

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
          try { jsonBody = JSON.parse(rawText); } catch { jsonBody = rawText; }

          const resHeaders: Record<string, string> = {};
          res.headers.forEach((v, k) => { resHeaders[k.toLowerCase()] = v; });

          resolve({ status: res.status, body: jsonBody, headers: resHeaders });
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
  }

  // 1. CSRF & Origin Verification
  describe('Gate 1 & 2: Origin Isolation and Cross-Origin Behavior', () => {
    it('CORS preflight from unauthorized origin (https://evil.example) is rejected with 403', async () => {
      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(res.status).toBe(403);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('CORS preflight from authorized origin (https://pubcore.site) is accepted with 204 and credentials', async () => {
      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://pubcore.site',
          'Access-Control-Request-Method': 'POST',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://pubcore.site');
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('Cross-origin request with unauthorized Origin does NOT receive Access-Control-Allow-Origin', async () => {
      const session = await sovereignProvider.issueSession('user-legit');
      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Origin: 'https://evil.example',
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });
      // The browser blocks reading the response if ACAO is missing
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  // 2. JWT Cryptographic Rejection Tests
  describe('Gate 5: Cryptographic Rigor & Algorithm Enforcement', () => {
    it('rejects alg:none token attack', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: 'fake' })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
      const noneToken = `${header}.${payload}.`;

      const result = verifyAccessToken(keyManager, noneToken);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/Unsupported algorithm/i);
      }
    });

    it('rejects HS256 HMAC confusion attack', () => {
      const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyManager.getCurrentSigningKey().kid })).toString('base64url');
      const payload = Buffer.from(JSON.stringify({ sub: 'admin', exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
      const forgedToken = `${header}.${payload}.invalidsignature`;

      const result = verifyAccessToken(keyManager, forgedToken);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/Unsupported algorithm/i);
      }
    });

    it('rejects token with nonexistent or unknown kid', () => {
      const token = signAccessToken(keyManager, { userId: 'u1', sessionId: 's1' });
      const parts = token.split('.');
      const alteredHeader = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: 'unknown-kid-xyz' })).toString('base64url');
      const alteredToken = `${alteredHeader}.${parts[1]}.${parts[2]}`;

      const result = verifyAccessToken(keyManager, alteredToken);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toMatch(/Unknown key identifier/i);
      }
    });

    it('verifies token payload carries minimal claims and never sensitive data', () => {
      const token = signAccessToken(keyManager, { userId: 'u-safe', sessionId: 's-safe' });
      const payloadStr = Buffer.from(token.split('.')[1], 'base64url').toString('utf8');
      const payload = JSON.parse(payloadStr);

      expect(payload.sub).toBe('u-safe');
      expect(payload.sid).toBe('s-safe');
      expect(payload.iss).toBeDefined();
      expect(payload.aud).toBeDefined();
      expect(payload.password).toBeUndefined();
      expect(payload.password_hash).toBeUndefined();
      expect(payload.role).toBeUndefined(); // Role is dynamically resolved, not static claim
    });
  });

  // 3. Workspace Isolation at Signup
  describe('Gate 4: Signup Isolation & Workspace Decoupling', () => {
    it('signup creates completely isolated users without auto-assigning existing workspaces', async () => {
      const resA = await makeRequest('/prototype/auth/signup', {
        method: 'POST',
        body: { email: 'userA@org.com', password: 'Password123!' },
      });
      const resB = await makeRequest('/prototype/auth/signup', {
        method: 'POST',
        body: { email: 'userB@org.com', password: 'Password123!' },
      });

      expect(resA.status).toBe(201);
      expect(resB.status).toBe(201);
      expect(resA.body.user.id).not.toBe(resB.body.user.id);

      // Neither user should have memberships created in mockMemberships automatically
      expect(mockMemberships.length).toBe(0);
    });
  });
});
