import { classifyApiError, type ClassificationResult } from '../api-error-classifier.js';
import type { Task } from '../domain.js';
import type { AgentProvider, ProviderTaskInput, ProviderTaskResult } from './types.js';
import { DEFAULT_OPENROUTER_BASE_URL, normalizeBaseUrl, resolveOpenRouterApiKey, NEUTRAL_TOOL_INSTRUCTIONS } from './shared.js';
import { ToolRuntime } from '../tools/runtime.js';
import { AgentExecutor } from '../executor.js';
import type { ToolCall, ToolResult, ToolExecutionContext, ToolDefinition } from '../tools/types.js';
import { loadOpenRouterConfig, type OpenRouterConfig } from './openrouterConfig.js';
import { canUsePaidFallback } from '../routing/index.js';
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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
  total_cost?: number;
  error?: { message?: string; type?: string; code?: string | number };
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

export class OpenRouterProvider implements AgentProvider {
  readonly kind = 'openrouter' as const;
  readonly model: string | null;
  readonly baseUrl: string;
  readonly apiKey: string | undefined;
  readonly timeoutMs: number;
  readonly maxToolRounds: number;
  readonly maxToolCalls: number;
  readonly enableStream: boolean;
  readonly consumer?: StreamConsumer;

  constructor(
    baseUrl = process.env.OPENROUTER_BASE_URL ?? DEFAULT_OPENROUTER_BASE_URL,
    apiKey?: string,
    timeoutMs = Number(process.env.OPENROUTER_TIMEOUT_MS ?? 900000),
    modelOverride?: string,
    enableStream = process.env.OPENROUTER_STREAM_ENABLED === 'true',
    consumer?: StreamConsumer,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl, DEFAULT_OPENROUTER_BASE_URL);
    this.apiKey = resolveOpenRouterApiKey(apiKey);
    this.timeoutMs = timeoutMs;
    this.maxToolRounds = Number(process.env.OPENROUTER_MAX_TOOL_ROUNDS ?? 20);
    this.maxToolCalls = Number(process.env.OPENROUTER_MAX_TOOL_CALLS ?? 50);
    this.model = modelOverride ?? process.env.OPENROUTER_MODEL ?? (this.apiKey ? 'anthropic/claude-3.5-haiku' : 'openrouter/free');
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
      commandTimeoutMs: Number(process.env.OPENROUTER_COMMAND_TIMEOUT_MS ?? 60000),
      maxFileBytes: Number(process.env.OPENROUTER_MAX_FILE_BYTES ?? 1024 * 1024),
      maxWriteBytes: Number(process.env.OPENROUTER_MAX_WRITE_BYTES ?? 256 * 1024),
      redactSecrets: true,
    };
    const runtime = new ToolRuntime(ctx, new AgentExecutor());
    const toolDefs = runtime.getToolDefinitions();
    const messages: OpenAIChatMessage[] = [
      buildSystemPrompt(workspace, task),
      buildUserPrompt(task),
    ];
    const cfg: OpenRouterConfig = loadOpenRouterConfig(this.model || undefined, task);
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
    let accumulatedPromptTokens = 0;
    let accumulatedCompletionTokens = 0;
    let accumulatedTotalTokens = 0;
    let accumulatedCostUsd: number | undefined = undefined;
    let paidAttemptsUsed = 0;
    // Ordered list of model identifiers that will be attempted (one entry per candidate model)
    const modelAttempts: string[] = [];

    const candidateEntries = cfg.candidateModels || modelQueue.map(m => {
      const isFree = m.includes(':free') || m.endsWith('/free');
      return {
        model: m,
        tier: m === 'openrouter/free' ? 2 : isFree ? 1 : 3,
        free: isFree,
        maxRetries: cfg.maxRetries,
      };
    });

    try {
      while (toolRounds < this.maxToolRounds) {
        let modelFound = false;
        for (const entry of candidateEntries) {
          const model = entry.model;
          const isPaid = !entry.free;

          // Cost Guard: verify if paid fallback is permitted before calling
          const isFallbackPaid = isPaid && entry.model !== cfg.primaryModel;
          if (isPaid && cfg.policy) {
            if (cfg.policy.limits.maxCostPerTaskUsd !== undefined && (accumulatedCostUsd ?? 0) >= cfg.policy.limits.maxCostPerTaskUsd) {
              continue; // Skip paid model if task budget is exhausted
            }
            if (isFallbackPaid && !canUsePaidFallback(cfg.policy, paidAttemptsUsed, accumulatedCostUsd ?? 0)) {
              continue; // Skip paid fallback if fallback policy prohibits it
            }
          }

          if (isPaid) {
            paidAttemptsUsed++;
          }
          // Record this candidate model as attempted (once per model)
          modelAttempts.push(entry.model);
          let attempt = 0;
          const retriesForModel = isPaid ? 1 : entry.maxRetries;

          while (attempt < retriesForModel) {
            attempt++;
            const requestBody: Record<string, unknown> = {
              model,
              messages: this.messagesToApi(messages),
              stream: this.enableStream,
              tools: toOpenAITools(toolDefs),
              tool_choice: 'auto',
            };

            try {
              const headers: Record<string, string> = {
                'content-type': 'application/json',
                'HTTP-Referer': 'https://github.com/pubcoreagencia/pub-dev-loop',
                'X-Title': 'PUB DEV LOOP',
              };
              if (this.apiKey) {
                headers['authorization'] = `Bearer ${this.apiKey}`;
              }

              const response = await fetch(`${this.baseUrl}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(requestBody),
                signal: controller.signal,
              });

              if (!response.ok) {
                const text = await response.text();
                const errPayload = this.parseError(text);
                const errMsg = errPayload.message || text;
                const errTextLower = text.toLowerCase();
                const hasToolMsg = messages.some(m => m.role === 'tool');
                // Pre-flight: se payload tem tool message E é Nvidia, forçar fallback imediato
                const isNvidiaToolMismatch =
                  hasToolMsg && (text.includes('Nvidia') || errTextLower.includes('nvidia'));
                if (response.status === 400) {
                  const cls = classifyApiError(response.status, errMsg, undefined, hasToolMsg);
                  if (cls.shouldFallback || isNvidiaToolMismatch) {
                    const isLastModel = model === candidateEntries[candidateEntries.length - 1].model;
                    if (isLastModel) {
                      clearTimeout(timer);
                      const hasFallbacks = cfg.fallbackModels && cfg.fallbackModels.length > 0;
                      return {
                        status: 'ROUTER_HTTP_ERROR',
                        provider: this.kind,
                        model: modelUsed ?? model,
                        exitCode: response.status,
                        durationMs: Date.now() - started,
                        stdout: lastResponseText || '',
                        stderr: isNvidiaToolMismatch
                          ? `[capability_error] Nvidia does not support tool-message format: ${errMsg}`
                          : `[capability_error] ${cls.reason}: ${errMsg}`,
                        changedFiles: runtime.getChangedFiles(),
                        commit: null,
                        errorCode: hasFallbacks ? 'ALL_PROVIDERS_FAILED' : 'ROUTER_HTTP_ERROR',
                        errorMessage: hasFallbacks
                          ? `All configured OpenRouter models failed: HTTP ${response.status} [${isNvidiaToolMismatch ? 'Nvidia tool-message' : cls.reason}]: ${errMsg}`
                          : `OpenRouter HTTP ${response.status} [${isNvidiaToolMismatch ? 'Nvidia tool-message' : cls.reason}]: ${errMsg}`,
                        toolCalls: totalToolCalls,
                        toolRounds: toolRounds,
                        httpStatus: response.status,
                        promptTokens: accumulatedPromptTokens || undefined,
                        completionTokens: accumulatedCompletionTokens || undefined,
                        totalTokens: accumulatedTotalTokens || undefined,
                        costUsd: accumulatedCostUsd,
                        modelAttempts: modelAttempts,
                      };
                    }
                    break; // → next model
                  }
                  // 400 payload error → abort
                  clearTimeout(timer);
                  return {
                    status: 'ROUTER_HTTP_ERROR',
                    provider: this.kind,
                    model: modelUsed ?? model,
                    exitCode: response.status,
                    durationMs: Date.now() - started,
                    stdout: lastResponseText || '',
                    stderr: `[payload_error] ${errMsg}`,
                    changedFiles: runtime.getChangedFiles(),
                    commit: null,
                    errorCode: 'ROUTER_HTTP_ERROR',
                    errorMessage: `OpenRouter HTTP 400 (payload): ${errMsg}`,
                    toolCalls: totalToolCalls,
                    toolRounds: toolRounds,
                    httpStatus: response.status,
                    promptTokens: accumulatedPromptTokens || undefined,
                    completionTokens: accumulatedCompletionTokens || undefined,
                    totalTokens: accumulatedTotalTokens || undefined,
                    costUsd: accumulatedCostUsd,
                  };
                }
                if (response.status === 429 && attempt < retriesForModel) {
                  const retryAfter = response.headers.get('retry-after');
                  const delayMs = retryAfter ? Number(retryAfter) * 1000 : cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100;
                  await new Promise(r => setTimeout(r, delayMs));
                  continue;
                }
                if (response.status >= 500 && attempt < retriesForModel) {
                  const delayMs = cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100;
                  await new Promise(r => setTimeout(r, delayMs));
                  continue;
                }

                const isLastModel = model === candidateEntries[candidateEntries.length - 1].model;
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
                      ? `OpenRouter authentication failed (HTTP ${response.status}): ${errPayload.message || 'Invalid or missing API key'}`
                      : (hasFallbacks
                        ? `All configured OpenRouter models failed: HTTP ${response.status}: ${errPayload.message || ''}`
                        : `OpenRouter HTTP ${response.status}: ${errPayload.message || ''}`),
                    toolCalls: totalToolCalls,
                    toolRounds: toolRounds,
                    httpStatus: response.status,
                    promptTokens: accumulatedPromptTokens || undefined,
                    completionTokens: accumulatedCompletionTokens || undefined,
                    totalTokens: accumulatedTotalTokens || undefined,
                    costUsd: accumulatedCostUsd,
                    modelAttempts: modelAttempts,
                  };
                }
                break;
              }

              let messageContent = '';
              let toolCalls: ToolCall[] | undefined = undefined;
              let finishReason: string | undefined = undefined;

              if (this.enableStream && response.body) {
                // STREAMING PATH (SSE)
                const streamResult = await parseOpenAISSEStream(
                  response.body,
                  controller.signal,
                  effectiveConsumer ? (event) => effectiveConsumer.onEvent?.(event) : undefined
                );
                messageContent = streamResult.fullText;
                toolCalls = streamResult.toolCalls;
                finishReason = streamResult.finishReason;

                if (streamResult.usage) {
                  if (typeof streamResult.usage.promptTokens === 'number') {
                    accumulatedPromptTokens += streamResult.usage.promptTokens;
                  }
                  if (typeof streamResult.usage.completionTokens === 'number') {
                    accumulatedCompletionTokens += streamResult.usage.completionTokens;
                  }
                  if (typeof streamResult.usage.totalTokens === 'number') {
                    accumulatedTotalTokens += streamResult.usage.totalTokens;
                  }
                  if (typeof streamResult.usage.costUsd === 'number') {
                    accumulatedCostUsd = (accumulatedCostUsd ?? 0) + streamResult.usage.costUsd;
                  }
                }
              } else {
                // STANDARD STREAM: FALSE PATH
                const text = await response.text();
                if (!text || text.trim() === '') {
                  const isLastModel = model === candidateEntries[candidateEntries.length - 1].model;
                  if (isLastModel && attempt >= retriesForModel) {
                    clearTimeout(timer);
                    return {
                      status: 'FAILED',
                      provider: this.kind,
                      model: modelUsed ?? model,
                      exitCode: null,
                      durationMs: Date.now() - started,
                      stdout: '',
                      stderr: 'Empty response body from OpenRouter',
                      changedFiles: runtime.getChangedFiles(),
                      commit: null,
                      errorCode: 'EMPTY_RESPONSE',
                      errorMessage: 'Empty response body from OpenRouter',
                      toolCalls: totalToolCalls,
                      toolRounds: toolRounds,
                      promptTokens: accumulatedPromptTokens || undefined,
                      completionTokens: accumulatedCompletionTokens || undefined,
                      totalTokens: accumulatedTotalTokens || undefined,
                      costUsd: accumulatedCostUsd,
                    };
                  }
                  continue;
                }

                let payload: OpenAIChatResponse & {
                  choices?: Array<{ message?: OpenAIChatMessage; finish_reason?: string }>;
                };
                try {
                  payload = JSON.parse(text);
                } catch {
                  const isLastModel = model === candidateEntries[candidateEntries.length - 1].model;
                  if (isLastModel && attempt >= retriesForModel) {
                    clearTimeout(timer);
                    return {
                      status: 'FAILED',
                      provider: this.kind,
                      model: modelUsed ?? model,
                      exitCode: null,
                      durationMs: Date.now() - started,
                      stdout: text,
                      stderr: 'Invalid JSON response from OpenRouter',
                      changedFiles: runtime.getChangedFiles(),
                      commit: null,
                      errorCode: 'INVALID_RESPONSE',
                      errorMessage: 'Invalid JSON response from OpenRouter',
                      toolCalls: totalToolCalls,
                      toolRounds: toolRounds,
                      promptTokens: accumulatedPromptTokens || undefined,
                      completionTokens: accumulatedCompletionTokens || undefined,
                      totalTokens: accumulatedTotalTokens || undefined,
                      costUsd: accumulatedCostUsd,
                    };
                  }
                  continue;
                }

                if (payload.usage) {
                  if (typeof payload.usage.prompt_tokens === 'number') {
                    accumulatedPromptTokens += payload.usage.prompt_tokens;
                  }
                  if (typeof payload.usage.completion_tokens === 'number') {
                    accumulatedCompletionTokens += payload.usage.completion_tokens;
                  }
                  if (typeof payload.usage.total_tokens === 'number') {
                    accumulatedTotalTokens += payload.usage.total_tokens;
                  }
                  if (typeof payload.usage.cost === 'number') {
                    accumulatedCostUsd = (accumulatedCostUsd ?? 0) + payload.usage.cost;
                  }
                }
                if (typeof payload.total_cost === 'number') {
                  accumulatedCostUsd = (accumulatedCostUsd ?? 0) + payload.total_cost;
                } else if (entry.free && accumulatedCostUsd === undefined) {
                  accumulatedCostUsd = 0;
                }

                modelUsed = payload.model ?? model;
                const choice = payload.choices?.[0];
                const message = choice?.message;
                finishReason = choice?.finish_reason;
                messageContent = message?.content ?? '';
                toolCalls = message?.tool_calls;
              }

              if (entry.free && accumulatedCostUsd === undefined) {
                accumulatedCostUsd = 0;
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
                  promptTokens: accumulatedPromptTokens || undefined,
                  completionTokens: accumulatedCompletionTokens || undefined,
                  totalTokens: accumulatedTotalTokens || undefined,
                  costUsd: accumulatedCostUsd,
                  modelAttempts: modelAttempts,
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
                    promptTokens: accumulatedPromptTokens || undefined,
                    completionTokens: accumulatedCompletionTokens || undefined,
                    totalTokens: accumulatedTotalTokens || undefined,
                    costUsd: accumulatedCostUsd,
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
                    promptTokens: accumulatedPromptTokens || undefined,
                    completionTokens: accumulatedCompletionTokens || undefined,
                    totalTokens: accumulatedTotalTokens || undefined,
                    costUsd: accumulatedCostUsd,
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
              const isAbort = fetchErr?.name === 'AbortError' || String(fetchErr?.message).toLowerCase().includes('abort');
              if (isAbort) {
                throw fetchErr;
              }
              if (attempt < retriesForModel) {
                await new Promise(r => setTimeout(r, cfg.baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100));
                continue;
              }
              break;
            }
          }
          if (modelFound) break;
        }
        if (!modelFound) break;
      }
      clearTimeout(timer);
      return {
        status: 'FAILED',
        provider: this.kind,
        model: modelUsed,
        exitCode: null,
        durationMs: Date.now() - started,
        stdout: finalMessage,
        stderr: 'All configured OpenRouter models failed',
        changedFiles: runtime.getChangedFiles(),
        commit: null,
        errorCode: 'ALL_PROVIDERS_FAILED',
        errorMessage: 'All configured OpenRouter models failed',
        toolCalls: totalToolCalls,
        toolRounds: toolRounds,
        promptTokens: accumulatedPromptTokens || undefined,
        completionTokens: accumulatedCompletionTokens || undefined,
        totalTokens: accumulatedTotalTokens || undefined,
        costUsd: accumulatedCostUsd,
        modelAttempts: modelAttempts,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'OpenRouter request failed';
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
        promptTokens: accumulatedPromptTokens || undefined,
        completionTokens: accumulatedCompletionTokens || undefined,
        totalTokens: accumulatedTotalTokens || undefined,
        costUsd: accumulatedCostUsd,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private messagesToApi(messages: OpenAIChatMessage[]): Record<string, unknown>[] {
    return messages.map(msg => {
      const result: Record<string, unknown> = { role: msg.role };
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

  private parseError(text: string): { message: string; type?: string; code?: string | number } {
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) {
        return {
          message: typeof parsed.error === 'string' ? parsed.error : parsed.error.message,
          type: parsed.error.type,
          code: parsed.error.code,
        };
      }
    } catch {
      // not JSON
    }
    return { message: text };
  }

  async health() {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['authorization'] = `Bearer ${this.apiKey}`;
      }
      const response = await fetch(`${this.baseUrl}/models`, { headers });
      return { available: response.ok, details: `GET /models -> ${response.status}` };
    } catch (error) {
      return { available: false, details: error instanceof Error ? error.message : 'unavailable' };
    }
  }

  capabilities() {
    return ['coding', 'planning', 'routing', 'tool-calling', 'openrouter'];
  }

  metadata() {
    return { baseUrl: this.baseUrl, model: this.model, provider: 'openrouter' };
  }
}
