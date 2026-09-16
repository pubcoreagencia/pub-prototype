import { describe, it, expect } from 'vitest';
import { SovereignSessionManager } from '../src/pp/auth/sovereign/refresh.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';

describe('GATE 3 · Concurrent Refresh Linearizability (Race Condition Test)', () => {
  it('strictly linearizes concurrent rotation requests: only one succeeds, the second triggers reuse detection', async () => {
    // Simulated PostgreSQL with realistic serialized / atomic UPDATE ... WHERE revoked_at IS NULL semantics
    const db: any[] = [];
    let lockActive = false;

    const mockPool: any = {
      query: async (sql: string, params: any[]) => {
        // Simulate small asynchronous I/O delay
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 10) + 1));

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
          db.push(row);
          return { rows: [row], rowCount: 1 };
        }

        if (sql.includes('SELECT * FROM auth_sessions WHERE refresh_token_hash = $1')) {
          const rows = db.filter((r) => r.refresh_token_hash === params[0]);
          return { rows };
        }

        // ATOMIC CAS (Compare-And-Swap) in PostgreSQL:
        // UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL
        if (sql.includes('UPDATE auth_sessions SET revoked_at = now()') && sql.includes('WHERE id = $1 AND revoked_at IS NULL')) {
          let updated = 0;
          for (const r of db) {
            if (r.id === params[0] && r.revoked_at === null) {
              r.revoked_at = new Date();
              updated++;
            }
          }
          return { rowCount: updated };
        }

        if (sql.includes('UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1')) {
          let updated = 0;
          for (const r of db) {
            if (r.family_id === params[0] && r.revoked_at === null) {
              r.revoked_at = new Date();
              updated++;
            }
          }
          return { rowCount: updated };
        }

        return { rows: [], rowCount: 0 };
      },
    };

    const keyManager = new KeyManager();
    const sessionManager = new SovereignSessionManager(mockPool, keyManager);

    // 1. Issue initial session
    const initial = await sessionManager.createSession({ userId: 'user-concurrent-test' });
    const sharedRefreshToken = initial.refreshToken;

    // 2. Fire Request A and Request B concurrently with the exact same refresh token
    const [resultA, resultB] = await Promise.all([
      sessionManager.rotateRefreshToken(sharedRefreshToken),
      sessionManager.rotateRefreshToken(sharedRefreshToken),
    ]);

    // 3. Exactly ONE request must succeed; the other MUST fail with REUSE_DETECTED
    const successes = [resultA, resultB].filter((r) => r.success);
    const failures = [resultA, resultB].filter((r) => !r.success);

    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0].error).toBe('REUSE_DETECTED');
  });
});
