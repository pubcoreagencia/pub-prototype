import crypto from 'node:crypto';
import type { JWKKey, JWKSResponse } from './types.js';

export interface KeyPairRecord {
  kid: string;
  publicKey: crypto.KeyObject;
  privateKey: crypto.KeyObject;
  createdAt: number;
}

export class KeyManager {
  private currentKey: KeyPairRecord;
  private previousKeys: Map<string, KeyPairRecord> = new Map();

  /**
   * KeyManager manages Ed25519 signing and verification keys.
   *
   * PRODUCTION DEPLOYMENT REQUIREMENT (Railway / Staging / Production):
   * For persistent production deployments, provision the private key via the environment variable:
   *   `PP_AUTH_PRIVATE_KEY_PEM` (PKCS#8 PEM string)
   * When configured, the server uses the persisted key rather than generating an ephemeral key pair on restart,
   * ensuring that previously issued access tokens and sessions remain valid across deployments and restarts.
   * If not provided (e.g. local dev / test), an ephemeral in-memory Ed25519 key pair is generated on startup.
   */
  constructor() {
    this.currentKey = this.initSigningKey();
  }

  private initSigningKey(): KeyPairRecord {
    const envPem = process.env.PP_AUTH_PRIVATE_KEY_PEM;
    if (envPem && typeof envPem === 'string' && envPem.trim().includes('PRIVATE KEY')) {
      try {
        const privateKey = crypto.createPrivateKey(envPem.trim());
        const publicKey = crypto.createPublicKey(privateKey);
        const kid = process.env.PP_AUTH_KEY_ID || `pp-key-static-${crypto.createHash('sha256').update(envPem).digest('hex').slice(0, 8)}`;
        return {
          kid,
          publicKey,
          privateKey,
          createdAt: Date.now(),
        };
      } catch (err: any) {
        console.warn('[KeyManager] Failed to parse PP_AUTH_PRIVATE_KEY_PEM, falling back to ephemeral key:', err.message);
      }
    }
    return this.generateEd25519Key();
  }

  /**
   * Generates a new Ed25519 key pair with a unique kid.
   */
  private generateEd25519Key(): KeyPairRecord {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const kid = `pp-key-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    return {
      kid,
      publicKey,
      privateKey,
      createdAt: Date.now(),
    };
  }

  /**
   * Returns the current active signing key record.
   */
  getCurrentSigningKey(): KeyPairRecord {
    return this.currentKey;
  }

  /**
   * Looks up a public verification key by kid (checks current and previous keys).
   */
  getVerificationKey(kid: string): crypto.KeyObject | null {
    if (this.currentKey.kid === kid) {
      return this.currentKey.publicKey;
    }
    const prev = this.previousKeys.get(kid);
    return prev ? prev.publicKey : null;
  }

  /**
   * Rotates the signing key. The current key moves to previousKeys for graceful verification.
   */
  rotateKey(): KeyPairRecord {
    this.previousKeys.set(this.currentKey.kid, this.currentKey);
    this.currentKey = this.generateEd25519Key();
    return this.currentKey;
  }

  /**
   * Returns the public JWKS representation containing current and non-retired public keys.
   * NUNCA expõe chaves privadas.
   */
  getJWKS(): JWKSResponse {
    const keys: JWKKey[] = [];

    // Current key public JWK
    const currentJwk = this.currentKey.publicKey.export({ format: 'jwk' }) as any;
    keys.push({
      kty: currentJwk.kty || 'OKP',
      crv: currentJwk.crv || 'Ed25519',
      x: currentJwk.x,
      kid: this.currentKey.kid,
      use: 'sig',
      alg: 'EdDSA',
    });

    // Previous keys public JWKs
    for (const [kid, record] of this.previousKeys.entries()) {
      const jwk = record.publicKey.export({ format: 'jwk' }) as any;
      keys.push({
        kty: jwk.kty || 'OKP',
        crv: jwk.crv || 'Ed25519',
        x: jwk.x,
        kid,
        use: 'sig',
        alg: 'EdDSA',
      });
    }

    return { keys };
  }
}
