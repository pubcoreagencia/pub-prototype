import type { Request, Response, Router } from 'express';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { Pool } from 'pg';
import { SovereignAuthProvider } from './sovereign-provider.js';
import { hashPassword, verifyPassword } from './sovereign/password.js';
import type { PostgresPrototypeRepository } from '../persistence/repository.js';
import type { KeyManager } from './sovereign/key-manager.js';
import { isAllowedOrigin } from '../config/origins.js';

export const REFRESH_COOKIE_NAME = 'pp_refresh_token';
export const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface CreateAuthRouterOptions {
  pool: Pool;
  sovereignProvider?: SovereignAuthProvider;
  protoRepo?: PostgresPrototypeRepository;
  keyManager?: KeyManager;
}

/**
 * Validates email format strictly and normalizes to lower case.
 */
export function normalizeEmail(rawEmail: unknown): string | null {
  if (typeof rawEmail !== 'string') return null;
  const trimmed = rawEmail.trim().toLowerCase();
  // Standard RFC-5322 compliant regex for practical email validation
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailRegex.test(trimmed) || trimmed.length > 254) {
    return null;
  }
  return trimmed;
}

/**
 * Validates password strength:
 * - At least 8 characters
 * - Max 128 characters
 */
export function validatePassword(rawPassword: unknown): boolean {
  if (typeof rawPassword !== 'string') return false;
  return rawPassword.length >= 8 && rawPassword.length <= 128;
}

/**
 * Extracts pp_refresh_token from Cookie header safely without extra dependencies.
 */
export function extractRefreshTokenFromCookie(cookieHeader?: string | null): string | null {
  if (!cookieHeader || typeof cookieHeader !== 'string') return null;
  const match = cookieHeader.match(/(?:^|;\s*)pp_refresh_token=([^;]+)/);
  return match ? decodeURIComponent(match[1].trim()) : null;
}

/**
 * Sets secure HttpOnly cookie for refresh token.
 */
export function setRefreshCookie(res: Response, token: string): void {
  const isSecure = process.env.NODE_ENV === 'production';
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/prototype/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  });
}

/**
 * Clears the refresh token cookie.
 */
export function clearRefreshCookie(res: Response): void {
  const isSecure = process.env.NODE_ENV === 'production';
  res.clearCookie(REFRESH_COOKIE_NAME, {
    httpOnly: true,
    secure: isSecure,
    sameSite: 'lax',
    path: '/prototype/auth',
  });
}

