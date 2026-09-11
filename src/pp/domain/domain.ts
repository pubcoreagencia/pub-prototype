export const PROTOTYPE_MODES = ['PROTOTYPE', 'DEVELOPMENT'] as const;
export type PrototypeMode = typeof PROTOTYPE_MODES[number];

export const PROTOTYPE_SESSION_STATUSES = ['CREATING','READY','BUILDING','PREVIEWING','FAILED','APPROVED','PROMOTED','ARCHIVED'] as const;
export type PrototypeSessionStatus = typeof PROTOTYPE_SESSION_STATUSES[number];

export const PROTOTYPE_EVENT_TYPES = [
  'USER_PROMPT',
  'PLAN_STARTED',
  'PLAN_COMPLETED',
  'AGENT_STARTED',
  'AGENT_OUTPUT',
  'AGENT_ATTEMPT_STARTED',
  'AGENT_TEXT_DELTA',
  'AGENT_TOOL_CALL_DELTA',
  'AGENT_TOOL_CALL_COMPLETED',
  'AGENT_USAGE',
  'AGENT_FINISH_REASON',
  'AGENT_STREAM_COMPLETED',
  'AGENT_ATTEMPT_COMPLETED',
  'AGENT_ATTEMPT_FAILED',
  'AGENT_RETRY_STARTED',
  'TASK_CANCELLED',
  'FILE_CHANGED',
  'BUILD_STARTED',
  'BUILD_PASSED',
  'BUILD_FAILED',
  'PREVIEW_STARTED',
  'PREVIEW_READY',
  'PREVIEW_FAILED',
  'PREVIEW_LOCAL_SERVER_READY',
  'PREVIEW_TUNNEL_READY',
  'CHECKPOINT_CREATED',
  'DEPLOY_STARTED',
  'DEPLOY_COMPLETED',
  'DEPLOY_FAILED',
  'PROMOTED_TO_DEVELOPMENT',
  'ERROR',
  'correction_started',
  'correction_succeeded',
  'correction_failed',
  'correction_escalated',
] as const;
export type PrototypeEventType = typeof PROTOTYPE_EVENT_TYPES[number];

export interface PrototypeSession {
  id: string;
  project: string;
  repository: string;
  branch: string;
  mode: PrototypeMode;
  status: PrototypeSessionStatus;
  previewUrl: string | null;
  previewRuntime: string | null;
  workspacePath: string | null;
  lastCheckpointSha: string | null;
  promptCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePrototypeSession { project: string; repository: string; branch?: string; }
export interface PrototypeCheckpoint { id:string; sessionId:string; promptIndex:number; prompt:string; commitSha:string|null; previewUrl:string|null; buildPassed:boolean; createdAt:Date; }
export interface PrototypeEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> { id:string; sessionId:string; type:PrototypeEventType; sequence:number; timestamp:Date; payload:TPayload; }
export interface PrototypePromotion { id?: string; sessionId:string; fromMode:Extract<PrototypeMode,'PROTOTYPE'>; toMode:Extract<PrototypeMode,'DEVELOPMENT'>; repository:string; branch:string; checkpointSha:string|null; promotedAt:Date; }

export interface PrototypeMessage {
  id: string;
  sessionId: string;
  taskId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'progress';
  content: string;
  createdAt: Date;
  order: number;
}

// === FASE 4: CONTRATOS DEDICADOS DE TAREFAS DO PROTOTYPE (PP) ===

export type PrototypeTaskStatus =
  | 'QUEUED'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'TESTING'
  | 'COMPLETED'
  | 'FAILED'
  | 'BLOCKED'
  | 'CANCELLED'
  | 'NEEDS_REVIEW';

export interface PrototypeTask {
  id: string;
  prototypeSessionId: string;
  project: string;
  repository: string;
  objective: string;
  prompt: string;
  status: PrototypeTaskStatus;
  priority: number;
  worker: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  branch: string | null;
  commitSha: string | null;
  gitStatus: string | null;
  workspacePath: string | null;
  leaseOwner: string | null;
  leaseDeadline: Date | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePrototypeTaskInput {
  prototypeSessionId: string;
  project: string;
  repository: string;
  objective: string;
  prompt: string;
  priority?: number;
  branch?: string;
  workspacePath?: string;
}

export interface PpTaskRepository {
  create(input: CreatePrototypeTaskInput): Promise<PrototypeTask>;
  list(sessionId?: string): Promise<PrototypeTask[]>;
  get(id: string): Promise<PrototypeTask | null>;
  claim(worker: string): Promise<PrototypeTask | null>;
  update(id: string, patch: Partial<PrototypeTask>): Promise<PrototypeTask | null>;
  cancel(id: string): Promise<PrototypeTask | null>;
  retry(id: string): Promise<PrototypeTask | null>;
  reclaimStuck(worker: string, leaseWindowMs: number, now: Date): Promise<number>;
  heartbeat(id: string, deadline: Date): Promise<boolean>;
}

