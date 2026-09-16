import crypto from 'node:crypto';
import type { KeyManager } from './key-manager.js';
import type { TokenClaims } from './types.js';

export const DEFAULT_ISSUER = process.env.PP_AUTH_ISSUER || 'https://api.pubcore.site';
export const DEFAULT_AUDIENCE = 'pub-prototype';
export const AUTH_ACCESS_TOKEN_TTL_SECONDS = Number(process.env.AUTH_ACCESS_TOKEN_TTL || 900); // 15 min

function base64UrlEncode(data: Buffer | string): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(str: string): Buffer {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return Buffer.from(base64, 'base64');
}

export interface SignTokenOptions {
  userId: string;
  sessionId: string;
  issuer?: string;
  audience?: string;
  ttlSeconds?: number;
}

/**
 * Signs an asymmetric Ed25519 JWT using the current active key from KeyManager.
 */
export function signAccessToken(keyManager: KeyManager, options: SignTokenOptions): string {
  const signingKey = keyManager.getCurrentSigningKey();
  const now = Math.floor(Date.now() / 1000);
  const ttl = options.ttlSeconds ?? AUTH_ACCESS_TOKEN_TTL_SECONDS;

  const header = {
    alg: 'EdDSA',
    typ: 'JWT',
    kid: signingKey.kid,
  };

  const claims: TokenClaims = {
    iss: options.issuer ?? DEFAULT_ISSUER,
    sub: options.userId,
    aud: options.audience ?? DEFAULT_AUDIENCE,
    sid: options.sessionId,
    iat: now,
    exp: now + ttl,
    jti: crypto.randomUUID(),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(claims));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = crypto.sign(null, Buffer.from(signingInput, 'utf8'), signingKey.privateKey);
  const encodedSignature = base64UrlEncode(signature);

  return `${signingInput}.${encodedSignature}`;
}

export interface VerifyTokenOptions {
  expectedIssuer?: string;
  expectedAudience?: string;
  clockToleranceSeconds?: number;
}

/**
 * Verifies an Ed25519 JWT purely in-memory using public keys from KeyManager.
 * Zero roundtrips to database or remote HTTP endpoints.
 */
export function verifyAccessToken(
  keyManager: KeyManager,
  token: string,
  options?: VerifyTokenOptions
): { valid: true; claims: TokenClaims } | { valid: false; error: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token must be a non-empty string' };
  }

  const cleanToken = token.startsWith('Bearer ') || token.startsWith('bearer ') ? token.slice(7).trim() : token.trim();
  const parts = cleanToken.split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Malformed JWT structure' };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  // 1. Decode header
  let header: { alg?: string; typ?: string; kid?: string };
  try {
    header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8'));
  } catch {
    return { valid: false, error: 'Invalid JWT header JSON' };
  }

  if (header.alg !== 'EdDSA') {
    return { valid: false, error: `Unsupported algorithm: ${header.alg}` };
  }

  if (!header.kid) {
    return { valid: false, error: 'Missing kid in JWT header' };
  }

  // 2. Fetch verification public key
  const publicKey = keyManager.getVerificationKey(header.kid);
  if (!publicKey) {
    return { valid: false, error: `Unknown key identifier: ${header.kid}` };
  }

  // 3. Verify cryptographic signature
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = base64UrlDecode(encodedSignature);
  const isSignatureValid = crypto.verify(null, Buffer.from(signingInput, 'utf8'), publicKey, signature);

  if (!isSignatureValid) {
    return { valid: false, error: 'Invalid cryptographic signature' };
  }

  // 4. Decode and validate claims
  let claims: TokenClaims;
  try {
    claims = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8'));
  } catch {
    return { valid: false, error: 'Invalid JWT payload JSON' };
  }

  const now = Math.floor(Date.now() / 1000);
  const tolerance = options?.clockToleranceSeconds ?? 0;

  // Expiration check
  if (typeof claims.exp !== 'number' || now - tolerance >= claims.exp) {
    return { valid: false, error: 'Token has expired' };
  }

  // Issuer check
  const expectedIssuer = options?.expectedIssuer ?? DEFAULT_ISSUER;
  if (claims.iss !== expectedIssuer) {
    return { valid: false, error: `Issuer mismatch: expected ${expectedIssuer}, got ${claims.iss}` };
  }

  // Audience check
  const expectedAudience = options?.expectedAudience ?? DEFAULT_AUDIENCE;
  if (claims.aud !== expectedAudience) {
    return { valid: false, error: `Audience mismatch: expected ${expectedAudience}, got ${claims.aud}` };
  }

  // Subject check
  if (!claims.sub || typeof claims.sub !== 'string') {
    return { valid: false, error: 'Missing or invalid subject claim (sub)' };
  }

  return { valid: true, claims };
}
