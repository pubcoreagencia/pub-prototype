import type { AuthProvider } from './provider.js';
import type { AuthenticatedUser } from './auth.js';
import type { IssuedTokens } from './sovereign/types.js';
import type { SovereignAuthProvider } from './sovereign-provider.js';
import type { SupabaseAuthProvider } from './supabase-provider.js';

/**
 * CompositeAuthProvider enables dual verification during Phase 4 parallel operation.
 * It inspects and verifies Sovereign Ed25519 JWTs as well as Supabase tokens.
 * This guarantees that when AUTH_PROVIDER=supabase remains configured in production,
 * claimed/sovereign-authenticated users can authenticate successfully against protected
 * backend routes without performing a premature global cutover.
 */
export class CompositeAuthProvider implements AuthProvider {
  readonly name = 'composite';

  constructor(
    private readonly sovereignProvider: SovereignAuthProvider,
    private readonly supabaseProvider: SupabaseAuthProvider
  ) {}

  isConfigured(): boolean {
    return this.sovereignProvider.isConfigured() || this.supabaseProvider.isConfigured();
  }

  getSovereignProvider(): SovereignAuthProvider {
    return this.sovereignProvider;
  }

  getSupabaseProvider(): SupabaseAuthProvider {
    return this.supabaseProvider;
  }

  async verifyAccessToken(token: string): Promise<AuthenticatedUser | null> {
    if (!token) return null;
    const cleanToken = token.startsWith('Bearer ') || token.startsWith('bearer ') ? token.slice(7).trim() : token.trim();
    if (!cleanToken) return null;

    // 1. Fast check if token appears to be an EdDSA / Sovereign JWT
    // Sovereign JWTs are 3 base64url segments with header alg: 'EdDSA' and kid starting with 'pp-key-'
    const parts = cleanToken.split('.');
    if (parts.length === 3) {
      try {
        let b64 = parts[0].replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        const headerJson = Buffer.from(b64, 'base64').toString('utf8');
        const header = JSON.parse(headerJson);

        if (header.alg === 'EdDSA' || (typeof header.kid === 'string' && header.kid.startsWith('pp-key-'))) {
          const sovereignUser = await this.sovereignProvider.verifyAccessToken(cleanToken);
          if (sovereignUser) {
            return sovereignUser;
          }
        }
      } catch {
        // Fall through to standard verification attempts
      }
    }

    // 2. Try primary/Sovereign provider verification
    const sovereignUser = await this.sovereignProvider.verifyAccessToken(cleanToken);
    if (sovereignUser) {
      return sovereignUser;
    }

    // 3. Fallback to Supabase provider verification
    if (this.supabaseProvider.isConfigured()) {
      const supabaseUser = await this.supabaseProvider.verifyAccessToken(cleanToken);
      if (supabaseUser) {
        return supabaseUser;
      }
    }

    return null;
  }

  async issueSession(userId: string, metadata?: { userAgent?: string; ipAddress?: string }): Promise<IssuedTokens> {
    return this.sovereignProvider.issueSession(userId, metadata);
  }

  async refreshSession(refreshToken: string, metadata?: { userAgent?: string; ipAddress?: string }): Promise<IssuedTokens | null> {
    return this.sovereignProvider.refreshSession(refreshToken, metadata);
  }

  async logout(sessionId: string): Promise<void> {
    return this.sovereignProvider.logout(sessionId);
  }
}
