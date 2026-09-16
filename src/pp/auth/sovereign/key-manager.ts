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

  constructor() {
    this.currentKey = this.generateEd25519Key();
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
