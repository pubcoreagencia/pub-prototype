import { describe, it, expect, beforeEach } from 'vitest';
import type { Task } from '../src/domain.js';
import type { PrototypeSession, PrototypePromotion } from '../src/pp/domain/domain.js';
import {
  PrototypeHandoffService,
  type PdlTaskIngestionPort,
  type PdlTaskIngestionRequest,
  type PdlTaskIngestionResult,
} from '../src/pp/handoff/handoff.js';
import type { PrototypeEventPublisher } from '../src/pp/events/events.js';

class InMemoryPdlTaskIngestionPort implements PdlTaskIngestionPort {
  readonly ingested: PdlTaskIngestionRequest[] = [];

  async ingest(request: PdlTaskIngestionRequest): Promise<PdlTaskIngestionResult> {
    const existing = this.ingested.find(
      r => r.promotionId === request.promotionId || r.prototypeSessionId === request.prototypeSessionId
    );
    if (existing) {
      return {
        id: `task-${existing.promotionId}`,
        taskId: `task-${existing.promotionId}`,
        status: 'QUEUED',
        branch: existing.branch,
        repository: existing.repository,
        prototypeSessionId: null,
      };
    }
    this.ingested.push(request);
    return {
      id: `task-${request.promotionId}`,
      taskId: `task-${request.promotionId}`,
      status: 'QUEUED',
      branch: request.branch,
      repository: request.repository,
      prototypeSessionId: null,
    };
  }
}

class InMemoryPrototypeRepository {
  private sessions = new Map<string, PrototypeSession>();
  private promotions: PrototypePromotion[] = [];

