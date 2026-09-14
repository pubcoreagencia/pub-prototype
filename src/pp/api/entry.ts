import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { Pool } from 'pg';
import { PostgresPpTaskRepository } from '../persistence/task-repository.js';
import type { PpTaskRepository } from '../domain/domain.js';
import { PostgresPrototypeRepository } from '../persistence/repository.js';
import { PrototypeEventStream, PostgresPrototypeEventBridge } from '../events/events.js';
import { PrototypeSseBroker } from '../events/sse.js';
import { prototypeUiHtml } from '../ui/ui.js';
import { prototypeHistoryUiScript } from '../ui/history-ui.js';
import { PrototypeComparisonPreviewManager } from '../preview/comparison-preview.js';
import { LocalPreviewRuntime } from '../preview/local-preview-runtime.js';
import { PublicPreviewRuntime } from '../preview/public-preview-runtime.js';
import { PrototypeHandoffService, type PrototypeHandoffInput, type PdlTaskIngestionPort } from '../handoff/handoff.js';
import { HttpPdlTaskIngestionPort, FailClosedPdlTaskIngestionPort } from '../handoff/http-client.js';

export const createPpApp = (
  pool?: Pool,
  tasks?: PpTaskRepository,
  prototypes?: PostgresPrototypeRepository,
  pdlHandoff?: PdlTaskIngestionPort,
) => {
  const activePool = pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  const taskRepo = tasks ?? new PostgresPpTaskRepository(activePool);
  const protoRepo = prototypes ?? new PostgresPrototypeRepository(activePool);

  const prototypeEvents = new PrototypeEventStream();
  const prototypeEventBridge = new PostgresPrototypeEventBridge(activePool, prototypeEvents);
  const prototypeSse = new PrototypeSseBroker();
  prototypeEvents.subscribe(event => prototypeSse.publish(event));
  void prototypeEventBridge.start().catch(error => console.error('[PP API] Event bridge error:', error));

  const defaultPrototypeRepository = process.env.PROTOTYPE_TEMPLATE_REPOSITORY ?? 'https://github.com/pubcoreagencia/pub-dev-loop-template.git';
  const prototypeWorkspaceRoot = process.env.PROTOTYPE_WORKSPACES_ROOT ?? '/tmp/pub-prototype';
  const comparisonRuntime = (process.env.PROTOTYPE_PREVIEW_MODE ?? 'public') === 'local'
    ? new LocalPreviewRuntime()
    : new PublicPreviewRuntime();
  const comparisonPreviews = new PrototypeComparisonPreviewManager(comparisonRuntime);
  const previewCommand = process.env.PROTOTYPE_PREVIEW_COMMAND ?? 'npm';
  const previewArgs = (process.env.PROTOTYPE_PREVIEW_ARGS ?? 'run dev -- --host 0.0.0.0 --port {PORT}')
    .split(' ')
    .filter(Boolean);
  const previewPublicBaseUrl = process.env.PROTOTYPE_PREVIEW_BASE_URL || undefined;

  const repoPath = (sessionId: string) => path.join(prototypeWorkspaceRoot, sessionId);
  function gitDiff(cwd: string, base: string, head: string): string {
    return execFileSync('git', ['diff', '--no-ext-diff', '--unified=3', base, head], { cwd, encoding: 'utf8', maxBuffer: 250_000 }).slice(0, 200_000);
  }

  const app = express();
  app.set('trust proxy', 1);
  
  // Structured JSON access logging middleware
  app.use((req, res, next) => {
    const requestId = crypto.randomUUID();
    req.headers['x-request-id'] = requestId;
    const start = Date.now();
    res.on('finish', () => {
      // Do not log /health or /ready to avoid log spam, unless desired.
      // But requirement says "all unexpected errors... and access logging". We'll log everything for now or maybe skip health? We'll log everything.
      if (req.path !== '/health' && req.path !== '/ready') {
        console.log(JSON.stringify({
          timestamp: new Date().toISOString(),
          request_id: requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          duration_ms: Date.now() - start
        }));
      }
    });
    next();
  });

  app.use(express.json());

  // API Rate Limiting for sensitive endpoints
  const sessionRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: { error: 'Too many requests, please try again later.' },
    standardHeaders: true,
    legacyHeaders: false,
  });

  const defaultHandoffPort: PdlTaskIngestionPort = process.env.PDL_API_URL
    ? new HttpPdlTaskIngestionPort(process.env.PDL_API_URL)
    : new FailClosedPdlTaskIngestionPort();

  const handoffPort: PdlTaskIngestionPort = pdlHandoff ?? defaultHandoffPort;
  const handoff = new PrototypeHandoffService(handoffPort, protoRepo, prototypeEvents);

  // Healthcheck dedicado do PP (Liveness)
  app.get('/health', (_req, res) => res.json({
    status: 'ok',
    service: 'pp-api',
    name: 'PP API',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));

  // Readiness dedicado do PP (Database connectivity + Handoff readiness)
  app.get('/ready', async (_req, res) => {
    try {
      await activePool.query('SELECT 1');
      return res.json({
        status: 'ready',
        service: 'pp-api',
        name: 'PP API',
        database: 'connected',
        handoffConfigured: Boolean(process.env.PDL_API_URL),
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
      });
    } catch (err: any) {
      return res.status(503).json({
        status: 'not_ready',
        service: 'pp-api',
        name: 'PP API',
        database: 'disconnected',
        error: err.message,
      });
    }
  });

  // UI do Prototype
  app.get(['/prototype', '/prototype/sessions/:id/view'], (_req, res) => {
    res.status(200).type('html').send(prototypeUiHtml() + prototypeHistoryUiScript());
  });

  // POST /prototype/sessions
  app.post('/prototype/sessions', sessionRateLimiter, async (req, res, next) => {
    try {
      const { project, repository, branch } = req.body ?? {};
      if (!project) return res.status(400).json({ error: 'project is required' });
      const session = await protoRepo.createSession({
        project,
        repository: repository || defaultPrototypeRepository,
        branch,
      });
      prototypeEvents.emit({ sessionId: session.id, type: 'PREVIEW_STARTED', payload: { phase: 'session_created', repository: session.repository } });
      return res.status(201).json(session);
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions
  app.get('/prototype/sessions', async (_req, res, next) => {
    try {
      return res.json(await protoRepo.listSessions());
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id
  app.get('/prototype/sessions/:id', async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(req.params.id);
      if (!session) return res.sendStatus(404);
      const sessionTasks = await taskRepo.list(session.id);
      return res.json({ session, checkpoints: await protoRepo.listCheckpoints(session.id), tasks: sessionTasks });
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id/events (SSE)
  app.get('/prototype/sessions/:id/events', async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(req.params.id);
      if (!session) return res.sendStatus(404);
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();
      const unsubscribe = prototypeSse.subscribe(session.id, res);
      const heartbeat = setInterval(() => prototypeSse.heartbeat(session.id), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      res.write(': connected\n\n');
    } catch (e) {
      return next(e);
    }
  });

  // PATCH /prototype/sessions/:id
  app.patch('/prototype/sessions/:id', async (req, res, next) => {
    try {
      const allowed = ['status', 'mode', 'previewUrl', 'previewRuntime', 'workspacePath', 'lastCheckpointSha'] as const;
      const patch = Object.fromEntries(allowed.filter(k => req.body?.[k] !== undefined).map(k => [k, req.body[k]]));
      const session = await protoRepo.updateSession(req.params.id, patch);
      if (!session) return res.sendStatus(404);
      const eventType = patch.status === 'READY' ? 'PREVIEW_READY' : patch.status === 'FAILED' ? 'ERROR' : null;
      if (eventType) prototypeEvents.emit({ sessionId: session.id, type: eventType, payload: { status: session.status, previewUrl: session.previewUrl } });
      return res.json(session);
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/prompts
  app.post('/prototype/sessions/:id/prompts', sessionRateLimiter, async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(String(req.params.id));
      if (!session) return res.sendStatus(404);
      const { objective = 'Prototype MVP iteration', prompt, priority } = req.body ?? {};
      if (!prompt) return res.status(400).json({ error: 'prompt is required' });
      if (['BUILDING', 'PREVIEWING'].includes(session.status)) return res.status(409).json({ error: 'Prototype session is already processing a prompt' });
      const updated = await protoRepo.incrementPromptCount(session.id);
      if (!updated) return res.sendStatus(409);
      prototypeEvents.emit({ sessionId: updated.id, type: 'USER_PROMPT', payload: { prompt, promptIndex: updated.promptCount, objective } });
      const task = await taskRepo.create({
        project: updated.project,
        repository: updated.repository,
        objective,
        prompt,
        priority: priority ?? 0,
        prototypeSessionId: updated.id,
      });
      await taskRepo.update(task.id, { branch: updated.branch, workspacePath: path.join(prototypeWorkspaceRoot, updated.id) });
      prototypeEvents.emit({ sessionId: updated.id, type: 'AGENT_STARTED', payload: { taskId: task.id } });
      return res.status(202).json({ session: updated, task, mode: 'PROTOTYPE' });
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id/diff
  app.get('/prototype/sessions/:id/diff', async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(req.params.id);
      if (!session) return res.sendStatus(404);
      const checkpoints = await protoRepo.listCheckpoints(session.id);
      const fromId = String(req.query.from ?? '');
      const toId = String(req.query.to ?? '');
      const from = fromId ? checkpoints.find(c => c.id === fromId) : null;
      const to = toId ? checkpoints.find(c => c.id === toId) : null;
      if (!from || !to || !from.commitSha || !to.commitSha) return res.status(400).json({ error: 'from and to must reference checkpoints with commits from this session' });
      const workspace = session.workspacePath || repoPath(session.id);
      const diff = gitDiff(workspace, from.commitSha, to.commitSha);
      return res.json({ from, to, diff, truncated: diff.length >= 200000 });
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/comparison-previews
  app.post('/prototype/sessions/:id/comparison-previews', async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(req.params.id);
      if (!session) return res.sendStatus(404);
      const checkpointId = String(req.body?.checkpointId ?? '');
      const checkpoint = (await protoRepo.listCheckpoints(session.id)).find(c => c.id === checkpointId);
      if (!checkpoint || !checkpoint.commitSha) return res.status(400).json({ error: 'checkpointId must reference a committed checkpoint from this session' });
      if (!session.workspacePath) return res.status(409).json({ error: 'Prototype workspace is not available' });
      const comparison = await comparisonPreviews.create({
        sessionId: session.id,
        checkpointId: checkpoint.id,
        repositoryWorkspace: session.workspacePath,
        commitSha: checkpoint.commitSha,
        command: previewCommand,
        args: previewArgs,
        publicBaseUrl: previewPublicBaseUrl,
      });
      prototypeEvents.emit({ sessionId: session.id, type: 'PREVIEW_READY', payload: { kind: 'comparison', checkpointId: checkpoint.id, url: comparison.info.url, runtimeId: comparison.runtimeId, comparisonId: comparison.id } });
      return res.status(201).json(comparison);
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id/comparison-previews/:previewId
  app.get('/prototype/sessions/:id/comparison-previews/:previewId', async (req, res, next) => {
    try {
      const comparison = await comparisonPreviews.get(req.params.previewId);
      if (!comparison || comparison.sessionId !== req.params.id) return res.sendStatus(404);
      return res.json(comparison);
    } catch (e) {
      return next(e);
    }
  });

  // DELETE /prototype/sessions/:id/comparison-previews/:previewId
  app.delete('/prototype/sessions/:id/comparison-previews/:previewId', async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(req.params.id);
      if (!session) return res.sendStatus(404);
      const comparison = await comparisonPreviews.get(req.params.previewId);
      if (!comparison || comparison.sessionId !== session.id) return res.sendStatus(404);
      await comparisonPreviews.destroy(comparison.id, session.workspacePath ?? repoPath(session.id));
      return res.sendStatus(204);
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/checkpoints
  app.post('/prototype/sessions/:id/checkpoints', async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(req.params.id);
      if (!session) return res.sendStatus(404);
      const { promptIndex, prompt, commitSha, previewUrl, buildPassed } = req.body ?? {};
      if (!Number.isInteger(promptIndex) || promptIndex < 1 || typeof prompt !== 'string') return res.status(400).json({ error: 'promptIndex and prompt are required' });
      const checkpoint = await protoRepo.createCheckpoint({ sessionId: session.id, promptIndex, prompt, commitSha: commitSha ?? null, previewUrl: previewUrl ?? null, buildPassed: buildPassed === true });
      const updated = await protoRepo.updateSession(session.id, { lastCheckpointSha: checkpoint.commitSha, previewUrl: checkpoint.previewUrl, status: checkpoint.buildPassed ? 'READY' : 'FAILED' });
      prototypeEvents.emit({ sessionId: session.id, type: 'CHECKPOINT_CREATED', payload: checkpoint as unknown as Record<string, unknown> });
      if (updated) prototypeEvents.emit({ sessionId: session.id, type: checkpoint.buildPassed ? 'PREVIEW_READY' : 'PREVIEW_FAILED', payload: { previewUrl: updated.previewUrl, buildPassed: checkpoint.buildPassed } });
      return res.status(201).json(checkpoint);
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/promote
  app.post('/prototype/sessions/:id/promote', async (req, res, next) => {
    try {
      const input: PrototypeHandoffInput = {
        sessionId: req.params.id,
        objective: req.body?.objective,
        prompt: req.body?.prompt,
        priority: req.body?.priority,
      };

      const result = await handoff.execute(input);
      return res.status(200).json({
        session: result.session,
        promotion: result.promotion,
        task: result.task,
        mode: result.mode,
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.startsWith('NOT_FOUND:')) return res.sendStatus(404);
      if (message.startsWith('CONFLICT:')) return res.status(409).json({ error: message.replace(/^CONFLICT:\s*/, '') });
      if (message.startsWith('PDL_HANDOFF_') || (e as any)?.status) {
        const status = (e as any).status ?? 502;
        const code = (e as any).status === 503
          ? 'PDL_HANDOFF_NOT_CONFIGURED'
          : (message.includes('TIMEOUT') ? 'PDL_HANDOFF_TIMEOUT' : 'PDL_HANDOFF_FAILED');
        return res.status(status >= 400 && status < 600 ? status : 502).json({
          error: message,
          code,
        });
      }
      return next(e);
    }
  });

  // Global structured JSON error handler
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    // If headers are already sent, delegate to default error handler
    if (res.headersSent) {
      return next(err);
    }
    const status = err.status || err.statusCode || 500;
    const message = status >= 500 ? 'Internal server error' : err.message;
    const requestId = req.headers['x-request-id'] || 'unknown';
    if (status >= 500) {
      console.error(JSON.stringify({
        timestamp: new Date().toISOString(),
        request_id: requestId,
        level: 'error',
        message: err.message,
        stack: err.stack,
      }));
    }
    res.status(status).json({ error: message, requestId });
  });

  return app;
};

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = Boolean(entryFile && currentFile === entryFile) ||
  process.argv[1]?.endsWith('entry.ts') ||
  process.argv[1]?.endsWith('entry.js') ||
  process.argv[1]?.endsWith('pp-api-entry.ts') ||
  process.argv[1]?.endsWith('pp-api-entry.js') ||
  process.env.RUN_PP_API === 'true';

if (isDirectRun) {
  const port = Number(process.env.PP_API_PORT ?? process.env.PORT ?? 3001);
  const dbUrl = process.env.DATABASE_URL;
  const pool = dbUrl ? new Pool({ connectionString: dbUrl }) : undefined;
  const app = createPpApp(pool);
  app.listen(port, '0.0.0.0', () => {
    console.log(`[PP API] Dedicated server listening on 0.0.0.0:${port}`);
  });
}
