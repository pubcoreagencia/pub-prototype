import type { Task } from '../domain.js';
import type { AgentProvider, ProviderKind, ProviderTaskResult, ProviderTaskInput } from './types.js';
import type { StreamConsumer } from './streaming/index.js';

export interface DualGatewayConfig {
  primary: AgentProvider;
  fallback: AgentProvider;
}

export class DualGatewayProvider implements AgentProvider {
  readonly kind: ProviderKind;
  readonly model: string | null;
  readonly primary: AgentProvider;
  readonly fallback: AgentProvider;

  constructor(primary: AgentProvider, fallback: AgentProvider) {
    this.primary = primary;
    this.fallback = fallback;
    this.kind = primary.kind;
    this.model = primary.model;
  }

  private hasMutableEffects(result: ProviderTaskResult): boolean {
    if (result.changedFiles && result.changedFiles.length > 0) {
      return true;
    }
    if (typeof result.toolCalls === 'number' && result.toolCalls > 0) {
      return true;
    }
    if (typeof result.toolRounds === 'number' && result.toolRounds > 0) {
      return true;
    }
    return false;
  }

  private isRetryableGatewayFailure(result: ProviderTaskResult): boolean {
    if (result.status === 'COMPLETED') return false;
    if (result.status === 'TOOL_LOOP_LIMIT') return false;

    // Retryable statuses:
    if (
      result.status === 'ROUTER_HTTP_ERROR' ||
      result.status === 'ROUTER_TIMEOUT' ||
      result.status === 'ROUTER_CONNECTION_ERROR' ||
      result.status === 'TIMED_OUT' ||
      result.status === 'FAILED'
    ) {
      return true;
    }

    if (result.httpStatus) {
      if (result.httpStatus === 429 || result.httpStatus === 402 || result.httpStatus >= 500) {
        return true;
      }
    }

    if (
      result.errorCode === 'EMPTY_RESPONSE' ||
      result.errorCode === 'INVALID_RESPONSE' ||
      result.errorCode === 'ALL_PROVIDERS_FAILED' ||
      result.errorCode === 'GATEWAY_EXHAUSTED'
    ) {
      return true;
    }

    return true;
  }

  async execute(
    task: Task | ProviderTaskInput,
    workspace: string,
    options?: { signal?: AbortSignal; consumer?: StreamConsumer }
  ): Promise<ProviderTaskResult> {
    const primaryResult = await this.primary.execute(task, workspace, options);

    if (primaryResult.status === 'COMPLETED') {
      return primaryResult;
    }

    // Safety rule: if primary failed AFTER producing mutable effects or tool calls,
    // block automatic fallback to prevent executing another model on a partially altered workspace.
    if (this.hasMutableEffects(primaryResult)) {
      const changedList = primaryResult.changedFiles?.length ? ` [${primaryResult.changedFiles.join(', ')}]` : '';
      return {
        ...primaryResult,
        status: 'FAILED',
        errorCode: 'PARTIAL_EXECUTION_REQUIRES_REVIEW',
        errorMessage: `Partial execution detected on primary gateway (${this.primary.kind}/${primaryResult.model ?? 'unknown'}) with ${primaryResult.toolCalls ?? 0} tool call(s) and ${primaryResult.changedFiles?.length ?? 0} changed file(s)${changedList}. Automatic gateway fallback blocked to prevent workspace corruption.`,
        stderr: primaryResult.stderr
          ? `${primaryResult.stderr}\n[DualGateway] Blocked fallback: PARTIAL_EXECUTION_REQUIRES_REVIEW (${this.primary.kind} executed tool calls/mutations before failure)`
          : `[DualGateway] Blocked fallback: PARTIAL_EXECUTION_REQUIRES_REVIEW (${this.primary.kind} executed tool calls/mutations before failure)`,
      };
    }

    if (!this.isRetryableGatewayFailure(primaryResult)) {
      return primaryResult;
    }

    // Attempt fallback gateway (safe: 0 tool calls, 0 changed files)
    try {
      const fallbackResult = await this.fallback.execute(task, workspace, options);
      return {
        ...fallbackResult,
        fallbackUsed: true,
      };
    } catch (fallbackError) {
      const message = fallbackError instanceof Error ? fallbackError.message : 'Fallback gateway failed';
      return {
        status: 'FAILED',
        provider: this.fallback.kind,
        model: this.fallback.model,
        exitCode: null,
        durationMs: primaryResult.durationMs,
        stdout: primaryResult.stdout,
        stderr: `${primaryResult.stderr}\nFallback gateway error (${this.fallback.kind}): ${message}`.trim(),
        changedFiles: primaryResult.changedFiles ?? [],
        commit: null,
        errorCode: 'ALL_PROVIDERS_FAILED',
        errorMessage: `Primary gateway (${this.primary.kind}) failed: ${primaryResult.errorMessage || primaryResult.stderr || 'unknown'}; Fallback (${this.fallback.kind}) error: ${message}`,
        toolCalls: primaryResult.toolCalls ?? 0,
        toolRounds: primaryResult.toolRounds ?? 0,
        fallbackUsed: true,
      };
    }
  }

  async health(): Promise<{ available: boolean; details: string }> {
    const primaryHealth = await this.primary.health();
    if (primaryHealth.available) {
      return { available: true, details: `Primary (${this.primary.kind}): ${primaryHealth.details}` };
    }
    const fallbackHealth = await this.fallback.health();
    return {
      available: fallbackHealth.available,
      details: `Primary (${this.primary.kind}) down: ${primaryHealth.details}; Fallback (${this.fallback.kind}): ${fallbackHealth.details}`,
    };
  }

  capabilities(): string[] {
    return Array.from(new Set([...this.primary.capabilities(), ...this.fallback.capabilities()]));
  }

  metadata(): Record<string, string | null> {
    return {
      primaryProvider: this.primary.kind,
      primaryModel: this.primary.model,
      fallbackProvider: this.fallback.kind,
      fallbackModel: this.fallback.model,
    };
  }
}
