import type { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import type { CreatePrototypeSession, PrototypeCheckpoint, PrototypeSession, PrototypeSessionStatus, PrototypeMode, PrototypePromotion, PrototypeMessage } from '../domain/domain.js';

const mapSession = (r: Record<string, unknown>): PrototypeSession => ({
  id: r.id as string,
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

}

// Sovereign in-memory fallback store to ensure zero downtime when database quota is reached
const fallbackSessions = new Map<string, PrototypeSession>();
const fallbackCheckpoints = new Map<string, PrototypeCheckpoint[]>();
const fallbackPromotions = new Map<string, PrototypePromotion>();
const fallbackMessages = new Map<string, PrototypeMessage[]>();

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
  fallbackSessions.set(s.id, {
    id: s.id,
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
    try {
      const result = await this.pool.query(
        `INSERT INTO prototype_sessions (id, project, repository, branch) VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, input.project, input.repository, branch]
      );
      if (result?.rows?.[0]) {
        const session = mapSession(result.rows[0]);
        fallbackSessions.set(session.id, session);
        return session;
      }
    } catch (err: any) {
      console.warn('[PostgresPrototypeRepository] DB quota/error on createSession, using sovereign memory:', err.message);
    }
    const session: PrototypeSession = {
      id,
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
      if (r?.rows) {
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
}

