import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createSovereignAuthRouter } from '../src/pp/auth/http.js';
import { KeyManager } from '../src/pp/auth/sovereign/key-manager.js';
import { SovereignAuthProvider } from '../src/pp/auth/sovereign-provider.js';

describe('PP Sovereign Auth — Rate Limiting Activation (Phase 3)', () => {
  let app: express.Express;

  beforeEach(() => {
    const mockPool: any = {
      query: vi.fn(async () => ({ rows: [] })),
    };
    const keyManager = new KeyManager();
    const provider = new SovereignAuthProvider(mockPool, keyManager);

    app = express();
    app.use(express.json());
    app.use('/prototype/auth', createSovereignAuthRouter({
      pool: mockPool,
      sovereignProvider: provider,
      keyManager,
    }));
  });

  async function makeRequest(path: string, body: any) {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address() as any;
          const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const raw = await res.text();
          let json: any = null;
          try { json = JSON.parse(raw); } catch { json = raw; }
          resolve({ status: res.status, body: json });
        } catch (e) {
          reject(e);
        } finally {
          server.close();
        }
      });
    });
  }

  it('activates 429 RATE_LIMITED after exceeding 5 login attempts within window', async () => {
    // 5 attempts should return 401 UNAUTHORIZED (bad credentials)
    for (let i = 0; i < 5; i++) {
      const res = await makeRequest('/prototype/auth/login', {
        email: 'user@test.com',
        password: 'Password123!',
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt must be rate limited
    const res6 = await makeRequest('/prototype/auth/login', {
      email: 'user@test.com',
      password: 'Password123!',
    });
    expect(res6.status).toBe(429);
    expect(res6.body).toEqual({ error: 'RATE_LIMITED' });
  });
});
