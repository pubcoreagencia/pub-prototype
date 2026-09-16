import crypto from 'node:crypto';

/**
 * Standard scrypt password hashing configuration.
 * N=16384 (CPU/memory cost), r=8 (block size), p=1 (parallelization)
 * Salt: 16 cryptographically secure random bytes.
 * Derived key length: 64 bytes.
 */
const SCRYPT_CONFIG = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 32 * 1024 * 1024,
  keyLen: 64,
  saltLen: 16,
};

/**
 * Hashes a plaintext password into a serialized standard format:
 * $scrypt$N=16384,r=8,p=1$<base64_salt>$<base64_hash>
 */
export function hashPassword(password: string): string {
  if (!password || typeof password !== 'string') {
    throw new Error('Password must be a non-empty string');
  }
  const salt = crypto.randomBytes(SCRYPT_CONFIG.saltLen);
  const derivedKey = crypto.scryptSync(password, salt, SCRYPT_CONFIG.keyLen, {
    N: SCRYPT_CONFIG.N,
    r: SCRYPT_CONFIG.r,
    p: SCRYPT_CONFIG.p,
    maxmem: SCRYPT_CONFIG.maxmem,
  });

  return `$scrypt$N=${SCRYPT_CONFIG.N},r=${SCRYPT_CONFIG.r},p=${SCRYPT_CONFIG.p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

/**
 * Verifies a plaintext password against a stored scrypt hash using timing-safe comparison.
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  if (!password || !storedHash || typeof password !== 'string' || typeof storedHash !== 'string') {
    return false;
  }

  const parts = storedHash.split('$');
  // Format: ["", "scrypt", "N=16384,r=8,p=1", "<salt>", "<hash>"]
  if (parts.length !== 5 || parts[1] !== 'scrypt') {
    return false;
  }

  try {
    const salt = Buffer.from(parts[3], 'base64');
    const expectedKey = Buffer.from(parts[4], 'base64');

    if (salt.length !== SCRYPT_CONFIG.saltLen || expectedKey.length !== SCRYPT_CONFIG.keyLen) {
      return false;
    }

    const actualKey = crypto.scryptSync(password, salt, expectedKey.length, {
      N: SCRYPT_CONFIG.N,
      r: SCRYPT_CONFIG.r,
      p: SCRYPT_CONFIG.p,
      maxmem: SCRYPT_CONFIG.maxmem,
    });

    return crypto.timingSafeEqual(expectedKey, actualKey);
  } catch {
    return false;
  }
}
