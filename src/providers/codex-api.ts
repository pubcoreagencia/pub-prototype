import type { Task } from '../domain.js';
import type { AgentExecutor, ExecutionResult } from '../executor.js';
import type { AgentProvider, ProviderTaskResult, ProviderTaskInput } from './types.js';

function buildProviderTaskResult(
  provider: 'codex-api',
  model: string | null,
  execution: ExecutionResult,
): ProviderTaskResult {
  return {
    status: execution.status,
    provider,
    model,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    stdout: execution.stdout,
    stderr: execution.stderr,
    changedFiles: [],
    commit: null,
    errorCode: execution.status === 'COMPLETED' ? null : `CODEX_EXECUTION_${execution.status}`,
    errorMessage: execution.status === 'COMPLETED' ? null : execution.stderr || 'Codex execution failed',
    execution,
  };
}

export class CodexApiProvider implements AgentProvider {
  readonly kind = 'codex-api' as const;
  readonly model = process.env.CODEX_MODEL ?? null;

  constructor(
    private readonly executor: AgentExecutor,
    private readonly command = process.env.CODEX_COMMAND ?? 'codex',
    private readonly timeoutMs = Number(process.env.AGENT_TIMEOUT_MS ?? 900000),
  ) {}

  async execute(task: Task | ProviderTaskInput, workspace: string): Promise<ProviderTaskResult> {
    const execution = await this.executor.execute({
      command: this.command,
      args: ['-c', 'approval_policy=never', '-c', 'sandbox_mode=workspace-write', 'exec', task.prompt],
      cwd: workspace,
      timeoutMs: this.timeoutMs,
    });
    return buildProviderTaskResult(this.kind, this.model, execution);
  }

  async health() {
    return { available: true, details: `command=${this.command}` };
  }

  capabilities() {
    return ['coding', 'filesystem', 'git', 'shell'];
  }

  metadata() {
    return { command: this.command, model: this.model };
  }
}
