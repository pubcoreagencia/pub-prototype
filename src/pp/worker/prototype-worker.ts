import { execFileSync } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PrototypeTask, PpTaskRepository, CheckpointFile } from '../domain/domain.js';
import { TaskFinalizer, captureWorkspaceSnapshot } from '../../finalizer.js';
import type { AgentProvider, ProviderTaskInput, ProviderTaskResult } from '../../providers/types.js';
import { PREVIEW_SYSTEM_INSTRUCTIONS } from './prompts.js';
import type { PrototypeEventPublisher } from '../events/events.js';
import { PostgresPrototypeRepository } from '../persistence/repository.js';
import { LocalPreviewRuntime } from '../preview/local-preview-runtime.js';
import { PublicPreviewRuntime } from '../preview/public-preview-runtime.js';
import type { PreviewRuntime, PreviewRuntimeInfo } from '../preview/preview-runtime.js';
import { StreamEventSink } from '../../providers/streaming/index.js';
import { OperationalEventBridge } from '../events/bridge.js';
import { loadOpenRouterConfig } from '../../providers/openrouterConfig.js';
import { CorrectionController } from './correction-controller.js';

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.next', '.cache', 'dist', 'build']);

function getContentTypeForFile(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case '.html':
    case '.htm':
      return 'text/html; charset=utf-8';
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'application/javascript; charset=utf-8';
    case '.ts':
    case '.tsx':
      return 'application/typescript; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.ico':
      return 'image/x-icon';
    case '.md':
      return 'text/markdown; charset=utf-8';
    default:
      return 'text/plain; charset=utf-8';
  }
}

