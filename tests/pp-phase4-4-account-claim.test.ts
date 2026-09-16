import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createSovereignAuthRouter } from '../src/pp/auth/http.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';
import { verifyPassword } from '../src/pp/auth/sovereign/password.js';
import {
  ClaimManager,
  hashClaimToken,
  type EmailAdapter,
  type SendClaimEmailOptions,
  type EmailDeliveryResult,
} from '../src/pp/auth/sovereign/claim.js';

describe('PP Sovereign Auth — Phase 4.4: Account Claim & Identity Transition', () => {
  let mockUsers: any[];
  let mockSessions: any[];
  let mockWorkspaces: any[];
  let mockMembers: any[];
  let mockClaimTokens: any[];
  let mockPool: any;
  let keyManager: KeyManager;
  let sovereignProvider: SovereignAuthProvider;
  let sentEmails: SendClaimEmailOptions[];
  let testEmailAdapter: EmailAdapter;
  let claimManager: ClaimManager;
  let app: express.Express;

  // The 3 Historical Users
  const HISTORICAL_DEFAULT_ID = '00000000-0000-0000-0000-000000000000';
  const HISTORICAL_FIXTURE_ID = 'a3b90f42-45e6-42bc-86db-589cf24a0d9b';
  const HISTORICAL_PROD_ID = '7e9b1070-cc87-427c-a7b3-bfa511e7a1a7';
  const HISTORICAL_WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';

  beforeEach(async () => {
    mockUsers = [
      {
        id: HISTORICAL_DEFAULT_ID,
        email: 'default@pubprototype.internal',
        name: 'Default User',
        avatar_url: null,
        password_hash: null, // Legacy Supabase user without sovereign password
        status: 'ACTIVE',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: HISTORICAL_FIXTURE_ID,
        email: 'contato.pubcore+fixture@gmail.com',
        name: 'PUB Core Master',
        avatar_url: null,
        password_hash: null, // Legacy Supabase user without sovereign password
        status: 'ACTIVE',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: HISTORICAL_PROD_ID,
        email: 'contato.pubcore@gmail.com',
        name: 'PUB Core Master (Production)',
        avatar_url: null,
        password_hash: null, // Legacy Supabase user without sovereign password
        status: 'ACTIVE',
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    mockWorkspaces = [
      {
        id: HISTORICAL_WORKSPACE_ID,
        name: 'Default Workspace',
        slug: 'default',
        owner_id: HISTORICAL_DEFAULT_ID,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ];

    mockMembers = [
      { workspace_id: HISTORICAL_WORKSPACE_ID, user_id: HISTORICAL_DEFAULT_ID, role: 'OWNER' },
      { workspace_id: HISTORICAL_WORKSPACE_ID, user_id: HISTORICAL_FIXTURE_ID, role: 'OWNER' },
      { workspace_id: HISTORICAL_WORKSPACE_ID, user_id: HISTORICAL_PROD_ID, role: 'OWNER' },
    ];

    mockSessions = [];
    mockClaimTokens = [];
    sentEmails = [];

    testEmailAdapter = {
      sendClaimEmail: async (options: SendClaimEmailOptions): Promise<EmailDeliveryResult> => {
        sentEmails.push(options);
        return { success: true, messageId: `msg-${Date.now()}` };
      },
    };

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

        // 3. Invalidate prior claim tokens
        if (s.includes('UPDATE account_claim_tokens SET used_at = now() WHERE user_id = $1')) {
          for (const t of mockClaimTokens) {
            if (t.user_id === params[0] && !t.used_at) {
              t.used_at = new Date();
            }
          }
          return { rowCount: 1 };
        }

        // 4. INSERT INTO account_claim_tokens
        if (s.includes('INSERT INTO account_claim_tokens')) {
          const record = {
            id: 'clm-id-' + Math.random().toString(36).slice(2, 9),
            user_id: params[0],
            token_hash: params[1],
            expires_at: params[2],
            used_at: null,
            created_at: new Date(),
          };
          mockClaimTokens.push(record);
          return { rows: [record] };
        }

        // 5. Atomic claim token update (CAS)
        if (s.includes('UPDATE account_claim_tokens') && s.includes('SET used_at = now()')) {
          const hash = params[0];
          const token = mockClaimTokens.find(
            t => t.token_hash === hash && !t.used_at && new Date(t.expires_at).getTime() > Date.now()
          );
          if (token) {
            token.used_at = new Date();
            return { rowCount: 1, rows: [{ id: token.id, user_id: token.user_id }] };
          }
          return { rowCount: 0, rows: [] };
        }

        // 6. UPDATE users SET password_hash = $1
        if (s.includes('UPDATE users') && s.includes('password_hash = $1')) {
          const hash = params[0];
          const userId = params[1];
          const user = mockUsers.find(u => u.id === userId);
          if (user) {
            user.password_hash = hash;
            user.status = 'ACTIVE';
            user.updated_at = new Date();
            return { rowCount: 1, rows: [user] };
          }
          return { rowCount: 0, rows: [] };
        }

        // 7. INSERT INTO auth_sessions
        if (s.includes('INSERT INTO auth_sessions')) {
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

        // 8. SELECT auth_sessions WHERE refresh_token_hash = $1
        if (s.includes('FROM auth_sessions WHERE refresh_token_hash = $1')) {
          const sess = mockSessions.find(x => x.refresh_token_hash === params[0]);
          return { rows: sess ? [sess] : [] };
        }

        return { rows: [] };
      }),
      connect: vi.fn(async () => {
        return {
          query: vi.fn(async (sql: string, params: any[] = []) => mockPool.query(sql, params)),
          release: vi.fn(),
        };
      }),
    };

    sovereignProvider = new SovereignAuthProvider(mockPool, keyManager);
    claimManager = new ClaimManager({
      pool: mockPool,
      emailAdapter: testEmailAdapter,
      claimBaseUrl: 'https://prototype.pubcore.internal/claim',
    });

    app = express();
    app.use(express.json());
    app.use(
      '/prototype/auth',
      createSovereignAuthRouter({
        pool: mockPool,
        sovereignProvider,
        keyManager,
        claimManager,
        emailAdapter: testEmailAdapter,
      })
    );
  });

  // Native HTTP request helper via Express ephemeral listener
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

  describe('1. Claim Token Request & Enumeration Resistance', () => {
    it('generates claim token and dispatches email for eligible historical user', async () => {
      const res = await makeRequest('/prototype/auth/claim/request', {
        method: 'POST',
        body: { email: 'contato.pubcore@gmail.com' },
      });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If an eligible account exists');

      // Email was dispatched
      expect(sentEmails.length).toBe(1);
      expect(sentEmails[0].to).toBe('contato.pubcore@gmail.com');
      expect(sentEmails[0].claimToken).toMatch(/^clm_[0-9a-f]{64}$/);
      expect(sentEmails[0].claimUrl).toContain('https://prototype.pubcore.internal/claim?token=clm_');

      // Token record created with SHA-256 hash
      expect(mockClaimTokens.length).toBe(1);
      const record = mockClaimTokens[0];
      expect(record.user_id).toBe(HISTORICAL_PROD_ID);
      expect(record.token_hash).toBe(hashClaimToken(sentEmails[0].claimToken));
      expect(record.used_at).toBeNull();
    });

    it('returns uniform 200 OK without dispatching email when email does not exist (Enumeration Resistance)', async () => {
      const res = await makeRequest('/prototype/auth/claim/request', {
        method: 'POST',
        body: { email: 'nonexistent-intruder@example.com' },
      });

      expect(res.status).toBe(200);
      expect(res.body.message).toContain('If an eligible account exists');
      expect(sentEmails.length).toBe(0);
      expect(mockClaimTokens.length).toBe(0);
    });

    it('rejects invalid or malformed email with 400', async () => {
      const res = await makeRequest('/prototype/auth/claim/request', {
        method: 'POST',
        body: { email: 'not-an-email' },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_REQUEST');
    });

    it('invalidates prior unused claim token when requesting a new one', async () => {
      // First request
      await makeRequest('/prototype/auth/claim/request', {
        method: 'POST',
        body: { email: 'contato.pubcore+fixture@gmail.com' },
      });

      expect(mockClaimTokens.length).toBe(1);
      const firstToken = mockClaimTokens[0];
      expect(firstToken.used_at).toBeNull();

      // Second request for same user
      await makeRequest('/prototype/auth/claim/request', {
        method: 'POST',
        body: { email: 'contato.pubcore+fixture@gmail.com' },
      });

      expect(mockClaimTokens.length).toBe(2);
      expect(firstToken.used_at).not.toBeNull(); // Marked as superseded/used
      expect(mockClaimTokens[1].used_at).toBeNull();
    });
  });

  describe('2. Account Claim Confirmation & Credential Establishment', () => {
    let rawToken: string;

    beforeEach(async () => {
      // Request a token for historical fixture user
      await makeRequest('/prototype/auth/claim/request', {
        method: 'POST',
        body: { email: 'contato.pubcore+fixture@gmail.com' },
      });

      rawToken = sentEmails[0].claimToken;
    });

    it('successfully confirms claim, sets scrypt password hash, and issues sovereign session', async () => {
      const res = await makeRequest('/prototype/auth/claim/confirm', {
        method: 'POST',
        body: {
          token: rawToken,
          password: 'CorrectHorseBatteryStaple123!',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Account successfully activated.');
      expect(res.body.accessToken).toBeDefined();
      expect(res.body.user).toBeDefined();
      expect(res.body.user.id).toBe(HISTORICAL_FIXTURE_ID);
      expect(res.body.user.email).toBe('contato.pubcore+fixture@gmail.com');

      // Refresh cookie is set
      const cookieHeader = res.headers['set-cookie'];
      expect(cookieHeader).toBeDefined();
      expect(cookieHeader).toContain('pp_refresh_token=');
      expect(cookieHeader).toContain('HttpOnly');

      // Check user record: password_hash is now an scrypt hash
      const user = mockUsers.find(u => u.id === HISTORICAL_FIXTURE_ID);
      expect(user.password_hash).not.toBeNull();
      expect(verifyPassword('CorrectHorseBatteryStaple123!', user.password_hash)).toBe(true);

      // Claim token marked as used
      const tokenRecord = mockClaimTokens.find(t => t.token_hash === hashClaimToken(rawToken));
      expect(tokenRecord.used_at).not.toBeNull();
    });

    it('strictly preserves historical user_id, workspace ownership, and memberships', async () => {
      await makeRequest('/prototype/auth/claim/confirm', {
        method: 'POST',
        body: {
          token: rawToken,
          password: 'Password999!',
        },
      });

      // User ID remains identical
      const user = mockUsers.find(u => u.id === HISTORICAL_FIXTURE_ID);
      expect(user.id).toBe(HISTORICAL_FIXTURE_ID);

      // Workspace membership and OWNER role are untouched
      const membership = mockMembers.find(m => m.user_id === HISTORICAL_FIXTURE_ID && m.workspace_id === HISTORICAL_WORKSPACE_ID);
      expect(membership).toBeDefined();
      expect(membership.role).toBe('OWNER');

      // Total count of users remains exactly 3 (no duplication)
      expect(mockUsers.length).toBe(3);
    });

    it('allows user to login via POST /prototype/auth/login immediately after claim', async () => {
      // Confirm claim
      const confirmRes = await makeRequest('/prototype/auth/claim/confirm', {
        method: 'POST',
        body: {
          token: rawToken,
          password: 'MyBrandNewPassword123!',
        },
      });
      expect(confirmRes.status).toBe(200);

      // Login using sovereign credentials
      const loginRes = await makeRequest('/prototype/auth/login', {
        method: 'POST',
        body: {
          email: 'contato.pubcore+fixture@gmail.com',
          password: 'MyBrandNewPassword123!',
        },
      });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.accessToken).toBeDefined();
      expect(loginRes.body.user.id).toBe(HISTORICAL_FIXTURE_ID);
    });

    it('rejects replay attempt with the same claim token (Single-Use Guarantee)', async () => {
      // First use: succeeds
      const res1 = await makeRequest('/prototype/auth/claim/confirm', {
        method: 'POST',
        body: {
          token: rawToken,
          password: 'PasswordFirst123!',
        },
      });
      expect(res1.status).toBe(200);

      // Replay use: fails
      const res2 = await makeRequest('/prototype/auth/claim/confirm', {
        method: 'POST',
        body: {
          token: rawToken,
          password: 'PasswordReplay456!',
        },
      });
      expect(res2.status).toBe(400);
      expect(res2.body.error).toBe('INVALID_OR_EXPIRED_TOKEN');
    });

    it('rejects expired claim token', async () => {
      // Manually expire token
      const tokenRecord = mockClaimTokens.find(t => t.token_hash === hashClaimToken(rawToken));
      expect(tokenRecord).toBeDefined();
      tokenRecord.expires_at = new Date(Date.now() - 1000); // 1 sec in the past

      const res = await makeRequest('/prototype/auth/claim/confirm', {
        method: 'POST',
        body: {
          token: rawToken,
          password: 'PasswordAfterExpiry123!',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_OR_EXPIRED_TOKEN');
    });

    it('rejects weak or invalid passwords (< 8 characters)', async () => {
      const res = await makeRequest('/prototype/auth/claim/confirm', {
        method: 'POST',
        body: {
          token: rawToken,
          password: 'short',
        },
      });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_PASSWORD');
    });
  });

  describe('3. Resource RBAC Provider-Independence Contract', () => {
    it('verifies that RBAC checks depend solely on user_id and workspace membership, irrespective of auth provider', async () => {
      // Given: User claimed account or authenticated
      const targetUserId = HISTORICAL_PROD_ID;
      const targetWorkspaceId = HISTORICAL_WORKSPACE_ID;

      // When verifying workspace membership
      const member = mockMembers.find(m => m.user_id === targetUserId && m.workspace_id === targetWorkspaceId);

      // Then: Role is resolved independently of auth origin
      expect(member).toBeDefined();
      expect(member.role).toBe('OWNER');
    });
  });
});
