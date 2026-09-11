import type { PrototypeSession, PrototypePromotion } from '../domain/domain.js';
import type { PrototypeEventPublisher } from '../events/events.js';

export interface PrototypeHandoffInput {
  sessionId: string;
  objective?: string;
  prompt?: string;
  priority?: number;
}

/**
 * FASE 4.3: Contrato neutro da boundary de ingestão para promoção PP → PDL.
 * O PP não conhece o domínio interno de Task do PDL nem o repositório de tarefas do PDL.
 */
export interface PdlTaskIngestionRequest {
  project: string;
  repository: string;
  branch: string;
  checkpointSha: string;
  promotionId: string;
  prototypeSessionId: string;
  objective: string;
  prompt: string;
  priority?: number;
}

export interface PdlTaskIngestionResult {
  id: string;
  taskId: string;
  status?: string;
  branch?: string | null;
  repository?: string;
  prototypeSessionId?: string | null;
  result?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * FASE 4.3: Interface enxuta de boundary.
 * Não expõe create/list/get/update. Apenas a capacidade estrita de ingestão para promoção.
 */
export interface PdlTaskIngestionPort {
  ingest(request: PdlTaskIngestionRequest): Promise<PdlTaskIngestionResult>;
}

export interface PrototypeHandoffResult {
  session: PrototypeSession;
  promotion: PrototypePromotion;
  task: PdlTaskIngestionResult;
  mode: 'DEVELOPMENT';
}

export class PrototypeHandoffService {
  constructor(
    private readonly tasks: PdlTaskIngestionPort,
    private readonly prototypes: {
      getSession(id: string): Promise<PrototypeSession | null>;
      promoteSession(id: string): Promise<PrototypeSession | null>;
      createPromotion(input: Omit<PrototypePromotion, 'id'>): Promise<PrototypePromotion>;
      getPromotion?(sessionId: string): Promise<PrototypePromotion | null>;
    },
    private readonly events: PrototypeEventPublisher,
  ) {}

  async execute(input: PrototypeHandoffInput): Promise<PrototypeHandoffResult> {
    const session = await this.prototypes.getSession(input.sessionId);
    if (!session) {
      throw new Error('NOT_FOUND: prototype session not found');
    }

    if (!session.lastCheckpointSha) {
      throw new Error('CONFLICT: session must have a valid lastCheckpointSha to be promoted');
    }

    if (!session.branch || !session.repository) {
      throw new Error('CONFLICT: session must have repository and branch configured');
    }

    const promoted = await this.prototypes.promoteSession(session.id);
    if (!promoted) {
      const maybeExistingPromotion = typeof this.prototypes.getPromotion === 'function'
        ? await this.prototypes.getPromotion(session.id)
        : null;
      if (maybeExistingPromotion) {
        const pdlTask = await this.tasks.ingest({
          project: session.project,
          repository: session.repository,
          branch: session.branch,
          checkpointSha: session.lastCheckpointSha!,
          promotionId: maybeExistingPromotion.id ?? `promo-${session.id}`,
          prototypeSessionId: session.id,
          objective: input.objective ?? `Development handoff from Prototype ${session.project}`,
          prompt: input.prompt ?? `Continue development from approved prototype (${session.branch} @ ${session.lastCheckpointSha})`,
          priority: input.priority ?? 0,
        });

        return {
          session: { ...session, status: 'PROMOTED', mode: 'DEVELOPMENT' },
          promotion: maybeExistingPromotion,
          task: pdlTask,
          mode: 'DEVELOPMENT',
        };
      }
      if (!['READY', 'APPROVED'].includes(session.status)) {
        throw new Error(`CONFLICT: session status ${session.status} cannot be promoted. Must be READY or APPROVED.`);
      }
      throw new Error('CONFLICT: session could not be promoted');
    }

    const promotion = await this.prototypes.createPromotion({
      sessionId: promoted.id,
      fromMode: 'PROTOTYPE',
      toMode: 'DEVELOPMENT',
      repository: promoted.repository,
      branch: promoted.branch,
      checkpointSha: promoted.lastCheckpointSha!,
      promotedAt: new Date(),
    });

    const objective = input.objective ?? `Development handoff from Prototype ${promoted.project}`;
    const prompt = input.prompt ?? `Continue development from approved prototype (${promoted.branch} @ ${promoted.lastCheckpointSha})`;
    const priority = input.priority ?? 0;

    const pdlTask = await this.tasks.ingest({
      project: promoted.project,
      repository: promoted.repository,
      branch: promoted.branch,
      checkpointSha: (promoted.lastCheckpointSha ?? session.lastCheckpointSha)!,
      promotionId: promotion.id ?? `promo-${promoted.id}`,
      prototypeSessionId: promoted.id,
      objective,
      prompt,
      priority,
    });

    this.events.emit({
      sessionId: promoted.id,
      type: 'PROMOTED_TO_DEVELOPMENT',
      payload: {
        sessionId: promoted.id,
        promotionId: promotion.id,
        taskId: pdlTask.taskId ?? pdlTask.id,
        branch: promoted.branch,
        checkpointSha: promoted.lastCheckpointSha,
        repository: promoted.repository,
      },
    });

    return {
      session: promoted,
      promotion,
      task: pdlTask,
      mode: 'DEVELOPMENT',
    };
  }
}
