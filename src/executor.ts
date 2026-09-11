import { spawn } from 'node:child_process';

export type ExecutionStatus = 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'START_ERROR';

export interface ExecutionRequest {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  environment?: NodeJS.ProcessEnv;
  detached?: boolean;
}

export interface ExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  status: ExecutionStatus;
}

const secretPattern = /((?:api[_-]?key|token|password|secret|credential|private[_-]?key)\s*(?:=|:|\s)\s*)([^\s'"'`]+)/gi;

export const redact = (value: string, environment: NodeJS.ProcessEnv = process.env) => {
  let result = value.replace(secretPattern, '$1[REDACTED]');
  for (const [key, secret] of Object.entries(environment)) {
    if (secret && /(api[_-]?key|token|password|secret|credential|private[_-]?key)/i.test(key) && secret.length >= 4) {
      result = result.split(secret).join('[REDACTED]');
    }
  }
  return result;
};

/**
 * Agent executor: runs commands via spawn with shell: false.
 *
 * On Windows, spawn with shell: false doesn't find git via PATH because
 * Git for Windows installs git.exe in paths not visible to node.exe.
 * The ToolRuntime handles PATH resolution by using the full path to git.
 * For non-git commands (node, echo, etc.), shell: false works correctly
 * because node.exe finds itself via process.execPath.
 */
export class AgentExecutor {
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const started = Date.now();
    const environment = request.environment ?? process.env;

    return new Promise(resolve => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const finish = (exitCode: number | null, status: ExecutionStatus) => {
        if (settled) return;
        settled = true;
        resolve({
          exitCode,
          stdout: redact(stdout, environment),
          stderr: redact(stderr, environment),
          durationMs: Date.now() - started,
          status,
        });
      };

      let child: ReturnType<typeof spawn>;

      try {
        child = spawn(request.command, request.args, {
          cwd: request.cwd,
          env: environment,
          shell: false,
          detached: request.detached ?? false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        stderr = error instanceof Error ? error.message : 'Unable to start process';
        finish(null, 'START_ERROR');
        return;
      }

      const terminate = (signal: NodeJS.Signals) => {
        try {
          if (child.pid) {
            process.kill(-child.pid, signal);
          } else {
            child.kill(signal);
          }
        } catch {
          child.kill(signal);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        terminate('SIGTERM');
        setTimeout(() => terminate('SIGKILL'), 500).unref();
      }, request.timeoutMs);

      child.stdout?.on('data', data => stdout += data.toString());
      child.stderr?.on('data', data => stderr += data.toString());
      child.on('error', error => {
        stderr += error.message;
        clearTimeout(timer);
        finish(null, 'START_ERROR');
      });
      child.on('close', code => {
        clearTimeout(timer);
        finish(code, timedOut ? 'TIMED_OUT' : code === 0 ? 'COMPLETED' : 'FAILED');
      });
    });
  }
}
