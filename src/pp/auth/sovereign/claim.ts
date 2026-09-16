import crypto from 'node:crypto';
import type { Pool } from 'pg';
import { hashPassword } from './password.js';

export interface EmailDeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface SendClaimEmailOptions {
  to: string;
  claimToken: string;
  claimUrl: string;
}

/**
 * Provider-independent email delivery adapter interface.
 */
export interface EmailAdapter {
  sendClaimEmail(options: SendClaimEmailOptions): Promise<EmailDeliveryResult>;
}

/**
 * Default No-op email adapter when no external transactional email service is configured.
 * Safely does not transmit emails and logs delivery status in development/test if requested.
 */
export class NoopEmailAdapter implements EmailAdapter {
  private readonly logToConsole: boolean;

  constructor(options?: { logToConsole?: boolean }) {
    this.logToConsole = options?.logToConsole ?? false;
  }

  async sendClaimEmail(options: SendClaimEmailOptions): Promise<EmailDeliveryResult> {
    if (this.logToConsole) {
      console.log(`[NoopEmailAdapter] Claim email dispatched to <${options.to}> with link: ${options.claimUrl}`);
    }
    return { success: true, messageId: `noop-${Date.now()}` };
  }
}

export interface ClaimTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface RequestClaimResult {
  success: boolean;
  message: string;
  rawToken?: string; // Only returned in test/internal mode, never exposed over public HTTP
}

export interface ConfirmClaimResult {
  userId: string;
  email: string;
  name?: string;
}

/**
 * Hashes raw claim token with SHA-256 for secure storage & lookup.
 */
export function hashClaimToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/**
 * Generates a cryptographically strong 32-byte claim token string prefixed with 'clm_'.
 */
export function generateClaimToken(): string {
  return `clm_${crypto.randomBytes(32).toString('hex')}`;
}

export class ClaimManager {
  private readonly pool: Pool;
  private readonly emailAdapter: EmailAdapter;
  private readonly tokenTtlMs: number;
  private readonly claimBaseUrl: string;

  constructor(options: {
    pool: Pool;
    emailAdapter?: EmailAdapter;
    tokenTtlMs?: number;
    claimBaseUrl?: string;
  }) {
    this.pool = options.pool;
    this.emailAdapter = options.emailAdapter ?? new NoopEmailAdapter();
    this.tokenTtlMs = options.tokenTtlMs ?? 60 * 60 * 1000; // 1 hour default
    this.claimBaseUrl = options.claimBaseUrl ?? 'https://pubprototype.internal/claim';
  }

  /**
   * Requests an account claim token for the given normalized email.
   * Enumeration-resistant: Always returns generic message whether email exists or not.
   */
  async requestClaim(email: string, options?: { exposeTokenForTesting?: boolean }): Promise<RequestClaimResult> {
    const genericResponse: RequestClaimResult = {
      success: true,
      message: 'If an eligible account exists with this email, an activation link has been sent.',
    };

    try {
      const userRes = await this.pool.query(
        'SELECT id, email, password_hash, status FROM users WHERE email = $1',
        [email]
      );

      // If user doesn't exist, return generic message without error
      if (userRes.rows.length === 0) {
        return genericResponse;
      }

      const user = userRes.rows[0];

      // If user is suspended, do not issue claim token
      if (user.status === 'SUSPENDED') {
        return genericResponse;
      }

      // Generate raw token and hash
      const rawToken = generateClaimToken();
      const tokenHash = hashClaimToken(rawToken);
      const expiresAt = new Date(Date.now() + this.tokenTtlMs);

      // Invalidate / revoke any prior unused claim tokens for this user
      await this.pool.query(
        'UPDATE account_claim_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL',
        [user.id]
      );

      // Insert new token
      await this.pool.query(
        `INSERT INTO account_claim_tokens (id, user_id, token_hash, expires_at, created_at)
         VALUES (gen_random_uuid(), $1, $2, $3, now())`,
        [user.id, tokenHash, expiresAt]
      );

      const claimUrl = `${this.claimBaseUrl}?token=${encodeURIComponent(rawToken)}`;
      await this.emailAdapter.sendClaimEmail({
        to: user.email,
        claimToken: rawToken,
        claimUrl,
      });

      if (options?.exposeTokenForTesting) {
        return {
          ...genericResponse,
          rawToken,
        };
      }

      return genericResponse;
    } catch (err: any) {
      console.warn('[ClaimManager] Error in requestClaim:', err.message);
      // Even on non-fatal DB errors, avoid leaking system details
      return genericResponse;
    }
  }

  /**
   * Confirms account claim:
   * 1. Validates token hash and checks single-use + expiry.
   * 2. Atomically marks token as used (`used_at = now()`) using CAS.
   * 3. Hashes new password with scrypt and updates `users` record.
   * 4. Returns user identity.
   */
  async confirmClaim(rawToken: string, rawPassword: string): Promise<ConfirmClaimResult> {
    if (!rawToken || typeof rawToken !== 'string' || !rawToken.trim()) {
      throw new Error('INVALID_OR_EXPIRED_TOKEN');
    }

    if (!rawPassword || typeof rawPassword !== 'string' || rawPassword.length < 8 || rawPassword.length > 128) {
      throw new Error('INVALID_PASSWORD');
    }

    const tokenHash = hashClaimToken(rawToken);
    const newPasswordHash = hashPassword(rawPassword);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Atomic CAS: Only update if token is not used and not expired
      const tokenRes = await client.query(
        `UPDATE account_claim_tokens
         SET used_at = now()
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
         RETURNING id, user_id`,
        [tokenHash]
      );

      if (tokenRes.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('INVALID_OR_EXPIRED_TOKEN');
      }

      const claimRecord = tokenRes.rows[0];

      // Update user password and ensure status is ACTIVE
      const userRes = await client.query(
        `UPDATE users
         SET password_hash = $1, status = 'ACTIVE', updated_at = now()
         WHERE id = $2
         RETURNING id, email, name`,
        [newPasswordHash, claimRecord.user_id]
      );

      if (userRes.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('USER_NOT_FOUND');
      }

      await client.query('COMMIT');

      const user = userRes.rows[0];
      return {
        userId: user.id,
        email: user.email,
        name: user.name,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
}
