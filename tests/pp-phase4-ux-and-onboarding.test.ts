import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createSovereignAuthRouter } from '../src/pp/auth/http.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';
import { hashPassword } from '../src/pp/auth/sovereign/password.js';

describe('PP Sovereign Auth — Phase 4 UX, Tenancy & Origin Hardening', () => {
  let mockUsers: any[];
  let mockSessions: any[];
  let mockWorkspaces: any[];
  let mockMemberships: any[];
  let mockPool: any;
  let keyManager: KeyManager;
  let sovereignProvider: SovereignAuthProvider;
  let app: express.Express;

  beforeEach(async () => {
    mockUsers = [];
    mockSessions = [];
    mockWorkspaces = [];
    mockMemberships = [];
    keyManager = new KeyManager();

    mockPool = {
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql: string, params: any[] = []) => {
          const s = sql.trim();
          if (s === 'BEGIN' || s === 'COMMIT' || s === 'ROLLBACK') {
            return { rows: [] };
          }
          if (s.includes('FROM workspaces WHERE slug = $1')) {
            const found = mockWorkspaces.find(w => w.slug === params[0]);
            return { rows: found ? [found] : [] };
          }
          if (s.startsWith('INSERT INTO workspaces')) {
            const newWs = {
              id: 'ws-' + Math.random().toString(36).slice(2, 8),
              name: params[0],
              slug: params[1],
              owner_id: params[2],
              created_at: new Date(),
              updated_at: new Date(),
            };
            mockWorkspaces.push(newWs);
            return { rows: [newWs] };
          }
          if (s.startsWith('INSERT INTO workspace_members')) {
            const newMember = {
              workspace_id: params[0],
              user_id: params[1],
              role: params[2] || 'OWNER',
              created_at: new Date(),
            };
            mockMemberships.push(newMember);
            return { rows: [newMember] };
          }
          return { rows: [] };
        }),
        release: vi.fn(),
      })),
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
            family_id: params[3],
            generation: params[4],
            expires_at: params[5],
            revoked_at: null,
            created_at: new Date(),
            updated_at: new Date(),
          };
          mockSessions.push(newSession);
          return { rows: [newSession] };
        }
        if (s.includes('FROM auth_sessions WHERE refresh_token_hash = $1')) {
          const sess = mockSessions.find(x => x.refresh_token_hash === params[0] && !x.revoked_at);
          return { rows: sess ? [sess] : [] };
        }
        if (s.includes('FROM auth_sessions WHERE id = $1')) {
          const sess = mockSessions.find(x => x.id === params[0]);
          return { rows: sess ? [sess] : [] };
        }
        if (s.startsWith('UPDATE auth_sessions') && s.includes('SET revoked_at = now()')) {
          const sess = mockSessions.find(x => x.id === params[0] && !x.revoked_at);
          if (sess) {
            sess.revoked_at = new Date();
            return { rowCount: 1, rows: [sess] };
          }
          return { rowCount: 0, rows: [] };
        }
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

  async function makeRequest(
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: any;
    } = {}
  ): Promise<{ status: number; body: any; headers: Record<string, string> }> {
    const { method = 'GET', headers = {}, body } = options;
    const req = (app as any).handle.bind(app);

    return new Promise((resolve) => {
      const http = require('node:http');
      const server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        const requestOpts: any = {
          hostname: '127.0.0.1',
          port,
          path,
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
        };

        const clientReq = http.request(requestOpts, (res: any) => {
          let data = '';
          res.on('data', (chunk: any) => {
            data += chunk;
          });
          res.on('end', () => {
            server.close();
            let parsedBody: any;
            try {
              parsedBody = JSON.parse(data);
            } catch {
              parsedBody = data;
            }
            resolve({
              status: res.statusCode,
              body: parsedBody,
              headers: res.headers,
            });
          });
        });

        if (body) {
          clientReq.write(JSON.stringify(body));
        }
        clientReq.end();
      });
    });
  }

  describe('1. Explicit Origin Validation on Refresh & Logout', () => {
    it('accepts refresh from authorized origin (pubcore.site)', async () => {
      const session = await sovereignProvider.issueSession('u-origin-test');

      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Origin: 'https://pubcore.site',
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.accessToken).toBeDefined();
    });

    it('accepts refresh from authorized local dev origin (http://localhost:5173)', async () => {
      const session = await sovereignProvider.issueSession('u-local-origin');

      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Origin: 'http://localhost:5173',
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });

      expect(res.status).toBe(200);
    });

    it('rejects refresh from unauthorized origin with 403 FORBIDDEN', async () => {
      const session = await sovereignProvider.issueSession('u-attacker');

      const res = await makeRequest('/prototype/auth/refresh', {
        method: 'POST',
        headers: {
          Origin: 'https://malicious-site.attacker.com',
          Cookie: `pp_refresh_token=${session.refreshToken}`,
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'FORBIDDEN' });
    });

    it('rejects logout from unauthorized origin with 403 FORBIDDEN', async () => {
      const res = await makeRequest('/prototype/auth/logout', {
        method: 'POST',
        headers: {
          Origin: 'https://malicious-site.attacker.com',
        },
      });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'FORBIDDEN' });
    });

    it('allows logout from authorized origin', async () => {
      const res = await makeRequest('/prototype/auth/logout', {
        method: 'POST',
        headers: {
          Origin: 'https://pubcore.site',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  describe('2. Workspace Onboarding Flow (POST /prototype/auth/workspaces)', () => {
    let activeToken: string;
    let userId: string;

    beforeEach(async () => {
      userId = 'u-onboarding-user';
      mockUsers.push({
        id: userId,
        email: 'onboard@pubprototype.dev',
        name: 'Onboard User',
        status: 'ACTIVE',
      });
      const session = await sovereignProvider.issueSession(userId);
      activeToken = session.accessToken;
    });

    it('creates a personal workspace with OWNER role for authenticated user', async () => {
      const res = await makeRequest('/prototype/auth/workspaces', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeToken}`,
        },
        body: {
          name: 'My Awesome Studio',
        },
      });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Awesome Studio');
      expect(res.body.slug).toBe('my-awesome-studio');
      expect(res.body.role).toBe('OWNER');

      // Check DB records
      expect(mockWorkspaces.length).toBe(1);
      expect(mockWorkspaces[0].owner_id).toBe(userId);
      expect(mockMemberships.length).toBe(1);
      expect(mockMemberships[0].user_id).toBe(userId);
      expect(mockMemberships[0].role).toBe('OWNER');
    });

    it('rejects unauthenticated workspace creation with 401 UNAUTHORIZED', async () => {
      const res = await makeRequest('/prototype/auth/workspaces', {
        method: 'POST',
        body: {
          name: 'Unauthorized Studio',
        },
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'UNAUTHORIZED' });
    });

    it('rejects workspace creation without a name', async () => {
      const res = await makeRequest('/prototype/auth/workspaces', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeToken}`,
        },
        body: {
          name: '',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_REQUEST');
    });

    it('rejects duplicate slug creation with 409 SLUG_EXISTS', async () => {
      mockWorkspaces.push({
        id: 'ws-existing',
        name: 'Existing WS',
        slug: 'existing-ws',
        owner_id: 'other-user',
      });

      const res = await makeRequest('/prototype/auth/workspaces', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${activeToken}`,
        },
        body: {
          name: 'Existing WS',
          slug: 'existing-ws',
        },
      });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('SLUG_EXISTS');
    });
  });
});
