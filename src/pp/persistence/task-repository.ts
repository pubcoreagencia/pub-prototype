import type { Pool } from 'pg';
import type { PrototypeTask, CreatePrototypeTaskInput, PpTaskRepository } from '../domain/domain.js';

const map = (r: Record<string, unknown>): PrototypeTask => ({
  id: r.id as string,
  prototypeSessionId: (r.prototype_session_id ?? r.prototypeSessionId) as string,
  project: r.project as string,
  repository: r.repository as string,
  objective: r.objective as string,
  prompt: r.prompt as string,
  status: r.status as PrototypeTask['status'],
  priority: r.priority as number,
  worker: r.worker as string | null,
  result: (r.result as Record<string, unknown> | null) ?? null,
  error: r.error as string | null,
  branch: r.branch as string | null,
  commitSha: (r.commit_sha ?? r.commitSha) as string | null,
  gitStatus: (r.git_status ?? r.gitStatus) as string | null,
  workspacePath: (r.workspace_path ?? r.workspacePath) as string | null,
  leaseOwner: (r.lease_owner ?? r.leaseOwner) as string | null,
  leaseDeadline: (r.lease_deadline ?? r.leaseDeadline) as Date | null,
  heartbeatAt: (r.heartbeat_at ?? r.heartbeatAt) as Date | null,
  createdAt: (r.created_at ?? r.createdAt) as Date,
  updatedAt: (r.updated_at ?? r.updatedAt) as Date,
});

const sovereignFallbackPpTasks = new Map<string, PrototypeTask>();

export class PostgresPpTaskRepository implements PpTaskRepository {
  constructor(private readonly pool: Pool) {}