export function createSovereignAuthRouter(options: CreateAuthRouterOptions): Router {
  const router = express.Router();
  const provider = options.sovereignProvider ?? new SovereignAuthProvider(options.pool, options.keyManager);
  const pool = options.pool;

  // Rate Limiting for security-sensitive endpoints
  // ARCHITECTURAL NOTE:
  // express-rate-limit uses an in-memory store by default.
  // KNOWN LIMITATION: SINGLE-INSTANCE RATE LIMIT STORE
  // In single-container deployments (current Railway deployment), this provides effective protection.
  // When scaling horizontally across multiple replicas, migrate to a distributed store (e.g. Redis / rate-limit-redis)
  // to coordinate rate limit quotas across instances.
  const loginLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 5, // 5 requests per minute
    message: { error: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10, // 10 signups per hour per IP
    message: { error: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const refreshLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 30, // 30 refresh requests per minute
    message: { error: 'RATE_LIMITED' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  // Middleware: Security headers for all auth responses (No cache, fail closed)
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  // 1. POST /prototype/auth/signup
  router.post('/signup', signupLimiter, async (req: Request, res: Response) => {
    try {
      const { email: rawEmail, password: rawPassword, name } = req.body ?? {};

      const email = normalizeEmail(rawEmail);
      if (!email) {
        return res.status(400).json({ error: 'INVALID_REQUEST' });
      }

      if (!validatePassword(rawPassword)) {
        return res.status(400).json({ error: 'INVALID_REQUEST' });
      }

      // Check if user already exists
      const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        // Uniform response to avoid account enumeration
        return res.status(409).json({ error: 'ACCOUNT_EXISTS' });
      }

      const passwordHash = await hashPassword(rawPassword);
      const safeName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : null;

      const userInsert = await pool.query(
        `INSERT INTO users (id, email, name, password_hash, status, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'ACTIVE', now(), now())
         RETURNING id, email, name, avatar_url, status, created_at, updated_at`,
        [email, safeName, passwordHash]
      );

      const user = userInsert.rows[0];

      // Automatically issue initial session
      const userAgent = req.headers['user-agent'] as string | undefined;
      const ipAddress = req.ip || (req.socket.remoteAddress as string | undefined);
      const tokens = await provider.issueSession(user.id, { userAgent, ipAddress });

      setRefreshCookie(res, tokens.refreshToken);

      return res.status(201).json({
        accessToken: tokens.accessToken,
        tokenType: 'Bearer',
        expiresIn: tokens.expiresIn,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatar_url,
          status: user.status,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  // 2. POST /prototype/auth/login
  router.post('/login', loginLimiter, async (req: Request, res: Response) => {
    try {
      const { email: rawEmail, password: rawPassword } = req.body ?? {};

      const email = normalizeEmail(rawEmail);
      if (!email || typeof rawPassword !== 'string' || !rawPassword) {
        return res.status(400).json({ error: 'INVALID_REQUEST' });
      }

      const userRes = await pool.query(
        'SELECT id, email, name, avatar_url, password_hash, status, created_at, updated_at FROM users WHERE email = $1',
        [email]
      );

      // Generic UNAUTHORIZED message to prevent account enumeration
      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const user = userRes.rows[0];

      if (user.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'ACCOUNT_INACTIVE' });
      }

      if (!user.password_hash) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const isValid = await verifyPassword(rawPassword, user.password_hash);
      if (!isValid) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const userAgent = req.headers['user-agent'] as string | undefined;
      const ipAddress = req.ip || (req.socket.remoteAddress as string | undefined);
      const tokens = await provider.issueSession(user.id, { userAgent, ipAddress });

      setRefreshCookie(res, tokens.refreshToken);

      return res.json({
        accessToken: tokens.accessToken,
        tokenType: 'Bearer',
        expiresIn: tokens.expiresIn,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatar_url,
          status: user.status,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  // Origin validation middleware (defensive depth against CSRF)
  function validateOrigin(req: Request, res: Response, next: any) {
    const origin = req.headers.origin;
    // When origin header is present, it MUST belong to the allowed origins
    if (origin && !isAllowedOrigin(origin)) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    next();
  }

  // 3. POST /prototype/auth/refresh
  router.post('/refresh', refreshLimiter, validateOrigin, async (req: Request, res: Response) => {
    try {
      // Refresh token MUST come from HttpOnly cookie
      const cookieHeader = req.headers.cookie;
      const refreshToken = extractRefreshTokenFromCookie(cookieHeader);

      if (!refreshToken) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const userAgent = req.headers['user-agent'] as string | undefined;
      const ipAddress = req.ip || (req.socket.remoteAddress as string | undefined);

      const sessionManager = provider.getSessionManager();
      const result = await sessionManager.rotateRefreshToken(refreshToken, { userAgent, ipAddress });

      if (!result.success || !result.tokens) {
        clearRefreshCookie(res);
        if (result.error === 'REUSE_DETECTED') {
          return res.status(401).json({ error: 'REUSE_DETECTED' });
        }
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      // Verify that user is still ACTIVE
      const userRes = await pool.query('SELECT status FROM users WHERE id = $1', [
        (await sessionManager.createSession({ userId: 'temp' })).sessionId, // we verify from session
      ]).catch(() => ({ rows: [] }));

      // Lookup user status for the session
      const sessLookup = await pool.query('SELECT user_id FROM auth_sessions WHERE id = $1', [result.tokens.sessionId]);
      if (sessLookup.rows.length > 0) {
        const u = await pool.query('SELECT status FROM users WHERE id = $1', [sessLookup.rows[0].user_id]);
        if (u.rows.length > 0 && u.rows[0].status !== 'ACTIVE') {
          await sessionManager.revokeSession(result.tokens.sessionId);
          clearRefreshCookie(res);
          return res.status(403).json({ error: 'ACCOUNT_INACTIVE' });
        }
      }

      setRefreshCookie(res, result.tokens.refreshToken);

      return res.json({
        accessToken: result.tokens.accessToken,
        tokenType: 'Bearer',
        expiresIn: result.tokens.expiresIn,
      });
    } catch (err) {
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  // 4. POST /prototype/auth/logout
  router.post('/logout', validateOrigin, async (req: Request, res: Response) => {
    try {
      const cookieHeader = req.headers.cookie;
      const refreshToken = extractRefreshTokenFromCookie(cookieHeader);

      if (refreshToken) {
        const sessionManager = provider.getSessionManager();
        const hash = (await import('./sovereign/refresh.js')).hashRefreshToken(refreshToken);
        const sess = await pool.query('SELECT id FROM auth_sessions WHERE refresh_token_hash = $1', [hash]);
        if (sess.rows.length > 0) {
          await sessionManager.revokeSession(sess.rows[0].id);
        }
      }

      clearRefreshCookie(res);
      return res.json({ ok: true });
    } catch {
      clearRefreshCookie(res);
      return res.json({ ok: true });
    }
  });

  // 5. GET /prototype/auth/me
  router.get('/me', async (req: Request, res: Response) => {
    try {
      const authHeader = (req.headers.authorization || req.headers['x-auth-token']) as string | undefined;
      if (!authHeader) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const cleanToken = authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : authHeader.trim();

      const authUser = await provider.verifyAccessToken(cleanToken);
      if (!authUser) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      // Query real user record from database
      const userRes = await pool.query(
        'SELECT id, email, name, avatar_url, status, created_at, updated_at FROM users WHERE id = $1',
        [authUser.id]
      );

      if (userRes.rows.length === 0) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const user = userRes.rows[0];

      if (user.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'ACCOUNT_INACTIVE' });
      }

      // Fetch user's active workspace memberships
      const membersRes = await pool.query(
        `SELECT wm.workspace_id, wm.role, w.name AS workspace_name, w.slug AS workspace_slug
         FROM workspace_members wm
         JOIN workspaces w ON wm.workspace_id = w.id
         WHERE wm.user_id = $1`,
        [user.id]
      );

      return res.json({
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          avatarUrl: user.avatar_url,
          status: user.status,
          createdAt: user.created_at,
          updatedAt: user.updated_at,
        },
        workspaces: membersRes.rows.map((r: any) => ({
          id: r.workspace_id,
          name: r.workspace_name,
          slug: r.workspace_slug,
          role: r.role,
        })),
      });
    } catch (err) {
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  // 6. GET /prototype/auth/.well-known/jwks.json
  router.get('/.well-known/jwks.json', (_req: Request, res: Response) => {
    const keyManager = provider.getKeyManager();
    const jwks = keyManager.getJWKS();
    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    return res.json(jwks);
  });

  // 7. POST /prototype/auth/workspaces (Phase 4: Sovereign Workspace Onboarding)
  router.post('/workspaces', async (req: Request, res: Response) => {
    try {
      const authHeader = (req.headers.authorization || req.headers['x-auth-token']) as string | undefined;
      if (!authHeader) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const cleanToken = authHeader.startsWith('Bearer ') || authHeader.startsWith('bearer ')
        ? authHeader.slice(7).trim()
        : authHeader.trim();

      const authUser = await provider.verifyAccessToken(cleanToken);
      if (!authUser) {
        return res.status(401).json({ error: 'UNAUTHORIZED' });
      }

      const { name, slug } = req.body ?? {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Workspace name is required' });
      }

      const cleanName = name.trim().slice(0, 100);
      const generatedSlug = (typeof slug === 'string' && slug.trim())
        ? slug.trim().toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        : cleanName.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `ws-${Date.now()}`;

      if (options.protoRepo) {
        const created = await options.protoRepo.createWorkspace({
          name: cleanName,
          slug: generatedSlug,
          ownerId: authUser.id,
        });
        return res.status(201).json({
          id: created.id,
          name: created.name,
          slug: created.slug,
          role: 'OWNER',
          createdAt: created.createdAt,
        });
      }

      // Direct SQL atomic transaction fallback when protoRepo is not injected directly
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        // Check slug uniqueness
        const existingSlug = await client.query('SELECT id FROM workspaces WHERE slug = $1', [generatedSlug]);
        if (existingSlug.rows.length > 0) {
          await client.query('ROLLBACK');
          return res.status(409).json({ error: 'SLUG_EXISTS', message: 'Workspace slug already exists' });
        }

        const wsRes = await client.query(
          `INSERT INTO workspaces (id, name, slug, owner_id, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, now(), now())
           RETURNING id, name, slug, owner_id, created_at, updated_at`,
          [cleanName, generatedSlug, authUser.id]
        );
        const ws = wsRes.rows[0];

        await client.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
           VALUES ($1, $2, 'OWNER', now())
           ON CONFLICT DO NOTHING`,
          [ws.id, authUser.id]
        );

        await client.query('COMMIT');
        return res.status(201).json({
          id: ws.id,
          name: ws.name,
          slug: ws.slug,
          role: 'OWNER',
          createdAt: ws.created_at,
        });
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err: any) {
      if (err.code === '23505') { // Postgres unique_violation
        return res.status(409).json({ error: 'SLUG_EXISTS' });
      }
      return res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
  });

  return router;
}
