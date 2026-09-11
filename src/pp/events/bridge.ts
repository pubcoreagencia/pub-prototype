import type { OperationalEventEnvelope } from '../../providers/streaming/types.js';
import type { PrototypeEventPublisher, PrototypeEventInput } from './events.js';
import type { PrototypeEventType } from '../domain/domain.js';

export const OPERATIONAL_TO_PROTOTYPE_EVENT_MAP: Record<string, PrototypeEventType | null> = {
  attempt_started: 'AGENT_ATTEMPT_STARTED',
  text_delta: 'AGENT_TEXT_DELTA',
  tool_call_delta: 'AGENT_TOOL_CALL_DELTA',
  tool_call_completed: 'AGENT_TOOL_CALL_COMPLETED',
  usage: 'AGENT_USAGE',
  finish_reason: 'AGENT_FINISH_REASON',
  stream_completed: 'AGENT_STREAM_COMPLETED',
  attempt_completed: 'AGENT_ATTEMPT_COMPLETED',
  attempt_failed: 'AGENT_ATTEMPT_FAILED',
  retry_started: 'AGENT_RETRY_STARTED',
  task_cancelled: 'TASK_CANCELLED',
  error: 'ERROR',
};

function sanitizePayload(payload: any): any {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }
  const cloned = Array.isArray(payload) ? [...payload] : { ...payload };

  const SENSITIVE_KEYS = new Set([
    'authorization',
    'api_key',
    'apikey',
    'secret',
    'password',
    'github_token',
    'token',
    'x-api-key',
  ]);
  for (const key of Object.keys(cloned)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.has(lower) || lower.endsWith('_token') || lower.endsWith('_secret') || lower.endsWith('_key')) {
      // Avoid redacting totalTokens or promptTokens
      if (!lower.includes('totaltokens') && !lower.includes('prompttokens') && !lower.includes('completiontokens')) {
        cloned[key] = '[REDACTED]';
      }
    } else if (typeof cloned[key] === 'object') {
      cloned[key] = sanitizePayload(cloned[key]);
    }
  }
  return cloned;
}

export interface BridgeOptions {
  coalesceDeltas?: boolean;
  flushIntervalMs?: number;
}

export class OperationalEventBridge {
  private readonly processedIds = new Set<string>();
  private readonly maxDeduplicationEntries = 5000;
  private pendingTextDelta: {
    taskId: string;
    attempt: number;
    startSeq: number;
    endSeq: number;
    text: string;
    timestamp: string;
  } | null = null;
  private flushTimer: any = null;

  constructor(
    private readonly sessionId: string,
    private readonly publisher: PrototypeEventPublisher,
    private readonly options: BridgeOptions = {}
  ) {}

  async handleEnvelope(envelope: OperationalEventEnvelope): Promise<void> {
    if (!envelope || !envelope.type) return;

    const dedupKey = `${this.sessionId}:${envelope.taskId}:${envelope.attempt}:${envelope.seq}:${envelope.type}`;
    if (this.processedIds.has(dedupKey)) {
      return;
    }
    this.addProcessedId(dedupKey);

    if (envelope.type !== 'text_delta') {
      await this.flushPendingDeltas();
    }

    if (envelope.type === 'text_delta' && this.options.coalesceDeltas !== false) {
      this.bufferTextDelta(envelope);
      return;
    }

    await this.emitMappedEvent(envelope);
  }

  private bufferTextDelta(envelope: OperationalEventEnvelope): void {
    const deltaText = envelope.payload?.text || '';
    if (!deltaText) return;

    if (
      this.pendingTextDelta &&
      this.pendingTextDelta.taskId === envelope.taskId &&
      this.pendingTextDelta.attempt === envelope.attempt
    ) {
      this.pendingTextDelta.text += deltaText;
      this.pendingTextDelta.endSeq = envelope.seq;
    } else {
      if (this.pendingTextDelta) {
        this.flushPendingDeltas();
      }
      this.pendingTextDelta = {
        taskId: envelope.taskId,
        attempt: envelope.attempt,
        startSeq: envelope.seq,
        endSeq: envelope.seq,
        text: deltaText,
        timestamp: envelope.timestamp,
      };
    }

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushPendingDeltas();
      }, this.options.flushIntervalMs ?? 25);
    }
  }

  async flushPendingDeltas(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (!this.pendingTextDelta) return;

    const pending = this.pendingTextDelta;
    this.pendingTextDelta = null;

    const input: PrototypeEventInput = {
      sessionId: this.sessionId,
      type: 'AGENT_TEXT_DELTA',
      payload: {
        taskId: pending.taskId,
        attempt: pending.attempt,
        operationalSeq: pending.endSeq,
        operationalSeqStart: pending.startSeq,
        text: pending.text,
        timestamp: pending.timestamp,
      },
    };

    await this.publisher.emit(input);
  }

  private async emitMappedEvent(envelope: OperationalEventEnvelope): Promise<void> {
    const prototypeType = OPERATIONAL_TO_PROTOTYPE_EVENT_MAP[envelope.type];
    if (!prototypeType) {
      return;
    }

    const cleanPayload = sanitizePayload(envelope.payload || {});

    const input: PrototypeEventInput = {
      sessionId: this.sessionId,
      type: prototypeType,
      payload: {
        taskId: envelope.taskId,
        attempt: envelope.attempt,
        operationalSeq: envelope.seq,
        timestamp: envelope.timestamp,
        ...(cleanPayload || {}),
      },
    };

    await this.publisher.emit(input);
  }

  private addProcessedId(id: string): void {
    if (this.processedIds.size >= this.maxDeduplicationEntries) {
      const first = this.processedIds.values().next().value;
      if (first !== undefined) this.processedIds.delete(first);
    }
    this.processedIds.add(id);
  }

  async close(): Promise<void> {
    await this.flushPendingDeltas();
  }
}
