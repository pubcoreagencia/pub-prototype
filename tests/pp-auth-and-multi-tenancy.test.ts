import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AuthService } from '../src/pp/auth/auth.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import { createPpApp } from '../src/pp/api/entry.js';
import http from 'node:http';

describe('PP 2.0 — Auth & Multi-Tenancy (RBAC)', () => {
  let protoRepo: PostgresPrototypeRepository;
  let authService: AuthService;
  let app: any;
  let server: http.Server;
  let baseUrl: string;

  beforeEach(async () => {
    protoRepo = new PostgresPrototypeRepository();
    await protoRepo.initializeSchema();
    authService = new AuthService(protoRepo);
    app = createPpApp(undefined, undefined, protoRepo);

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  describe('RBAC Role Hierarchy', () => {
    it('enforces role privilege levels correctly', () => {
      // OWNER has full access
      expect(authService.hasRole('OWNER', 'OWNER')).toBe(true);
      expect(authService.hasRole('OWNER', 'ADMIN')).toBe(true);
      expect(authService.hasRole('OWNER', 'MEMBER')).toBe(true);
      expect(authService.hasRole('OWNER', 'VIEWER')).toBe(true);

      // ADMIN has admin, member, viewer access, not owner
      expect(authService.hasRole('ADMIN', 'OWNER')).toBe(false);
      expect(authService.hasRole('ADMIN', 'ADMIN')).toBe(true);
      expect(authService.hasRole('ADMIN', 'MEMBER')).toBe(true);
      expect(authService.hasRole('ADMIN', 'VIEWER')).toBe(true);

      // MEMBER has member, viewer access, not admin or owner
      expect(authService.hasRole('MEMBER', 'OWNER')).toBe(false);
      expect(authService.hasRole('MEMBER', 'ADMIN')).toBe(false);
      expect(authService.hasRole('MEMBER', 'MEMBER')).toBe(true);
      expect(authService.hasRole('MEMBER', 'VIEWER')).toBe(true);

      // VIEWER has read-only access
      expect(authService.hasRole('VIEWER', 'OWNER')).toBe(false);
      expect(authService.hasRole('VIEWER', 'ADMIN')).toBe(false);
      expect(authService.hasRole('VIEWER', 'MEMBER')).toBe(false);
      expect(authService.hasRole('VIEWER', 'VIEWER')).toBe(true);
    });
  });

  describe('Sovereign Local Authentication Fallback', () => {
    it('returns default local developer user in offline/local environments', async () => {
      const user = await authService.getUserFromToken('bearer test-token');
      expect(user).toBeDefined();
      expect(user?.email).toBe('dev@pubprototype.local');
      expect(user?.name).toBe('Default Developer');
    });

    it('identifies default user as OWNER of the default workspace', async () => {
      const role = await authService.getUserWorkspaceRole(
        '00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-000000000001'
      );
      expect(role).toBe('OWNER');
    });
  });

  describe('Auth HTTP Endpoints', () => {
    it('GET /api/auth/me returns the active authenticated user', async () => {
      const res = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { authorization: 'Bearer sovereign-token' },
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.user).toBeDefined();
      expect(data.user.email).toBe('dev@pubprototype.local');
    });

    it('POST /api/auth/login succeeds with credentials', async () => {
      const res = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'developer@example.com', password: 'password123' }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.token).toBeDefined();
      expect(data.user.email).toBe('developer@example.com');
    });

    it('POST /api/auth/logout returns ok status', async () => {
      const res = await fetch(`${baseUrl}/api/auth/logout`, { method: 'POST' });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.ok).toBe(true);
    });
  });
});
