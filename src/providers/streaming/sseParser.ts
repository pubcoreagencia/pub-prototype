// src/providers/streaming/sseParser.ts
import type { StreamEvent, ToolCallDelta, StreamUsageData } from './types.js';
import { ToolCallStreamAssembler } from './assembler.js';

export interface ParseStreamResult {
  fullText: string;
  finishReason?: string;
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  usage?: StreamUsageData;
}

/**
 * Process an SSE ReadableStream and extract text, tool calls, finish reasons, and usage.
 */
export async function parseOpenAISSEStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  onEvent?: (event: StreamEvent) => void
): Promise<ParseStreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8');
  const assembler = new ToolCallStreamAssembler();

  let fullText = '';
  let finishReason: string | undefined = undefined;
  let usage: StreamUsageData | undefined = undefined;
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) {
        throw new Error('STREAM_ABORTED: Request was cancelled by caller signal');
      }

      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Retain partial trailing line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {
          continue; // Empty line or SSE comment/keep-alive
        }

        if (trimmed.startsWith('data:')) {
          const dataContent = trimmed.slice(5).trim();
          if (dataContent === '[DONE]') {
            onEvent?.({ type: 'stream_completed' });
            continue;
          }

          try {
            const parsed = JSON.parse(dataContent);
            // 1. Check top-level or chunk-level usage
            if (parsed.usage) {
              usage = {
                promptTokens: parsed.usage.prompt_tokens,
                completionTokens: parsed.usage.completion_tokens,
                totalTokens: parsed.usage.total_tokens,
                costUsd: parsed.usage.total_cost || parsed.total_cost,
              };
              onEvent?.({ type: 'usage', usage });
            }

            const choice = parsed.choices?.[0];
            if (choice) {
              if (choice.finish_reason) {
                finishReason = choice.finish_reason;
                onEvent?.({ type: 'finish_reason', finishReason });
              }

              const delta = choice.delta;
              if (delta) {
                // Text delta
                if (delta.content) {
                  fullText += delta.content;
                  onEvent?.({ type: 'text_delta', text: delta.content });
                }

                // Tool calls delta
                if (Array.isArray(delta.tool_calls)) {
                  for (const tc of delta.tool_calls) {
                    const toolDelta: ToolCallDelta = {
                      index: tc.index ?? 0,
                      id: tc.id,
                      type: tc.type || 'function',
                      function: tc.function ? {
                        name: tc.function.name,
                        arguments: tc.function.arguments,
                      } : undefined,
                    };
                    assembler.ingestDelta(toolDelta);
                    onEvent?.({ type: 'tool_call_delta', toolCallDelta: toolDelta });
                  }
                }
              }
            }
          } catch {
            // Ignore non-JSON payload or fragmented JSON lines
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  const toolCalls = assembler.assemble();
  for (const tc of toolCalls) {
    onEvent?.({ type: 'tool_call_completed', toolCall: tc });
  }

  return {
    fullText,
    finishReason,
    toolCalls,
    usage,
  };
}
