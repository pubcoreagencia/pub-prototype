import type { Task } from '../domain.js';
import type { AgentProvider, ProviderTaskInput, ProviderTaskResult } from './types.js';
import { DEFAULT_ROUTER_BASE_URL, normalizeBaseUrl, NEUTRAL_TOOL_INSTRUCTIONS } from './shared.js';
import { ToolRuntime } from '../tools/runtime.js';
import { AgentExecutor } from '../executor.js';
import type { ToolCall, ToolResult, ToolExecutionContext, ToolDefinition } from '../tools/types.js';
import { loadRouterConfig, type RouterConfig } from './routerConfig.js';
import { parseOpenAISSEStream, type StreamConsumer, StreamEventSink } from './streaming/index.js';

interface OpenAIChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: OpenAIChatMessage;
    finish_reason?: string;
  }>;
  model?: string;
  error?: { message?: string; type?: string; code?: string };
}

function buildSystemPrompt(workspace: string, task: Task | ProviderTaskInput): OpenAIChatMessage {
  const instructions = 'systemInstructions' in task && Array.isArray(task.systemInstructions)
    ? task.systemInstructions
    : [];

  const content = [
    `Workspace: ${workspace}`,
    `Task ID: ${task.id}`,
    `Objective: ${task.objective}`,
    ...NEUTRAL_TOOL_INSTRUCTIONS,
    ...instructions,
  ].join('\n');

  return {
    role: 'system',
    content,
  };
}

function buildUserPrompt(task: Task | ProviderTaskInput): OpenAIChatMessage {

  return {
    role: 'user',
    content: task.prompt,
  };
}

/**
 * Convert ToolDefinition[] to OpenAI tools format for the chat completion request.
 */
function toOpenAITools(defs: ToolDefinition[]) {
  return defs.map(def => ({
    type: 'function' as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    },
  }));
}

export class RouterProvider implements AgentProvider {
  readonly kind = '9router' as const;
  readonly model: string | null;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly maxToolRounds: number;
  readonly maxToolCalls: number;
  readonly enableStream: boolean;
  readonly consumer?: StreamConsumer;

