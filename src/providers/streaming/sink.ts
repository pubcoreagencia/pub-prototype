// src/providers/streaming/sink.ts
import type {
  StreamConsumer,
  StreamEvent,
  StreamUsageData,
  ToolCallDelta,
  OperationalEventEnvelope,
  OperationalEventType,
} from './types.js';
import type { ToolCall } from '../../tools/types.js';

export interface RuntimeStreamFeedback {
  textBuffer: string;
  toolCallsReceived: ToolCall[];
  completedEventReceived: boolean;
  finishReason?: string;
  usage?: StreamUsageData;
  error?: Error;
  eventsCount: number;
}

/**
 * StreamEventSink
 * A lightweight runtime bridge connecting provider streaming and lifecycle events
 * to execution observation without interfering with task execution lifecycle.
 */
export class StreamEventSink implements StreamConsumer {
  private feedback: RuntimeStreamFeedback = {
    textBuffer: '',
    toolCallsReceived: [],
    completedEventReceived: false,
    eventsCount: 0,
  };

  private readonly externalConsumer?: StreamConsumer;
  private readonly taskId?: string;
  private readonly attempt: number;
  private seqCounter = 0;

  constructor(
    externalConsumer?: StreamConsumer,
    options?: { taskId?: string; attempt?: number; startSeq?: number }
  ) {
    this.externalConsumer = externalConsumer;
    this.taskId = options?.taskId;
    this.attempt = options?.attempt ?? 0;
    this.seqCounter = options?.startSeq ?? 0;
  }

  emitEnvelope<TPayload = any>(type: OperationalEventType, payload: TPayload): OperationalEventEnvelope<TPayload> {
    const envelope: OperationalEventEnvelope<TPayload> = {
      taskId: this.taskId ?? '',
      attempt: this.attempt,
      seq: this.seqCounter++,
      timestamp: new Date().toISOString(),
      type,
      payload,
    };

    try {
      const res = this.externalConsumer?.onEnvelope?.(envelope) as any;
      if (res && typeof res.catch === 'function') {
        res.catch(() => {});
      }
    } catch {}

    return envelope;
  }

  onEvent(event: StreamEvent): void {
    this.feedback.eventsCount++;

    // 1. Generate and emit OperationalEventEnvelope
    this.emitEnvelope(event.type, event);

    // 2. Specific event routing
    if (event.type === 'text_delta' && event.text) {
      this.feedback.textBuffer += event.text;
      try { this.externalConsumer?.onTextDelta?.(event.text); } catch {}
    } else if (event.type === 'tool_call_completed' && event.toolCall) {
      this.feedback.toolCallsReceived.push(event.toolCall);
      try { this.externalConsumer?.onToolCallCompleted?.(event.toolCall); } catch {}
    } else if (event.type === 'tool_call_delta' && event.toolCallDelta) {
      try { this.externalConsumer?.onToolCallDelta?.(event.toolCallDelta); } catch {}
    } else if (event.type === 'finish_reason' && event.finishReason) {
      this.feedback.finishReason = event.finishReason;
    } else if (event.type === 'usage' && event.usage) {
      this.feedback.usage = event.usage;
      try { this.externalConsumer?.onUsage?.(event.usage); } catch {}
    } else if (event.type === 'stream_completed') {
      this.feedback.completedEventReceived = true;
    }

    try { this.externalConsumer?.onEvent?.(event); } catch {}
  }

  onError(error: Error): void {
    this.feedback.error = error;
    this.emitEnvelope('error', { message: error.message, name: error.name });
    try { this.externalConsumer?.onError?.(error); } catch {}
  }

  getFeedback(): Readonly<RuntimeStreamFeedback> {
    return { ...this.feedback };
  }

  getCurrentSeq(): number {
    return this.seqCounter;
  }

  reset(): void {
    this.feedback = {
      textBuffer: '',
      toolCallsReceived: [],
      completedEventReceived: false,
      eventsCount: 0,
    };
  }
}
