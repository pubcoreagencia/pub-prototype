import { resolve, isAbsolute, relative, sep } from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * WorkspaceSecurity: validates and resolves file paths within a workspace root.
 *
 * Blocks:
 * - Path traversal (../)
 * - Absolute paths outside the workspace
 * - Access to HOME, .env, secrets, CODEX_HOME
 * - Any path that resolves outside workspaceRoot
 */
export class WorkspaceSecurity {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string) {
    // Normalize and resolve without requiring the directory to exist
    this.workspaceRoot = resolve(workspaceRoot);
  }

  /**
   * Resolve a user-provided path and ensure it stays within the workspace.
   * Returns the absolute, normalized path if safe.
   * Throws Error if the path escapes the workspace.
   */
  resolvePath(userPath: string): string {
    // Reject null/undefined/empty
    if (!userPath || typeof userPath !== 'string') {
      throw new Error('Invalid path: path is required');
    }

    // Never allow paths containing null bytes
    if (userPath.includes('\0')) {
      throw new Error('Invalid path: null bytes not allowed');
    }

    // Block known sensitive names anywhere in the path
    const sensitivePatterns = [
      '.env',
      '.env.local',
      '.env.production',
      '.env.development',
      '.env.test',
      'auth.json',
      'credentials',
      'secret',
      'secrets',
    ];

    for (const pattern of sensitivePatterns) {
      if (userPath.includes(pattern)) {
        throw new Error(`Access denied: path contains sensitive pattern '${pattern}'`);
      }
    }

    // Resolve the path: if absolute, use as-is; if relative, resolve against workspace
    let resolved: string;
    if (isAbsolute(userPath)) {
      resolved = resolve(userPath);
    } else {
      resolved = resolve(this.workspaceRoot, userPath);
    }

    // Normalize for comparison
    resolved = resolve(resolved);

    // Check if resolved path is within workspace
    if (resolved === this.workspaceRoot) {
      return resolved;
    }
    if (resolved.startsWith(this.workspaceRoot + sep)) {
      return resolved;
    }

    // Path escaped the workspace
    const rel = relative(this.workspaceRoot, resolved);
    throw new Error(`Path traversal blocked: '${rel}' resolves outside workspace`);
  }

  /**
   * Validate that a path is inside the workspace (without resolving).
   * Returns true if safe.
   */
  isSafePath(userPath: string): boolean {
    try {
      this.resolvePath(userPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if a resolved path is within the workspace root.
   */
  isWithinWorkspace(absolutePath: string): boolean {
    const resolved = resolve(absolutePath);
    if (resolved === this.workspaceRoot) return true;
    return resolved.startsWith(this.workspaceRoot + sep);
  }

  get root(): string {
    return this.workspaceRoot;
  }
}
