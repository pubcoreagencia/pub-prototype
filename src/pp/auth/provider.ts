import type { AuthenticatedUser } from './auth.js';
import type { IssuedTokens } from './sovereign/types.js';

export interface AuthProvider {
  readonly name: string;
  isConfigured(): boolean;
  verifyAccessToken(token: string): Promise<AuthenticatedUser | null>;
  issueSession?(userId: string, metadata?: { userAgent?: string; ipAddress?: string }): Promise<IssuedTokens>;
  refreshSession?(refreshToken: string, metadata?: { userAgent?: string; ipAddress?: string }): Promise<IssuedTokens | null>;
  logout?(sessionId: string): Promise<void>;
}
