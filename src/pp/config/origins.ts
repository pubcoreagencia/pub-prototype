/**
 * Shared CORS and CSRF Origin Allowlist for PUB Prototype.
 * Authorized origins include the host consumer (https://pubcore.site) and local dev environments.
 */
export const ALLOWED_ORIGINS: ReadonlySet<string> = new Set([
  'https://pubcore.site',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:5173',
]);

/**
 * Returns whether a given origin string is authorized.
 */
export function isAllowedOrigin(origin?: string | null): boolean {
  if (!origin || typeof origin !== 'string') return false;
  return ALLOWED_ORIGINS.has(origin);
}