  async create(input: CreatePrototypeTaskInput): Promise<PrototypeTask> {
    try {
      const r = await this.pool.query(
        `INSERT INTO prototype_tasks (prototype_session_id, project, repository, objective, prompt, priority, branch, workspace_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          input.prototypeSessionId,
          input.project,
          input.repository,
          input.objective,
          input.prompt,
          input.priority ?? 0,
          input.branch ?? null,
          input.workspacePath ?? null,
        ],
      );
      if (r?.rows?.[0]) return map(r.rows[0]);
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB quota/connection issue on create, using fallback:', err.message);
    }

    const id = `pp-task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const task: PrototypeTask = {
      id,
      prototypeSessionId: input.prototypeSessionId,
      project: input.project,
      repository: input.repository,
      objective: input.objective,
      prompt: input.prompt,
      status: 'QUEUED',
      priority: input.priority ?? 0,
      worker: null,
      result: null,
      error: null,
      branch: input.branch ?? null,
      commitSha: null,
      gitStatus: null,
      workspacePath: input.workspacePath ?? null,
      leaseOwner: null,
      leaseDeadline: null,
      heartbeatAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    sovereignFallbackPpTasks.set(id, task);
    return task;
  }

  async list(sessionId?: string): Promise<PrototypeTask[]> {
    let tasks: PrototypeTask[] = [];
    try {
      const query = sessionId
        ? `SELECT * FROM prototype_tasks WHERE prototype_session_id = $1 ORDER BY priority DESC, created_at ASC`
        : `SELECT * FROM prototype_tasks ORDER BY priority DESC, created_at ASC`;
      const params = sessionId ? [sessionId] : [];
      const r = await this.pool.query(query, params);
      if (r?.rows) tasks = r.rows.map(map);
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on list, using fallback:', err.message);
    }

    const dbIds = new Set(tasks.map(t => t.id));
    for (const mem of sovereignFallbackPpTasks.values()) {
      if (!dbIds.has(mem.id)) {
        if (!sessionId || mem.prototypeSessionId === sessionId) {
          tasks.push(mem);
        }
      }
    }
    return tasks.sort((a, b) => (b.priority - a.priority) || (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()));
  }

  async get(id: string): Promise<PrototypeTask | null> {
    try {
      const r = await this.pool.query(`SELECT * FROM prototype_tasks WHERE id = $1`, [id]);
      if (r?.rows?.[0]) return map(r.rows[0]);
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on get:', err.message);
    }
    return sovereignFallbackPpTasks.get(id) ?? null;
  }

  async claim(worker: string): Promise<PrototypeTask | null> {
    try {
      const r = await this.pool.query(`
        WITH candidate AS (
          SELECT id FROM prototype_tasks
          WHERE status = 'QUEUED'
          ORDER BY priority DESC, created_at ASC
          FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE prototype_tasks SET status='ASSIGNED', worker=$1, lease_owner=$1,
          lease_deadline=now()+interval '30 seconds', heartbeat_at=now(), updated_at=now()
        WHERE id=(SELECT id FROM candidate) RETURNING *`, [worker]);
      if (r?.rows?.[0]) return map(r.rows[0]);
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on claim, using fallback:', err.message);
    }

    for (const task of sovereignFallbackPpTasks.values()) {
      if (task.status === 'QUEUED') {
        task.status = 'ASSIGNED';
        task.worker = worker;
        task.leaseOwner = worker;
        task.leaseDeadline = new Date(Date.now() + 30000);
        task.heartbeatAt = new Date();
        task.updatedAt = new Date();
        return task;
      }
    }
    return null;
  }

  async update(id: string, patch: Partial<PrototypeTask>): Promise<PrototypeTask | null> {
    try {
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;

      const columnMap: Record<string, string> = {
        status: 'status',
        priority: 'priority',
        worker: 'worker',
        result: 'result',
        error: 'error',
        branch: 'branch',
        commitSha: 'commit_sha',
        gitStatus: 'git_status',
        workspacePath: 'workspace_path',
        leaseOwner: 'lease_owner',
        leaseDeadline: 'lease_deadline',
        heartbeatAt: 'heartbeat_at',
      };

      for (const [key, val] of Object.entries(patch)) {
        const col = columnMap[key];
        if (col) {
          sets.push(`${col} = $${i++}`);
          values.push(val);
        }
      }

      if (sets.length > 0) {
        sets.push(`updated_at = now()`);
        values.push(id);
        const r = await this.pool.query(
          `UPDATE prototype_tasks SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
          values,
        );
        if (r?.rows?.[0]) return map(r.rows[0]);
      }
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on update:', err.message);
    }

    const mem = sovereignFallbackPpTasks.get(id);
    if (mem) {
      Object.assign(mem, patch, { updatedAt: new Date() });
      return mem;
    }
    return null;
  }

  async cancel(id: string): Promise<PrototypeTask | null> {
    try {
      const r = await this.pool.query(
        `UPDATE prototype_tasks SET status='CANCELLED', updated_at=now() WHERE id=$1 AND status IN ('QUEUED','ASSIGNED','RUNNING') RETURNING *`,
        [id],
      );
      if (r?.rows?.[0]) return map(r.rows[0]);
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on cancel:', err.message);
    }
    const mem = sovereignFallbackPpTasks.get(id);
    if (mem && ['QUEUED', 'ASSIGNED', 'RUNNING'].includes(mem.status)) {
      mem.status = 'CANCELLED';
      mem.updatedAt = new Date();
      return mem;
    }
    return null;
  }

  async retry(id: string): Promise<PrototypeTask | null> {
    try {
      const r = await this.pool.query(
        `UPDATE prototype_tasks SET status='QUEUED', worker=null, lease_owner=null, lease_deadline=null, error=null, updated_at=now()
         WHERE id=$1 AND status IN ('FAILED','CANCELLED') RETURNING *`,
        [id],
      );
      if (r?.rows?.[0]) return map(r.rows[0]);
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on retry:', err.message);
    }
    const mem = sovereignFallbackPpTasks.get(id);
    if (mem && ['FAILED', 'CANCELLED'].includes(mem.status)) {
      mem.status = 'QUEUED';
      mem.worker = null;
      mem.leaseOwner = null;
      mem.leaseDeadline = null;
      mem.error = null;
      mem.updatedAt = new Date();
      return mem;
    }
    return null;
  }

  async reclaimStuck(worker: string, _leaseWindowMs: number, now: Date): Promise<number> {
    let count = 0;
    try {
      const r = await this.pool.query(
        `UPDATE prototype_tasks SET status='QUEUED', worker=$1, lease_owner=$1,
         lease_deadline=now()+interval '30 seconds', heartbeat_at=now(), updated_at=now()
         WHERE status IN ('ASSIGNED','RUNNING','TESTING') AND lease_deadline IS NOT NULL
         AND lease_deadline < $2 AND updated_at < $2 - interval '5 seconds' RETURNING id`,
        [worker, now],
      );
      count += r?.rowCount ?? 0;
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on reclaimStuck:', err.message);
    }

    for (const task of sovereignFallbackPpTasks.values()) {
      if (['ASSIGNED', 'RUNNING', 'TESTING'].includes(task.status) && task.leaseDeadline && task.leaseDeadline < now) {
        task.status = 'QUEUED';
        task.worker = worker;
        task.leaseOwner = worker;
        task.leaseDeadline = new Date(now.getTime() + 30000);
        task.heartbeatAt = now;
        task.updatedAt = now;
        count++;
      }
    }
    return count;
  }

  async heartbeat(id: string, deadline: Date): Promise<boolean> {
    try {
      const r = await this.pool.query(
        `UPDATE prototype_tasks SET lease_deadline=$2, heartbeat_at=now(), updated_at=now()
         WHERE id=$1 AND status IN ('ASSIGNED','RUNNING','TESTING')`,
        [id, deadline],
      );
      if ((r?.rowCount ?? 0) > 0) return true;
    } catch (err: any) {
      console.warn('[PostgresPpTaskRepository] DB issue on heartbeat:', err.message);
    }

    const mem = sovereignFallbackPpTasks.get(id);
    if (mem && ['ASSIGNED', 'RUNNING', 'TESTING'].includes(mem.status)) {
      mem.leaseDeadline = deadline;
      mem.heartbeatAt = new Date();
      mem.updatedAt = new Date();
      return true;
    }
    return false;
  }
}
