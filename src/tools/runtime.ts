import { promises as fs, constants as fsConstants } from 'node:fs';
import { join, relative, sep, parse } from 'node:path';
import { AgentExecutor, type ExecutionResult, type ExecutionRequest } from '../executor.js';
import { WorkspaceSecurity } from './security.js';
import type { ToolResult, ToolExecutionContext, ToolDefinition } from './types.js';

// Git subcommands that are explicitly blocked for security
const BLOCKED_GIT_COMMANDS = [
  'push', 'remote', 'reset', 'clean', 'checkout --', 'restore .',
  'branch -D', 'branch -d', 'fetch', 'pull', 'merge',
];

/**
 * Sanitize a git commit message:
 * - Truncate to 200 chars
 * - Remove control characters
 */
export function sanitizeCommitMessage(message: string): string {
  let sanitized = message
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') // Remove control chars except \t \n \r
    .trim();

  if (sanitized.length > 200) {
    sanitized = sanitized.substring(0, 200);
  }

  return sanitized;
}

/**
 * Check if a command contains blocked git operations.
 * Returns the blocked pattern if found, otherwise null.
 */
function checkBlockedGit(cmd: string): string | null {
  const lower = cmd.toLowerCase();
  for (const blocked of BLOCKED_GIT_COMMANDS) {
    if (lower.includes(blocked)) {
      return blocked;
    }
  }
  return null;
}

/**
 * ToolRuntime: executes tools requested by the 9Router LLM.
 *
 * All filesystem operations are confined to the workspace root.
 * Commands are executed via AgentExecutor with workspace cwd.
 * Git operations are restricted to safe subcommands.
 */
export class ToolRuntime {
  private readonly security: WorkspaceSecurity;
  private readonly executor: AgentExecutor;
  private readonly ctx: ToolExecutionContext;
  private readonly changedFiles: Set<string> = new Set();
  private readonly calledTools: Set<string> = new Set();
  private toolCallCounter: number = 0;

  constructor(ctx: ToolExecutionContext, executor: AgentExecutor = new AgentExecutor()) {
    this.ctx = ctx;
    this.security = new WorkspaceSecurity(ctx.workspaceRoot);
    this.executor = executor;
  }

