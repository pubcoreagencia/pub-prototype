import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createSovereignAuthRouter } from '../src/pp/auth/http.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';
import { AuthService } from '../src/pp/auth/auth.js';
import { signAccessToken } from '../src/pp/auth/sovereign/jwt.js';

describe('PP Sovereign Auth — Security, Multi-Tenancy & Hardening (Phase 3)', () => {
  let mockUsers: any[];
  let mockSessions: any[];
  let mockMemberships: any[];
  let mockWorkspaces: any[];
  let mockPool: any;
  let keyManager: KeyManager;
  let sovereignProvider: SovereignAuthProvider;
  let app: express.Express;

  beforeEach(() => {
    mockUsers = [
      { id: 'user-a-id', email: 'user-a@org.com', status: 'ACTIVE', password_hash: 'hash-a' },
      { id: 'user-b-id', email: 'user-b@org.com', status: 'ACTIVE', password_hash: 'hash-b' },
    ];
    mockSessions = [];
    mockWorkspaces = [
      { id: 'ws-a', name: 'Workspace A', slug: 'ws-a', owner_id: 'user-a-id' },
      { id: 'ws-b', name: 'Workspace B', slug: 'ws-b', owner_id: 'user-b-id' },
    ];
    mockMemberships = [
      { user_id: 'user-a-id', workspace_id: 'ws-a', role: 'OWNER' },
      { user_id: 'user-b-id', workspace_id: 'ws-b', role: 'OWNER' },
      { user_id: 'user-b-id', workspace_id: 'ws-a', role: 'VIEWER' }, // User B is only VIEWER in WS A
    ];

    keyManager = new KeyManager();
    mockPool = {
      query: vi.fn(async (sql: string, params: any[] = []) => {
        const s = sql.trim();
        if (s.includes('FROM users WHERE id = $1')) {
          const u = mockUsers.find(x => x.id === params[0]);
          return { rows: u ? [u] : [] };
        }
        if (s.includes('FROM workspace_members wm')) {
          const members = mockMemberships.filter(m => m.user_id === params[0]);
          return {
            rows: members.map(m => ({
              workspace_id: m.workspace_id,
              role: m.role,
              workspace_name: 'Workspace ' + m.workspace_id,
              workspace_slug: m.workspace_id,
            })),
          };
        }
        return { rows: [] };
      }),
    };

    sovereignProvider = new SovereignAuthProvider(mockPool, keyManager);

    app = express();
    app.use(express.json());

    // Setup dummy prototype repo for AuthService
    const mockProtoRepo: any = {
      getWorkspace: async (id: string) => mockWorkspaces.find(w => w.id === id) || null,
      getWorkspaceMembership: async (userId: string, workspaceId: string) => {
        const m = mockMemberships.find(x => x.user_id === userId && x.workspace_id === workspaceId);
        return m ? { role: m.role } : null;
      },
      getSession: async (id: string) => {
        if (id === 'sess-in-ws-a') {
          return { id, projectId: 'proj-a' };
        }
        return null;
      },
      getProject: async (id: string) => {
        if (id === 'proj-a') {
          return { id, workspaceId: 'ws-a' };
        }
        return null;
      },
    };

    const authService = new AuthService(mockProtoRepo, sovereignProvider);

    // Protected route requiring ADMIN in workspace
    app.post('/api/workspaces/:workspaceId/admin-action', authService.requireRole('ADMIN'), (req, res) => {
      res.json({ success: true, actor: req.user?.id, role: req.user?.role });
    });

    // Protected route requiring MEMBER on session
    app.post('/prototype/sessions/:id/edit', authService.requireSessionRole('MEMBER'), (req, res) => {
      res.json({ success: true, sessionId: req.params.id, role: req.user?.role });
    });
  });

  async function makeRequest(path: string, options: { method: string; body?: any; headers?: Record<string, string> }) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address() as any;
          const url = `http://127.0.0.1:${addr.port}${path}`;
          const res = await fetch(url, {
            method: options.method,
            headers: {
              'content-type': 'application/json',
              ...(options.headers || {}),
            },
            body: options.body ? JSON.stringify(options.body) : undefined,
          });
          const rawText = await res.text();
          let jsonBody: any = null;
          try {
            jsonBody = JSON.parse(rawText);
          } catch {
            jsonBody = rawText;
          }
          resolve({ status: res.status, body: jsonBody });
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
  }

  it('multi-tenancy: User A with valid Sovereign token can perform OWNER action on WS A', async () => {
    const tokenA = signAccessToken(keyManager, {
      userId: 'user-a-id',
      sessionId: 'sess-a',
    });

    const res = await makeRequest('/api/workspaces/ws-a/admin-action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.actor).toBe('user-a-id');
    expect(res.body.role).toBe('OWNER');
  });

  it('multi-tenancy: User B with valid Sovereign token is FORBIDDEN (403) from ADMIN actions on WS A (role is only VIEWER)', async () => {
    const tokenB = signAccessToken(keyManager, {
      userId: 'user-b-id',
      sessionId: 'sess-b',
    });

    const res = await makeRequest('/api/workspaces/ws-a/admin-action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  it('multi-tenancy: User B is FORBIDDEN from editing sessions in WS A where they lack MEMBER permissions', async () => {
    const tokenB = signAccessToken(keyManager, {
      userId: 'user-b-id',
      sessionId: 'sess-b',
    });

    const res = await makeRequest('/prototype/sessions/sess-in-ws-a/edit', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Forbidden');
  });

  it('tamper resistance: an access token with modified payload is rejected (401 UNAUTHORIZED)', async () => {
    const validToken = signAccessToken(keyManager, {
      userId: 'user-a-id',
      sessionId: 'sess-a',
    });

    const parts = validToken.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({
      sub: 'user-b-id', // attacker tries to impersonate User B
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 900,
    })).toString('base64url');

    const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

    const res = await makeRequest('/api/workspaces/ws-a/admin-action', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });

    expect(res.status).toBe(401);
  });
});
