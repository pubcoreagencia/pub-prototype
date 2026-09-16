// src/pp/ui/api-client.ts
// Exported helper mirroring internal apiFetch for module imports and automated test suites.
import { getAccessToken, sovereignFetch } from './sovereign-auth.js';

const HOST_ORIGIN = 'https://pubcore.site';
const HOST_LOGIN_URL = 'https://pubcore.site/login';
let activeRefreshPromise: Promise<string | null> | null = null;

export function getAuthToken(): string | undefined {
  // Sovereign Auth: prioritize in-memory token
  const sovereignToken = getAccessToken();
  if (sovereignToken) return sovereignToken;

  if (typeof localStorage === 'undefined') {
    return process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development' ? 'test-token' : undefined;
  }
  const token = localStorage.getItem('pub-prototype:token');
  if (token) return token;

  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && ((key.startsWith('sb-') && key.endsWith('-auth-token')) || key === 'supabase.auth.token')) {
        const raw = localStorage.getItem(key);
        if (raw) {
          const parsed = JSON.parse(raw);
          const candidate = parsed?.access_token || parsed?.currentSession?.access_token;
          if (typeof candidate === 'string' && candidate) {
            localStorage.setItem('pub-prototype:token', candidate);
            return candidate;
          }
        }
      }
    }
  } catch {}

  if (typeof process !== 'undefined' && (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development')) {
    return 'test-token';
  }
  return undefined;
}

export function handleHostPostMessage(event: { origin: string; data?: any }): boolean {
  const isAllowedOrigin = event.origin === HOST_ORIGIN || (typeof window !== 'undefined' && Boolean(window.location?.origin) && event.origin === window.location.origin);
  if (!isAllowedOrigin) {
    return false;
  }
  const data = event.data;
  if (data && data.type === 'PUB_AUTH_TOKEN_UPDATE' && typeof data.token === 'string' && data.token.trim()) {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('pub-prototype:token', data.token.trim());
    }
    return true;
  }
  return false;
}

export async function requestTokenRefreshFromHost(oldToken?: string): Promise<string | null> {
  if (activeRefreshPromise) return activeRefreshPromise;

  activeRefreshPromise = (async () => {
    const current = getAuthToken();
    if (current && current !== oldToken) {
      return current;
    }

    if (typeof window !== 'undefined') {
      try {
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: 'PUB_AUTH_REFRESH_REQUEST' }, HOST_ORIGIN);
        } else if (window.opener) {
          window.opener.postMessage({ type: 'PUB_AUTH_REFRESH_REQUEST' }, HOST_ORIGIN);
        }
      } catch {}
    }

    const timeoutMs = 2000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, 100));
      const updated = getAuthToken();
      if (updated && updated !== oldToken) {
        return updated;
      }
    }
    return null;
  })().finally(() => {
    activeRefreshPromise = null;
  });

  return activeRefreshPromise;
}

export async function apiFetch(url: string, opts: RequestInit = {}, isRetry = false): Promise<Response> {
  // If in-memory sovereign token exists or url is sovereign auth endpoint, route via sovereignFetch
  if (getAccessToken()) {
    return sovereignFetch(url, opts, isRetry);
  }

  const headers = new Headers(opts.headers || {});
  const token = getAuthToken();
  if (token && !headers.has('Authorization') && !headers.has('authorization')) {
    headers.set('Authorization', 'Bearer ' + token);
  }

  const response = await fetch(url, { ...opts, headers });

  if (response.status === 401 && !isRetry) {
    const refreshedToken = await requestTokenRefreshFromHost(token);
    if (refreshedToken && refreshedToken !== token) {
      const retryHeaders = new Headers(opts.headers || {});
      retryHeaders.set('Authorization', 'Bearer ' + refreshedToken);
      return apiFetch(url, { ...opts, headers: retryHeaders }, true);
    }
  }

  return response;
}

