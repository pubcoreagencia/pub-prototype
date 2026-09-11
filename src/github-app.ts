import { execFileSync } from 'node:child_process';

/**
 * PAT authentication for the persistent prototypes repository.
 *
 * Uses a fine-grained Personal Access Token stored as `PROTOTYPE_BOT_TOKEN`
 * environment variable (Cloudflare Worker secret).
 *
 * The token is NEVER logged, returned to the frontend, or committed.
 *
 * For local development only, `gh auth token` may be used as fallback,
 * but this MUST be disabled in production.
 */

// FIXED WHITELIST: only this repository can receive persistent pushes.
// The env var PROTOTYPE_PROTOTYPES_REPO is intentionally IGNORED for the
// push target — it can only be used to override the *display name* of the
// canonical repository, not to change where pushes go.
export const PROTOTYPE_REPOSITORY = 'pubcoreagencia/pub-dev-loop-prototypes';

/**
 * Returns the PAT for the persistent prototypes repository.
 *
 * Order of precedence:
 * 1. PROTOTYPE_BOT_TOKEN (env var / Cloudflare secret) — primary for production
 * 2. gh auth token (local dev only) — fallback, disabled if PROD=true
 *
 * Returns empty string if no token is available.
 *
 * The returned token is a SECRET. Do not log, print, or return to clients.
 */
export function getGitHubToken(): string {
  const envToken = process.env.PROTOTYPE_BOT_TOKEN || process.env.GITHUB_TOKEN;
  console.log('[github-app] getGitHubToken: env keys with token:',
    process.env.PROTOTYPE_BOT_TOKEN ? 'PROTOTYPE_BOT_TOKEN' : (process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : 'NONE'),
    'length:', envToken ? envToken.length : 0);
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  // Refuse to use gh auth token in production
  if (process.env.PROD === 'true' || process.env.NODE_ENV === 'production') {
    return '';
  }

  try {
    const result = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
    });
    return result.trim();
  } catch {
    return '';
  }
}

/**
 * Returns the canonical prototype repository (read-only).
 * The whitelist is fixed and cannot be overridden via env vars.
 */
export function getPrototypesRepo(): string {
  return PROTOTYPE_REPOSITORY;
}

export interface PushResult {
  ok: boolean;
  remote?: string;
  branch?: string;
  error?: string;
}

/**
 * Sanitizes an error message to ensure no token leaks.
 */
function sanitizeError(msg: string): string {
  const token = getGitHubToken();
  if (token && token.length >= 8) {
    return msg.split(token).join('[REDACTED]');
  }
  return msg;
}

/**
 * Pushes the current branch to the persistent prototypes repository.
 *
 * SECURITY:
 * - The remote URL is constructed from a FIXED whitelist repository
 * - The token is never included in error messages or logs
 * - The remote is removed from git config after push to avoid persisting credentials
 */
export function pushBranch(workspace: string, branch: string): PushResult {
  const allowedRepo = PROTOTYPE_REPOSITORY; // Fixed whitelist — NOT configurable
  const token = getGitHubToken();

  if (!token) {
    return { ok: false, error: 'No GitHub token available (PROTOTYPE_BOT_TOKEN not set)' };
  }

  // Construct the remote URL. Token is embedded in URL for git push authentication.
  // We immediately remove the remote after push to avoid persisting credentials.
  const remoteUrl = `https://x-access-token:${token}@github.com/${allowedRepo}.git`;

  try {
    // Remove any existing origin (in case the workspace was cloned from elsewhere)
    try {
      execFileSync('git', ['remote', 'remove', 'origin'], {
        cwd: workspace, stdio: 'pipe', timeout: 5000,
      });
    } catch { /* Remote didn't exist — that's fine */ }

    // Add our whitelisted remote
    execFileSync('git', ['remote', 'add', 'origin', remoteUrl], {
      cwd: workspace, stdio: 'pipe', timeout: 5000,
    });

    // Push the branch
    // For prototype sessions (1 user, 1 branch), --force is acceptable
    // to allow rapid iteration without race conditions.
    try {
      const pushOutput = execFileSync('git', ['push', '-u', 'origin', branch, '--force'], {
        cwd: workspace,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 60000,
      });
      console.log('[github-app] push output:', pushOutput?.toString()?.slice(0, 500));
    } catch (pushError: any) {
      console.error('[github-app] push failed:', pushError.message?.slice(0, 500), 'stderr:', pushError.stderr?.toString()?.slice(0, 500));
      throw pushError;
    }

    // SECURITY: remove the remote (with the token) from git config immediately
    try {
      execFileSync('git', ['remote', 'remove', 'origin'], {
        cwd: workspace, stdio: 'pipe', timeout: 5000,
      });
    } catch { /* Ignore cleanup errors */ }

    return { ok: true, remote: allowedRepo, branch };
  } catch (error) {
    // SECURITY: always try to remove the remote, even on failure
    try {
      execFileSync('git', ['remote', 'remove', 'origin'], {
        cwd: workspace, stdio: 'pipe', timeout: 5000,
      });
    } catch { /* Ignore */ }

    const rawMessage = error instanceof Error ? error.message : String(error);
    return { ok: false, error: sanitizeError(rawMessage) };
  }
}

/**
 * Verifies if a SHA exists in the remote branch.
 * Uses a separate process to avoid leaking the token in git config.
 */
export function verifyRemoteSha(branch: string, expectedSha: string): boolean {
  const token = getGitHubToken();
  if (!token) return false;

  const remoteUrl = `https://x-access-token:${token}@github.com/${PROTOTYPE_REPOSITORY}.git`;

  try {
    const result = execFileSync('git', ['ls-remote', remoteUrl, branch], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10000,
    });
    return result.includes(expectedSha);
  } catch {
    return false;
  }
}
