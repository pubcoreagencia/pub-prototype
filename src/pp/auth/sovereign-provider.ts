import type { Pool } from 'pg';
import type { AuthProvider } from './provider.js';
import type { AuthenticatedUser } from './auth.js';
import type { IssuedTokens } from './sovereign/types.js';
import { KeyManager } from './sovereign/key-manager.js';
import { verifyAccessToken } from './sovereign/jwt.js';
import { SovereignSessionManager } from './sovereign/refresh.js';

export class SovereignAuthProvider implements AuthProvider {
  readonly name = 'sovereign';
  private readonly keyManager: KeyManager;
  private readonly sessionManager: SovereignSessionManager;

  constructor(private readonly pool: Pool, keyManager?: KeyManager) {
    this.keyManager = keyManager ?? new KeyManager();
    this.sessionManager = new SovereignSessionManager(this.pool, this.keyManager);
  }

  getKeyManager(): KeyManager {
    return this.keyManager;
  }

  getSessionManager(): SovereignSessionManager {
    return this.sessionManager;
  }

  isConfigured(): boolean {
    return true;
  }

  /**
   * Fast in-memory asymmetric JWT verification (<0.5ms).
   * Does NOT query the database or remote HTTP endpoints.
   */
  async verifyAccessToken(token: string): Promise<AuthenticatedUser | null> {
    const result = verifyAccessToken(this.keyManager, token);
    if (!result.valid) {
      return null;
    }

    const { claims } = result;

    // Return lightweight authenticated user representation
    // Note: role is intentionally undefined; RBAC is resolved dynamically via workspace_members
    return {
      id: claims.sub,
      email: 'user@pubprototype.internal',
      name: null,
      avatarUrl: null,
      createdAt: new Date(claims.iat * 1000),
      updatedAt: new Date(),
    };
  }

  async issueSession(
    userId: string,
    metadata?: { userAgent?: string; ipAddress?: string }
  ): Promise<IssuedTokens> {
    return this.sessionManager.createSession({
      userId,
      userAgent: metadata?.userAgent,
      ipAddress: metadata?.ipAddress,
    });
  }

  async refreshSession(
    refreshToken: string,
    metadata?: { userAgent?: string; ipAddress?: string }
  ): Promise<IssuedTokens | null> {
    const res = await this.sessionManager.rotateRefreshToken(refreshToken, metadata);
    if (!res.success || !res.tokens) {
      return null;
    }
    return res.tokens;
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessionManager.revokeSession(sessionId);
  }
}