  async getSession(id: string): Promise<PrototypeSession | null> {
    const s = this.sessions.get(id);
    return s ? { ...s } : null;
  }
  async createSession(input: any): Promise<PrototypeSession> {
    const id = `session-${this.sessions.size + 1}`;
    const session: PrototypeSession = {
      id,
      project: input.project,
      repository: input.repository,
      branch: input.branch ?? `prototype/${input.project}/${id}`,
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
    this.sessions.set(id, session);
    return { ...session };
  }
  async updateSession(id: string, patch: any): Promise<PrototypeSession | null> {
    const s = this.sessions.get(id);
    if (!s) return null;
    Object.assign(s, patch, { updatedAt: new Date() });
    return { ...s };
  }
  async promoteSession(id: string): Promise<PrototypeSession | null> {
    const s = this.sessions.get(id);
    if (!s || !['READY', 'APPROVED'].includes(s.status) || !s.lastCheckpointSha) return null;
    s.status = 'PROMOTED';
    s.mode = 'DEVELOPMENT';
    s.updatedAt = new Date();
    return { ...s };
  }
  async createCheckpoint(_input: any): Promise<any> { return { id: 'checkpoint-1', ..._input }; }
  async listCheckpoints(_sessionId: string): Promise<any[]> { return []; }
  async createPromotion(input: any): Promise<PrototypePromotion> {
    const promotion: PrototypePromotion = {
      id: `promo-${this.promotions.length + 1}`,
      sessionId: input.sessionId,
      fromMode: input.fromMode,
      toMode: input.toMode,
      repository: input.repository,
      branch: input.branch,
      checkpointSha: input.checkpointSha,
      promotedAt: input.promotedAt ?? new Date(),
    };
    this.promotions.push(promotion);
    return { ...promotion };
  }
  async getPromotion(sessionId: string): Promise<PrototypePromotion | null> {
    const found = [...this.promotions].reverse().find(p => p.sessionId === sessionId);
    return found ? { ...found } : null;
  }
}

class FakeEventPublisher implements PrototypeEventPublisher {
  readonly events: any[] = [];
  emit(event: any) { this.events.push(event); }
}

describe('PrototypeHandoffService', () => {
  let port: InMemoryPdlTaskIngestionPort;
  let prototypes: InMemoryPrototypeRepository;
  let events: FakeEventPublisher;
  let service: PrototypeHandoffService;

  beforeEach(() => {
    port = new InMemoryPdlTaskIngestionPort();
    prototypes = new InMemoryPrototypeRepository();
    events = new FakeEventPublisher();
    service = new PrototypeHandoffService(port, prototypes as any, events as any);
  });

  it('promotes READY session and creates Development Task', async () => {
    const session = await prototypes.createSession({ project: 'app', repository: 'repo', branch: 'prototype/app/1' });
    await prototypes.updateSession(session.id, { status: 'READY', lastCheckpointSha: 'sha123', branch: session.branch, repository: session.repository });

    const result = await service.execute({ sessionId: session.id });

    expect(result.session.status).toBe('PROMOTED');
    expect(result.session.mode).toBe('DEVELOPMENT');
    expect(result.task.prototypeSessionId).toBeNull();
    expect(result.task.branch).toBe(session.branch);
    expect(result.task.repository).toBe(session.repository);
    expect(result.promotion.fromMode).toBe('PROTOTYPE');
    expect(result.promotion.toMode).toBe('DEVELOPMENT');
    expect(events.events.some(e => e.type === 'PROMOTED_TO_DEVELOPMENT')).toBe(true);
  });

  it('promotes APPROVED session and creates Development Task', async () => {
    const session = await prototypes.createSession({ project: 'app', repository: 'repo', branch: 'prototype/app/2' });
    await prototypes.updateSession(session.id, { status: 'APPROVED', lastCheckpointSha: 'sha456', branch: session.branch, repository: session.repository });

    const result = await service.execute({ sessionId: session.id });

    expect(result.session.status).toBe('PROMOTED');
    expect(result.session.mode).toBe('DEVELOPMENT');
    expect(result.task.id).toBeTruthy();
  });

  it('rejects invalid session status', async () => {
    const session = await prototypes.createSession({ project: 'app', repository: 'repo', branch: 'prototype/app/3' });
    await prototypes.updateSession(session.id, { lastCheckpointSha: 'sha123' });
    await expect(service.execute({ sessionId: session.id })).rejects.toThrow(/CONFLICT: session status CREATING cannot be promoted/);
  });

  it('rejects missing session', async () => {
    await expect(service.execute({ sessionId: 'unknown' })).rejects.toThrow(/NOT_FOUND: prototype session not found/);
  });

  it('is idempotent when already promoted', async () => {
    const session = await prototypes.createSession({ project: 'app', repository: 'repo', branch: 'prototype/app/4' });
    await prototypes.updateSession(session.id, { status: 'READY', lastCheckpointSha: 'sha123', branch: session.branch, repository: session.repository });

    const first = await service.execute({ sessionId: session.id });
    const second = await service.execute({ sessionId: session.id, objective: 'Retry handoff' });

    expect(second.task.id).toBe(first.task.id);
    expect(events.events.filter(e => e.type === 'PROMOTED_TO_DEVELOPMENT').length).toBe(1);
  });

  it('funciona com mock de PdlTaskIngestionPort puro provando que não depende de TaskRepository nem de Task', async () => {
    let capturedRequest: any = null;
    const purePort = {
      async ingest(req: any) {
        capturedRequest = req;
        return { id: 'pure-task-99', taskId: 'pure-task-99', status: 'QUEUED' };
      },
    };
    const isolatedService = new PrototypeHandoffService(purePort, prototypes as any, events as any);
    const session = await prototypes.createSession({ project: 'pure', repository: 'repo', branch: 'prototype/pure/1' });
    await prototypes.updateSession(session.id, { status: 'READY', lastCheckpointSha: 'sha999', branch: session.branch, repository: session.repository });

    const res = await isolatedService.execute({ sessionId: session.id });
    expect(res.task.taskId).toBe('pure-task-99');
    expect(capturedRequest.promotionId).toBeDefined();
    expect(capturedRequest.checkpointSha).toBe('sha999');
  });
});
