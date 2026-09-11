/**
 * Input validation for PUB Prototype API.
 *
 * All values that originate from the client (session IDs, branch names,
 * repository URLs, prompt text, checkpoint IDs) are validated here before
 * they are used in database queries, file-system operations or git commands.
 *
 * Rules:
 *  - UUIDs: standard RFC 4122 format.
 *  - Repository URLs: must be https://, http:// or git@, max 2048 chars.
 *    file://, relative paths, shell metacharacters are rejected.
 *  - Branch names: git-safe pattern, no "..", no shell metacharacters, max 200 chars.
 *  - Prompts: free-text, max 32 000 chars (prevents payload bloat).
 *  - Project names: alphanumeric + dash/underscore/dot, max 100 chars.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Valid git branch name:
 *  - no consecutive dots (..)
 *  - no leading/trailing dot or slash
 *  - no shell-unsafe chars
 *  - max 200 chars
 */
const BRANCH_CHAR_RE = /^[^\s\0~^:?*[\\\x00]{1,200}$/;
const BRANCH_DOUBLE_DOT_RE = /\.\./;
const BRANCH_LEADING_DOT_RE = /^\./;
const BRANCH_TRAILING_RE = /[./]$/;
const BRANCH_SHELL_UNSAFE_RE = /[`$;&|<>(){}'"!\n\r\t@{]/;

const PROJECT_RE = /^[a-zA-Z0-9._-]{1,100}$/;

const REPO_ALLOWED_PREFIXES = ['https://', 'http://', 'git@'];
const REPO_MAX_LENGTH = 2048;

// Shell-injection guard for repository URLs
const REPO_SHELL_UNSAFE_RE = /[`$;&|<>(){}\n\r\t]/;

export class ValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export function validateUuid(value: unknown, field = 'id'): string {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError(`Invalid ${field}: must be a valid UUID`);
  }
  return value;
}

export function validateOptionalUuid(value: unknown, field = 'id'): string | undefined {
  if (value === undefined || value === null) return undefined;
  return validateUuid(value, field);
}

export function validateRepositoryUrl(value: unknown, field = 'repository'): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (value.length === 0 || value.length > REPO_MAX_LENGTH) {
    throw new ValidationError(`${field} must be 1-${REPO_MAX_LENGTH} characters`);
  }
  const hasAllowedPrefix = REPO_ALLOWED_PREFIXES.some(p => value.startsWith(p));
  if (!hasAllowedPrefix) {
    throw new ValidationError(`${field} must start with https://, http://, or git@`);
  }
  if (REPO_SHELL_UNSAFE_RE.test(value)) {
    throw new ValidationError(`${field} contains disallowed characters`);
  }
  return value;
}

export function validateBranchName(value: unknown, field = 'branch'): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (value.length === 0 || value.length > 200) {
    throw new ValidationError(`${field} must be 1-200 characters`);
  }
  if (BRANCH_DOUBLE_DOT_RE.test(value)) {
    throw new ValidationError(`${field} must not contain '..'`);
  }
  if (BRANCH_LEADING_DOT_RE.test(value)) {
    throw new ValidationError(`${field} must not start with '.'`);
  }
  if (BRANCH_TRAILING_RE.test(value)) {
    throw new ValidationError(`${field} must not end with '.' or '/'`);
  }
  if (BRANCH_SHELL_UNSAFE_RE.test(value)) {
    throw new ValidationError(`${field} contains disallowed characters`);
  }
  if (!BRANCH_CHAR_RE.test(value)) {
    throw new ValidationError(`${field} is not a valid git branch name`);
  }
  return value;
}

export function validateOptionalBranchName(value: unknown, field = 'branch'): string | undefined {
  if (value === undefined || value === null) return undefined;
  return validateBranchName(value, field);
}

export function validatePrompt(value: unknown, field = 'prompt'): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (value.trim().length === 0) throw new ValidationError(`${field} must not be empty`);
  if (value.length > 32_000) throw new ValidationError(`${field} must be at most 32000 characters`);
  return value;
}

export function validateProjectName(value: unknown, field = 'project'): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  if (!PROJECT_RE.test(value)) {
    throw new ValidationError(`${field} must be 1-100 alphanumeric characters (dots, dashes, underscores allowed)`);
  }
  return value;
}
