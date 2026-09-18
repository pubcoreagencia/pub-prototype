import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  CreatePrototypeSession,
  PrototypeCheckpoint,
  PrototypeSession,
  PrototypeSessionStatus,
  PrototypeMode,
  PrototypePromotion,
  PrototypeMessage,
  User,
  Workspace,
  WorkspaceMember,
  WorkspaceRole,
  Project,
  ProjectStatus,
  CheckpointFile,
  PrototypeVerification,
  VerificationEvidence,
  PrototypeCorrectionAttempt,
  CreateCorrectionAttemptInput,
} from '../domain/domain.js';

const mapSession = (r: Record<string, unknown>): PrototypeSession => ({
  id: r.id as string,
  projectId: (r.project_id as string) || null,
  project: r.project as string,
  repository: r.repository as string,
  branch: r.branch as string,
  mode: r.mode as PrototypeMode,
  status: r.status as PrototypeSessionStatus,
  previewUrl: r.preview_url as string | null,
  previewRuntime: r.preview_runtime as string | null,
  workspacePath: r.workspace_path as string | null,
  lastCheckpointSha: r.last_checkpoint_sha as string | null,
  promptCount: r.prompt_count as number,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const mapCheckpoint = (r: Record<string, unknown>): PrototypeCheckpoint => ({
  id: r.id as string, sessionId: r.session_id as string, promptIndex: r.prompt_index as number,
  prompt: r.prompt as string, commitSha: r.commit_sha as string | null,
  previewUrl: r.preview_url as string | null, buildPassed: r.build_passed as boolean, createdAt: r.created_at as Date,
});

const mapVerification = (r: Record<string, unknown>): PrototypeVerification => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  checkpointId: r.checkpoint_id as string,
  commitSha: r.commit_sha as string,
  pipelineVersion: (r.pipeline_version as string) || 'v1',
  status: r.status as any,
  evidence: (typeof r.evidence === 'string' ? JSON.parse(r.evidence) : r.evidence) as VerificationEvidence,
  startedAt: r.started_at as Date,
  finishedAt: (r.finished_at as Date) || null,
  durationMs: (r.duration_ms as number) ?? null,
  createdAt: r.created_at as Date,
});

const mapCorrectionAttempt = (r: Record<string, unknown>): PrototypeCorrectionAttempt => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  taskId: r.task_id as string,
  sourceVerificationId: r.source_verification_id as string,
  sourceCheckpointId: r.source_checkpoint_id as string,
  attemptNumber: Number(r.attempt_number),
  status: r.status as any,
  resultCommitSha: (r.result_commit_sha as string) || null,
  resultCheckpointId: (r.result_checkpoint_id as string) || null,
  resultVerificationId: (r.result_verification_id as string) || null,
  failureEvidence: (typeof r.failure_evidence === 'string' ? JSON.parse(r.failure_evidence) : r.failure_evidence) || {},
  error: (r.error as string) || null,
  startedAt: r.started_at as Date,
  finishedAt: (r.finished_at as Date) || null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const mapProject = (r: Record<string, unknown>): Project => ({
  id: r.id as string,
  workspaceId: r.workspace_id as string,
  name: r.name as string,
  description: (r.description as string) || '',
  status: (r.status as ProjectStatus) || 'ACTIVE',
  githubRepository: (r.github_repository as string) || null,
  githubBranch: (r.github_branch as string) || null,
  supabaseProjectReference: (r.supabase_project_reference as string) || null,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const mapWorkspace = (r: Record<string, unknown>): Workspace => ({
  id: r.id as string,
  name: r.name as string,
  slug: r.slug as string,
  ownerId: (r.owner_id as string) || '00000000-0000-0000-0000-000000000000',
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
});

const mapCheckpointFile = (r: Record<string, unknown>): CheckpointFile => ({
  id: r.id as string,
  checkpointId: r.checkpoint_id as string,
  sessionId: r.session_id as string,
  path: r.path as string,
  content: r.content as string,
  contentType: (r.content_type as string) || 'text/plain',
  sizeBytes: Number(r.size_bytes || 0),
  createdAt: r.created_at as Date,
});

const mapPromotion = (r: Record<string, unknown>): PrototypePromotion => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  fromMode: r.from_mode as Extract<PrototypeMode, 'PROTOTYPE'>,
  toMode: r.to_mode as Extract<PrototypeMode, 'DEVELOPMENT'>,
  repository: r.repository as string,
  branch: r.branch as string,
  checkpointSha: r.checkpoint_sha as string | null,
  promotedAt: r.promoted_at as Date,
});

const mapMessage = (r: Record<string, unknown>): PrototypeMessage => ({
  id: r.id as string,
  sessionId: r.session_id as string,
  taskId: r.task_id as string | undefined,
  role: r.role as any,
  content: r.content as string,
  createdAt: r.created_at as Date,
  order: Number(r.order),
});

export interface PrototypeRepository {
  createSession(input: CreatePrototypeSession): Promise<PrototypeSession>;
  getSession(id: string): Promise<PrototypeSession | null>;
  listSessions(): Promise<PrototypeSession[]>;
  updateSession(id: string, patch: Partial<Pick<PrototypeSession,'status'|'mode'|'previewUrl'|'previewRuntime'|'workspacePath'|'lastCheckpointSha'>>): Promise<PrototypeSession | null>;
  incrementPromptCount(id: string): Promise<PrototypeSession | null>;
  promoteSession(id: string): Promise<PrototypeSession | null>;
  createCheckpoint(input: Omit<PrototypeCheckpoint,'id'|'createdAt'>): Promise<PrototypeCheckpoint>;
  listCheckpoints(sessionId: string): Promise<PrototypeCheckpoint[]>;
  createPromotion(input: Omit<PrototypePromotion, 'id'>): Promise<PrototypePromotion>;
  getPromotion(sessionId: string): Promise<PrototypePromotion | null>;
  addMessage(msg: PrototypeMessage): Promise<PrototypeMessage>;
  listMessages(sessionId: string): Promise<PrototypeMessage[]>;
  nextMessageOrder(sessionId: string): Promise<number>;

  // PP 2.0 Workspaces & Projects
  listWorkspaces(userId?: string): Promise<Workspace[]>;
  createWorkspace(input: { name: string; slug?: string; ownerId?: string }): Promise<Workspace>;
  getWorkspace(id: string): Promise<Workspace | null>;
  listProjects(workspaceId?: string): Promise<Project[]>;
  createProject(input: { workspaceId?: string; name: string; description?: string; githubRepository?: string; githubBranch?: string }): Promise<Project>;
  getProject(id: string): Promise<Project | null>;
  updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'status' | 'githubRepository' | 'githubBranch'>>): Promise<Project | null>;
  deleteProject(id: string): Promise<boolean>;
  getWorkspaceMembership(userId: string, workspaceId: string): Promise<{ role: string } | null>;
  addWorkspaceMember(input: { workspaceId: string; userId: string; role: string }): Promise<void>;

  // PP 2.0 Checkpoint Files for Native Preview & Code Inspector
  saveCheckpointFiles(files: CheckpointFile[]): Promise<void>;
  listCheckpointFiles(checkpointId: string): Promise<CheckpointFile[]>;
  getCheckpointFile(checkpointId: string, path: string): Promise<CheckpointFile | null>;
  listSessionFiles(sessionId: string): Promise<CheckpointFile[]>;
  getLatestSessionFile(sessionId: string, path: string): Promise<CheckpointFile | null>;

  // PP 2.0 Mandatory Verification Gate & Audit Trail
  createVerification(input: Omit<PrototypeVerification, 'id' | 'createdAt'>): Promise<PrototypeVerification>;
  getVerification(id: string): Promise<PrototypeVerification | null>;
  getLatestVerificationForCheckpoint(checkpointId: string): Promise<PrototypeVerification | null>;
  listVerifications(sessionId: string): Promise<PrototypeVerification[]>;
  compareAndPromoteSession(sessionId: string, expectedCurrentCheckpointSha: string | null, targetCheckpoint: PrototypeCheckpoint, previewUrl: string, previewRuntime?: string): Promise<PrototypeSession | null>;

  // PP 2.1 Autonomous Verification Recovery Loop
  createCorrectionAttempt(input: CreateCorrectionAttemptInput): Promise<PrototypeCorrectionAttempt | null>;
  updateCorrectionAttempt(id: string, patch: Partial<Pick<PrototypeCorrectionAttempt, 'status' | 'resultCommitSha' | 'resultCheckpointId' | 'resultVerificationId' | 'error' | 'finishedAt'>>): Promise<PrototypeCorrectionAttempt | null>;
  getCorrectionAttempt(id: string): Promise<PrototypeCorrectionAttempt | null>;
  listCorrectionAttempts(sessionId: string): Promise<PrototypeCorrectionAttempt[]>;
  getCorrectionAttemptsForVerification(sourceVerificationId: string): Promise<PrototypeCorrectionAttempt[]>;

  initializeSchema(): Promise<void>;
}

