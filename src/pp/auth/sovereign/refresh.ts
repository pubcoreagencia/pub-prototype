import crypto from 'node:crypto';
import type { Pool } from 'pg';
import type { AuthSession, IssuedTokens } from './types.js';
import type { KeyManager } from './key-manager.js';
import { signAccessToken } from './jwt.js';

export const AUTH_REFRESH_TOKEN_TTL_SECONDS = Number(process.env.AUTH_REFRESH_TOKEN_TTL || 30 * 24 * 3600); // 30 days

/**
 * Computes SHA-256 hash of a plaintext token for secure persistence.
 * Plaintext refresh token is NEVER persisted.
 */
export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Generates a cryptographically strong random refresh token string.
 */
export function generatePlaintextRefreshToken(): string {
  return `rt_${crypto.randomBytes(32).toString('hex')}`;
}

export interface CreateSessionParams {
  userId: string;
  userAgent?: string | null;
  ipAddress?: string | null;
  familyId?: string;
  rotatedFrom?: string | null;
}

export interface RefreshResult {
  success: boolean;
  tokens?: IssuedTokens;
  error?: 'EXPIRED' | 'REVOKED' | 'REUSE_DETECTED' | 'NOT_FOUND' | 'INVALID';
  reusedFamilyId?: string;
}

export class SovereignSessionManager {
  constructor(
    private readonly pool: Pool,
    private readonly keyManager: KeyManager
  ) {}

  /**
   * Creates a new auth session and issues an initial (accessToken, refreshToken) pair.
   */
  async createSession(params: CreateSessionParams): Promise<IssuedTokens> {
    const sessionId = crypto.randomUUID();
    const familyId = params.familyId || crypto.randomUUID();
    const plaintextRefresh = generatePlaintextRefreshToken();
    const refreshTokenHash = hashRefreshToken(plaintextRefresh);
    const expiresAt = new Date(Date.now() + AUTH_REFRESH_TOKEN_TTL_SECONDS * 1000);

    await this.pool.query(
      `INSERT INTO auth_sessions (
        id, user_id, refresh_token_hash, user_agent, ip_address, expires_at, revoked_at, created_at, last_active_at, family_id, rotated_from
      ) VALUES ($1, $2, $3, $4, $5, $6, NULL, now(), now(), $7, $8)`,
      [
        sessionId,
        params.userId,
        refreshTokenHash,
        params.userAgent ?? null,
        params.ipAddress ?? null,
        expiresAt,
        familyId,
        params.rotatedFrom ?? null,
      ]
    );

    const accessToken = signAccessToken(this.keyManager, {
      userId: params.userId,
      sessionId,
    });

    return {
      accessToken,
      refreshToken: plaintextRefresh,
      tokenType: 'Bearer',
      expiresIn: 900,
      sessionId,
    };
  }

  /**
   * Refreshes a session with strict rotation and reuse detection.
   */
  async rotateRefreshToken(
    plaintextToken: string,
    metadata?: { userAgent?: string | null; ipAddress?: string | null }
  ): Promise<RefreshResult> {
    if (!plaintextToken || typeof plaintextToken !== 'string') {
      return { success: false, error: 'INVALID' };
    }

    const tokenHash = hashRefreshToken(plaintextToken);

    // Look up session matching the presented refresh token hash
    const res = await this.pool.query(
      `SELECT * FROM auth_sessions WHERE refresh_token_hash = $1`,
      [tokenHash]
    );

    if (res.rows.length === 0) {
      return { success: false, error: 'NOT_FOUND' };
    }

    const session: AuthSession = {
      id: res.rows[0].id,
      userId: res.rows[0].user_id,
      refreshTokenHash: res.rows[0].refresh_token_hash,
      userAgent: res.rows[0].user_agent,
      ipAddress: res.rows[0].ip_address,
      expiresAt: new Date(res.rows[0].expires_at),
      revokedAt: res.rows[0].revoked_at ? new Date(res.rows[0].revoked_at) : null,
      createdAt: new Date(res.rows[0].created_at),
      lastActiveAt: new Date(res.rows[0].last_active_at),
      familyId: res.rows[0].family_id,
      rotatedFrom: res.rows[0].rotated_from,
    };

    // 1. REUSE DETECTION: If this session was already revoked (e.g. rotated previously),
    // someone is presenting an old refresh token -> compromise of the token family!
    if (session.revokedAt !== null) {
      // Invalidate the entire family immediately
      await this.revokeFamily(session.familyId);
      return {
        success: false,
        error: 'REUSE_DETECTED',
        reusedFamilyId: session.familyId,
      };
    }

    // 2. EXPIRATION CHECK
    if (session.expiresAt.getTime() <= Date.now()) {
      await this.revokeSession(session.id);
      return { success: false, error: 'EXPIRED' };
    }

    // 3. ATOMIC ROTATION (CAS): Only ONE concurrent caller can update revoked_at from NULL to now().
    // If rowCount === 0, another request beat us to it -> race condition / reuse detected!
    const updateRes = await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now(), last_active_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [session.id]
    );

    if (updateRes.rowCount === 0) {
      await this.revokeFamily(session.familyId);
      return {
        success: false,
        error: 'REUSE_DETECTED',
        reusedFamilyId: session.familyId,
      };
    }

    const newTokens = await this.createSession({
      userId: session.userId,
      userAgent: metadata?.userAgent ?? session.userAgent,
      ipAddress: metadata?.ipAddress ?? session.ipAddress,
      familyId: session.familyId,
      rotatedFrom: session.id,
    });

    return {
      success: true,
      tokens: newTokens,
    };
  }

  /**
   * Revokes a single session (e.g. user logout).
   */
  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId]
    );
  }

  /**
   * Revokes all sessions belonging to a specific family (e.g. after reuse detection).
   */
  async revokeFamily(familyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId]
    );
  }

  /**
   * Revokes all sessions for a user (e.g. password change or global logout).
   */
  async revokeAllUserSessions(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId]
    );
  }
}
