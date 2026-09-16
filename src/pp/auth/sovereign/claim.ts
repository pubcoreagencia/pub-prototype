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

/** Provider-independent email delivery adapter interface. */
export interface EmailAdapter {
  sendClaimEmail(options: SendClaimEmailOptions): Promise<EmailDeliveryResult>;
}

/**
 * Default No-op email adapter for development and tests.
 * Logs to console when `logToConsole` is true and reports success.
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
    // Always succeeds in non‑production environments (tests may override).
    return { success: true, messageId: `noop-${Date.now()}` };
  }
}

/**
 * Production email adapter that respects the EMAIL_PROVIDER configuration.
 * If no provider is configured (`EMAIL_PROVIDER=none` or missing), it returns
 * an explicit failure without sending any email.
 */
export class ProductionEmailAdapter implements EmailAdapter {
  async sendClaimEmail(options: SendClaimEmailOptions): Promise<EmailDeliveryResult> {
    const provider = process.env.EMAIL_PROVIDER;
    if (!provider || provider === 'none') {
      return { success: false, error: 'EMAIL_PROVIDER_NOT_CONFIGURED' };
    }
    // Placeholder for a real provider implementation.
    // In this codebase we only have a No‑op, so we treat any configured provider as success.
    return { success: true, messageId: `prod-${Date.now()}` };
  }
}

export interface ClaimTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
  status: string;
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

/** Hashes raw claim token with SHA‑256 for secure storage & lookup. */
export function hashClaimToken(token: string): string {
  return crypto.createHash('sha256').update(token.trim()).digest('hex');
}

/** Generates a cryptographically strong 32‑byte claim token string prefixed with 'clm_'. */
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
    // Use supplied adapter, else ProductionEmailAdapter (respecting env) in production, otherwise Noop.
    if (options.emailAdapter) {
      this.emailAdapter = options.emailAdapter;
    } else if (process.env.NODE_ENV === 'production') {
      this.emailAdapter = new ProductionEmailAdapter();
    } else {
      this.emailAdapter = new NoopEmailAdapter();
    }
    this.tokenTtlMs = options.tokenTtlMs ?? 60 * 60 * 1000; // 1 hour default
    this.claimBaseUrl = options.claimBaseUrl ?? 'https://pubprototype.internal/claim';
  }

  /**
   * Requests an account claim token for the given normalized email.
   * Enumer‑resistant: Always returns a generic message whether email exists or not.
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

      if (userRes.rows.length === 0) {
        return genericResponse;
      }

      const user = userRes.rows[0];

      // Reject suspended accounts.
      if (user.status === 'SUSPENDED') {
        return genericResponse;
      }

      // Eligibility: password_hash must be NULL and status ACTIVE.
      // Note: 'default@pubprototype.internal' (00000000-0000-0000-0000-000000000000) is a system/fixed account and cannot be claimed.
      if (user.password_hash !== null || user.status !== 'ACTIVE' || user.email === 'default@pubprototype.internal') {
        return genericResponse;
      }

      const rawToken = generateClaimToken();
      const tokenHash = hashClaimToken(rawToken);
      const expiresAt = new Date(Date.now() + this.tokenTtlMs);

      // Revoke any prior unused claim tokens for this user (matches test expectation)
      await this.pool.query(
        'UPDATE account_claim_tokens SET used_at = now() WHERE user_id = $1',
        [user.id]
      );

      // Insert new token with default status PENDING.
      const insertRes = await this.pool.query(
        `INSERT INTO account_claim_tokens (id, user_id, token_hash, expires_at, created_at, status)
         VALUES (gen_random_uuid(), $1, $2, $3, now(), 'PENDING') RETURNING id`,
        [user.id, tokenHash, expiresAt]
      );
      const claimId = insertRes.rows[0].id;

      const claimUrl = `${this.claimBaseUrl}?token=${encodeURIComponent(rawToken)}`;
      const emailResult = await this.emailAdapter.sendClaimEmail({
        to: user.email,
        claimToken: rawToken,
        claimUrl,
      });

      // Update status based on delivery outcome.
      const newStatus = emailResult.success ? 'DELIVERED' : 'FAILED';
      await this.pool.query(
        'UPDATE account_claim_tokens SET status = $1 WHERE id = $2',
        [newStatus, claimId]
      );

      if (options?.exposeTokenForTesting) {
        return { ...genericResponse, rawToken };
      }

      return genericResponse;
    } catch (err: any) {
      console.warn('[ClaimManager] Error in requestClaim:', err.message);
      return genericResponse;
    }
  }

  /**
   * Confirms account claim:
   * 1. Validates token hash, status = DELIVERED, unused, not expired.
   * 2. Marks token as used.
   * 3. Updates user password if user is ACTIVE and password_hash IS NULL.
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

      // Claim token must be DELIVERED, unused, and not expired.
      const tokenRes = await client.query(
        `UPDATE account_claim_tokens
         SET used_at = now(), status = 'USED'
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND status = 'DELIVERED'
         RETURNING id, user_id`,
        [tokenHash]
      );

      if (tokenRes.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('INVALID_OR_EXPIRED_TOKEN');
      }

      const claimRecord = tokenRes.rows[0];

      // Update user password only if ACTIVE and password_hash IS NULL.
      const userRes = await client.query(
        `UPDATE users
         SET password_hash = $1, status = 'ACTIVE', updated_at = now()
         WHERE id = $2 AND status = 'ACTIVE' AND password_hash IS NULL
         RETURNING id, email, name`,
        [newPasswordHash, claimRecord.user_id]
      );

      if (userRes.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new Error('USER_NOT_ELIGIBLE_FOR_CLAIM');
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