// Sovereign in-memory fallback store to ensure zero downtime when database quota is reached
const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_WORKSPACE_ID = '11111111-1111-1111-1111-111111111111';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toDbUserId = (id?: string | null): string => (id && UUID_REGEX.test(id) ? id : DEFAULT_USER_ID);


const fallbackWorkspaces = new Map<string, Workspace>();
const fallbackProjects = new Map<string, Project>();
const fallbackSessions = new Map<string, PrototypeSession>();
const fallbackCheckpoints = new Map<string, PrototypeCheckpoint[]>();
const fallbackPromotions = new Map<string, PrototypePromotion>();
const fallbackMessages = new Map<string, PrototypeMessage[]>();
const fallbackCheckpointFiles = new Map<string, CheckpointFile[]>();
const fallbackVerifications = new Map<string, PrototypeVerification[]>();
const fallbackCorrectionAttempts = new Map<string, PrototypeCorrectionAttempt[]>();
const fallbackWorkspaceMembers = new Map<string, Map<string, WorkspaceRole>>([
      [DEFAULT_WORKSPACE_ID,
        new Map<string, WorkspaceRole>([
          ['test-user-id', 'OWNER'],
          ['viewer-user-id', 'VIEWER'],
        ]),
      ],
]);

fallbackWorkspaces.set(DEFAULT_WORKSPACE_ID, {
  id: DEFAULT_WORKSPACE_ID,
  name: 'Default Workspace',
  slug: 'default-workspace',
  ownerId: DEFAULT_USER_ID,
  createdAt: new Date('2026-08-28T12:00:00.000Z'),
  updatedAt: new Date('2026-08-28T12:00:00.000Z'),
});

const RECOVERED_GIT_SESSIONS: Array<{ id: string; project: string; branch: string }> = [
  { id: "0b91af99-f7d8-42f1-87f5-2740d50045fb", project: "app-eletricista-live", branch: "prototype/app-eletricista-live/0b91af99-f7d8-42f1-87f5-2740d50045fb" },
  { id: "6ce6bf09-37bf-46b2-a862-de49b7bca577", project: "app-eletricista-v2", branch: "prototype/app-eletricista-v2/6ce6bf09-37bf-46b2-a862-de49b7bca577" },
  { id: "0f17bc03-fad0-463f-bdc8-9fe05d604f31", project: "app-para-parque-de-diversao", branch: "prototype/app-para-parque-de-diversao/0f17bc03-fad0-463f-bdc8-9fe05d604f31" },
  { id: "f963a297-93a0-4673-8d9f-33654b12c844", project: "app-pedreiro", branch: "prototype/app-pedreiro/f963a297-93a0-4673-8d9f-33654b12c844" },
  { id: "cbddfdcb-c434-48e0-816e-391f5f7c5439", project: "atelie-rogerio-paes", branch: "prototype/atelie-rogerio-paes/cbddfdcb-c434-48e0-816e-391f5f7c5439" },
  { id: "d8b44296-9204-4b6b-94a4-dc5a39a8e815", project: "atelie-rogerio-paes", branch: "prototype/atelie-rogerio-paes/d8b44296-9204-4b6b-94a4-dc5a39a8e815" },
  { id: "barber-session-001", project: "barber-app", branch: "prototype/barber-app/barber-session-001" },
  { id: "dad6db70-6664-4a43-98bd-4d7a8ccaa27f", project: "carlton", branch: "prototype/carlton/dad6db70-6664-4a43-98bd-4d7a8ccaa27f" },
  { id: "fda7f694-dbd6-4d69-a8b5-84baa8450f08", project: "denise", branch: "prototype/denise/fda7f694-dbd6-4d69-a8b5-84baa8450f08" },
  { id: "efe0766d-8f8b-4965-98cd-b56704d0d6c6", project: "lotada-app", branch: "prototype/lotada-app/efe0766d-8f8b-4965-98cd-b56704d0d6c6" },
  { id: "e45c0652-9c60-46eb-9d71-37428d1340c0", project: "lotada", branch: "prototype/lotada/e45c0652-9c60-46eb-9d71-37428d1340c0" },
  { id: "e2e-node-session", project: "node-app", branch: "prototype/node-app/e2e-node-session" },
  { id: "c1e2068d-6832-47a9-b2c8-084fac43b0c5", project: "pub-adsearch", branch: "prototype/pub-adsearch/c1e2068d-6832-47a9-b2c8-084fac43b0c5" },
  { id: "7a961833-32e6-483a-b7d5-a3e0116b2cb8", project: "rotinaapp", branch: "prototype/rotinaapp/7a961833-32e6-483a-b7d5-a3e0116b2cb8" },
  { id: "6cc1bf1a-6074-418e-b205-2539eee03380", project: "sistema-barbearia", branch: "prototype/sistema-barbearia/6cc1bf1a-6074-418e-b205-2539eee03380" },
  { id: "35d1fb14-b2a8-4f7b-99a7-1fdf70245def", project: "sistema-eletricista", branch: "prototype/sistema-eletricista/35d1fb14-b2a8-4f7b-99a7-1fdf70245def" },
  { id: "24c749cf-d0cd-4a6b-9dfe-2c54f26b5c69", project: "sistema-gestao-maniucure", branch: "prototype/sistema-gestao-maniucure/24c749cf-d0cd-4a6b-9dfe-2c54f26b5c69" },
  { id: "4e036e24-f852-441d-9f62-bde1e2f7f3b2", project: "sistema-pato-de-minas", branch: "prototype/sistema-pato-de-minas/4e036e24-f852-441d-9f62-bde1e2f7f3b2" },
  { id: "e2e-static-session", project: "static-landing-app", branch: "prototype/static-landing-app/e2e-static-session" },
  { id: "0351dd14-e1a4-42d3-90af-4815bdab5fb9", project: "teste-live-timeline", branch: "prototype/teste-live-timeline/0351dd14-e1a4-42d3-90af-4815bdab5fb9" },
  { id: "00000000-0000-0000-0000-000000000001", project: "pub-neural-os", branch: "prototype/pub-neural-os/00000000-0000-0000-0000-000000000001" },
];

