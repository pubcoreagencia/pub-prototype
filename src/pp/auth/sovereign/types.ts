export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'INVITED';

export interface SovereignUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  status: UserStatus;
  passwordHash?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  id: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  lastActiveAt: Date;
  familyId: string;
  rotatedFrom: string | null;
}

export interface TokenClaims {
  iss: string;
  sub: string;
  aud: string;
  sid: string;
  iat: number;
  exp: number;
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  sessionId: string;
}

export interface JWKKey {
  kty: string;
  crv: string;
  x: string;
  kid: string;
  use?: string;
  alg?: string;
}

export interface JWKSResponse {
  keys: JWKKey[];
}
