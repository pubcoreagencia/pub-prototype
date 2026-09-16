import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import * as sovereignAuth from '../src/pp/ui/sovereign-auth.js';

describe('PP Sovereign Auth — Client Session Bootstrap & 401 Recovery', () => {
  beforeEach(() => {
    sovereignAuth.clearAuthSession();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    sovereignAuth.clearAuthSession();
    vi.restoreAllMocks();
  });

  it('bootstrapSession succeeds when HttpOnly refresh token cookie can rotate', async () => {
    const mockUser = {
      id: 'u-123',
      email: 'tester@pubprototype.dev',
      name: 'Tester',
      avatarUrl: null,
      status: 'ACTIVE',
      createdAt: '2026-09-16T00:00:00.000Z',
      updatedAt: '2026-09-16T00:00:00.000Z',
    };
    const mockWorkspaces = [
      { id: 'ws-1', name: 'Studio', slug: 'studio', role: 'OWNER' },
    ];

    // Mock global fetch
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/prototype/auth/refresh') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accessToken: 'token-rotated-abc',
            tokenType: 'Bearer',
            expiresIn: 900,
          }),
        } as any;
      }
      if (url === '/prototype/auth/me') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            user: mockUser,
            workspaces: mockWorkspaces,
          }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    globalThis.fetch = fetchMock;

    const session = await sovereignAuth.bootstrapSession();

    expect(session).not.toBeNull();
    expect(session?.user.id).toBe('u-123');
    expect(session?.workspaces.length).toBe(1);
    expect(sovereignAuth.getAccessToken()).toBe('token-rotated-abc');
  });

  it('bootstrapSession returns null and clears state if refresh cookie is invalid or absent', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/prototype/auth/refresh') {
        return {
          ok: false,
          status: 401,
          json: async () => ({ error: 'UNAUTHORIZED' }),
        } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    globalThis.fetch = fetchMock;

    const session = await sovereignAuth.bootstrapSession();

    expect(session).toBeNull();
    expect(sovereignAuth.getAccessToken()).toBeNull();
  });

  it('sovereignFetch automatically retries once on 401 after rotating refresh token without infinite loop', async () => {
    sovereignAuth.setAccessToken('old-stale-token');

    let apiCallCount = 0;
    let refreshCallCount = 0;

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/prototype/auth/refresh') {
        refreshCallCount++;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            accessToken: 'new-fresh-token',
            tokenType: 'Bearer',
            expiresIn: 900,
          }),
        } as any;
      }

      if (url === '/prototype/sessions') {
        apiCallCount++;
        const headers = new Headers(init?.headers);
        const auth = headers.get('Authorization');

        if (auth === 'Bearer old-stale-token') {
          return { ok: false, status: 401, json: async () => ({ error: 'UNAUTHORIZED' }) } as any;
        }

        if (auth === 'Bearer new-fresh-token') {
          return { ok: true, status: 200, json: async () => ({ data: 'success' }) } as any;
        }
      }

      return { ok: false, status: 404 } as any;
    });

    globalThis.fetch = fetchMock;

    const res = await sovereignAuth.sovereignFetch('/prototype/sessions');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ data: 'success' });

    expect(apiCallCount).toBe(2); // Original 401 + exactly 1 retry
    expect(refreshCallCount).toBe(1); // 1 token refresh
    expect(sovereignAuth.getAccessToken()).toBe('new-fresh-token');
  });

  it('sovereignFetch stops retrying if token refresh also fails, preventing infinite loops', async () => {
    sovereignAuth.setAccessToken('expired-token');

    let apiCallCount = 0;

    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/prototype/auth/refresh') {
        return { ok: false, status: 401, json: async () => ({ error: 'UNAUTHORIZED' }) } as any;
      }
      if (url === '/prototype/sessions') {
        apiCallCount++;
        return { ok: false, status: 401, json: async () => ({ error: 'UNAUTHORIZED' }) } as any;
      }
      return { ok: false, status: 404 } as any;
    });

    globalThis.fetch = fetchMock;

    const res = await sovereignAuth.sovereignFetch('/prototype/sessions');
    expect(res.status).toBe(401);
    expect(apiCallCount).toBe(1); // Never retried because refresh failed
    expect(sovereignAuth.getAccessToken()).toBeNull();
  });
});