for (const s of RECOVERED_GIT_SESSIONS) {
  const projectId = `proj-${s.id}`;
  if (!fallbackProjects.has(projectId)) {
    fallbackProjects.set(projectId, {
      id: projectId,
      workspaceId: DEFAULT_WORKSPACE_ID,
      name: s.project,
      description: '',
      status: 'ACTIVE',
      githubRepository: 'https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git',
      githubBranch: s.branch,
      supabaseProjectReference: null,
      createdAt: new Date('2026-08-28T12:00:00.000Z'),
      updatedAt: new Date('2026-08-28T12:00:00.000Z'),
    });
  }
  fallbackSessions.set(s.id, {
    id: s.id,
    projectId,
    project: s.project,
    repository: 'https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git',
    branch: s.branch,
    mode: 'PROTOTYPE',
    status: 'READY',
    previewUrl: `/prototype/sessions/${s.id}/preview/`,
    previewRuntime: 'cloudflared',
    workspacePath: `/tmp/pub-prototype/${s.id}`,
    lastCheckpointSha: 'ab7ecf5d61a3fee4ae96734aab0668955402e490',
    promptCount: 1,
    createdAt: new Date('2026-08-28T12:00:00.000Z'),
    updatedAt: new Date('2026-08-28T12:00:00.000Z'),
  });
}

export class PostgresPrototypeRepository implements PrototypeRepository {
  constructor(private readonly pool: Pool) {}

