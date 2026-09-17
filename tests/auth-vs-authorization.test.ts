import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Server } from 'http';
import { createPpApp } from '../src/pp/api/entry.js';
import { isAllowedOrigin } from '../src/pp/config/origins.js';

describe('Authentication 401 vs Authorization 403 Semantics', () => {
  let app: any;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    app = createPpApp();
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe('Origin Allowlist', () => {
    it('allows Railway production domain in origin validator', () => {
      expect(isAllowedOrigin('https://pp-api-production-24bc.up.railway.app')).toBe(true);
      expect(isAllowedOrigin('https://pubcore.site')).toBe(true);
      expect(isAllowedOrigin('http://localhost:3000')).toBe(true);
      expect(isAllowedOrigin('https://malicious-site.com')).toBe(false);
    });
  });

  describe('Auth 401 vs 403 API Responses', () => {
    it('returns 401 Unauthorized when no authentication token is provided', async () => {
      const res = await fetch(`${baseUrl}/prototype/sessions/test-session-id/prompts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'Create test app' }),
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain('Unauthorized');
    });

    it('returns 401 Unauthorized when invalid authentication token is provided', async () => {
      const res = await fetch(`${baseUrl}/prototype/sessions/test-session-id/prompts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer invalid-garbage-token',
        },
        body: JSON.stringify({ prompt: 'Create test app' }),
      });

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain('Unauthorized');
    });

    it('returns 404 Not Found when session does not exist', async () => {
      const res = await fetch(`${baseUrl}/prototype/sessions/non-existent-session-id/prompts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify({ prompt: 'Create test app' }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('Session not found');
    });

    it('returns 403 Forbidden (not 401) when user has insufficient role / lack of permissions for session', async () => {
      const createRes = await fetch(`${baseUrl}/prototype/sessions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-token',
        },
        body: JSON.stringify({ project: 'test-project-permissions' }),
      });

      expect(createRes.status).toBe(201);
      const session = await createRes.json();
      const sessionId = session.id;

      // viewer-user-id has VIEWER role, not MEMBER role required to post prompts
      const promptRes = await fetch(`${baseUrl}/prototype/sessions/${sessionId}/prompts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer viewer-user-id',
        },
        body: JSON.stringify({ prompt: 'Create test app' }),
      });

      expect(promptRes.status).toBe(403);
      const promptData = await promptRes.json();
      expect(promptData.error).toContain('Forbidden');
    });
  });
});
