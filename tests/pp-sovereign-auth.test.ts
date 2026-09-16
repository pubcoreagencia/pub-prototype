import { describe, it, expect, beforeEach } from 'vitest';
import { hashPassword, verifyPassword } from '../src/pp/auth/sovereign/password.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { signAccessToken, verifyAccessToken, DEFAULT_ISSUER, DEFAULT_AUDIENCE } from '../src/pp/auth/sovereign/jwt.js';
import { SovereignSessionManager, hashRefreshToken, generatePlaintextRefreshToken } from '../src/pp/auth/sovereign/refresh.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';

describe('PP Sovereign Auth — Foundation (Phase 1 & Phase 2)', () => {
  describe('1. Password Hashing (timing-safe scrypt)', () => {
    it('generates non-empty, well-formatted scrypt hash', () => {
      const password = 'CorrectHorseBatteryStaple123!';
      const hash = hashPassword(password);
      expect(hash).toMatch(/^\$scrypt\$N=16384,r=8,p=1\$/);
      expect(hash.split('$').length).toBe(5);
    });

    it('verifies correct password successfully', () => {
      const password = 'SuperSecretDevPassword2026';
      const hash = hashPassword(password);
      expect(verifyPassword(password, hash)).toBe(true);
    });

    it('rejects wrong password', () => {
      const hash = hashPassword('OriginalPassword');
      expect(verifyPassword('WrongPassword', hash)).toBe(false);
    });

    it('handles malformed hashes safely without throwing unhandled exceptions', () => {
      expect(verifyPassword('pass', '')).toBe(false);
      expect(verifyPassword('pass', 'not-a-hash')).toBe(false);
      expect(verifyPassword('pass', '$scrypt$invalid$format')).toBe(false);
    });

    it('security: plaintext password is never exposed in hash output', () => {
      const plain = 'SecretPlaintext12345';
      const hash = hashPassword(plain);
      expect(hash.includes(plain)).toBe(false);
    });
  });

  describe('2. Key Management & JWKS', () => {
    it('initializes with active signing Ed25519 key and kid', () => {
      const km = new KeyManager();
      const current = km.getCurrentSigningKey();
      expect(current.kid).toMatch(/^pp-key-/);
      expect(current.publicKey).toBeDefined();
      expect(current.privateKey).toBeDefined();
    });

    it('exports public JWKS without exposing private keys', () => {
      const km = new KeyManager();
      const jwks = km.getJWKS();
      expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
      const key = jwks.keys[0];
      expect(key.kty).toBe('OKP');
      expect(key.crv).toBe('Ed25519');
      expect(key.kid).toBe(km.getCurrentSigningKey().kid);
      expect(key.x).toBeDefined();
      // SECURITY: private key parameter (d) must NOT exist in JWKS
      expect((key as any).d).toBeUndefined();
    });

    it('rotates signing key gracefully and retains previous key for verification', () => {
      const km = new KeyManager();
      const key1 = km.getCurrentSigningKey();

      const key2 = km.rotateKey();
      expect(key2.kid).not.toBe(key1.kid);
      expect(km.getCurrentSigningKey().kid).toBe(key2.kid);

      // Both keys must be present in JWKS
      const jwks = km.getJWKS();
      const kids = jwks.keys.map((k) => k.kid);
      expect(kids).toContain(key1.kid);
      expect(kids).toContain(key2.kid);

      // Previous key can still be resolved for verification
      expect(km.getVerificationKey(key1.kid)).toBeDefined();
      expect(km.getVerificationKey(key2.kid)).toBeDefined();
      expect(km.getVerificationKey('unknown-kid')).toBeNull();
    });
  });

  describe('3. Asymmetric JWT (Ed25519 / EdDSA)', () => {
    let keyManager: KeyManager;

    beforeEach(() => {
      keyManager = new KeyManager();
    });

    it('signs and verifies a valid access token in-memory', () => {
      const token = signAccessToken(keyManager, {
        userId: 'user-1234-uuid',
        sessionId: 'session-5678-uuid',
      });

      const res = verifyAccessToken(keyManager, token);
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.claims.sub).toBe('user-1234-uuid');
        expect(res.claims.sid).toBe('session-5678-uuid');
        expect(res.claims.iss).toBe(DEFAULT_ISSUER);
        expect(res.claims.aud).toBe(DEFAULT_AUDIENCE);
        expect(res.claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
      }
    });

    it('rejects expired tokens', () => {
      const expiredToken = signAccessToken(keyManager, {
        userId: 'user-expired',
        sessionId: 'session-expired',
        ttlSeconds: -10, // already expired
      });

      const res = verifyAccessToken(keyManager, expiredToken);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.error).toBe('Token has expired');
      }
    });

    it('rejects tokens signed with unknown or untrusted keys', () => {
      const otherKeyManager = new KeyManager();
      const alienToken = signAccessToken(otherKeyManager, {
        userId: 'alien-user',
        sessionId: 'alien-session',
      });

      const res = verifyAccessToken(keyManager, alienToken);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.error).toMatch(/Unknown key identifier/);
      }
    });

    it('rejects tokens with forged or tampered payloads', () => {
      const token = signAccessToken(keyManager, {
        userId: 'real-user',
        sessionId: 'real-session',
      });

      const [h, p, s] = token.split('.');
      const tamperedPayload = Buffer.from(JSON.stringify({ sub: 'attacker', iss: DEFAULT_ISSUER, aud: DEFAULT_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 900 })).toString('base64url');
      const tamperedToken = `${h}.${tamperedPayload}.${s}`;

      const res = verifyAccessToken(keyManager, tamperedToken);
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.error).toBe('Invalid cryptographic signature');
      }
    });

    it('rejects tokens with mismatched issuer or audience', () => {
      const token = signAccessToken(keyManager, {
        userId: 'user-1',
        sessionId: 'sess-1',
        issuer: 'https://evil.site',
      });

      const res = verifyAccessToken(keyManager, token, { expectedIssuer: DEFAULT_ISSUER });
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.error).toMatch(/Issuer mismatch/);
      }
    });

    it('verifies tokens signed before a key rotation (previous key compatibility)', () => {
      const oldToken = signAccessToken(keyManager, {
        userId: 'user-pre-rotation',
        sessionId: 'sess-pre-rotation',
      });

      // Rotate key
      keyManager.rotateKey();

      // Old token must still be validly verified using previous key
      const res = verifyAccessToken(keyManager, oldToken);
      expect(res.valid).toBe(true);
      if (res.valid) {
        expect(res.claims.sub).toBe('user-pre-rotation');
      }
    });
  });

  describe('4. Refresh Token Security & Lifecycle (Mock DB Pool)', () => {
    let keyManager: KeyManager;
    let mockDb: any[];
    let mockPool: any;
    let sessionManager: SovereignSessionManager;

    beforeEach(() => {
      keyManager = new KeyManager();
      mockDb = [];
      mockPool = {
        query: async (sql: string, params: any[]) => {
          if (sql.includes('INSERT INTO auth_sessions')) {
            const row = {
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
            mockDb.push(row);
            return { rows: [row] };
          }
          if (sql.includes('SELECT * FROM auth_sessions WHERE refresh_token_hash = $1')) {
            const found = mockDb.filter((r) => r.refresh_token_hash === params[0]);
            return { rows: found };
          }
          if (sql.includes('UPDATE auth_sessions') && sql.includes('WHERE id = $1')) {
            for (const r of mockDb) {
              if (r.id === params[0]) r.revoked_at = new Date();
            }
            return { rowCount: 1 };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1')) {
            let count = 0;
            for (const r of mockDb) {
              if (r.family_id === params[0]) {
                r.revoked_at = new Date();
                count++;
              }
            }
            return { rowCount: count };
          }
          if (sql.includes('UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1')) {
            let count = 0;
            for (const r of mockDb) {
              if (r.user_id === params[0]) {
                r.revoked_at = new Date();
                count++;
              }
            }
            return { rowCount: count };
          }
          return { rows: [] };
        },
      };

      sessionManager = new SovereignSessionManager(mockPool, keyManager);
    });

    it('creates a session with hashed refresh token; plaintext is never persisted in DB', async () => {
      const tokens = await sessionManager.createSession({ userId: 'user-sovereign-1' });

      expect(tokens.accessToken).toBeDefined();
      expect(tokens.refreshToken).toMatch(/^rt_/);
      expect(mockDb.length).toBe(1);

      const stored = mockDb[0];
      expect(stored.user_id).toBe('user-sovereign-1');
      // SECURITY: Database stores ONLY hash, never plaintext
      expect(stored.refresh_token_hash).toBe(hashRefreshToken(tokens.refreshToken));
      expect(stored.refresh_token_hash).not.toBe(tokens.refreshToken);
    });

    it('rotates refresh token successfully and invalidates previous session', async () => {
      const initial = await sessionManager.createSession({ userId: 'user-rot-1' });
      const initialSessionId = initial.sessionId;

      const refreshRes = await sessionManager.rotateRefreshToken(initial.refreshToken);
      expect(refreshRes.success).toBe(true);
      expect(refreshRes.tokens).toBeDefined();

      const newTokens = refreshRes.tokens!;
      expect(newTokens.refreshToken).not.toBe(initial.refreshToken);

      // Previous session must be marked revoked
      const oldSession = mockDb.find((s) => s.id === initialSessionId);
      expect(oldSession.revoked_at).not.toBeNull();

      // New session must be active and linked via rotated_from
      const newSession = mockDb.find((s) => s.id === newTokens.sessionId);
      expect(newSession.revoked_at).toBeNull();
      expect(newSession.rotated_from).toBe(initialSessionId);
      expect(newSession.family_id).toBe(oldSession.family_id);
    });

    it('detects token reuse and revokes entire family immediately', async () => {
      const initial = await sessionManager.createSession({ userId: 'victim-user' });

      // Legitimate user rotates token
      const legitRefresh = await sessionManager.rotateRefreshToken(initial.refreshToken);
      expect(legitRefresh.success).toBe(true);

      // Attacker tries to use the old initial refresh token again
      const attackRes = await sessionManager.rotateRefreshToken(initial.refreshToken);
      expect(attackRes.success).toBe(false);
      expect(attackRes.error).toBe('REUSE_DETECTED');

      // The entire family (including legitimate new session) must be revoked
      const familyId = attackRes.reusedFamilyId;
      const familySessions = mockDb.filter((s) => s.family_id === familyId);
      expect(familySessions.length).toBe(2);
      expect(familySessions.every((s) => s.revoked_at !== null)).toBe(true);
    });

    it('revokes session on user logout', async () => {
      const session = await sessionManager.createSession({ userId: 'logout-user' });
      await sessionManager.revokeSession(session.sessionId);

      const stored = mockDb.find((s) => s.id === session.sessionId);
      expect(stored.revoked_at).not.toBeNull();

      // Attempting to refresh after logout should trigger reuse/revoked handling
      const res = await sessionManager.rotateRefreshToken(session.refreshToken);
      expect(res.success).toBe(false);
      expect(res.error).toBe('REUSE_DETECTED');
    });
  });

  describe('5. SovereignAuthProvider Integration', () => {
    it('verifies access tokens issued by Sovereign provider', async () => {
      const mockPool: any = { query: async () => ({ rows: [] }) };
      const keyManager = new KeyManager();
      const provider = new SovereignAuthProvider(mockPool, keyManager);

      const token = signAccessToken(keyManager, {
        userId: 'sovereign-user-999',
        sessionId: 'sess-999',
      });

      const user = await provider.verifyAccessToken(token);
      expect(user).toBeDefined();
      expect(user?.id).toBe('sovereign-user-999');
      expect(user?.role).toBeUndefined();
    });
  });
});