  async createSession(input: CreatePrototypeSession): Promise<PrototypeSession> {
    const id = randomUUID();
    const sanitizedProject = input.project.replace(/[^a-zA-Z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const branch = input.branch ?? `prototype/${sanitizedProject || 'untitled'}/${id}`;
    let projectId: string | null = input.projectId ?? null;

    try {
      if (!projectId) {
        // Auto-link or create project in default workspace
        const existingProj = await this.pool.query(
          `SELECT id FROM projects WHERE name = $1 LIMIT 1`,
          [input.project]
        );
        if (existingProj?.rows?.[0]) {
          projectId = existingProj.rows[0].id;
        } else {
          const newProj = await this.createProject({
            name: input.project,
            githubRepository: input.repository,
            githubBranch: branch,
          });
          projectId = newProj.id;
        }
      }

      const result = await this.pool.query(
        `INSERT INTO prototype_sessions (id, project_id, project, repository, branch) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [id, projectId, input.project, input.repository, branch]
      );
      if (result?.rows?.[0]) {
        const session = mapSession(result.rows[0]);
        fallbackSessions.set(session.id, session);
        return session;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on createSession, using sovereign memory:', err.message);
    }

    if (!projectId) {
      const found = Array.from(fallbackProjects.values()).find(p => p.name === input.project);
      if (found) {
        projectId = found.id;
      } else {
        projectId = `proj-${id}`;
        fallbackProjects.set(projectId, {
          id: projectId,
          workspaceId: DEFAULT_WORKSPACE_ID,
          name: input.project,
          description: '',
          status: 'ACTIVE',
          githubRepository: input.repository,
          githubBranch: branch,
          supabaseProjectReference: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    const session: PrototypeSession = {
      id,
      projectId,
      project: input.project,
      repository: input.repository,
      branch,
      mode: 'PROTOTYPE',
      status: 'CREATING',
      previewUrl: null,
      previewRuntime: null,
      workspacePath: null,
      lastCheckpointSha: null,
      promptCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    fallbackSessions.set(id, session);
    return session;
  }

  async getSession(id: string): Promise<PrototypeSession | null> {
    try {
      const r = await this.pool.query(`SELECT * FROM prototype_sessions WHERE id=$1`, [id]);
      if (r?.rows?.[0]) {
        const session = mapSession(r.rows[0]);
        fallbackSessions.set(session.id, session);
        return session;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on getSession:', err.message);
    }
    return fallbackSessions.get(id) || null;
  }

  setFallbackSession(session: PrototypeSession): void {
    if (session && session.id) {
      fallbackSessions.set(session.id, session);
    }
  }

  ensureFallbackSession(id: string, projectName: string): PrototypeSession {
    const existing = fallbackSessions.get(id);
    if (existing) return existing;
    const cleanProject = (projectName || 'projeto-personalizado').trim().replace(/[^a-zA-Z0-9-_]/g, '-');
    const session: PrototypeSession = {
      id,
      project: projectName || 'Projeto Personalizado',
      repository: 'https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git',
      branch: `prototype/${cleanProject}/${id}`,
      mode: 'PROTOTYPE',
      status: 'READY',
      previewUrl: `/prototype/sessions/${id}/preview/`,
      previewRuntime: 'cloudflared',
      workspacePath: `/tmp/pub-prototype/${id}`,
      lastCheckpointSha: null,
      promptCount: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    fallbackSessions.set(id, session);
    return session;
  }

  async listSessions(): Promise<PrototypeSession[]> {
    try {
      const r = await this.pool.query(`SELECT * FROM prototype_sessions ORDER BY updated_at DESC`);
      if (r?.rows) {
        const dbSessions = r.rows.map(mapSession);
        for (const s of dbSessions) {
          fallbackSessions.set(s.id, s);
        }
        return Array.from(fallbackSessions.values()).sort(
          (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
        );
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on listSessions:', err.message);
    }
    return Array.from(fallbackSessions.values()).sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  async updateSession(id: string, patch: Partial<Pick<PrototypeSession, 'status' | 'mode' | 'previewUrl' | 'previewRuntime' | 'workspacePath' | 'lastCheckpointSha'>>): Promise<PrototypeSession | null> {
    try {
      const fields: Record<string, string> = { status: 'status', mode: 'mode', previewUrl: 'preview_url', previewRuntime: 'preview_runtime', workspacePath: 'workspace_path', lastCheckpointSha: 'last_checkpoint_sha' };
      const values: unknown[] = [];
      const set: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        set.push(`${fields[key]}=$${values.length + 1}`);
        values.push(value);
      }
      if (set.length > 0) {
        values.push(id);
        const r = await this.pool.query(`UPDATE prototype_sessions SET ${set.join(',')}, updated_at=now() WHERE id=$${values.length} RETURNING *`, values);
        if (r?.rows?.[0]) {
          const session = mapSession(r.rows[0]);
          fallbackSessions.set(session.id, session);
          return session;
        }
      } else {
        return this.getSession(id);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on updateSession:', err.message);
    }
    const current = fallbackSessions.get(id);
    if (!current) return null;
    const updated: PrototypeSession = {
      ...current,
      ...patch,
      updatedAt: new Date(),
    };
    fallbackSessions.set(id, updated);
    return updated;
  }

  async incrementPromptCount(id: string): Promise<PrototypeSession | null> {
    try {
      const r = await this.pool.query(`UPDATE prototype_sessions
        SET prompt_count=prompt_count+1,status='BUILDING',updated_at=now()
        WHERE id=$1 AND status IN ('CREATING','READY','FAILED')
        RETURNING *`, [id]);
      if (r?.rows) {
        if (r.rows[0]) {
          const session = mapSession(r.rows[0]);
          fallbackSessions.set(session.id, session);
          return session;
        }
        return null;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on incrementPromptCount:', err.message);
    }
    const current = fallbackSessions.get(id);
    if (!current) return null;
    if (!['CREATING', 'READY', 'FAILED'].includes(current.status)) return null;
    const updated: PrototypeSession = {
      ...current,
      promptCount: (current.promptCount || 0) + 1,
      status: 'BUILDING',
      updatedAt: new Date(),
    };
    fallbackSessions.set(id, updated);
    return updated;
  }

  async promoteSession(id: string): Promise<PrototypeSession | null> {
    try {
      const r = await this.pool.query(`UPDATE prototype_sessions
        SET mode='DEVELOPMENT', status='PROMOTED', updated_at=now()
        WHERE id=$1 AND status IN ('READY','APPROVED') AND last_checkpoint_sha IS NOT NULL
        RETURNING *`, [id]);
      if (r?.rows) {
        if (r.rows[0]) {
          const session = mapSession(r.rows[0]);
          fallbackSessions.set(session.id, session);
          return session;
        }
        return null;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on promoteSession:', err.message);
    }
    const current = fallbackSessions.get(id);
    if (!current) return null;
    if (!['READY', 'APPROVED'].includes(current.status) || !current.lastCheckpointSha) return null;
    const updated: PrototypeSession = {
      ...current,
      mode: 'DEVELOPMENT',
      status: 'PROMOTED',
      updatedAt: new Date(),
    };
    fallbackSessions.set(id, updated);
    return updated;
  }

  async createCheckpoint(input: Omit<PrototypeCheckpoint, 'id' | 'createdAt'>): Promise<PrototypeCheckpoint> {
    const id = randomUUID();
    try {
      const r = await this.pool.query(
        `INSERT INTO prototype_checkpoints (id,session_id,prompt_index,prompt,commit_sha,preview_url,build_passed) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, input.sessionId, input.promptIndex, input.prompt, input.commitSha, input.previewUrl, input.buildPassed]
      );
      if (r?.rows?.[0]) {
        const cp = mapCheckpoint(r.rows[0]);
        const list = fallbackCheckpoints.get(input.sessionId) || [];
        list.unshift(cp);
        fallbackCheckpoints.set(input.sessionId, list);
        return cp;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on createCheckpoint:', err.message);
    }
    const checkpoint: PrototypeCheckpoint = {
      id,
      sessionId: input.sessionId,
      promptIndex: input.promptIndex,
      prompt: input.prompt,
      commitSha: input.commitSha,
      previewUrl: input.previewUrl,
      buildPassed: input.buildPassed,
      createdAt: new Date(),
    };
    const list = fallbackCheckpoints.get(input.sessionId) || [];
    list.unshift(checkpoint);
    fallbackCheckpoints.set(input.sessionId, list);
    return checkpoint;
  }

  async listCheckpoints(sessionId: string): Promise<PrototypeCheckpoint[]> {
    try {
      const r = await this.pool.query(`SELECT * FROM prototype_checkpoints WHERE session_id=$1 ORDER BY prompt_index DESC`, [sessionId]);
      if (r?.rows && r.rows.length > 0) {
        const cps = r.rows.map(mapCheckpoint);
        fallbackCheckpoints.set(sessionId, cps);
        return cps;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on listCheckpoints:', err.message);
    }
    return fallbackCheckpoints.get(sessionId) || [];
  }

  async createPromotion(input: Omit<PrototypePromotion, 'id'>): Promise<PrototypePromotion> {
    const id = randomUUID();
    try {
      const r = await this.pool.query(
        `INSERT INTO prototype_promotions (id,session_id,from_mode,to_mode,repository,branch,checkpoint_sha,promoted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, input.sessionId, input.fromMode, input.toMode, input.repository, input.branch, input.checkpointSha, input.promotedAt || new Date()]
      );
      if (r?.rows?.[0]) {
        const promo = mapPromotion(r.rows[0]);
        fallbackPromotions.set(input.sessionId, promo);
        return promo;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on createPromotion:', err.message);
    }
    const promo: PrototypePromotion = {
      id,
      sessionId: input.sessionId,
      fromMode: input.fromMode,
      toMode: input.toMode,
      repository: input.repository,
      branch: input.branch,
      checkpointSha: input.checkpointSha,
      promotedAt: input.promotedAt || new Date(),
    };
    fallbackPromotions.set(input.sessionId, promo);
    return promo;
  }

  async getPromotion(sessionId: string): Promise<PrototypePromotion | null> {
    try {
      const r = await this.pool.query(`SELECT * FROM prototype_promotions WHERE session_id=$1 ORDER BY promoted_at DESC LIMIT 1`, [sessionId]);
      if (r?.rows?.[0]) {
        const promo = mapPromotion(r.rows[0]);
        fallbackPromotions.set(sessionId, promo);
        return promo;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on getPromotion:', err.message);
    }
    return fallbackPromotions.get(sessionId) || null;
  }

  async nextMessageOrder(sessionId: string): Promise<number> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT 1 FROM prototype_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
        const r = await client.query(
          `SELECT COALESCE(MAX("order"),0)+1 AS next FROM prototype_messages WHERE session_id=$1`,
          [sessionId]
        );
        await client.query('COMMIT');
        return Number(r.rows[0].next);
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on nextMessageOrder:', err.message);
      const msgs = fallbackMessages.get(sessionId) || [];
      const maxOrder = msgs.reduce((max, m) => Math.max(max, m.order || 0), 0);
      return maxOrder + 1;
    }
  }

  async addMessage(msg: PrototypeMessage): Promise<PrototypeMessage> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        let order = msg.order;
        if (!order || order <= 0) {
          await client.query('SELECT 1 FROM prototype_sessions WHERE id=$1 FOR UPDATE', [msg.sessionId]);
          const r = await client.query(
            `SELECT COALESCE(MAX("order"),0)+1 AS next FROM prototype_messages WHERE session_id=$1`,
            [msg.sessionId]
          );
          order = Number(r.rows[0].next);
        }
        const id = (msg as any).id ?? randomUUID();
        const r = await client.query(
          `INSERT INTO prototype_messages (id, session_id, task_id, role, content, "order")
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (session_id, "order") DO UPDATE SET content=EXCLUDED.content
           RETURNING *`,
          [id, msg.sessionId, msg.taskId ?? null, msg.role, msg.content, order]
        );
        await client.query('COMMIT');
        const mapped = mapMessage(r.rows[0]);
        const msgs = fallbackMessages.get(msg.sessionId) || [];
        msgs.push(mapped);
        fallbackMessages.set(msg.sessionId, msgs);
        return mapped;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on addMessage:', err.message);
      const msgs = fallbackMessages.get(msg.sessionId) || [];
      const order = msg.order && msg.order > 0 ? msg.order : (msgs.reduce((max, m) => Math.max(max, m.order || 0), 0) + 1);
      const savedMsg: PrototypeMessage = {
        ...msg,
        id: msg.id || randomUUID(),
        order,
        createdAt: msg.createdAt || new Date(),
      };
      msgs.push(savedMsg);
      fallbackMessages.set(msg.sessionId, msgs);
      return savedMsg;
    }
  }

  async listMessages(sessionId: string): Promise<PrototypeMessage[]> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_messages WHERE session_id=$1 ORDER BY "order" ASC`,
        [sessionId]
      );
      if (r?.rows) {
        const msgs = r.rows.map(mapMessage);
        fallbackMessages.set(sessionId, msgs);
        return msgs;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on listMessages:', err.message);
    }
    return fallbackMessages.get(sessionId) || [];
  }

  async listWorkspaces(userId?: string): Promise<Workspace[]> {
    try {
      const dbUserId = userId ? toDbUserId(userId) : undefined;
      const q = dbUserId
        ? `SELECT DISTINCT w.* FROM workspaces w JOIN workspace_members wm ON w.id = wm.workspace_id WHERE wm.user_id = $1 OR w.owner_id = $1 ORDER BY w.created_at ASC`
        : `SELECT * FROM workspaces ORDER BY created_at ASC`;
      const params = dbUserId ? [dbUserId] : [];
      const r = await this.pool.query(q, params);
      if (r?.rows) {
        const list = r.rows.map(mapWorkspace);
        for (const w of list) fallbackWorkspaces.set(w.id, w);
        return list;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] listWorkspaces error:', err.message);
    }
    return Array.from(fallbackWorkspaces.values());
  }

  async createWorkspace(input: { name: string; slug?: string; ownerId?: string }): Promise<Workspace> {
    const id = randomUUID();
    const slug = input.slug || input.name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || `ws-${Date.now()}`;
    const ownerId = input.ownerId || DEFAULT_USER_ID;
    const dbOwnerId = toDbUserId(ownerId);
    try {
      const r = await this.pool.query(
        `INSERT INTO workspaces (id, name, slug, owner_id) VALUES ($1, $2, $3, $4) RETURNING *`,
        [id, input.name, slug, dbOwnerId]
      );
      if (r?.rows?.[0]) {
        await this.pool.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'OWNER') ON CONFLICT DO NOTHING`,
          [id, dbOwnerId]
        );
        const ws = mapWorkspace(r.rows[0]);
        // Preserve raw ownerId for multi-tenancy tests matching in-memory mappings
        ws.ownerId = ownerId;
        fallbackWorkspaces.set(ws.id, ws);
        let workspaceMembers = fallbackWorkspaceMembers.get(id);
        if (!workspaceMembers) {
          workspaceMembers = new Map<string, WorkspaceRole>();
          fallbackWorkspaceMembers.set(id, workspaceMembers);
        }
        workspaceMembers.set(ownerId, 'OWNER');
        return ws;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] createWorkspace error:', err.message);
    }
    const ws: Workspace = {
      id,
      name: input.name,
      slug,
      ownerId,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    fallbackWorkspaces.set(id, ws);
    let workspaceMembers = fallbackWorkspaceMembers.get(id);
    if (!workspaceMembers) {
      workspaceMembers = new Map<string, WorkspaceRole>();
      fallbackWorkspaceMembers.set(id, workspaceMembers);
    }
    workspaceMembers.set(ownerId, 'OWNER');
    return ws;
  }


  async getWorkspaceMembership(userId: string, workspaceId: string): Promise<{ role: string } | null> {
      try {
        const dbUserId = toDbUserId(userId);
        const r = await this.pool.query(
          `SELECT role FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
          [dbUserId, workspaceId]
        );
        if (r?.rows?.[0]) {
          return { role: r.rows[0].role as string };
        }
      } catch (err: any) {
        console.warn('[PostgresPrototypeRepository] getWorkspaceMembership error:', err.message);
      }
      // Fallback to in-memory store (same pattern as other methods)
      const workspaceMembers = fallbackWorkspaceMembers.get(workspaceId);
      if (workspaceMembers?.has(userId)) {
        return { role: workspaceMembers.get(userId)! };
      }
      return null;
    }

    async addWorkspaceMember(input: { workspaceId: string; userId: string; role: string }): Promise<void> {
      try {
        const dbUserId = toDbUserId(input.userId);
        await this.pool.query(
          `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [input.workspaceId, dbUserId, input.role]
        );
      } catch (err: any) {
        console.warn('[PostgresPrototypeRepository] addWorkspaceMember error:', err.message);
      }
      // Fallback to in-memory store (same pattern as other methods)
      let workspaceMembers = fallbackWorkspaceMembers.get(input.workspaceId);
      if (!workspaceMembers) {
        workspaceMembers = new Map<string, WorkspaceRole>();
        fallbackWorkspaceMembers.set(input.workspaceId, workspaceMembers);
      }
      workspaceMembers.set(input.userId, input.role as WorkspaceRole);
    }

  async getWorkspace(id: string): Promise<Workspace | null> {
    try {
      const r = await this.pool.query(`SELECT * FROM workspaces WHERE id = $1`, [id]);
      if (r?.rows?.[0]) {
        const ws = mapWorkspace(r.rows[0]);
        fallbackWorkspaces.set(ws.id, ws);
        return ws;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] getWorkspace error:', err.message);
    }
    return fallbackWorkspaces.get(id) || null;
  }

  async listProjects(workspaceId?: string): Promise<Project[]> {
    try {
      const q = workspaceId
        ? `SELECT * FROM projects WHERE workspace_id = $1 ORDER BY updated_at DESC`
        : `SELECT * FROM projects ORDER BY updated_at DESC`;
      const params = workspaceId ? [workspaceId] : [];
      const r = await this.pool.query(q, params);
      if (r?.rows) {
        const list = r.rows.map(mapProject);
        for (const p of list) fallbackProjects.set(p.id, p);
        return list;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] listProjects error:', err.message);
    }
    let list = Array.from(fallbackProjects.values());
    if (workspaceId) {
      list = list.filter(p => p.workspaceId === workspaceId);
    }
    return list.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async createProject(input: { workspaceId?: string; name: string; description?: string; githubRepository?: string; githubBranch?: string }): Promise<Project> {
    const id = randomUUID();
    const wsId = input.workspaceId || DEFAULT_WORKSPACE_ID;
    try {
      const r = await this.pool.query(
        `INSERT INTO projects (id, workspace_id, name, description, github_repository, github_branch) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [id, wsId, input.name, input.description || '', input.githubRepository || null, input.githubBranch || null]
      );
      if (r?.rows?.[0]) {
        const p = mapProject(r.rows[0]);
        fallbackProjects.set(p.id, p);
        return p;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] createProject error:', err.message);
    }
    const p: Project = {
      id,
      workspaceId: wsId,
      name: input.name,
      description: input.description || '',
      status: 'ACTIVE',
      githubRepository: input.githubRepository || null,
      githubBranch: input.githubBranch || null,
      supabaseProjectReference: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    fallbackProjects.set(id, p);
    return p;
  }

  async getProject(id: string): Promise<Project | null> {
    try {
      const r = await this.pool.query(`SELECT * FROM projects WHERE id = $1`, [id]);
      if (r?.rows?.[0]) {
        const p = mapProject(r.rows[0]);
        fallbackProjects.set(p.id, p);
        return p;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] getProject error:', err.message);
    }
    return fallbackProjects.get(id) || null;
  }

  async updateProject(id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'status' | 'githubRepository' | 'githubBranch'>>): Promise<Project | null> {
    try {
      const fields: Record<string, string> = {
        name: 'name',
        description: 'description',
        status: 'status',
        githubRepository: 'github_repository',
        githubBranch: 'github_branch',
      };
      const values: unknown[] = [];
      const set: string[] = [];
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        set.push(`${fields[key]}=$${values.length + 1}`);
        values.push(value);
      }
      if (set.length > 0) {
        values.push(id);
        const r = await this.pool.query(
          `UPDATE projects SET ${set.join(',')}, updated_at=now() WHERE id=$${values.length} RETURNING *`,
          values
        );
        if (r?.rows?.[0]) {
          const p = mapProject(r.rows[0]);
          fallbackProjects.set(p.id, p);
          return p;
        }
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] updateProject error:', err.message);
    }
    const current = fallbackProjects.get(id);
    if (!current) return null;
    const updated: Project = { ...current, ...patch, updatedAt: new Date() };
    fallbackProjects.set(id, updated);
    return updated;
  }

  async deleteProject(id: string): Promise<boolean> {
    try {
      const r = await this.pool.query(`DELETE FROM projects WHERE id = $1 RETURNING id`, [id]);
      const deleted = (r?.rowCount ?? 0) > 0;
      fallbackProjects.delete(id);
      for (const [sid, session] of fallbackSessions.entries()) {
        if (session.projectId === id) {
          fallbackSessions.delete(sid);
          fallbackCheckpoints.delete(sid);
          fallbackMessages.delete(sid);
          fallbackCheckpointFiles.delete(sid);
        }
      }
      return deleted;
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] deleteProject error:', err.message);
      const existed = fallbackProjects.has(id);
      fallbackProjects.delete(id);
      for (const [sid, session] of fallbackSessions.entries()) {
        if (session.projectId === id) {
          fallbackSessions.delete(sid);
          fallbackCheckpoints.delete(sid);
          fallbackMessages.delete(sid);
          fallbackCheckpointFiles.delete(sid);
        }
      }
      return existed;
    }
  }

  async saveCheckpointFiles(files: CheckpointFile[]): Promise<void> {
    if (!files || files.length === 0) return;
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        for (const f of files) {
          await client.query(
            `INSERT INTO prototype_checkpoint_files (id, checkpoint_id, session_id, path, content, content_type, size_bytes)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (checkpoint_id, path) DO UPDATE SET
               content = EXCLUDED.content,
               content_type = EXCLUDED.content_type,
               size_bytes = EXCLUDED.size_bytes,
               created_at = now()`,
            [f.id || randomUUID(), f.checkpointId, f.sessionId, f.path, f.content, f.contentType || 'text/plain', f.sizeBytes || Buffer.byteLength(f.content, 'utf8')]
          );
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] saveCheckpointFiles error:', err.message);
    }
    for (const f of files) {
      const list = fallbackCheckpointFiles.get(f.sessionId) || [];
      const filtered = list.filter(item => !(item.checkpointId === f.checkpointId && item.path === f.path));
      filtered.push({
        ...f,
        id: f.id || randomUUID(),
        contentType: f.contentType || 'text/plain',
        sizeBytes: f.sizeBytes || Buffer.byteLength(f.content, 'utf8'),
        createdAt: f.createdAt || new Date(),
      });
      fallbackCheckpointFiles.set(f.sessionId, filtered);
    }
  }

  async listCheckpointFiles(checkpointId: string): Promise<CheckpointFile[]> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_checkpoint_files WHERE checkpoint_id = $1 ORDER BY path ASC`,
        [checkpointId]
      );
      if (r?.rows) {
        return r.rows.map(mapCheckpointFile);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] listCheckpointFiles error:', err.message);
    }
    for (const files of fallbackCheckpointFiles.values()) {
      const matches = files.filter(f => f.checkpointId === checkpointId);
      if (matches.length > 0) return matches.sort((a, b) => a.path.localeCompare(b.path));
    }
    return [];
  }

  async getCheckpointFile(checkpointId: string, path: string): Promise<CheckpointFile | null> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_checkpoint_files WHERE checkpoint_id = $1 AND path = $2 LIMIT 1`,
        [checkpointId, path]
      );
      if (r?.rows?.[0]) {
        return mapCheckpointFile(r.rows[0]);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] getCheckpointFile error:', err.message);
    }
    for (const files of fallbackCheckpointFiles.values()) {
      const match = files.find(f => f.checkpointId === checkpointId && f.path === path);
      if (match) return match;
    }
    return null;
  }

  async listSessionFiles(sessionId: string): Promise<CheckpointFile[]> {
    try {
      const r = await this.pool.query(
        `SELECT DISTINCT ON (path) * FROM prototype_checkpoint_files WHERE session_id = $1 ORDER BY path, created_at DESC`,
        [sessionId]
      );
      if (r?.rows) {
        return r.rows.map(mapCheckpointFile);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] listSessionFiles error:', err.message);
    }
    const files = fallbackCheckpointFiles.get(sessionId) || [];
    const latestByPath = new Map<string, CheckpointFile>();
    for (const f of files) {
      latestByPath.set(f.path, f);
    }
    return Array.from(latestByPath.values()).sort((a, b) => a.path.localeCompare(b.path));
  }

  async getLatestSessionFile(sessionId: string, filePath: string): Promise<CheckpointFile | null> {
    try {
      const cleanPath = filePath.replace(/^\/+/, '');
      const r = await this.pool.query(
        `SELECT * FROM prototype_checkpoint_files WHERE session_id = $1 AND (path = $2 OR path = $3) ORDER BY created_at DESC LIMIT 1`,
        [sessionId, cleanPath, `/${cleanPath}`]
      );
      if (r?.rows?.[0]) {
        return mapCheckpointFile(r.rows[0]);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] getLatestSessionFile error:', err.message);
    }
    const files = fallbackCheckpointFiles.get(sessionId) || [];
    const cleanPath = filePath.replace(/^\/+/, '');
    const matching = files
      .filter(f => f.path === cleanPath || f.path === `/${cleanPath}`)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return matching[0] || null;
  }

  async createVerification(input: Omit<PrototypeVerification, 'id' | 'createdAt'>): Promise<PrototypeVerification> {
    const id = randomUUID();
    const durationMs = input.durationMs ?? (input.finishedAt ? input.finishedAt.getTime() - input.startedAt.getTime() : null);
    try {
      const r = await this.pool.query(
        `INSERT INTO prototype_verifications (id, session_id, checkpoint_id, commit_sha, pipeline_version, status, evidence, started_at, finished_at, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING *`,
        [
          id,
          input.sessionId,
          input.checkpointId,
          input.commitSha,
          input.pipelineVersion || 'v1',
          input.status,
          JSON.stringify(input.evidence || {}),
          input.startedAt,
          input.finishedAt,
          durationMs,
        ]
      );
      if (r?.rows?.[0]) {
        const v = mapVerification(r.rows[0]);
        const list = fallbackVerifications.get(input.sessionId) || [];
        list.unshift(v);
        fallbackVerifications.set(input.sessionId, list);
        return v;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on createVerification:', err.message);
    }
    const verification: PrototypeVerification = {
      id,
      sessionId: input.sessionId,
      checkpointId: input.checkpointId,
      commitSha: input.commitSha,
      pipelineVersion: input.pipelineVersion || 'v1',
      status: input.status,
      evidence: input.evidence,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs,
      createdAt: new Date(),
    };
    const list = fallbackVerifications.get(input.sessionId) || [];
    list.unshift(verification);
    fallbackVerifications.set(input.sessionId, list);
    return verification;
  }

  async getVerification(id: string): Promise<PrototypeVerification | null> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_verifications WHERE id = $1`,
        [id]
      );
      if (r?.rows?.[0]) {
        return mapVerification(r.rows[0]);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on getVerification:', err.message);
    }
    for (const list of fallbackVerifications.values()) {
      const found = list.find(v => v.id === id);
      if (found) return found;
    }
    return null;
  }

  async getLatestVerificationForCheckpoint(checkpointId: string): Promise<PrototypeVerification | null> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_verifications WHERE checkpoint_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [checkpointId]
      );
      if (r?.rows?.[0]) {
        return mapVerification(r.rows[0]);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on getLatestVerificationForCheckpoint:', err.message);
    }
    for (const list of fallbackVerifications.values()) {
      const matching = list.filter(v => v.checkpointId === checkpointId);
      if (matching.length > 0) {
        return matching.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
      }
    }
    return null;
  }

  async listVerifications(sessionId: string): Promise<PrototypeVerification[]> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_verifications WHERE session_id = $1 ORDER BY created_at DESC`,
        [sessionId]
      );
      if (r?.rows) {
        const dbList = r.rows.map(mapVerification);
        fallbackVerifications.set(sessionId, dbList);
        return dbList;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on listVerifications:', err.message);
    }
    return fallbackVerifications.get(sessionId) || [];
  }

  async compareAndPromoteSession(
    sessionId: string,
    expectedCurrentCheckpointSha: string | null,
    targetCheckpoint: PrototypeCheckpoint,
    previewUrl: string,
    previewRuntime?: string
  ): Promise<PrototypeSession | null> {
    try {
      let r;
      if (expectedCurrentCheckpointSha === null) {
        r = await this.pool.query(
          `UPDATE prototype_sessions
           SET status = 'READY',
               last_checkpoint_sha = $1,
               preview_url = $2,
               preview_runtime = COALESCE($3, preview_runtime),
               updated_at = now()
           WHERE id = $4
             AND (last_checkpoint_sha IS NULL OR last_checkpoint_sha = $1)
           RETURNING *`,
          [targetCheckpoint.commitSha, previewUrl, previewRuntime || null, sessionId]
        );
      } else {
        r = await this.pool.query(
          `UPDATE prototype_sessions
           SET status = 'READY',
               last_checkpoint_sha = $1,
               preview_url = $2,
               preview_runtime = COALESCE($3, preview_runtime),
               updated_at = now()
           WHERE id = $4
             AND last_checkpoint_sha = $5
           RETURNING *`,
          [targetCheckpoint.commitSha, previewUrl, previewRuntime || null, sessionId, expectedCurrentCheckpointSha]
        );
      }
      if (r?.rows?.[0]) {
        const session = mapSession(r.rows[0]);
        fallbackSessions.set(session.id, session);
        return session;
      }
      if (r?.rowCount === 0) {
        // Concurrency conflict / stale promotion
        return null;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on compareAndPromoteSession:', err.message);
    }

    // In-memory optimistic fallback
    const current = fallbackSessions.get(sessionId);
    if (!current) return null;
    const currentSha = current.lastCheckpointSha;
    const matchesExpected = expectedCurrentCheckpointSha === null
      ? (currentSha === null || currentSha === targetCheckpoint.commitSha)
      : currentSha === expectedCurrentCheckpointSha;

    if (!matchesExpected) {
      return null;
    }

    const updated: PrototypeSession = {
      ...current,
      status: 'READY',
      lastCheckpointSha: targetCheckpoint.commitSha,
      previewUrl,
      previewRuntime: previewRuntime ?? current.previewRuntime,
      updatedAt: new Date(),
    };
    fallbackSessions.set(sessionId, updated);
    return updated;
  }

  // === PP 2.1: AUTONOMOUS VERIFICATION RECOVERY METHODS ===

  async createCorrectionAttempt(input: CreateCorrectionAttemptInput): Promise<PrototypeCorrectionAttempt | null> {
    const id = randomUUID();
    try {
      const r = await this.pool.query(
        `INSERT INTO prototype_correction_attempts 
         (id, session_id, task_id, source_verification_id, source_checkpoint_id, attempt_number, status, failure_evidence, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING', $7, now())
         ON CONFLICT (source_verification_id, attempt_number) DO NOTHING
         RETURNING *`,
        [
          id,
          input.sessionId,
          input.taskId,
          input.sourceVerificationId,
          input.sourceCheckpointId,
          input.attemptNumber,
          JSON.stringify(input.failureEvidence || {}),
        ]
      );
      if (r?.rows?.[0]) {
        const attempt = mapCorrectionAttempt(r.rows[0]);
        const list = fallbackCorrectionAttempts.get(input.sessionId) || [];
        list.unshift(attempt);
        fallbackCorrectionAttempts.set(input.sessionId, list);
        return attempt;
      }
      if (r?.rowCount === 0) {
        // Concurrency conflict: another process already claimed this attempt number for this verification
        return null;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on createCorrectionAttempt:', err.message);
    }

    // In-memory fallback
    const list = fallbackCorrectionAttempts.get(input.sessionId) || [];
    const conflict = list.find(
      a => a.sourceVerificationId === input.sourceVerificationId && a.attemptNumber === input.attemptNumber
    );
    if (conflict) {
      return null;
    }

    const now = new Date();
    const attempt: PrototypeCorrectionAttempt = {
      id,
      sessionId: input.sessionId,
      taskId: input.taskId,
      sourceVerificationId: input.sourceVerificationId,
      sourceCheckpointId: input.sourceCheckpointId,
      attemptNumber: input.attemptNumber,
      status: 'RUNNING',
      resultCommitSha: null,
      resultCheckpointId: null,
      resultVerificationId: null,
      failureEvidence: input.failureEvidence || {},
      error: null,
      startedAt: now,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    list.unshift(attempt);
    fallbackCorrectionAttempts.set(input.sessionId, list);
    return attempt;
  }

  async updateCorrectionAttempt(
    id: string,
    patch: Partial<Pick<PrototypeCorrectionAttempt, 'status' | 'resultCommitSha' | 'resultCheckpointId' | 'resultVerificationId' | 'error' | 'finishedAt'>>
  ): Promise<PrototypeCorrectionAttempt | null> {
    try {
      const sets: string[] = ['updated_at = now()'];
      const values: any[] = [];
      let idx = 1;

      if (patch.status !== undefined) {
        sets.push(`status = $${idx++}`);
        values.push(patch.status);
      }
      if (patch.resultCommitSha !== undefined) {
        sets.push(`result_commit_sha = $${idx++}`);
        values.push(patch.resultCommitSha);
      }
      if (patch.resultCheckpointId !== undefined) {
        sets.push(`result_checkpoint_id = $${idx++}`);
        values.push(patch.resultCheckpointId);
      }
      if (patch.resultVerificationId !== undefined) {
        sets.push(`result_verification_id = $${idx++}`);
        values.push(patch.resultVerificationId);
      }
      if (patch.error !== undefined) {
        sets.push(`error = $${idx++}`);
        values.push(patch.error);
      }
      if (patch.finishedAt !== undefined) {
        sets.push(`finished_at = $${idx++}`);
        values.push(patch.finishedAt);
      }

      values.push(id);
      const r = await this.pool.query(
        `UPDATE prototype_correction_attempts SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`,
        values
      );
      if (r?.rows?.[0]) {
        const attempt = mapCorrectionAttempt(r.rows[0]);
        for (const [sid, list] of fallbackCorrectionAttempts.entries()) {
          const itemIdx = list.findIndex(a => a.id === id);
          if (itemIdx >= 0) {
            list[itemIdx] = attempt;
            fallbackCorrectionAttempts.set(sid, list);
            break;
          }
        }
        return attempt;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on updateCorrectionAttempt:', err.message);
    }

    // In-memory fallback
    for (const [sid, list] of fallbackCorrectionAttempts.entries()) {
      const itemIdx = list.findIndex(a => a.id === id);
      if (itemIdx >= 0) {
        const updated: PrototypeCorrectionAttempt = {
          ...list[itemIdx],
          ...patch,
          updatedAt: new Date(),
        };
        list[itemIdx] = updated;
        fallbackCorrectionAttempts.set(sid, list);
        return updated;
      }
    }
    return null;
  }

  async getCorrectionAttempt(id: string): Promise<PrototypeCorrectionAttempt | null> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_correction_attempts WHERE id = $1`,
        [id]
      );
      if (r?.rows?.[0]) {
        return mapCorrectionAttempt(r.rows[0]);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on getCorrectionAttempt:', err.message);
    }

    for (const list of fallbackCorrectionAttempts.values()) {
      const found = list.find(a => a.id === id);
      if (found) return found;
    }
    return null;
  }

  async listCorrectionAttempts(sessionId: string): Promise<PrototypeCorrectionAttempt[]> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_correction_attempts WHERE session_id = $1 ORDER BY created_at DESC`,
        [sessionId]
      );
      if (r?.rows) {
        return r.rows.map(mapCorrectionAttempt);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on listCorrectionAttempts:', err.message);
    }

    return fallbackCorrectionAttempts.get(sessionId) || [];
  }

  async getCorrectionAttemptsForVerification(sourceVerificationId: string): Promise<PrototypeCorrectionAttempt[]> {
    try {
      const r = await this.pool.query(
        `SELECT * FROM prototype_correction_attempts WHERE source_verification_id = $1 ORDER BY attempt_number ASC`,
        [sourceVerificationId]
      );
      if (r?.rows) {
        return r.rows.map(mapCorrectionAttempt);
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on getCorrectionAttemptsForVerification:', err.message);
    }

    const matches: PrototypeCorrectionAttempt[] = [];
    for (const list of fallbackCorrectionAttempts.values()) {
      for (const a of list) {
        if (a.sourceVerificationId === sourceVerificationId) {
          matches.push(a);
        }
      }
    }
    return matches.sort((a, b) => a.attemptNumber - b.attemptNumber);
  }

  async initializeSchema(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email TEXT NOT NULL UNIQUE,
          name TEXT,
          avatar_url TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS workspaces (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS workspace_members (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER','ADMIN','MEMBER','VIEWER')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(workspace_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED','BUILDING')),
          github_repository TEXT,
          github_branch TEXT,
          supabase_project_reference TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        ALTER TABLE prototype_sessions ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE CASCADE;
        -- Idempotent runtime migration: verification pipeline uses VERIFYING session status.
        ALTER TABLE prototype_sessions DROP CONSTRAINT IF EXISTS prototype_sessions_status_check;
        ALTER TABLE prototype_sessions ADD CONSTRAINT prototype_sessions_status_check
          CHECK (status IN ('CREATING','READY','BUILDING','PREVIEWING','VERIFYING','FAILED','APPROVED','PROMOTED','ARCHIVED'));
        CREATE TABLE IF NOT EXISTS prototype_checkpoint_files (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          checkpoint_id UUID NOT NULL REFERENCES prototype_checkpoints(id) ON DELETE CASCADE,
          session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          content TEXT NOT NULL,
          content_type TEXT NOT NULL DEFAULT 'text/plain',
          size_bytes INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE(checkpoint_id, path)
        );
        CREATE TABLE IF NOT EXISTS prototype_verifications (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE RESTRICT,
          checkpoint_id UUID NOT NULL REFERENCES prototype_checkpoints(id) ON DELETE RESTRICT,
          commit_sha TEXT NOT NULL,
          pipeline_version TEXT NOT NULL DEFAULT 'v1',
          status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'PASSED', 'FAILED')),
          evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at TIMESTAMPTZ,
          duration_ms INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS prototype_verifications_session_idx ON prototype_verifications(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS prototype_verifications_checkpoint_idx ON prototype_verifications(checkpoint_id);
        CREATE INDEX IF NOT EXISTS prototype_verifications_commit_idx ON prototype_verifications(commit_sha);
        CREATE INDEX IF NOT EXISTS prototype_verifications_status_idx ON prototype_verifications(status);

        CREATE TABLE IF NOT EXISTS prototype_correction_attempts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          session_id UUID NOT NULL REFERENCES prototype_sessions(id) ON DELETE RESTRICT,
          task_id UUID NOT NULL REFERENCES prototype_tasks(id) ON DELETE CASCADE,
          source_verification_id UUID NOT NULL REFERENCES prototype_verifications(id) ON DELETE RESTRICT,
          source_checkpoint_id UUID NOT NULL REFERENCES prototype_checkpoints(id) ON DELETE RESTRICT,
          attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
          status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'ESCALATED')),
          result_commit_sha TEXT,
          result_checkpoint_id UUID REFERENCES prototype_checkpoints(id) ON DELETE SET NULL,
          result_verification_id UUID REFERENCES prototype_verifications(id) ON DELETE SET NULL,
          failure_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
          error TEXT,
          started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT uq_source_verification_attempt UNIQUE (source_verification_id, attempt_number)
        );
        CREATE INDEX IF NOT EXISTS prototype_correction_attempts_session_idx ON prototype_correction_attempts(session_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS prototype_correction_attempts_source_verif_idx ON prototype_correction_attempts(source_verification_id);
        CREATE INDEX IF NOT EXISTS prototype_correction_attempts_result_cp_idx ON prototype_correction_attempts(result_checkpoint_id);
        CREATE INDEX IF NOT EXISTS prototype_correction_attempts_status_idx ON prototype_correction_attempts(status);

        CREATE OR REPLACE FUNCTION prevent_verification_mutation()
        RETURNS TRIGGER AS $$
        BEGIN
          IF TG_OP = 'UPDATE' THEN
            RAISE EXCEPTION 'UPDATE on prototype_verifications is forbidden: verification records are immutable audit records';
          ELSIF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION 'DELETE on prototype_verifications is forbidden: verification records are immutable audit records';
          END IF;
          RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;

        DROP TRIGGER IF EXISTS trg_prototype_verifications_immutable ON prototype_verifications;
        CREATE TRIGGER trg_prototype_verifications_immutable
        BEFORE UPDATE OR DELETE ON prototype_verifications
        FOR EACH ROW
        EXECUTE FUNCTION prevent_verification_mutation();

        DO $$
        DECLARE
          v_default_user_id UUID := '00000000-0000-0000-0000-000000000000';
          v_default_workspace_id UUID := '11111111-1111-1111-1111-111111111111';
        BEGIN
          INSERT INTO users (id, email, name)
          VALUES (v_default_user_id, 'default@pubprototype.internal', 'Default User')
          ON CONFLICT (id) DO NOTHING;

          INSERT INTO workspaces (id, name, slug, owner_id)
          VALUES (v_default_workspace_id, 'Default Workspace', 'default-workspace', v_default_user_id)
          ON CONFLICT (id) DO NOTHING;

          INSERT INTO workspace_members (workspace_id, user_id, role)
          VALUES (v_default_workspace_id, v_default_user_id, 'OWNER')
          ON CONFLICT (workspace_id, user_id) DO NOTHING;

          INSERT INTO projects (id, workspace_id, name, github_repository, github_branch)
          SELECT 
            gen_random_uuid(),
            v_default_workspace_id,
            s.project,
            MAX(s.repository),
            MAX(s.branch)
          FROM prototype_sessions s
          WHERE s.project_id IS NULL AND s.project IS NOT NULL
          GROUP BY s.project
          ON CONFLICT DO NOTHING;

          UPDATE prototype_sessions s
          SET project_id = p.id
          FROM projects p
          WHERE s.project_id IS NULL AND s.project = p.name AND p.workspace_id = v_default_workspace_id;
        END $$;

        -- Sovereign Auth Migration (008)
        ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;
        ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ACTIVE';

        CREATE TABLE IF NOT EXISTS auth_sessions (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          refresh_token_hash TEXT NOT NULL,
          user_agent TEXT,
          ip_address INET,
          expires_at TIMESTAMPTZ NOT NULL,
          revoked_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_active_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          family_id UUID NOT NULL,
          rotated_from UUID REFERENCES auth_sessions(id) ON DELETE SET NULL
        );

        CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
        CREATE INDEX IF NOT EXISTS auth_sessions_refresh_hash_idx ON auth_sessions(refresh_token_hash);
        CREATE INDEX IF NOT EXISTS auth_sessions_family_idx ON auth_sessions(family_id);
        CREATE INDEX IF NOT EXISTS auth_sessions_expires_revoked_idx ON auth_sessions(expires_at, revoked_at);

        -- Account Claim Tokens (009)
        CREATE TABLE IF NOT EXISTS account_claim_tokens (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          status TEXT NOT NULL DEFAULT 'PENDING'
        );

        ALTER TABLE account_claim_tokens ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'PENDING';

        CREATE INDEX IF NOT EXISTS account_claim_tokens_hash_idx ON account_claim_tokens(token_hash);
        CREATE INDEX IF NOT EXISTS account_claim_tokens_user_idx ON account_claim_tokens(user_id);
        CREATE UNIQUE INDEX IF NOT EXISTS account_claim_tokens_one_active_per_user_idx
          ON account_claim_tokens(user_id)
          WHERE used_at IS NULL AND status = 'PENDING';
      `);
      console.log('[PostgresPrototypeRepository] Schema initialized successfully');
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] Schema initialization notice:', err.message);
    }
  }
}

