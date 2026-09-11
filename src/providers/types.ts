import type { Task } from '../domain.js';
import type { ExecutionResult } from '../executor.js';
import type { TaskRoutingProfile } from '../routing/types.js';

export type ProviderKind = 'mock' | 'codex-api' | '9router' | 'openrouter';

export type ProviderResultStatus =
  | 'COMPLETED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'START_ERROR'
  | 'TOOL_LOOP_LIMIT'
  | 'ROUTER_HTTP_ERROR'
  | 'ROUTER_TIMEOUT'
  | 'ROUTER_CONNECTION_ERROR';

export interface ProviderTaskResult {
  status: ProviderResultStatus;
  provider: ProviderKind;
  model: string | null;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  changedFiles: string[];
  commit: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  execution?: ExecutionResult;
  toolCalls?: number;
  toolRounds?: number;
  commitMessage?: string | null;
  testsPassed?: boolean | null;
  httpStatus?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  // New field: ordered list of model identifiers attempted by the provider
  modelAttempts?: string[];
  /**
   * true → gateway fallback was invoked (regardless of success).
   * false / undefined → no gateway fallback.
   */
  fallbackUsed?: boolean;
  /** Validation result (currently always null; placeholder for future). */
  validationResult?: string | null;
  /** Formal error classification (currently always null; placeholder). */
  errorClass?: string | null;
}

export interface ProviderTaskInput {
  id: string;
  objective: string;
  prompt: string;
  project?: string;
  repository?: string;
  branch?: string | null;
  /** Domain/agent-specific system instructions injected by workers */
  systemInstructions?: string[];
  /** Optional task routing profile explicitly provided by caller (e.g., 'fast_prototype') */
  routingProfile?: TaskRoutingProfile;
  [key: string]: unknown;
}

export interface AgentProvider {
  readonly kind: ProviderKind;
  readonly model: string | null;
  execute(
    task: Task | ProviderTaskInput,
    workspace: string,
    options?: { signal?: AbortSignal; consumer?: any }
  ): Promise<ProviderTaskResult>;
  health(): Promise<{ available: boolean; details: string }>;
  capabilities(): string[];
  metadata(): Record<string, string | null>;
}

