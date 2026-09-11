// src/providers/routerConfig.ts
/**
 * Centralized loader for Router provider configuration.
 * Reads environment variables and provides strongly‑typed defaults.
 */
export interface RouterConfig {
  primaryModel: string; // required
  fallbackModels: string[]; // optional list, order matters
  maxRetries: number; // attempts per model (including the first try)
  baseDelayMs: number; // base delay for exponential backoff
}

export function loadRouterConfig(modelOverride?: string): RouterConfig {
  const primary = modelOverride?.trim() || process.env.ROUTER_MODEL?.trim() || 'gemini/gemini-3.5-flash-lite';
  if (!primary) {
    throw new Error('ROUTER_MODEL must be defined in the environment');
  }

  const fallbackRaw = process.env.ROUTER_FALLBACK_MODELS?.trim() ?? '';
  const fallbackModels = fallbackRaw
    ? fallbackRaw.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const maxRetries = Number(process.env.ROUTER_MAX_RETRIES ?? 2);
  const baseDelayMs = Number(process.env.ROUTER_RETRY_BASE_DELAY_MS ?? 500);

  return {
    primaryModel: primary,
    fallbackModels,
    maxRetries: Math.max(1, maxRetries), // at least 1 attempt
    baseDelayMs: Math.max(0, baseDelayMs),
  };
}