async function extractWorkspaceFiles(
  workspaceDir: string,
  checkpointId: string,
  sessionId: string
): Promise<CheckpointFile[]> {
  const { readdir, readFile, stat } = await import('node:fs/promises');
  const results: CheckpointFile[] = [];

  async function walk(currentDir: string) {
    let entries: string[] = [];
    try {
      entries = await readdir(currentDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry) || entry.startsWith('.')) continue;
      const fullPath = path.join(currentDir, entry);
      try {
        const fileStat = await stat(fullPath);
        if (fileStat.isDirectory()) {
          await walk(fullPath);
        } else if (fileStat.isFile()) {
          if (fileStat.size > 2 * 1024 * 1024) continue; // Skip files > 2MB
          const relPath = path.relative(workspaceDir, fullPath).replace(/\\/g, '/');
          const content = await readFile(fullPath, 'utf8');
          results.push({
            checkpointId,
            sessionId,
            path: relPath,
            content,
            contentType: getContentTypeForFile(relPath),
            sizeBytes: fileStat.size,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  await walk(workspaceDir);
  return results;
}



const LEASE_TIMEOUT_MS = Number(process.env.WORKER_LEASE_TIMEOUT_MS ?? 30000);
const WORKSPACE_ROOT = process.env.PROTOTYPE_WORKSPACES_ROOT ?? '/tmp/pub-prototype';
const PREVIEW_PUBLIC_BASE_URL = process.env.PROTOTYPE_PREVIEW_BASE_URL || undefined;
const PREVIEW_COMMAND = process.env.PROTOTYPE_PREVIEW_COMMAND ?? 'npm';
const PREVIEW_ARGS = (process.env.PROTOTYPE_PREVIEW_ARGS ?? 'run dev -- --host 0.0.0.0 --port {PORT}')
  .split(' ')
  .filter(Boolean);
const PREVIEW_MODE = process.env.PROTOTYPE_PREVIEW_MODE ?? 'public';
const RESTORE_OBJECTIVE = '__PP_RESTORE_CHECKPOINT__';

const DEFAULT_IDLE_TIMEOUT_MS = 120 * 1000; // 120 seconds
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes

const IDLE_TIMEOUT_MS = Number(
  process.env.PROTOTYPE_IDLE_TIMEOUT_MS ??
  process.env.PP_IDLE_TIMEOUT_MS ??
  DEFAULT_IDLE_TIMEOUT_MS
);

const ABSOLUTE_TIMEOUT_MS = Number(
  process.env.PROTOTYPE_ABSOLUTE_TIMEOUT_MS ??
  process.env.PP_ABSOLUTE_TIMEOUT_MS ??
  DEFAULT_ABSOLUTE_TIMEOUT_MS
);

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function workspaceFor(task: PrototypeTask): string {
  if (!task.prototypeSessionId) throw new Error('Prototype task missing prototypeSessionId');
  return task.workspacePath ?? path.join(WORKSPACE_ROOT, task.prototypeSessionId);
}

async function directoryExists(dir: string): Promise<boolean> {
  try { await access(dir); return true; } catch { return false; }
}

function parseRestore(prompt: string): { commitSha: string; checkpointId: string } {
  const value = JSON.parse(prompt) as { commitSha?: string; checkpointId?: string };
  if (!value.commitSha || !value.checkpointId) throw new Error('Invalid restore payload');
  return { commitSha: value.commitSha, checkpointId: value.checkpointId };
}

export interface PrototypeWorkerOptions {
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
}

export class PrototypeWorker {
  private state = 'IDLE';
  private readonly preview: PreviewRuntime;
  private readonly cleanupTimers = new Map<string, NodeJS.Timeout>();
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;

  constructor(
    private readonly tasks: PpTaskRepository,
    private readonly prototypes: PostgresPrototypeRepository,
    private readonly provider: AgentProvider,
    private readonly events: PrototypeEventPublisher,
    private readonly name = 'prototype',
    previewRuntime?: PreviewRuntime,
    options?: PrototypeWorkerOptions,
  ) {
    this.preview = previewRuntime ?? (
      (process.env.PROTOTYPE_PREVIEW_MODE ?? 'public') === 'local'
        ? new LocalPreviewRuntime()
        : new PublicPreviewRuntime()
    );
    this.idleTimeoutMs = options?.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs = options?.absoluteTimeoutMs ?? ABSOLUTE_TIMEOUT_MS;
  }

  status(): string { return this.state; }

  async executeOnce(): Promise<boolean> {
    const task = await this.tasks.claim(this.name);
    if (!task) return false;

    if (this.cleanupTimers.has(task.prototypeSessionId!)) {
      clearTimeout(this.cleanupTimers.get(task.prototypeSessionId!)!);
      this.cleanupTimers.delete(task.prototypeSessionId!);
    }

    const sessionId = task.prototypeSessionId!;
    const workspace = workspaceFor(task);
    const branch = task.branch ?? `prototype/${task.project}/${sessionId}`;
    this.state = 'RUNNING';

    console.log(JSON.stringify({
      event: 'TASK_LEASED',
      taskId: task.id,
      sessionId,
      worker: this.name,
      timestamp: new Date().toISOString(),
    }));

    const heartbeat = setInterval(() => {
      this.tasks.heartbeat(task.id, new Date(Date.now() + LEASE_TIMEOUT_MS)).catch(() => undefined);
    }, Number(process.env.WORKER_HEARTBEAT_MS ?? 10000));
    heartbeat.unref();

    try {
      console.log(JSON.stringify({
        event: 'TASK_EXECUTION_STARTED',
        taskId: task.id,
        sessionId,
        objective: task.objective,
        timestamp: new Date().toISOString(),
      }));

      await this.tasks.update(task.id, { status: 'RUNNING', workspacePath: workspace, branch });
      await this.prototypes.updateSession(sessionId, { status: 'BUILDING', workspacePath: workspace });
      await this.events.emit({ sessionId, type: 'AGENT_STARTED', payload: { taskId: task.id } });

      await mkdir(WORKSPACE_ROOT, { recursive: true });

      // Determine which repository to use.
      // Architecture:
      //   - session.repository = persistent repo (where commits are pushed)
      //   - template = base for the first clone (has package.json, etc.)
      //   - For 1st task: clone template, push to persistent
      //   - For 2nd+ tasks: clone persistent, fetch existing branch
      const { PROTOTYPE_REPOSITORY, getGitHubToken } = await import('../../github-app.js');
      const usePersistentPush =
        process.env.PROTOTYPE_PERSISTENT_PUSH === 'true' &&
        !!getGitHubToken();

      const templateRepo = process.env.PROTOTYPE_TEMPLATE_REPOSITORY
        || 'https://github.com/pubcoreagencia/pub-dev-loop-template.git';

      const persistentUrl = usePersistentPush
        ? `https://x-access-token:${getGitHubToken()}@github.com/${PROTOTYPE_REPOSITORY}.git`
        : null;

      if (!await directoryExists(path.join(workspace, '.git'))) {
        await mkdir(workspace, { recursive: true });
        // For 1st task: clone from TEMPLATE (public, no auth needed).
        // The persistent push will be done by the finalizer using the token.
        // Fallback: if PROTOTYPE_TEMPLATE_REPOSITORY is not set, use task.repository
        // (which may be a local path for tests, or the legacy template URL).
        const templateUrl = process.env.PROTOTYPE_TEMPLATE_REPOSITORY
          || task.repository
          || 'https://github.com/pubcoreagencia/pub-dev-loop-template.git';
        git(['clone', templateUrl, workspace]);
      }

      // If persistent push is enabled, try to fetch the existing branch.
      // If the branch exists remotely, checkout from it (continue from last checkpoint).
      // If not, create a new branch from current HEAD (which is template's main).
      if (usePersistentPush && persistentUrl) {
        // Set up origin to point to the persistent repo
        try {
          execFileSync('git', ['remote', 'remove', 'origin'], {
            cwd: workspace, stdio: 'pipe', timeout: 5000,
          });
        } catch { /* ignore */ }
        execFileSync('git', ['remote', 'add', 'origin', persistentUrl], {
          cwd: workspace, stdio: 'pipe', timeout: 5000,
        });

        try {
          // Try to fetch the specific branch from origin
          git(['fetch', 'origin', branch], workspace);
          try {
            const revParse = execFileSync('git', ['rev-parse', '--verify', `origin/${branch}`], {
              cwd: workspace, encoding: 'utf8', stdio: 'pipe',
            });
            if (revParse.trim()) {
              // Branch exists remotely — continue from there
              git(['checkout', '-B', branch, `origin/${branch}`], workspace);
              console.log(JSON.stringify({
                event: 'PROTOTYPE_BRANCH_RESUMED',
                sessionId,
                branch,
                fromCheckpoint: revParse.trim().slice(0, 8),
                timestamp: new Date().toISOString(),
              }));
            } else {
              git(['checkout', '-B', branch], workspace);
            }
          } catch {
            git(['checkout', '-B', branch], workspace);
          }
        } catch {
          git(['checkout', '-B', branch], workspace);
        }
        // SECURITY: remove the remote (with token) from git config
        try {
          execFileSync('git', ['remote', 'remove', 'origin'], {
            cwd: workspace, stdio: 'pipe', timeout: 5000,
          });
        } catch { /* ignore */ }
      } else {
        git(['checkout', '-B', branch], workspace);
      }

      if (task.objective === RESTORE_OBJECTIVE) {
        return await this.restoreCheckpoint(task, workspace, branch);
      }

      const baseline = captureWorkspaceSnapshot(workspace);
      const started = Date.now();

      const controller = new AbortController();
      let idleTimer: NodeJS.Timeout | null = null;
      let absoluteTimer: NodeJS.Timeout | null = null;
      let executionFinished = false;
      let timeoutReason: 'IDLE' | 'ABSOLUTE' | null = null;

      let resolveTimeout!: (value: ProviderTaskResult) => void;
      const timeoutPromise = new Promise<ProviderTaskResult>((resolve) => {
        resolveTimeout = resolve;
      });

      const cleanupTimers = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (absoluteTimer) {
          clearTimeout(absoluteTimer);
          absoluteTimer = null;
        }
      };

      const handleTimeout = (reason: 'IDLE' | 'ABSOLUTE') => {
        if (executionFinished) return;
        executionFinished = true;
        timeoutReason = reason;
        cleanupTimers();
        controller.abort();

        const durationMs = Date.now() - started;
        const errorMessage = reason === 'IDLE'
          ? `AI Provider execution timed out: idle timeout exceeded (${Math.round(this.idleTimeoutMs / 1000)}s without activity)`
          : `AI Provider execution timed out: absolute timeout exceeded (${Math.round(this.absoluteTimeoutMs / 1000)}s limit)`;

        resolveTimeout({
          status: 'TIMED_OUT',
          provider: this.provider.kind || 'openrouter',
          model: initialModel || (this.provider as any).model || 'default',
          exitCode: null,
          durationMs,
          stdout: '',
          stderr: errorMessage,
          changedFiles: [],
          commit: null,
          errorCode: reason === 'IDLE' ? 'IDLE_TIMEOUT' : 'EXECUTION_TIMEOUT',
          errorMessage,
        });
      };

      const resetIdleTimer = () => {
        if (executionFinished) return;
        if (idleTimer) {
          clearTimeout(idleTimer);
        }
        idleTimer = setTimeout(() => handleTimeout('IDLE'), this.idleTimeoutMs);
      };

      // Start two-tier timers
      resetIdleTimer();
      absoluteTimer = setTimeout(() => handleTimeout('ABSOLUTE'), this.absoluteTimeoutMs);

      const bridge = new OperationalEventBridge(sessionId, this.events);
      const sink = new StreamEventSink(
        {
          onEnvelope: (envelope) => {
            resetIdleTimer();
            bridge.handleEnvelope(envelope).catch(() => undefined);
          },
          onActivity: () => {
            resetIdleTimer();
          },
        },
        { taskId: task.id, attempt: 0 }
      );

      const taskWithInstructions: ProviderTaskInput = {
        ...task,
        systemInstructions: [...PREVIEW_SYSTEM_INSTRUCTIONS],
        routingProfile: 'fast_prototype',
      };

      // Resolve the dynamic model selected by policy for this task (if provider is OpenRouter or DualGateway)
      let initialModel = (this.provider as any).model;
      if (!initialModel || initialModel === 'default' || initialModel === 'openrouter/free') {
        try {
          const cfg = loadOpenRouterConfig(undefined, taskWithInstructions);
          if (cfg?.primaryModel) {
            initialModel = cfg.primaryModel;
          }
        } catch {
          // ignore error and fall back to provider default
        }
      }

      // Emit initial attempt_started lifecycle event
      sink.emitEnvelope('attempt_started', {
        attempt: 0,
        provider: this.provider.kind || 'openrouter',
        model: initialModel || (this.provider as any).model || 'default',
      });

      let result: ProviderTaskResult;
      try {
        result = await Promise.race([
          this.provider.execute(taskWithInstructions, workspace, {
            consumer: sink,
            signal: controller.signal,
          }),
          timeoutPromise,
        ]);
        executionFinished = true;
        cleanupTimers();
      } catch (e: any) {
        executionFinished = true;
        cleanupTimers();
        if (controller.signal.aborted || timeoutReason) {
          const durationMs = Date.now() - started;
          const errorMessage = timeoutReason === 'IDLE'
            ? `AI Provider execution timed out: idle timeout exceeded (${Math.round(this.idleTimeoutMs / 1000)}s without activity)`
            : timeoutReason === 'ABSOLUTE'
              ? `AI Provider execution timed out: absolute timeout exceeded (${Math.round(this.absoluteTimeoutMs / 1000)}s limit)`
              : 'AI Provider execution timed out';
          result = {
            status: 'TIMED_OUT',
            provider: this.provider.kind || 'openrouter',
            model: initialModel || (this.provider as any).model || 'default',
            exitCode: null,
            durationMs,
            stdout: '',
            stderr: errorMessage,
            changedFiles: [],
            commit: null,
            errorCode: timeoutReason === 'IDLE' ? 'IDLE_TIMEOUT' : 'EXECUTION_TIMEOUT',
            errorMessage,
          };
        } else {
          throw e;
        }
      } finally {
        executionFinished = true;
        cleanupTimers();
      }

      if (controller.signal.aborted || timeoutReason) {
        const durationMs = Date.now() - started;
        const errorMessage = timeoutReason === 'IDLE'
          ? `AI Provider execution timed out: idle timeout exceeded (${Math.round(this.idleTimeoutMs / 1000)}s without activity)`
          : timeoutReason === 'ABSOLUTE'
            ? `AI Provider execution timed out: absolute timeout exceeded (${Math.round(this.absoluteTimeoutMs / 1000)}s limit)`
            : (result?.errorMessage ?? 'AI Provider execution timed out');
        result = {
          status: 'TIMED_OUT',
          provider: this.provider.kind || 'openrouter',
          model: initialModel || (this.provider as any).model || 'default',
          exitCode: null,
          durationMs,
          stdout: result?.stdout ?? '',
          stderr: errorMessage,
          changedFiles: [],
          commit: null,
          errorCode: timeoutReason === 'IDLE' ? 'IDLE_TIMEOUT' : 'EXECUTION_TIMEOUT',
          errorMessage,
        };
      }

      // If provider completed, emit attempt_completed before closing bridge
      if (result.status === 'COMPLETED') {
        sink.emitEnvelope('attempt_completed', {
          attempt: 0,
          status: result.status,
          durationMs: result.durationMs,
        });
      } else {
        sink.emitEnvelope('attempt_failed', {
          attempt: 0,
          error: result.errorMessage ?? result.stderr ?? 'Prototype agent failed',
          retryable: false,
        });
      }
      await bridge.close();



      // Check for cancellation during provider execution
      try {
        const currentTask = await (this.tasks as any).get?.(task.id);
        if (currentTask?.status === 'CANCELLED') {
          await this.tasks.update(task.id, { status: 'CANCELLED', workspacePath: workspace, leaseOwner: null, leaseDeadline: null });
          await this.prototypes.updateSession(sessionId, { status: 'READY', workspacePath: workspace });
          await this.events.emit({ sessionId, type: 'ERROR', payload: { message: 'Task cancelled by user', taskId: task.id } });
          console.log(JSON.stringify({ event: 'TASK_CANCELLED', taskId: task.id, sessionId, timestamp: new Date().toISOString() }));
          return true;
        }
      } catch {
        // get() may not be available on mock repos — cancellation check is best-effort
      }
      const durationMs = Date.now() - started;

      console.log(JSON.stringify({
        event: 'TASK_EXECUTION_COMPLETED',
        taskId: task.id,
        sessionId,
        status: result.status,
        provider: result.provider,
        model: result.model,
        changedFilesCount: result.changedFiles?.length ?? 0,
        toolCalls: result.toolCalls ?? 0,
        durationMs,
        timestamp: new Date().toISOString(),
      }));

      const isToolLoopWithChanges = result.status === 'TOOL_LOOP_LIMIT' && (result.changedFiles?.length ?? 0) > 0;

      if (result.status !== 'COMPLETED' && !isToolLoopWithChanges) {
        const message = result.errorMessage ?? result.stderr ?? 'Prototype agent failed';
        await this.tasks.update(task.id, { status: 'FAILED', error: message.slice(0, 4000), workspacePath: workspace,
          result: { provider: result.provider, model: result.model, stdout: result.stdout, stderr: result.stderr, durationMs },
          leaseOwner: null, leaseDeadline: null });

        const session = await this.prototypes.getSession(sessionId);
        const hasPriorFunctionalState = Boolean(session?.lastCheckpointSha || session?.previewUrl);
        await this.prototypes.updateSession(sessionId, {
          status: hasPriorFunctionalState ? 'READY' : 'FAILED',
          workspacePath: workspace,
        });
        await this.events.emit({ sessionId, type: 'ERROR', payload: { message, taskId: task.id } });
        return true;
      }

      await this.events.emit({ sessionId, type: 'AGENT_OUTPUT', payload: { summary: result.stdout.slice(-8000), changedFiles: result.changedFiles ?? [], taskId: task.id } });
      const finalizer = new TaskFinalizer(workspace, { commandTimeoutMs: Number(process.env.ROUTER_COMMAND_TIMEOUT_MS ?? 60000) });

      // Check for cancellation before finalizer
      try {
        const currentTask = await (this.tasks as any).get?.(task.id);
        if (currentTask?.status === 'CANCELLED') {
          await this.prototypes.updateSession(sessionId, { status: 'READY', workspacePath: workspace });
          await this.events.emit({ sessionId, type: 'ERROR', payload: { message: 'Task cancelled by user', taskId: task.id } });
          console.log(JSON.stringify({ event: 'TASK_CANCELLED', taskId: task.id, sessionId, timestamp: new Date().toISOString() }));
          return true;
        }
      } catch {
        // get() may not be available on mock repos — cancellation check is best-effort
      }

      await this.events.emit({ sessionId, type: 'BUILD_STARTED', payload: { taskId: task.id, phase: 'finalize' } });
      const finalize = await finalizer.finalize(task.objective, task.prompt, {
        testCommand: process.env.TASK_TEST_COMMAND || null,
        commitMessage: `prototype(${task.project}): prompt ${task.id}`,
        expectChanges: false,
        allowUnexpectedFiles: false,
        baselineSnapshot: baseline,
        declaredChangedFiles: result.changedFiles ?? [],
      });

      // If finalization failed, attempt in-process correction before marking the task as failed
      if (finalize.status !== 'COMPLETED') {
        const controller = new CorrectionController(this.provider, this.events);
        const decision = await controller.runCorrectionLoop(
          task,
          workspace,
          baseline,
          result,
          {
            status: finalize.status,
            errorCode: finalize.errorCode,
            errorMessage: finalize.errorMessage,
            testOutput: finalize.testOutput ?? '',
            gitStatus: finalize.gitStatus,
            changedFiles: finalize.changedFiles ?? [],
          },
        );
        if (decision !== 'SUCCESS') {
          const session = await this.prototypes.getSession(sessionId);
          const hasPriorFunctionalState = Boolean(session?.lastCheckpointSha || session?.previewUrl);
          const finalError = finalize.errorMessage ?? (result.status === 'TOOL_LOOP_LIMIT' ? 'Tool loop limit reached and finalization failed' : 'Prototype finalization failed');

          // Escalation – treat as a regular failure
          await this.tasks.update(task.id, {
            status: 'FAILED',
            branch,
            workspacePath: workspace,
            gitStatus: finalize.gitStatus,
            error: finalError,
            result: { finalize, provider: result.provider, model: result.model, durationMs },
            leaseOwner: null,
            leaseDeadline: null,
          });
          await this.prototypes.updateSession(sessionId, {
            status: hasPriorFunctionalState ? 'READY' : 'FAILED',
            workspacePath: workspace,
          });
          await this.events.emit({
            sessionId,
            type: 'BUILD_FAILED',
            payload: { message: finalize.errorMessage ?? 'Finalization failed' },
          });
          return true;
        }
        // decision === 'SUCCESS': fall through to the success path below
      }


      console.log(JSON.stringify({
        event: 'TASK_FINALIZED',
        taskId: task.id,
        sessionId,
        commitSha: finalize.commitSha,
        status: finalize.status,
        timestamp: new Date().toISOString(),
      }));

      await this.tasks.update(task.id, { status: 'COMPLETED', branch, commitSha: finalize.commitSha, gitStatus: finalize.gitStatus,
        workspacePath: workspace, leaseOwner: null, leaseDeadline: null,
        result: { finalize, provider: result.provider, model: result.model, durationMs } });
      await this.events.emit({ sessionId, type: 'BUILD_PASSED', payload: { commitSha: finalize.commitSha, taskId: task.id } });

      // If changedFiles is empty on an iterative prompt (e.g. agent answered question or workspace was already updated),
      // we ensure the existing prototype files are served and preview is refreshed without failing the session.
      const preview = await this.ensurePreview(sessionId, workspace);
      const nativePreviewUrl = `/prototype/sessions/${sessionId}/preview/`;
      const resolvedPreviewUrl = preview.url || nativePreviewUrl;
      const publicUrl = preview.url || null;
      await this.prototypes.updateSession(sessionId, {
        status: 'READY',
        workspacePath: workspace,
        previewRuntime: preview.id,
        previewUrl: resolvedPreviewUrl,
        lastCheckpointSha: finalize.commitSha,
      });

      // Save assistant message to the chat history linked to the task_id
      try {
        if (typeof this.prototypes.addMessage === 'function') {
          const defaultMsg = result.status === 'TOOL_LOOP_LIMIT'
            ? 'Protótipo atualizado (limite de rodadas de ferramentas atingido).'
            : 'Protótipo atualizado com sucesso.';
          const content = result.stdout
            ? (result.status === 'TOOL_LOOP_LIMIT' && !result.stdout.includes('limite')
                ? `${result.stdout}\n\n*(Aviso: Limite de rodadas de ferramentas atingido)*`
                : result.stdout)
            : defaultMsg;
          await this.prototypes.addMessage({
            id: randomUUID(),
            sessionId,
            role: 'assistant',
            content,
            taskId: task.id,
            order: 0,
            createdAt: new Date(),
          });
        }
      } catch (msgErr) {
        console.error('[Prototype Worker] Failed to persist assistant message:', (msgErr as Error).message);
      }

      const session = await this.prototypes.getSession(sessionId);
      const checkpoint = await this.prototypes.createCheckpoint({
        sessionId,
        promptIndex: session?.promptCount ?? 1,
        prompt: task.prompt,
        commitSha: finalize.commitSha,
        previewUrl: resolvedPreviewUrl,
        buildPassed: true,
      });

      try {
        if (typeof this.prototypes.saveCheckpointFiles === 'function') {
          const files = await extractWorkspaceFiles(workspace, checkpoint.id, sessionId);
          if (files.length > 0) {
            await this.prototypes.saveCheckpointFiles(files);
            console.log(`[Prototype Worker] Stored ${files.length} checkpoint files for session ${sessionId}, cp ${checkpoint.id}`);
          }
        }
      } catch (fErr: any) {
        console.warn('[Prototype Worker] Failed to extract checkpoint files:', fErr.message);
      }

      console.log(JSON.stringify({
        event: 'CHECKPOINT_CREATED',
        checkpointId: checkpoint.id,
        sessionId,
        commitSha: checkpoint.commitSha,
        timestamp: new Date().toISOString(),
      }));

      await this.tasks.update(task.id, { status: 'COMPLETED' });
      task.status = 'COMPLETED'; // Update local object for finally block
      await this.events.emit({ sessionId, type: 'CHECKPOINT_CREATED', payload: checkpoint as unknown as Record<string, unknown> });
      await this.events.emit({
        sessionId,
        type: 'PREVIEW_READY',
        payload: {
          sessionId,
          url: resolvedPreviewUrl,
          publicUrl,
          runtimeId: preview.id,
          port: preview.port,
        },
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.tasks.update(task.id, { status: 'FAILED', error: message.slice(0, 4000), workspacePath: workspace, leaseOwner: null, leaseDeadline: null });
      task.status = 'FAILED'; // Update local object for finally block

      const session = await this.prototypes.getSession(sessionId);
      const hasPriorFunctionalState = Boolean(session?.lastCheckpointSha || session?.previewUrl);
      await this.prototypes.updateSession(sessionId, {
        status: hasPriorFunctionalState ? 'READY' : 'FAILED',
        workspacePath: workspace,
      });
      await this.events.emit({ sessionId, type: 'ERROR', payload: { message, taskId: task.id } });
      return true;
    } finally {
      this.scheduleCleanup(sessionId, workspace, task.status);
      clearInterval(heartbeat);
      this.state = 'IDLE';
    }
  }

  private async scheduleCleanup(sessionId: string, workspace: string, taskStatus: string) {
    // If the task was completed successfully, its status in the DB is 'COMPLETED', but the `task` object
    // might have the old status. The caller should pass the *final* status.
    const isSuccess = taskStatus === 'COMPLETED';
    let hasPriorFunctionalState = false;
    try {
      const session = await this.prototypes.getSession(sessionId);
      hasPriorFunctionalState = Boolean(session?.lastCheckpointSha || session?.previewUrl);
    } catch {
      // Ignore repository lookup error
    }

    // Preserve preview if the task completed successfully OR if there is a prior working checkpoint/preview.
    // Only destroy immediately (delay 0) if there is NO working state to preserve.
    const delayMs = (isSuccess || hasPriorFunctionalState) ? 15 * 60 * 1000 : 0;

    const timer = setTimeout(async () => {
      try {
        if (this.cleanupTimers.get(sessionId) !== timer) return;

        const session = await this.prototypes.getSession(sessionId);
        if (session && ['BUILDING', 'PREVIEWING'].includes(session.status)) {
          return;
        }

        if (session?.previewRuntime) {
          await this.preview.destroy(session.previewRuntime);
        }
        const { rm } = await import('node:fs/promises');
        await rm(workspace, { recursive: true, force: true });
      } catch (e) {
        console.error('[PP Worker] Cleanup failed:', e);
      } finally {
        if (this.cleanupTimers.get(sessionId) === timer) {
          this.cleanupTimers.delete(sessionId);
        }
      }
    }, delayMs);
    
    this.cleanupTimers.set(sessionId, timer);
  }

  private async restoreCheckpoint(task: PrototypeTask, workspace: string, branch: string): Promise<boolean> {
    const sessionId = task.prototypeSessionId!;
    const { commitSha, checkpointId } = parseRestore(task.prompt);
    const currentSha = git(['rev-parse', 'HEAD'], workspace).trim();
    if (currentSha === commitSha) {
      await this.tasks.update(task.id, { status: 'COMPLETED', branch, workspacePath: workspace, commitSha: currentSha, leaseOwner: null, leaseDeadline: null });
      await this.prototypes.updateSession(sessionId, { status: 'READY', workspacePath: workspace, lastCheckpointSha: currentSha });
      await this.events.emit({ sessionId, type: 'PREVIEW_READY', payload: { sessionId, url: (await this.prototypes.getSession(sessionId))?.previewUrl, restoredFrom: checkpointId, unchanged: true } });
      return true;
    }

    await this.events.emit({ sessionId, type: 'BUILD_STARTED', payload: { phase: 'restore', checkpointId, targetSha: commitSha } });
    git(['read-tree', '-m', '-u', commitSha], workspace);
    git(['add', '-A'], workspace);
    const commitMessage = `prototype(${task.project}): restore checkpoint ${checkpointId}`;
    git(['commit', '--allow-empty', '-m', commitMessage], workspace);
    const restoredSha = git(['rev-parse', 'HEAD'], workspace).trim();

    const preview = await this.ensurePreview(sessionId, workspace);
    await this.prototypes.updateSession(sessionId, {
      status: 'READY', workspacePath: workspace, previewRuntime: preview.id,
      previewUrl: preview.url, lastCheckpointSha: restoredSha,
    });
    await this.tasks.update(task.id, {
      status: 'COMPLETED', branch, workspacePath: workspace, commitSha: restoredSha,
      leaseOwner: null, leaseDeadline: null, result: { restoredFrom: checkpointId, targetSha: commitSha, restoredSha },
    });

    const session = await this.prototypes.getSession(sessionId);
    const checkpoint = await this.prototypes.createCheckpoint({
      sessionId,
      promptIndex: session?.promptCount ?? 1,
      prompt: `Restore checkpoint ${checkpointId}`,
      commitSha: restoredSha,
      previewUrl: preview.url,
      buildPassed: true,
    });
    await this.events.emit({ sessionId, type: 'BUILD_PASSED', payload: { commitSha: restoredSha, restoredFrom: checkpointId, targetSha: commitSha } });
    await this.events.emit({ sessionId, type: 'CHECKPOINT_CREATED', payload: checkpoint as unknown as Record<string, unknown> });
    await this.events.emit({ sessionId, type: 'PREVIEW_READY', payload: { sessionId, url: preview.url, runtimeId: preview.id, port: preview.port, restoredFrom: checkpointId } });
    return true;
  }

  private async ensurePreview(sessionId: string, workspace: string): Promise<PreviewRuntimeInfo> {
    const session = await this.prototypes.getSession(sessionId);
    if (session?.previewRuntime) {
      const existing = await this.preview.get(session.previewRuntime);
      if (existing?.status === 'READY') return existing;
    }

    const previewCommand = process.env.PROTOTYPE_PREVIEW_COMMAND ?? PREVIEW_COMMAND;
    const previewArgs = process.env.PROTOTYPE_PREVIEW_ARGS
      ? process.env.PROTOTYPE_PREVIEW_ARGS.split(' ').filter(Boolean)
      : PREVIEW_ARGS;
    const previewMode = process.env.PROTOTYPE_PREVIEW_MODE ?? PREVIEW_MODE;
    const publicBaseUrl = process.env.PROTOTYPE_PREVIEW_BASE_URL || PREVIEW_PUBLIC_BASE_URL;

    await this.events.emit({ sessionId, type: 'PREVIEW_STARTED', payload: { phase: 'runtime_starting', mode: previewMode } });
    const runtime = await this.preview.create({
      workspace,
      command: previewCommand,
      args: previewArgs,
      port: 0,
      publicBaseUrl,
      startupTimeoutMs: Number(process.env.PROTOTYPE_PREVIEW_STARTUP_TIMEOUT_MS ?? 60000),
      environment: { NODE_ENV: 'development' },
    });
    const unsubscribe = this.preview.subscribe(runtime.id, async event => {
          if (event.stream === 'stderr') {
            const isInfoBanner = event.line?.includes('INF ') || event.line?.includes('Thank you for trying Cloudflare Tunnel') || event.line?.includes('Your quick Tunnel has been created');
            if (!isInfoBanner) {
              await this.events.emit({ sessionId, type: 'ERROR', payload: { runtimeId: event.runtimeId, line: event.line } });
            }
          }
          // Emit PREVIEW_LOCAL_SERVER_READY when local server is up
          if (event.line?.includes('local-server:ready')) {
            await this.events.emit({ sessionId, type: 'PREVIEW_LOCAL_SERVER_READY', payload: { runtimeId: event.runtimeId, port: event.line.match(/port=(\\d+)/)?.[1] } });
          }
          // Emit PREVIEW_TUNNEL_READY when tunnel connects
          if (event.line?.includes('tunnel:connected')) {
            await this.events.emit({ sessionId, type: 'PREVIEW_TUNNEL_READY', payload: { runtimeId: event.runtimeId, url: event.line.match(/url=(\\S+)/)?.[1] } });
          }
          // If the tunnel was restarted with a new URL, update the session DB
          // and emit PREVIEW_READY so the UI can reload the iframe.
          const m = event.line.match(/public-preview:restarted url=(\\S+)/);
      if (m) {
        const newUrl = m[1];
        await this.prototypes.updateSession(sessionId, { previewUrl: newUrl });
        await this.events.emit({ sessionId, type: 'PREVIEW_READY', payload: { sessionId, url: newUrl, restoredFrom: 'tunnel-restart' } });
      }
    });
    // Note: we intentionally do NOT unsubscribe here. The tunnel watcher
    // keeps the runtime alive and may emit 'public-preview:restarted' events
    // when the URL changes. The listener persists for the session lifetime.
    void unsubscribe; // suppress unused warning
    return await this.preview.start(runtime.id);
  }
}
