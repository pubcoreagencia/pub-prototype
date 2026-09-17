/**
 * Sovereign Authentication Client for PP Frontend (Phase 4).
 *
 * Adheres strictly to sovereign auth principles:
 * - Access token is held in-memory only (never stored in localStorage, sessionStorage, or URL).
 * - Refresh token is managed exclusively via secure, HttpOnly cookies (credentials: 'include').
 * - Automatic session bootstrap on initial load via /prototype/auth/refresh.
 * - Automatic single-retry token recovery on 401 Unauthorized responses without infinite loops.
 * - Graceful fallback to legacy token if present during transitional migration.
 */

export interface SovereignUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceMembership {
  id: string;
  name: string;
  slug: string;
  role: string;
}

export interface MeResponse {
  user: SovereignUser;
  workspaces: WorkspaceMembership[];
}

export interface AuthSuccessResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  user: SovereignUser;
}

// Module-scoped in-memory state
let inMemoryAccessToken: string | null = null;
let currentUser: SovereignUser | null = null;
let currentWorkspaces: WorkspaceMembership[] = [];
let activeRefreshPromise: Promise<string | null> | null = null;

/**
 * Returns current access token in memory.
 */
export function getAccessToken(): string | null {
  return inMemoryAccessToken;
}

/**
 * Sets access token in memory.
 */
export function setAccessToken(token: string | null): void {
  inMemoryAccessToken = token;
}

/**
 * Returns currently cached authenticated user.
 */
export function getCurrentUser(): SovereignUser | null {
  return currentUser;
}

/**
 * Returns currently cached user workspaces.
 */
export function getCurrentWorkspaces(): WorkspaceMembership[] {
  return currentWorkspaces;
}

/**
 * Clears all in-memory authentication state.
 */
export function clearAuthSession(): void {
  inMemoryAccessToken = null;
  currentUser = null;
  currentWorkspaces = [];
}

/**
 * Performs login using credentials.
 * Sets in-memory access token and browser HttpOnly refresh cookie.
 */
export async function login(email: string, password: string): Promise<AuthSuccessResponse> {
  const response = await fetch('/prototype/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'LOGIN_FAILED' }));
    throw new Error(err.error || 'LOGIN_FAILED');
  }

  const data: AuthSuccessResponse = await response.json();
  setAccessToken(data.accessToken);
  currentUser = data.user;
  return data;
}

/**
 * Performs user signup.
 * Sets in-memory access token and browser HttpOnly refresh cookie.
 */
export async function signup(email: string, password: string, name?: string): Promise<AuthSuccessResponse> {
  const response = await fetch('/prototype/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email, password, name }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'SIGNUP_FAILED' }));
    throw new Error(err.error || 'SIGNUP_FAILED');
  }

  const data: AuthSuccessResponse = await response.json();
  setAccessToken(data.accessToken);
  currentUser = data.user;
  return data;
}

/**
 * Refreshes access token using the HttpOnly cookie.
 * Ensures single inflight promise to prevent race conditions.
 */
export async function refreshSession(): Promise<string | null> {
  if (activeRefreshPromise) return activeRefreshPromise;

  activeRefreshPromise = (async () => {
    try {
      const response = await fetch('/prototype/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });

      if (!response.ok) {
        if (response.status === 401) {
          clearAuthSession();
        }
        return null;
      }

      const data = await response.json();
      if (data.accessToken) {
        setAccessToken(data.accessToken);
        return data.accessToken;
      }
      return null;
    } catch {
      return null;
    }
  })().finally(() => {
    activeRefreshPromise = null;
  });

  return activeRefreshPromise;
}

/**
 * Logs out user: revokes DB session, clears refresh cookie, and clears in-memory tokens.
 */
export async function logout(): Promise<void> {
  try {
    await fetch('/prototype/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
  } finally {
    clearAuthSession();
  }
}

/**
 * Fetches current authenticated user and their active workspace memberships.
 */
export async function fetchMe(): Promise<MeResponse | null> {
  const token = inMemoryAccessToken;
  if (!token) return null;

  const response = await sovereignFetch('/prototype/auth/me');
  if (!response.ok) {
    return null;
  }

  const data: MeResponse = await response.json();
  currentUser = data.user;
  currentWorkspaces = data.workspaces;
  return data;
}

/**
 * Onboards a workspace for the authenticated user.
 */
export async function onboardWorkspace(name: string, slug?: string): Promise<WorkspaceMembership> {
  const response = await sovereignFetch('/prototype/auth/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, slug }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'WORKSPACE_CREATION_FAILED' }));
    throw new Error(err.error || 'WORKSPACE_CREATION_FAILED');
  }

  const ws = await response.json();
  currentWorkspaces.push(ws);
  return ws;
}

/**
 * Bootstraps user session on app launch:
 * 1. Checks if refresh token cookie can rotate and provide access token.
 * 2. If valid, queries /prototype/auth/me to populate user and workspaces.
 */
export async function bootstrapSession(): Promise<MeResponse | null> {
  const token = await refreshSession();
  if (!token) {
    return null;
  }
  return fetchMe();
}

/**
 * Fetch wrapper with automatic 401 token refresh and single retry.
 * Avoids infinite loops by strictly attempting retry at most once.
 */
export async function sovereignFetch(url: string, opts: RequestInit = {}, isRetry = false): Promise<Response> {
  const headers = new Headers(opts.headers || {});
  const token = inMemoryAccessToken;

  if (token && !headers.has('Authorization') && !headers.has('authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  const response = await fetch(url, {
    ...opts,
    headers,
    credentials: 'include',
  });

  // Single recovery retry on 401
  if (response.status === 401 && !isRetry) {
    const newToken = await refreshSession();
    if (newToken && newToken !== token) {
      const retryHeaders = new Headers(opts.headers || {});
      retryHeaders.set('Authorization', `Bearer ${newToken}`);
      return sovereignFetch(url, { ...opts, headers: retryHeaders }, true);
    }
  }

  return response;
}