  constructor(
    baseUrl = process.env.ROUTER_BASE_URL ?? DEFAULT_ROUTER_BASE_URL,
    apiKey = process.env.ROUTER_API_KEY,
    timeoutMs = Number(process.env.ROUTER_TIMEOUT_MS ?? 900000),
    modelOverride?: string,
    enableStream = process.env.ROUTER_STREAM_ENABLED === 'true',
    consumer?: StreamConsumer,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl, DEFAULT_ROUTER_BASE_URL);
    this.apiKey = apiKey?.trim() || undefined;
    this.timeoutMs = timeoutMs;
    this.maxToolRounds = Number(process.env.ROUTER_MAX_TOOL_ROUNDS ?? 20);
    this.maxToolCalls = Number(process.env.ROUTER_MAX_TOOL_CALLS ?? 50);
    this.model = modelOverride ?? process.env.ROUTER_MODEL ?? null;
    this.enableStream = enableStream;
    this.consumer = consumer;
  }

  async execute(
    task: Task | ProviderTaskInput,
    workspace: string,
    options?: { signal?: AbortSignal; consumer?: StreamConsumer }
  ): Promise<ProviderTaskResult> {

    const started = Date.now();
    const rawConsumer = options?.consumer ?? this.consumer;
    const effectiveConsumer = rawConsumer instanceof StreamEventSink ? rawConsumer : rawConsumer ? new StreamEventSink(rawConsumer) : undefined;
    const ctx: ToolExecutionContext = {
      workspaceRoot: workspace,
      maxRounds: this.maxToolRounds,
      maxToolCalls: this.maxToolCalls,
      commandTimeoutMs: Number(process.env.ROUTER_COMMAND_TIMEOUT_MS ?? 60000),
      maxFileBytes: Number(process.env.ROUTER_MAX_FILE_BYTES ?? 1024 * 1024),
      maxWriteBytes: Number(process.env.ROUTER_MAX_WRITE_BYTES ?? 256 * 1024),
      redactSecrets: true,
    };
    const runtime = new ToolRuntime(ctx, new AgentExecutor());
    const toolDefs = runtime.getToolDefinitions();
    const messages: OpenAIChatMessage[] = [
      buildSystemPrompt(workspace, task),
      buildUserPrompt(task),
    ];
    const cfg: RouterConfig = loadRouterConfig(this.model || undefined);
    const modelQueue = [cfg.primaryModel, ...cfg.fallbackModels];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
    let modelUsed: string | null = null;
    let totalToolCalls = 0;
    let toolRounds = 0;
    let finalMessage = '';
    let lastResponseText = '';

    let modelFound = false;
    try {
    while (toolRounds < this.maxToolRounds) {
      for (const model of modelQueue) {
        modelFound = false;
        let attempt = 0;
        while (attempt < cfg.maxRetries) {
          attempt++;
          const requestBody: Record<string, unknown> = {
            model,
            messages: this.messagesToApi(messages),
            stream: this.enableStream,
            tools: toOpenAITools(toolDefs),
            tool_choice: 'auto',
          };

          try {
            const response = await fetch(`${this.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
              },
              body: JSON.stringify(requestBody),
              signal: controller.signal,
            });

            if (!response.ok) {
              const text = await response.text();
              const errPayload = this.parseError(text);
              if (response.status === 429 && attempt < cfg.maxRetries) {
                const retryAfter = response.headers.get('retry-after');
                const delayMs = retryAfter ? Number(retryAfter) * 1000 : cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100;
                await new Promise(r => setTimeout(r, delayMs));
                continue;
              }
              if (response.status >= 500 && attempt < cfg.maxRetries) {
                const delayMs = cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100;
                await new Promise(r => setTimeout(r, delayMs));
                continue;
              }

              const isLastModel = model === modelQueue[modelQueue.length - 1];
              if (isLastModel) {
                clearTimeout(timer);
                const hasFallbacks = cfg.fallbackModels && cfg.fallbackModels.length > 0;
                const isAuth = response.status === 401 || response.status === 403;
                const isRateLimit = response.status === 429;
                const isServerError = response.status >= 500;
                const determinedErrorCode = isAuth
                  ? 'AUTHENTICATION_FAILURE'
                  : isRateLimit
                    ? 'RATE_LIMITED'
                    : isServerError
                      ? 'PROVIDER_UNAVAILABLE'
                      : (hasFallbacks ? 'ALL_PROVIDERS_FAILED' : 'ROUTER_HTTP_ERROR');
                return {
                  status: isAuth ? 'FAILED' : 'ROUTER_HTTP_ERROR',
                  provider: this.kind,
                  model: modelUsed ?? model,
                  exitCode: response.status,
                  durationMs: Date.now() - started,
                  stdout: lastResponseText || '',
                  stderr: errPayload.message || text,
                  changedFiles: runtime.getChangedFiles(),
                  commit: null,
                  errorCode: determinedErrorCode,
                  errorMessage: isAuth
                    ? `9router authentication failed (HTTP ${response.status}): ${errPayload.message || 'Invalid or missing API key'}`
                    : (hasFallbacks
                      ? `All configured models failed: HTTP ${response.status}: ${errPayload.message || ''}`
                      : `HTTP ${response.status}: ${errPayload.message || ''}`),
                  toolCalls: totalToolCalls,
                  toolRounds: toolRounds,
                  httpStatus: response.status,
                };
              }
              break;
            }

            let messageContent = '';
            let toolCalls: ToolCall[] | undefined = undefined;
            let finishReason: string | undefined = undefined;

            if (this.enableStream && response.body) {
              const streamResult = await parseOpenAISSEStream(
                response.body,
                controller.signal,
                effectiveConsumer ? (event) => effectiveConsumer.onEvent?.(event) : undefined
              );
              messageContent = streamResult.fullText;
              toolCalls = streamResult.toolCalls;
              finishReason = streamResult.finishReason;
            } else {
              const text = await response.text();
              const payload = JSON.parse(text) as OpenAIChatResponse & { choices?: Array<{ message?: OpenAIChatMessage; finish_reason?: string }> };

              modelUsed = payload.model ?? model;
              const choice = payload.choices?.[0];
              const message = choice?.message;
              finishReason = choice?.finish_reason;
              messageContent = message?.content ?? '';
              toolCalls = message?.tool_calls;
            }

            modelUsed = modelUsed ?? model;
            lastResponseText = messageContent;
            if (messageContent) finalMessage = messageContent;

            if (!toolCalls || toolCalls.length === 0) {
              clearTimeout(timer);
              return {
                status: 'COMPLETED',
                provider: this.kind,
                model: modelUsed,
                exitCode: 0,
                durationMs: Date.now() - started,
                stdout: finalMessage,
                stderr: '',
                changedFiles: runtime.getChangedFiles(),
                commit: null,
                errorCode: null,
                errorMessage: null,
                toolCalls: totalToolCalls,
                toolRounds: toolRounds,
              };
            }

            const toolResults: ToolResult[] = [];
            for (const tc of toolCalls) {
              if (controller.signal.aborted) {
                clearTimeout(timer);
                return {
                  status: 'ROUTER_TIMEOUT',
                  provider: this.kind,
                  model: modelUsed,
                  exitCode: null,
                  durationMs: Date.now() - started,
                  stdout: finalMessage,
                  stderr: 'Execution cancelled/aborted prior to tool execution',
                  changedFiles: runtime.getChangedFiles(),
                  commit: null,
                  errorCode: 'ROUTER_TIMEOUT',
                  errorMessage: 'Execution cancelled/aborted prior to tool execution',
                  toolCalls: totalToolCalls,
                  toolRounds: toolRounds,
                };
              }
              if (totalToolCalls >= this.maxToolCalls) {
                clearTimeout(timer);
                return {
                  status: 'TOOL_LOOP_LIMIT',
                  provider: this.kind,
                  model: modelUsed,
                  exitCode: null,
                  durationMs: Date.now() - started,
                  stdout: finalMessage,
                  stderr: '',
                  changedFiles: runtime.getChangedFiles(),
                  commit: null,
                  errorCode: 'TOOL_LOOP_LIMIT',
                  errorMessage: `Exceeded max tool calls (${this.maxToolCalls})`,
                  toolCalls: totalToolCalls,
                  toolRounds: toolRounds,
                };
              }
              totalToolCalls++;
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.function.arguments);
              } catch {
                toolResults.push({ toolCallId: tc.id, toolName: tc.function.name, success: false, content: '', error: 'Failed to parse tool arguments as JSON' });
                continue;
              }
              toolResults.push(await runtime.executeTool(tc.id, tc.function.name, args));
            }

            messages.push({ role: 'assistant', content: messageContent || null, tool_calls: toolCalls });
            for (const tr of toolResults) {
              messages.push({ role: 'tool', content: tr.success ? tr.content : `Error: ${tr.error}`, tool_call_id: tr.toolCallId });
            }

            modelFound = true;
            toolRounds++;
            break;
          } catch (fetchErr: any) {
            if (attempt < cfg.maxRetries) {
              await new Promise(r => setTimeout(r, cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100));
              continue;
            }
            break;
          }
        }
        // If this is the last model (including fallbacks) and all attempts failed, return FAILED
        if (model === modelQueue[modelQueue.length - 1]) {
          clearTimeout(timer);
          return {
            status: 'FAILED',
            provider: this.kind,
            model: modelUsed,
            exitCode: null,
            durationMs: Date.now() - started,
            stdout: finalMessage,
            stderr: 'All configured models failed',
            changedFiles: runtime.getChangedFiles(),
            commit: null,
            errorCode: 'ALL_PROVIDERS_FAILED',
            errorMessage: 'All configured models failed',
            toolCalls: totalToolCalls,
            toolRounds: toolRounds,
          };
        }
        // otherwise continue to next model (fallback) without returning
        }

}
}



    catch (error) {
      const message = error instanceof Error ? error.message : 'Router request failed';
      const isAbort = message.includes('abort') || (error as any)?.name === 'AbortError';
      clearTimeout(timer);
      return {
        status: isAbort ? 'ROUTER_TIMEOUT' : 'ROUTER_CONNECTION_ERROR',
        provider: this.kind,
        model: modelUsed,
        exitCode: null,
        durationMs: Date.now() - started,
        stdout: finalMessage || lastResponseText,
        stderr: message,
        changedFiles: runtime.getChangedFiles(),
        commit: null,
        errorCode: isAbort ? 'ROUTER_TIMEOUT' : 'ROUTER_CONNECTION_ERROR',
        errorMessage: message,
        toolCalls: totalToolCalls,
        toolRounds: toolRounds,
      };
    } finally {
      clearTimeout(timer);
    }

    // Fallback return if execution reaches end without a response
    return {
      status: 'FAILED',
      provider: this.kind,
      model: modelUsed,
      exitCode: null,
      durationMs: Date.now() - started,
      stdout: finalMessage,
      stderr: 'No response',
      changedFiles: runtime.getChangedFiles(),
      commit: null,
      errorCode: 'NO_RESPONSE',
      errorMessage: 'No response',
      toolCalls: totalToolCalls,
      toolRounds: toolRounds,
    };
  }

  /**
   * Convert internal message format to API-compatible format.
   * Always include content (null when empty) for OpenAI-compatible compliance.
   */
  private messagesToApi(messages: OpenAIChatMessage[]): Record<string, unknown>[] {
    return messages.map(msg => {
      const result: Record<string, unknown> = { role: msg.role };
      // Always include content — null when not present (required by Gemini via 9Router)
      if (msg.content !== undefined) {
        result.content = msg.content;
      } else {
        result.content = null;
      }
      if (msg.tool_calls) {
        result.tool_calls = msg.tool_calls;
      }
      if (msg.tool_call_id) {
        result.tool_call_id = msg.tool_call_id;
      }
      return result;
    });
  }

  private parseError(text: string): { message: string; type?: string; code?: string } {
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) return { message: parsed.error.message, type: parsed.error.type, code: parsed.error.code };
    } catch {
      // not JSON
    }
    return { message: text };
  }

  async health() {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : undefined,
      });
      return { available: response.ok, details: `GET /models -> ${response.status}` };
    } catch (error) {
      return { available: false, details: error instanceof Error ? error.message : 'unavailable' };
    }
  }

  capabilities() {
    return ['coding', 'planning', 'routing', 'tool-calling'];
  }

  metadata() {
    return { baseUrl: this.baseUrl, model: this.model };
  }
}
