// src/providers/streaming/assembler.ts
import type { ToolCall } from '../../tools/types.js';
import type { ToolCallDelta } from './types.js';

export interface PendingToolCall {
  index: number;
  id?: string;
  name?: string;
  argumentsBuffer: string;
}

/**
 * Deterministic ToolCallStreamAssembler.
 * Reconstructs fragmented tool calls streamed via OpenAI-compatible SSE deltas.
 */
export class ToolCallStreamAssembler {
  private readonly toolCallsByIndex: Map<number, PendingToolCall> = new Map();

  /**
   * Ingest a tool call delta chunk from a streaming event.
   */
  ingestDelta(delta: ToolCallDelta): void {
    if (delta.index === undefined || delta.index === null) {
      return;
    }

    let current = this.toolCallsByIndex.get(delta.index);
    if (!current) {
      current = {
        index: delta.index,
        id: delta.id,
        name: delta.function?.name,
        argumentsBuffer: delta.function?.arguments || '',
      };
      this.toolCallsByIndex.set(delta.index, current);
      return;
    }

    // Accumulate metadata & arguments
    if (delta.id && !current.id) {
      current.id = delta.id;
    }
    if (delta.function?.name && !current.name) {
      current.name = delta.function.name;
    }
    if (delta.function?.arguments) {
      current.argumentsBuffer += delta.function.arguments;
    }
  }

  /**
   * Finalize and assemble all accumulated tool calls.
   * Returns valid ToolCall[] ordered by index.
   */
  assemble(): ToolCall[] {
    const sortedIndices = Array.from(this.toolCallsByIndex.keys()).sort((a, b) => a - b);
    const result: ToolCall[] = [];

    for (const idx of sortedIndices) {
      const pending = this.toolCallsByIndex.get(idx)!;
      const name = pending.name || 'unknown_tool';
      const id = pending.id || `call_${idx}_${Date.now()}`;
      const argsRaw = pending.argumentsBuffer.trim();

      // Validate JSON structure; if empty string, normalize to "{}"
      let validArgs = '{}';
      if (argsRaw) {
        try {
          JSON.parse(argsRaw);
          validArgs = argsRaw;
        } catch {
          // If JSON is malformed or partial when finish_reason occurs, retain raw buffer or fallback
          validArgs = argsRaw;
        }
      }

      result.push({
        id,
        type: 'function',
        function: {
          name,
          arguments: validArgs,
        },
      });
    }

    return result;
  }

  /**
   * Reset assembler state.
   */
  reset(): void {
    this.toolCallsByIndex.clear();
  }

  /**
   * Check if any tool calls have been detected.
   */
  hasToolCalls(): boolean {
    return this.toolCallsByIndex.size > 0;
  }
}
