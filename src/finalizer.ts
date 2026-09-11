import { execSync, spawn } from 'node:child_process';
import { WorkspaceSecurity } from './tools/security.js';
import type { ToolExecutionContext } from './tools/types.js';
import { sanitizeCommitMessage } from './tools/runtime.js';

// Git subcommands that are explicitly blocked for security
const BLOCKED_GIT_COMMANDS = [
  'push', 'remote', 'reset', 'clean', 'checkout --', 'restore .',
  'branch -D', 'branch -d', 'fetch', 'pull', 'merge',
];

/**
 * Snapshot of workspace state at a point in time.
 * Used to detect changes introduced by the agent vs pre-existing state.
 */
export interface WorkspaceSnapshot {
  /** All tracked files in the repo at snapshot time (relative paths). */
  trackedFiles: string[];
  /** git status --short output at snapshot time (empty = clean). */
  gitStatus: string;
  /** Commit SHA at snapshot time (or null if no commits). */
  headSha: string | null;
}

/**
 * Detects unexpected changes between a baseline snapshot and the current
 * workspace state. A change is "unexpected" if it doesn't belong to the
 * task — i.e., it was present in the baseline (pre-existing) but now
 * modified, or it's an unrelated file modification.
 */
export class WorkspaceValidator {
  /**
   * Capture a snapshot of the current workspace state.
   */
  static captureSnapshot(root: string): WorkspaceSnapshot {
    try {
      const statusResult = execSync('git status --short', {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const gitStatus = statusResult.toString().trim();

      const lsFilesResult = execSync('git ls-files', {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const trackedFiles = lsFilesResult.toString().trim().split('\n').filter(Boolean);

      let headSha: string | null = null;
      try {
        headSha = execSync('git rev-parse HEAD', {
          cwd: root,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 10000,
        }).toString().trim();
        if (!/^[0-9a-f]{40}$/.test(headSha)) headSha = null;
      } catch {
        headSha = null;
      }

      return { trackedFiles, gitStatus, headSha };
    } catch {
      return { trackedFiles: [], gitStatus: '', headSha: null };
    }
  }

  /**
   * Compare current workspace state against a baseline snapshot.
   * Returns the list of unexpected files (files not in the agent's changedFiles).
   *
   * Strategy:
   * - Files that were modified before the agent ran (in baseline gitStatus)
   *   but are now clean (already committed or reverted) → NOT unexpected
   * - Files that were clean in baseline but are now changed → could be
   *   from agent OR pre-existing modifications committed during baseline
   * - The safest approach: use `git diff` against the baseline HEAD commit
   *   to find what the agent actually changed, then validate that the
   *   agent's declared changedFiles ⊆ git diff output.
   */
  static detectUnexpectedChanges(
    root: string,
    baseline: WorkspaceSnapshot,
    agentChangedFiles: string[],
  ): string[] {
    // Use git status --short to get ALL changes (tracked + untracked).
    // git diff HEAD only shows tracked modifications — untracked files
    // require git status or git ls-files --others.

    const currentStatus = this.parseChangedFiles(root);
    const declaredSet = new Set(agentChangedFiles);

    // If baseline was clean (no pre-existing changes), then ALL files in
    // git status are agent-introduced. Any not declared by the agent = unexpected.
    if (!baseline.gitStatus.trim()) {
      // Clean baseline: every change in git status is from the agent.
      // If the agent declared all of them, they're expected.
      // If not declared → unexpected.
      return currentStatus.filter(f => !declaredSet.has(f));
    }

    // Baseline was dirty — pre-existing changes existed before the agent.
    // Fail closed: any change in current status that isn't declared by the
    // agent is considered unexpected. We can't distinguish pre-existing from
    // agent-introduced without file-level tracking.
    return currentStatus.filter(f => !declaredSet.has(f));
  }

  /**
   * Parse `git status --short` to get list of changed file paths.
   */
  private static parseChangedFiles(root: string): string[] {
    try {
      const output = execSync('git status --short', {
        cwd: root,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      }).toString();

      return output
        .split(/\r?\n/)
        .filter(line => line.length >= 4)
        .map(line => {
          let filename = line.length >= 4 && line[2] === ' '
            ? line.substring(3).trim()
            : line.trimStart().replace(/^[^\s]+\s+/, '').trim();

          if (filename.startsWith('"') && filename.endsWith('"')) {
            filename = filename.slice(1, -1);
          }
          const arrowIdx = filename.indexOf(' -> ');
          return arrowIdx >= 0 ? filename.substring(arrowIdx + 4).trim() : filename;
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }
}

/**
 * Result of task finalization (validation + auto-commit).
 */
export interface FinalizeResult {
  status: 'COMPLETED' | 'FAILED';
  commitSha: string | null;
  commitMessage: string | null;
  changedFiles: string[];
  gitStatus: string;
  testsPassed: boolean | null;
  testOutput: string;
  errorCode: string | null;
  errorMessage: string | null;
}

/**
 * Options for task finalization.
 */
export interface FinalizeOptions {
  testCommand?: string | null;   // TASK_TEST_COMMAND — if null, skip tests
  commitMessage?: string | null;  // TASK_COMMIT_MESSAGE — if null, auto-generate
  expectChanges?: boolean;         // If true, require changes (else FAIL)
  allowUnexpectedFiles?: boolean;  // If false, only commit changedFiles
  baselineSnapshot?: WorkspaceSnapshot; // Snapshot taken before agent ran
  declaredChangedFiles?: string[]; // Files the agent claims to have changed
}

/**
 * TaskFinalizer: validates task results and performs automatic git commit.
 *
 * Flow:
 * 1. Check git status
 * 2. If no changes → COMPLETED (no commit)
 * 3. If changes → run tests (if configured)
 * 4. If tests pass → auto-commit with sanitized message
 * 5. Block all dangerous git operations
 */
export class TaskFinalizer {
  private readonly security: WorkspaceSecurity;
  private readonly ctx: ToolExecutionContext;

  constructor(workspace: string, ctx?: Partial<ToolExecutionContext>) {
    this.ctx = {
      workspaceRoot: workspace,
      maxRounds: 20,
      maxToolCalls: 50,
      commandTimeoutMs: Number(process.env.ROUTER_COMMAND_TIMEOUT_MS ?? 60000),
      maxFileBytes: 1024 * 1024,
      maxWriteBytes: 256 * 1024,
      redactSecrets: true,
      ...ctx,
    };
    this.security = new WorkspaceSecurity(workspace);
  }

  /**
   * Finalize the task: validate changes, run tests, and auto-commit.
   */
  async finalize(
    taskObjective: string,
    taskPrompt: string,
    options: FinalizeOptions,
  ): Promise<FinalizeResult> {
    // Check git status
    const gitStatusResult = await this.exec('git', ['status', '--short']);
    const gitStatus = gitStatusResult.stdout || '';

    const changedFiles = gitStatus
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const filename = line.substring(3);
        const arrowIdx = filename.indexOf(' -> ');
        return arrowIdx >= 0 ? filename.substring(arrowIdx + 4) : filename;
      });

    // No changes — task is complete, no commit needed
    if (changedFiles.length === 0) {
      return {
        status: 'COMPLETED',
        commitSha: null,
        commitMessage: null,
        changedFiles: [],
        gitStatus: 'clean',
        testsPassed: null,
        testOutput: '',
        errorCode: null,
        errorMessage: null,
      };
    }

    // VALIDATE UNEXPECTED CHANGES (FAILED_UNEXPECTED_CHANGES)
    // If a baseline snapshot was provided, validate that ALL changes
    // belong to the task — no pre-existing or unexpected modifications.
    const allowUnexpected = options.allowUnexpectedFiles ?? false;
    const declaredFiles = options.declaredChangedFiles ?? changedFiles;
    if (!allowUnexpected && options.baselineSnapshot) {
      const unexpected = WorkspaceValidator.detectUnexpectedChanges(
        this.security.root,
        options.baselineSnapshot,
        declaredFiles,
      );

      if (unexpected.length > 0) {
        return {
          status: 'FAILED',
          commitSha: null,
          commitMessage: null,
          changedFiles,
          gitStatus,
          testsPassed: null,
          testOutput: '',
          errorCode: 'FAILED_UNEXPECTED_CHANGES',
          errorMessage: `Unexpected changes detected: ${unexpected.join(', ')}. ` +
            `Agent declared: [${declaredFiles.join(', ')}]. ` +
            `Commit aborted — failing closed.`,
        };
      }
    }

    // Run tests if configured
    let testsPassed: boolean | null = null;
    let testOutput = '';

    if (options.testCommand) {
      const testResult = await this.execShell(options.testCommand, {
        timeoutMs: this.ctx.commandTimeoutMs,
      });

      testOutput = testResult.stdout + testResult.stderr;
      testsPassed = testResult.exitCode === 0;

      if (!testsPassed) {
        return {
          status: 'FAILED',
          commitSha: null,
          commitMessage: null,
          changedFiles,
          gitStatus,
          testsPassed: false,
          testOutput: this.redactSecrets(testOutput),
          errorCode: 'TASK_TESTS_FAILED',
          errorMessage: `Tests failed (exit code ${testResult.exitCode})`,
        };
      }
    }

    // Generate commit message
    let commitMessage: string;
    if (options.commitMessage) {
      commitMessage = sanitizeCommitMessage(options.commitMessage);
    } else {
      const shortObjective = taskObjective.length > 80
        ? taskObjective.substring(0, 77) + '...'
        : taskObjective;
      commitMessage = sanitizeCommitMessage(`feat: ${shortObjective}`);
    }

    if (!commitMessage || !commitMessage.trim()) {
      commitMessage = `feat: task ${Date.now()}`;
    }

    // Run git add -A
    await this.exec('git', ['add', '-A']);

    // Get diff stat before commit
    const diffStatResult = await this.exec('git', ['diff', '--cached', '--stat']);
    const diffStat = diffStatResult.stdout || '';

    // Execute git commit
    const commitResult = await this.exec('git', ['commit', '-m', commitMessage]);

    if (commitResult.status !== 'COMPLETED') {
      return {
        status: 'FAILED',
        commitSha: null,
        commitMessage: null,
        changedFiles,
        gitStatus,
        testsPassed,
        testOutput: '',
        errorCode: 'COMMIT_FAILED',
        errorMessage: `git commit failed: ${commitResult.stderr || 'unknown error'}`,
      };
    }

    // Get commit SHA
    const shaResult = await this.exec('git', ['rev-parse', 'HEAD']);
    const commitSha = shaResult.stdout?.trim() || null;

    if (!commitSha) {
      return {
        status: 'FAILED',
        commitSha: null,
        commitMessage: null,
        changedFiles,
        gitStatus,
        testsPassed,
        testOutput: '',
        errorCode: 'COMMIT_FAILED',
        errorMessage: 'Failed to read commit SHA after git commit',
      };
    }

    // PERSISTENT PUSH (optional): push the commit to the persistent prototypes
    // repository before reporting success. This ensures lastCheckpointSha points
    // to a commit that is actually retrievable from the remote.
    // Disabled by default to maintain backwards compatibility with existing tests.
    // Enable in production via env var: PROTOTYPE_PERSISTENT_PUSH=true
    console.log('[Finalizer] PROTOTYPE_PERSISTENT_PUSH:', process.env.PROTOTYPE_PERSISTENT_PUSH);
    if (process.env.PROTOTYPE_PERSISTENT_PUSH === 'true') {
      const { pushBranch, getPrototypesRepo } = await import('./github-app.js');
      console.log('[Finalizer] Starting persistent push...');
      // Discover current branch from git (works for both prototype and worker)
      const branchResult = await this.exec('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branchName = branchResult.stdout?.trim() || 'main';
      console.log('[Finalizer] Branch:', branchName);
      const pushResult = pushBranch(this.security.root, branchName);
      console.log('[Finalizer] Push result:', JSON.stringify(pushResult));
      if (!pushResult.ok) {
        // Push failed — return FAILED so checkpoint is not persisted
        return {
          status: 'FAILED',
          commitSha: null,
          commitMessage,
          changedFiles,
          gitStatus,
          testsPassed,
          testOutput: '',
          errorCode: 'PUSH_FAILED',
          errorMessage: `git push to ${getPrototypesRepo()} failed: ${pushResult.error}`,
        };
      }
    }

    // Verify working tree is clean after commit
    const finalStatusResult = await this.exec('git', ['status', '--short']);
    const workingTreeClean = (finalStatusResult.stdout || '').trim() === '';

    return {
      status: 'COMPLETED',
      commitSha,
      commitMessage,
      changedFiles,
      gitStatus: workingTreeClean ? 'clean' : finalStatusResult.stdout || '',
      testsPassed,
      testOutput: this.redactSecrets(testOutput),
      errorCode: null,
      errorMessage: null,
    };
  }

  /**
   * Execute a command in the workspace.
   */
  private async exec(command: string, args: string[]): Promise<{ status: string; stdout: string; stderr: string; exitCode: number | null }> {
    const result = await this.ctx.redactSecrets
      ? this.execWithRedaction(command, args)
      : this.execRaw(command, args);
    return result;
  }

  private async execRaw(command: string, args: string[]): Promise<{ status: string; stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise(resolve => {
      try {
        // execSync uses shell:true on Windows automatically for PATH resolution
        const output = execSync(command + ' ' + args.map(a => '"' + a.replace(/"/g, '\\"') + '"').join(' '), {
          cwd: this.security.root,
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: this.ctx.commandTimeoutMs,
        });
        resolve({
          status: 'COMPLETED',
          stdout: output.toString(),
          stderr: '',
          exitCode: 0,
        });
      } catch (error: any) {
        resolve({
          status: error.status === 0 ? 'COMPLETED' : 'FAILED',
          stdout: error.stdout?.toString() || '',
          stderr: error.stderr?.toString() || error.message || 'Command failed',
          exitCode: typeof error.status === 'number' ? error.status : null,
        });
      }
    });
  }

  private async execWithRedaction(command: string, args: string[]): Promise<{ status: string; stdout: string; stderr: string; exitCode: number | null }> {
    const result = await this.execRaw(command, args);
    return {
      status: result.status,
      stdout: this.redactSecrets(result.stdout),
      stderr: this.redactSecrets(result.stderr),
      exitCode: result.exitCode,
    };
  }

  /**
   * Execute a shell command (test command) in the workspace.
   */
  private async execShell(command: string, opts: { timeoutMs?: number }): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    return new Promise(resolve => {
      const proc = spawn(command, {
        cwd: this.security.root,
        shell: true,
        timeout: opts.timeoutMs ?? this.ctx.commandTimeoutMs,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', d => stdout += d);
      proc.stderr?.on('data', d => stderr += d);

      proc.on('error', () => {
        resolve({ stdout: '', stderr: 'Command not found', exitCode: null });
      });

      proc.on('close', code => {
        resolve({
          stdout: this.redactSecrets(stdout),
          stderr: this.redactSecrets(stderr),
          exitCode: code,
        });
      });
    });
  }

  /**
   * Redact known secret patterns from output.
   */
  private redactSecrets(value: string): string {
    if (!value) return value;
    let result = value;
    for (const [key, secret] of Object.entries(process.env)) {
      if (secret && /(api[_-]?key|token|password|secret|credential|private[_-]?key)/i.test(key) && secret.length >= 4) {
        result = result.split(secret).join('[REDACTED]');
      }
    }
    // Also redact Bearer tokens
    result = result.replace(/Bearer [A-Za-z0-9_-]{8,}/g, 'Bearer [REDACTED]');
    return result;
  }
}

/**
 * Check if a git command is blocked.
 */
export function isBlockedGitCommand(cmd: string): string | null {
  const lower = cmd.toLowerCase();
  for (const blocked of BLOCKED_GIT_COMMANDS) {
    if (lower.includes(blocked)) {
      return blocked;
    }
  }
  return null;
}

/**
 * Convenience function: capture a workspace snapshot.
 * Used by BaseWorker.executeOnce() to capture baseline before agent runs.
 */
export function captureWorkspaceSnapshot(root: string): WorkspaceSnapshot {
  return WorkspaceValidator.captureSnapshot(root);
}