  /**
   * Get the OpenAI-compatible tool definitions for all implemented tools.
   */
  getToolDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'read_file',
        description: 'Read the contents of a file within the task workspace. Returns an error if the file does not exist or is outside the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to read (relative to workspace or absolute within workspace).',
            },
          },
          required: ['path'],
        },
      },
      {
        name: 'write_file',
        description: 'Write content to a file within the task workspace. Creates parent directories if needed. Overwrites existing files.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Path to the file to write (relative to workspace or absolute within workspace).',
            },
            content: {
              type: 'string',
              description: 'The content to write to the file.',
            },
          },
          required: ['path', 'content'],
        },
      },
      {
        name: 'list_files',
        description: 'List files and directories within the workspace. Returns relative paths.',
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Directory path to list (defaults to workspace root). Must be within workspace.',
            },
            limit: {
              type: 'integer',
              description: 'Maximum number of entries to return (default 100, max 500).',
            },
          },
          required: [],
        },
      },
      {
        name: 'git_status',
        description: 'Check git status of the workspace. Returns short status of changed files. Never pushes or modifies git state.',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
        },
      },
      {
        name: 'git_diff',
        description: 'Show git diff for the workspace (staged and unstaged changes). Never pushes or modifies git state.',
        parameters: {
          type: 'object',
          properties: {
            file: {
              type: 'string',
              description: 'Optional: specific file to diff. If omitted, shows all changes.',
            },
          },
          required: [],
        },
      },
      {
        name: 'git_commit',
        description: 'Create a local git commit of all staged and unstaged changes in the workspace. Runs git add -A, validates changes, and commits with the provided message. NEVER pushes to remote. Blocked commands: push, remote, reset, clean, checkout, restore, fetch, pull, merge, branch -D.',
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: 'Commit message (max 200 chars, will be sanitized).',
            },
          },
          required: ['message'],
        },
      },
      {
        name: 'run_command',
        description: 'Execute a shell command within the task workspace. Returns stdout, stderr, and exit code. Blocked patterns: git push, git remote, git reset, git clean, git fetch, git pull, git merge, git checkout --, git restore, git branch -D.',
        parameters: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              description: 'The command to execute. cwd will be the workspace root.',
            },
            timeout_ms: {
              type: 'integer',
              description: 'Timeout in milliseconds (default 60000, max 300000).',
            },
          },
          required: ['command'],
        },
      },
    ];
  }

  /**
   * Execute a single tool call and return the result.
   */
  async executeTool(toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    this.calledTools.add(toolName);

    try {
      switch (toolName) {
        case 'read_file':
          return await this.readFile(toolCallId, args);
        case 'write_file':
          return await this.writeFile(toolCallId, args);
        case 'list_files':
          return await this.listFiles(toolCallId, args);
        case 'git_status':
          return await this.gitStatus(toolCallId, args);
        case 'git_diff':
          return await this.gitDiff(toolCallId, args);
        case 'git_commit':
          return await this.gitCommit(toolCallId, args);
        case 'run_command':
          return await this.runCommand(toolCallId, args);
        default:
          return {
            toolCallId,
            toolName,
            success: false,
            content: '',
            error: `Unknown tool: ${toolName}`,
          };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        toolCallId,
        toolName,
        success: false,
        content: '',
        error: message,
      };
    }
  }

  private async readFile(toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const path = String(args.path ?? '');
    const resolved = this.security.resolvePath(path);

    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile()) {
        return {
          toolCallId,
          toolName: 'read_file',
          success: false,
          content: '',
          error: `Not a file: ${relative(this.security.root, resolved)}`,
        };
      }

      if (stat.size > this.ctx.maxFileBytes) {
        return {
          toolCallId,
          toolName: 'read_file',
          success: false,
          content: '',
          error: `File too large: ${stat.size} bytes (max ${this.ctx.maxFileBytes})`,
        };
      }

      const content = await fs.readFile(resolved, 'utf8');
      return {
        toolCallId,
        toolName: 'read_file',
        success: true,
        content: content,
        error: null,
      };
    } catch (e: any) {
      return {
        toolCallId,
        toolName: 'read_file',
        success: false,
        content: '',
        error: `File not found: ${relative(this.security.root, resolved)}`,
      };
    }
  }

  private async writeFile(toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const path = String(args.path ?? '');
    const content = String(args.content ?? '');
    const resolved = this.security.resolvePath(path);

    if (content.length > this.ctx.maxWriteBytes) {
      return {
        toolCallId,
        toolName: 'write_file',
        success: false,
        content: '',
        error: `Content too large: ${content.length} chars (max ${this.ctx.maxWriteBytes})`,
      };
    }

    // Create parent directories
    const parent = resolved.substring(0, resolved.lastIndexOf(sep));
    if (parent && parent !== resolved) {
      await fs.mkdir(parent, { recursive: true });
    }

    await fs.writeFile(resolved, content, 'utf8');

    // Track changed files (relative to workspace)
    const relativePath = relative(this.security.root, resolved);
    this.changedFiles.add(relativePath);

    return {
      toolCallId,
      toolName: 'write_file',
      success: true,
      content: `Wrote ${content.length} chars to ${relativePath}`,
      error: null,
    };
  }

  private async listFiles(toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const dirPath = String(args.path ?? '.');
    const limit = Math.min(Number(args.limit ?? 100), 500);
    const resolved = this.security.resolvePath(dirPath);

    try {
      const entries = await fs.readdir(resolved, { withFileTypes: true });
      const results: string[] = [];

      for (const entry of entries) {
        if (results.length >= limit) break;
        const relativePath = relative(this.security.root, join(resolved, entry.name));
        const suffix = entry.isDirectory() ? '/' : '';
        results.push(relativePath + suffix);
      }

      return {
        toolCallId,
        toolName: 'list_files',
        success: true,
        content: results.join('\n'),
        error: null,
      };
    } catch (e: any) {
      return {
        toolCallId,
        toolName: 'list_files',
        success: false,
        content: '',
        error: `Cannot list directory: ${dirPath}`,
      };
    }
  }

  private async gitStatus(toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await this.executor.execute({
      command: 'git',
      args: ['status', '--short'],
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    const gitStatus = result.stdout || '';
    const changed = gitStatus.trim().split('\n').filter(Boolean).map(line => {
      // git status --short format: "XY filename" or "XY filename -> newname"
      return line.substring(3).trim();
    });

    // Update changedFiles tracking
    for (const f of changed) {
      this.changedFiles.add(f);
    }

    return {
      toolCallId,
      toolName: 'git_status',
      success: result.status === 'COMPLETED',
      content: JSON.stringify({ gitStatus, changedFiles: changed }, null, 2),
      error: result.status === 'COMPLETED' ? null : `git status failed: ${result.stderr || 'unknown'}`,
    };
  }

  private async gitDiff(toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const file = args.file ? String(args.file) : '';
    const gitArgs = file ? ['diff', '--', file] : ['diff'];
    
    // Resolve and validate file path if specified
    if (file) {
      try {
        this.security.resolvePath(file);
      } catch (e: any) {
        return {
          toolCallId,
          toolName: 'git_diff',
          success: false,
          content: '',
          error: `Invalid file path: ${e.message}`,
        };
      }
    }

    const result = await this.executor.execute({
      command: 'git',
      args: gitArgs,
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    return {
      toolCallId,
      toolName: 'git_diff',
      success: result.status === 'COMPLETED',
      content: result.stdout || '',
      error: result.status === 'COMPLETED' ? null : `git diff failed: ${result.stderr || 'unknown'}`,
    };
  }

  private async gitCommit(toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const message = String(args.message ?? '');

    // Validate message
    if (!message || !message.trim()) {
      return {
        toolCallId,
        toolName: 'git_commit',
        success: false,
        content: '',
        error: 'Commit message is required and cannot be empty',
      };
    }

    const sanitizedMessage = sanitizeCommitMessage(message);

    // Check git status first
    const statusResult = await this.executor.execute({
      command: 'git',
      args: ['status', '--short'],
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    const gitStatus = statusResult.stdout || '';
    const changedFiles = gitStatus.trim().split('\n').filter(Boolean).map(line => {
      // git status --short format: "XY filename" or "XY filename -> newname"
      // Extract filename (skip the 2-char status + space)
      const filename = line.substring(3);
      // Handle rename: "old -> new"
      const arrowIdx = filename.indexOf(' -> ');
      return arrowIdx >= 0 ? filename.substring(arrowIdx + 4) : filename;
    });

    if (changedFiles.length === 0) {
      return {
        toolCallId,
        toolName: 'git_commit',
        success: false,
        content: '',
        error: 'No changes to commit — working tree is clean',
      };
    }

    // git add -A
    await this.executor.execute({
      command: 'git',
      args: ['add', '-A'],
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    // git diff --cached --stat (to show what will be committed)
    const diffStatResult = await this.executor.execute({
      command: 'git',
      args: ['diff', '--cached', '--stat'],
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    // git commit
    const commitResult = await this.executor.execute({
      command: 'git',
      args: ['commit', '-m', sanitizedMessage],
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    if (commitResult.status !== 'COMPLETED') {
      return {
        toolCallId,
        toolName: 'git_commit',
        success: false,
        content: '',
        error: `git commit failed: ${commitResult.stderr || 'unknown error'}`,
      };
    }

    // Get commit SHA
    const shaResult = await this.executor.execute({
      command: 'git',
      args: ['rev-parse', 'HEAD'],
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    const commitSha = shaResult.stdout?.trim() || null;

    // Get final git status
    const finalStatusResult = await this.executor.execute({
      command: 'git',
      args: ['status', '--short'],
      cwd: this.security.root,
      timeoutMs: this.ctx.commandTimeoutMs,
      environment: process.env,
    });

    const finalStatus = finalStatusResult.stdout || '';

    const response = {
      success: true,
      commitSha,
      message: sanitizedMessage,
      changedFiles: changedFiles,
      gitStatus: finalStatus,
      diffStat: diffStatResult.stdout || '',
    };

    return {
      toolCallId,
      toolName: 'git_commit',
      success: true,
      content: JSON.stringify(response, null, 2),
      error: null,
    };
  }

  private async runCommand(toolCallId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const command = String(args.command ?? '');
    const timeoutMs = Math.min(Number(args.timeout_ms ?? 60000), this.ctx.commandTimeoutMs);

    if (!command.trim()) {
      return {
        toolCallId,
        toolName: 'run_command',
        success: false,
        content: '',
        error: 'Empty command',
      };
    }

    // Block dangerous git operations in run_command too
    const blocked = checkBlockedGit(command);
    if (blocked) {
      return {
        toolCallId,
        toolName: 'run_command',
        success: false,
        content: '',
        error: `Blocked git operation: '${blocked}' is not allowed via run_command`,
      };
    }

    // Parse command into parts (simple split — no shell expansion)
    const parts = this.parseCommand(command);

    const request: ExecutionRequest = {
      command: parts[0],
      args: parts.slice(1),
      cwd: this.security.root,
      timeoutMs,
      environment: this.ctx.redactSecrets ? this.redactEnv(process.env) : process.env,
    };

    const execResult = await this.executor.execute(request);

    if (execResult.status === 'COMPLETED') {
      return {
        toolCallId,
        toolName: 'run_command',
        success: true,
        content: execResult.stdout || '',
        error: null,
      };
    }

    return {
      toolCallId,
      toolName: 'run_command',
      success: false,
      content: execResult.stdout || '',
      error: `Command failed (exit ${execResult.exitCode || 'N/A'}): ${execResult.stderr || execResult.status}`,
    };
  }

  /**
   * Simple command parser: splits on spaces but respects quotes.
   * Does not use shell — passes directly to spawn.
   */
  private parseCommand(command: string): string[] {
    const parts: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';

    for (let i = 0; i < command.length; i++) {
      const char = command[i];
      if ((char === '"' || char === "'") && !inQuote) {
        inQuote = true;
        quoteChar = char;
      } else if (char === quoteChar && inQuote) {
        inQuote = false;
        quoteChar = '';
      } else if (char === ' ' && !inQuote) {
        if (current) parts.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    if (current) parts.push(current);

    return parts;
  }

  /**
   * Redact known secret patterns from environment variables.
   */
  private redactEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const redacted: NodeJS.ProcessEnv = { ...env };
    for (const [key, value] of Object.entries(env)) {
      if (value && /(api[_-]?key|token|password|secret|credential|private[_-]?key)/i.test(key) && value.length >= 4) {
        redacted[key] = '[REDACTED]';
      }
    }
    return redacted;
  }

  /**
   * Get list of changed files (relative to workspace).
   */
  getChangedFiles(): string[] {
    return Array.from(this.changedFiles);
  }

  /**
   * Get list of tool names that were called.
   */
  getCalledTools(): string[] {
    return Array.from(this.calledTools);
  }
}
