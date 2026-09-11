export type TaskStatus =
  | 'QUEUED'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'TESTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'NEEDS_REVIEW';

export interface Task {
  id: string;
  project: string;
  repository: string;
  objective: string;
  prompt: string;
  status: TaskStatus;
  priority: number;
  worker: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  branch: string | null;
  commitSha: string | null;
  gitStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  workspacePath?: string | null;
  prototypeSessionId?: string | null;
  [key: string]: unknown;
}

export type ProviderResultStatus =
  | 'COMPLETED'
  | 'FAILED'
  | 'ROUTER_TIMEOUT'
  | 'ROUTER_HTTP_ERROR'
  | 'ALL_PROVIDERS_FAILED'
  | 'UNKNOWN';

export interface AttemptTrace {
  attempt: number;
  provider: string;
  model: string | null;
  status: ProviderResultStatus;
  retryable: boolean;
  retryReason: string | null;
  httpStatus: number | undefined;
  errorCode: string | null;
  errorMessage: string | null;
  toolCalls: number;
  toolRounds: number;
  durationMs: number;
  exitCode: number | null;
  attemptTimeoutMs: number;
  isWinner: boolean;
  workspaceCreated: boolean;
  workspaceCleaned: boolean;
  tier?: 1 | 2 | 3;
  profile?: string;
  fallbackType?: 'retry' | 'model_switch' | 'tier_escalation';
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  gateway?: string;
  action?: string;
  fallbackChain?: string[];
  fallbackUsed?: boolean;
  validationResult?: string | null;
  errorClass?: string | null;
  agentId?: string | null;
}

export interface WorkerExecutionTrace {
  totalDurationMs: number;
  totalAttempts: number;
  providerChainLength: number;
  attempts: AttemptTrace[];
  winningAttempt: number | null;
  finalStatus: 'COMPLETED' | 'FAILED';
  errorCode: string | null;
  errorMessage: string | null;
  timedOut: boolean;
  globalTimeoutMs: number;
  finalizeWasCalled: boolean;
  finalizeStatus: 'COMPLETED' | 'FAILED' | 'SKIPPED_AGENT_FAILED' | null;
  commitSha: string | null;
}
