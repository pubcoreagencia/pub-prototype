import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
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
import { PreviewRecoveryService } from '../preview/preview-recovery.js';
import { AuthService } from '../auth/auth.js';
import { VerificationGate } from '../verification/verification-gate.js';
import { createSovereignAuthRouter } from '../auth/http.js';
import { getAuthProvider } from '../auth/factory.js';

export const createPpApp = (
  pool?: Pool,
  tasks?: PpTaskRepository,
  prototypes?: PostgresPrototypeRepository,
  pdlHandoff?: PdlTaskIngestionPort,
) => {
  const activePool = pool ?? new Pool({ connectionString: process.env.DATABASE_URL });
  const taskRepo = tasks ?? new PostgresPpTaskRepository(activePool);
  const protoRepo = prototypes ?? new PostgresPrototypeRepository(activePool);
  const activeAuthProvider = getAuthProvider({ pool: activePool });
  const authService = new AuthService(protoRepo, activeAuthProvider);
  const previewRecovery = new PreviewRecoveryService(protoRepo);
  const verificationGate = new VerificationGate(protoRepo);
  if (typeof protoRepo.initializeSchema === 'function') {
    void protoRepo.initializeSchema().catch(err => console.warn('[PP API] Auto schema init notice:', err.message));
  }

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

  // CORS middleware for authorized origins (https://pubcore.site and local dev)
  const allowedOrigins = new Set([
    'https://pubcore.site',
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
  ]);

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-auth-token, x-request-id');
      res.setHeader('Access-Control-Max-Age', '86400');
    }

    if (req.method === 'OPTIONS') {
      if (origin && allowedOrigins.has(origin)) {
        return res.sendStatus(204);
      }
      return res.sendStatus(403);
    }
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
      const { project, repository, branch, projectId } = req.body ?? {};
      if (!project) return res.status(400).json({ error: 'project is required' });
      const session = await protoRepo.createSession({
        projectId,
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
      const session = await protoRepo.getSession(String(req.params.id));
      if (!session) return res.sendStatus(404);
      const sessionTasks = await taskRepo.list(session.id);
      return res.json({ session, checkpoints: await protoRepo.listCheckpoints(session.id), tasks: sessionTasks });
    } catch (e) {
      return next(e);
    }
  });

  // Native Preview Serving: GET /prototype/sessions/:id/preview and /prototype/sessions/:id/preview/*
  const handlePreviewRequest = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      const sessionId = String(req.params.id);
      const session = await protoRepo.getSession(sessionId);
      if (!session) {
        return res.status(404).send('Session not found');
      }

      let rawPath = (req.params as any).path ?? (req.params as any)[0];
      let reqPath = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || 'index.html');
      if (!reqPath || reqPath === '/' || reqPath.trim() === '') {
        reqPath = 'index.html';
      }
      // Normalize and prevent path traversal
      reqPath = path.posix.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '').replace(/^\/+/, '');
      if (reqPath.startsWith('..') || reqPath.includes('../')) {
        return res.status(400).send('Invalid file path');
      }

      // Security headers for preview iframe embedding
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      res.setHeader('Access-Control-Allow-Origin', '*');

      // State check: FAILED sessions with no checkpoints should NOT show the waiting placeholder
      if (session.status === 'FAILED') {
        if (reqPath === 'index.html') {
          return res.status(200).type('html').send(`
            <!doctype html>
            <html>
              <head>
                <meta charset="utf-8">
                <title>${session.project} — Falha na Geração</title>
                <style>
                  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0e0f12; color: #a1a1aa; display: grid; place-items: center; height: 100vh; margin: 0; }
                  .card { text-align: center; max-width: 440px; padding: 32px; background: #18191f; border-radius: 12px; border: 1px solid #ef444433; }
                  h2 { color: #fafafa; font-size: 18px; margin-top: 0; }
                  p { font-size: 14px; line-height: 1.5; color: #71717a; }
                  .status { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; background: #ef444422; color: #ef4444; font-weight: 600; margin-bottom: 12px; border: 1px solid #ef444444; }
                </style>
              </head>
              <body>
                <div class="card">
                  <div class="status">FALHA NA COMPILAÇÃO</div>
                  <h2>${session.project}</h2>
                  <p>A tarefa de geração do protótipo falhou antes de produzir um preview funcional. Envie uma nova instrução pelo chat para reiniciar.</p>
                </div>
              </body>
            </html>
          `);
        }
        return res.status(404).send(`File ${reqPath} not available on failed session`);
      }

      // 1. Try to serve from immutable checkpoint files stored in Postgres
      // Bind to the active promoted checkpoint if available
      let checkpointFile = null;
      if (session.lastCheckpointSha && typeof protoRepo.listCheckpoints === 'function') {
        const checkpoints = await protoRepo.listCheckpoints(sessionId);
        const activeCheckpoint = checkpoints.find(c => c.commitSha === session.lastCheckpointSha);
        if (activeCheckpoint) {
          checkpointFile = await protoRepo.getCheckpointFile(activeCheckpoint.id, reqPath);
        }
      }

      // Fallback to latest session file across checkpoints
      if (!checkpointFile) {
        checkpointFile = await protoRepo.getLatestSessionFile(sessionId, reqPath);
      }

      if (checkpointFile) {
        res.setHeader('Content-Type', checkpointFile.contentType || 'text/html; charset=utf-8');
        return res.send(checkpointFile.content);
      }

      // 2. Fallback to local workspace files if workspace exists on disk (same container / dev)
      if (session.workspacePath) {
        try {
          const { readFile, stat } = await import('node:fs/promises');
          const localFilePath = path.join(session.workspacePath, reqPath);
          const st = await stat(localFilePath);
          if (st.isFile()) {
            const content = await readFile(localFilePath);
            const ext = path.extname(reqPath).toLowerCase();
            let contentType = 'text/plain; charset=utf-8';
            if (ext === '.html' || ext === '.htm') contentType = 'text/html; charset=utf-8';
            else if (ext === '.css') contentType = 'text/css; charset=utf-8';
            else if (ext === '.js' || ext === '.mjs') contentType = 'application/javascript; charset=utf-8';
            else if (ext === '.json') contentType = 'application/json; charset=utf-8';
            else if (ext === '.svg') contentType = 'image/svg+xml';
            else if (ext === '.png') contentType = 'image/png';
            else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
            res.setHeader('Content-Type', contentType);
            return res.send(content);
          }
        } catch {
          // Fall through
        }
      }

      // 3. For index.html, render state-appropriate status page
      if (reqPath === 'index.html') {
        if (session.status === 'READY') {
          return res.status(200).type('html').send(`
            <!doctype html>
            <html>
              <head>
                <meta charset="utf-8">
                <title>${session.project} — Preview Indisponível</title>
                <style>
                  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0e0f12; color: #a1a1aa; display: grid; place-items: center; height: 100vh; margin: 0; }
                  .card { text-align: center; max-width: 440px; padding: 32px; background: #18191f; border-radius: 12px; border: 1px solid #27272a; }
                  h2 { color: #fafafa; font-size: 18px; margin-top: 0; }
                  p { font-size: 14px; line-height: 1.5; color: #71717a; }
                  .status { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; background: #27272a; color: #eab308; font-weight: 600; margin-bottom: 12px; }
                </style>
              </head>
              <body>
                <div class="card">
                  <div class="status">SEM ARQUIVOS DE PREVIEW</div>
                  <h2>${session.project}</h2>
                  <p>A sessão está marcada como pronta, mas os arquivos de visualização não foram localizados para este checkpoint. Tente acionar a recarga do preview.</p>
                </div>
              </body>
            </html>
          `);
        }

        // Status is BUILDING, VERIFYING, CREATING, etc.
        const label = session.status === 'VERIFYING'
          ? 'Executando verificação de integridade (V0..V5)...'
          : 'O protótipo está sendo preparado ou aguarda a conclusão da tarefa de compilação.';

        return res.status(200).type('html').send(`
          <!doctype html>
          <html>
            <head>
              <meta charset="utf-8">
              <title>${session.project} — Preview</title>
              <style>
                body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0e0f12; color: #a1a1aa; display: grid; place-items: center; height: 100vh; margin: 0; }
                .card { text-align: center; max-width: 420px; padding: 32px; background: #18191f; border-radius: 12px; border: 1px solid #27272a; }
                h2 { color: #fafafa; font-size: 18px; margin-top: 0; }
                p { font-size: 14px; line-height: 1.5; }
                .status { display: inline-block; padding: 4px 10px; border-radius: 6px; font-size: 12px; background: #27272a; color: #38bdf8; font-weight: 600; margin-bottom: 12px; }
              </style>
            </head>
            <body>
              <div class="card">
                <div class="status">${session.status}</div>
                <h2>${session.project}</h2>
                <p>${label}</p>
              </div>
            </body>
          </html>
        `);
      }

      return res.status(404).send(`File ${reqPath} not found in session preview`);
    } catch (e) {
      return next(e);
    }
  };

  app.get(['/prototype/sessions/:id/preview', '/prototype/sessions/:id/preview/{*path}'], handlePreviewRequest);

  // POST /prototype/sessions/:id/preview/refresh & /restart
  app.post(['/prototype/sessions/:id/preview/refresh', '/prototype/sessions/:id/preview/restart'], authService.requireSessionRole('MEMBER'), async (req, res, next) => {
    try {
      const sessionId = String(req.params.id);
      const session = await protoRepo.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      // First check if checkpoint files exist for native preview
      const files = await protoRepo.listSessionFiles(sessionId);
      if (files.length > 0) {
        const nativeUrl = `/prototype/sessions/${sessionId}/preview/`;
        // Only update previewUrl if session is already READY and verified
        if (session.status === 'READY') {
          await protoRepo.updateSession(sessionId, { previewUrl: nativeUrl });
          prototypeEvents.emit({
            sessionId,
            type: 'PREVIEW_READY',
            payload: { sessionId, url: nativeUrl, mode: 'native' }
          });
        }
        return res.json({
          ok: true,
          previewUrl: nativeUrl,
          mode: 'native',
          filesCount: files.length,
        });
      }

      // Otherwise attempt runtime recovery
      try {
        const result = await previewRecovery.refresh(sessionId);
        prototypeEvents.emit({
          sessionId,
          type: 'PREVIEW_READY',
          payload: { sessionId, url: result.previewUrl, runtimeId: result.previewRuntime }
        });
        return res.json({ ok: true, previewUrl: result.previewUrl, previewRuntime: result.previewRuntime });
      } catch (recErr: any) {
        console.warn('[PP API] Preview recovery warning:', recErr.message);
        const nativeUrl = `/prototype/sessions/${sessionId}/preview/`;
        return res.json({ ok: true, previewUrl: nativeUrl, fallback: true });
      }
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id/files (List files for inspector)
  app.get('/prototype/sessions/:id/files', authService.requireSessionRole('VIEWER'), async (req, res, next) => {
    try {
      const sessionId = String(req.params.id);
      const session = await protoRepo.getSession(sessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });

      const files = await protoRepo.listSessionFiles(sessionId);
      return res.json({
        sessionId,
        files: files.map(f => ({
          path: f.path,
          contentType: f.contentType,
          sizeBytes: f.sizeBytes,
          checkpointId: f.checkpointId,
          createdAt: f.createdAt,
        }))
      });
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id/files/* (Inspect single file content)
  app.get('/prototype/sessions/:id/files/{*path}', authService.requireSessionRole('VIEWER'), async (req, res, next) => {
    try {
      const sessionId = String(req.params.id);
      const rawPath = (req.params as any).path ?? (req.params as any)[0];
      const filePath = Array.isArray(rawPath) ? rawPath.join('/') : String(rawPath || '');
      if (!filePath) return res.status(400).json({ error: 'File path required' });

      const file = await protoRepo.getLatestSessionFile(sessionId, filePath);
      if (!file) return res.status(404).json({ error: `File ${filePath} not found` });

      return res.json({
        path: file.path,
        content: file.content,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        checkpointId: file.checkpointId,
      });
    } catch (e) {
      return next(e);
    }
  });

  // Workspaces API
  app.get('/api/workspaces', authService.requireAuth(), async (req, res, next) => {
    try {
      const user = await authService.verifyToken(req.headers.authorization);
      const workspaces = await protoRepo.listWorkspaces(user?.id);
      return res.json(workspaces);
    } catch (e) {
      return next(e);
    }
  });

  app.post('/api/workspaces', authService.requireAuth(), async (req, res, next) => {
    try {
      const { name, slug } = req.body ?? {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const ws = await protoRepo.createWorkspace({
        name,
        slug,
        ownerId: req.user?.id,
      });
      return res.status(201).json(ws);
    } catch (e) {
      return next(e);
    }
  });

  // Projects API
  app.get('/api/projects', authService.requireAuth(), async (req, res, next) => {
    try {
      const workspaceId = (req.query.workspaceId as string) || undefined;
      const projects = await protoRepo.listProjects(workspaceId);
      return res.json(projects);
    } catch (e) {
      return next(e);
    }
  });

  app.get('/api/workspaces/:workspaceId/projects', authService.requireAuth(), authService.requireRole('VIEWER'), async (req, res, next) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const projects = await protoRepo.listProjects(workspaceId);
      return res.json(projects);
    } catch (e) {
      return next(e);
    }
  });

  app.post('/api/workspaces/:workspaceId/projects', authService.requireAuth(), authService.requireRole('MEMBER'), async (req, res, next) => {
    try {
      const workspaceId = String(req.params.workspaceId);
      const { name, description, githubRepository, githubBranch } = req.body ?? {};
      if (!name) return res.status(400).json({ error: 'name is required' });
      const project = await protoRepo.createProject({
        workspaceId,
        name,
        description,
        githubRepository,
        githubBranch,
      });
      return res.status(201).json(project);
    } catch (e) {
      return next(e);
    }
  });

  app.get('/api/projects/:id', authService.requireAuth(), async (req, res, next) => {
    try {
      const projectId = String(req.params.id);
      const project = await protoRepo.getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const wsRole = await authService.authorizeProject(req.user?.id ?? '', projectId);
      if (!wsRole) return res.status(403).json({ error: 'Forbidden' });
      const wsRoleStr = String(wsRole);
      if (wsRoleStr !== 'OWNER' && wsRoleStr !== 'ADMIN' && wsRoleStr !== 'MEMBER' && wsRoleStr !== 'VIEWER') return res.status(403).json({ error: 'Forbidden' });
      const allSessions = await protoRepo.listSessions();
      const projectSessions = allSessions.filter(s => s.projectId === project.id || s.project === project.name);
      return res.json({ ...project, sessions: projectSessions });
    } catch (e) {
      return next(e);
    }
  });

  app.patch('/api/projects/:id', authService.requireAuth(), async (req, res, next) => {
    try {
      const projectId = String(req.params.id);
      const project = await protoRepo.getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const wsRole = await authService.authorizeProject(req.user?.id ?? '', projectId);
      if (!wsRole || (wsRole !== 'OWNER' && wsRole !== 'ADMIN' && wsRole !== 'MEMBER')) return res.status(403).json({ error: 'Forbidden' });
      const { name, description, status, githubRepository, githubBranch } = req.body ?? {};
      const updated = await protoRepo.updateProject(projectId, {
        name,
        description,
        status,
        githubRepository,
        githubBranch,
      });
      if (!updated) return res.status(404).json({ error: 'Project not found' });
      return res.json(updated);
    } catch (e) {
      return next(e);
    }
  });

  app.delete('/api/projects/:id', authService.requireAuth(), async (req, res, next) => {
    try {
      const projectId = String(req.params.id);
      const project = await protoRepo.getProject(projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const wsRole = await authService.authorizeProject(req.user?.id ?? '', projectId);
      if (!wsRole || wsRole !== 'OWNER') return res.status(403).json({ error: 'Forbidden: Requires OWNER' });
      // Delete project - relational CASCADE deletes associated sessions, tasks, checkpoints, files
      // Explicitly: remote GitHub repository is NEVER touched.
      const ok = await protoRepo.deleteProject(projectId);
      return res.json({ ok, deletedId: projectId });
    } catch (e) {
      return next(e);
    }
  });

  // Sovereign Auth HTTP Contract (Phase 3)
  const sovereignAuthRouter = createSovereignAuthRouter({ pool: activePool, protoRepo });
  app.use('/prototype/auth', sovereignAuthRouter);

  // Legacy / Transitional Auth API (Supabase / local dev fallback)
  app.get('/api/auth/me', async (req, res) => {
    const user = await authService.verifyToken(req.headers.authorization);
    return res.json({ user, supabaseConfigured: authService.isSupabaseConfigured() });
  });

  app.post('/api/auth/login', async (req, res) => {
    const providedToken = req.body?.token;
    // In production, disallow fallback test-token usage
    if (!providedToken && process.env.NODE_ENV === 'production') {
      return res.status(403).json({ error: 'Login not available in production' });
    }
    const token = providedToken || 'test-token';
    const user = await authService.verifyToken(token);
    if (!user) {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    const email = req.body?.email || 'default@pubprototype.internal';
    return res.json({ token, user: { ...user, email } });
  });

  app.post('/api/auth/logout', async (_req, res) => {
    return res.json({ ok: true });
  });

  // GET /prototype/sessions/:id/events (SSE)
  app.get('/prototype/sessions/:id/events', async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(String(req.params.id));
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
  app.patch('/prototype/sessions/:id', authService.requireSessionRole('MEMBER'), async (req, res, next) => {
    try {
      // Disallow setting status = 'READY' directly via PATCH to prevent bypass of VerificationGate
      if (req.body?.status === 'READY') {
        return res.status(400).json({ error: 'FORBIDDEN_PROMOTION: status READY must be granted via VerificationGate' });
      }

      const allowed = ['status', 'mode', 'previewUrl', 'previewRuntime', 'workspacePath', 'lastCheckpointSha'] as const;
      const patch = Object.fromEntries(
        allowed
          .filter(k => (req.body as any)[k] !== undefined)
          .map(k => [k, (req.body as any)[k]])
      );
      const session = await protoRepo.updateSession(String(req.params.id), patch);
      if (!session) return res.sendStatus(404);
      const eventType = patch.status === 'FAILED' ? 'ERROR' : null;
      if (eventType) prototypeEvents.emit({ sessionId: session.id, type: eventType, payload: { status: session.status, previewUrl: session.previewUrl } });
      return res.json(session);
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/prompts
  app.post('/prototype/sessions/:id/prompts', authService.requireSessionRole('MEMBER'), sessionRateLimiter, async (req, res, next) => {
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
  app.get('/prototype/sessions/:id/diff', authService.requireSessionRole('VIEWER'), async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(String(req.params.id));
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
  app.post('/prototype/sessions/:id/comparison-previews', authService.requireSessionRole('MEMBER'), async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(String(req.params.id));
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
  app.get('/prototype/sessions/:id/comparison-previews/:previewId', authService.requireSessionRole('VIEWER'), async (req, res, next) => {
    try {
      const comparison = await comparisonPreviews.get(String(req.params.previewId));
      if (!comparison || comparison.sessionId !== String(req.params.id)) return res.sendStatus(404);
      return res.json(comparison);
    } catch (e) {
      return next(e);
    }
  });

  // DELETE /prototype/sessions/:id/comparison-previews/:previewId
  app.delete('/prototype/sessions/:id/comparison-previews/:previewId', authService.requireSessionRole('MEMBER'), async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(String(req.params.id));
      if (!session) return res.sendStatus(404);
      const comparison = await comparisonPreviews.get(String(req.params.previewId));
      if (!comparison || comparison.sessionId !== session.id) return res.sendStatus(404);
      await comparisonPreviews.destroy(comparison.id, session.workspacePath ?? repoPath(session.id));
      return res.sendStatus(204);
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/checkpoints
  app.post('/prototype/sessions/:id/checkpoints', authService.requireSessionRole('MEMBER'), async (req, res, next) => {
    try {
      const session = await protoRepo.getSession(String(req.params.id));
      if (!session) return res.sendStatus(404);
      const { promptIndex, prompt, commitSha, previewUrl, buildPassed } = req.body ?? {};
      if (!Number.isInteger(promptIndex) || promptIndex < 1 || typeof prompt !== 'string') return res.status(400).json({ error: 'promptIndex and prompt are required' });
      const checkpoint = await protoRepo.createCheckpoint({ sessionId: session.id, promptIndex, prompt, commitSha: commitSha ?? null, previewUrl: previewUrl ?? null, buildPassed: buildPassed === true });
      prototypeEvents.emit({ sessionId: session.id, type: 'CHECKPOINT_CREATED', payload: checkpoint as unknown as Record<string, unknown> });

      const resolvedWorkspace = session.workspacePath ?? repoPath(session.id);
      const expectedCurrentSha = session.lastCheckpointSha;
      if (checkpoint.buildPassed && checkpoint.commitSha && existsSync(resolvedWorkspace)) {
        try {
          const verification = await verificationGate.verify(session.id, checkpoint.id, resolvedWorkspace);
          if (verification.status === 'PASSED') {
            const promo = await verificationGate.promoteIfValid(
              session.id,
              checkpoint.id,
              resolvedWorkspace,
              checkpoint.previewUrl || `/prototype/sessions/${session.id}/preview/`,
              undefined,
              expectedCurrentSha
            );
            if (promo.promoted) {
              prototypeEvents.emit({ sessionId: session.id, type: 'PREVIEW_READY', payload: { previewUrl: checkpoint.previewUrl, buildPassed: true } });
            } else {
              prototypeEvents.emit({ sessionId: session.id, type: 'PREVIEW_FAILED', payload: { previewUrl: checkpoint.previewUrl, buildPassed: false, reason: promo.reason } });
            }
          } else {
            prototypeEvents.emit({ sessionId: session.id, type: 'PREVIEW_FAILED', payload: { previewUrl: checkpoint.previewUrl, buildPassed: false } });
          }
        } catch {
          // Verification failed or was skipped
        }
      } else if (!checkpoint.buildPassed) {
        prototypeEvents.emit({ sessionId: session.id, type: 'PREVIEW_FAILED', payload: { previewUrl: checkpoint.previewUrl, buildPassed: false } });
      }

      return res.status(201).json(checkpoint);
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id/verifications
  app.get('/prototype/sessions/:id/verifications', authService.requireSessionRole('VIEWER'), async (req, res, next) => {
    try {
      const sessionId = String(req.params.id);
      const session = await protoRepo.getSession(sessionId);
      if (!session) return res.sendStatus(404);
      const verifications = await protoRepo.listVerifications(sessionId);
      return res.json(verifications);
    } catch (e) {
      return next(e);
    }
  });

  // GET /prototype/sessions/:id/verifications/:verId
  app.get('/prototype/sessions/:id/verifications/:verId', authService.requireSessionRole('VIEWER'), async (req, res, next) => {
    try {
      const sessionId = String(req.params.id);
      const session = await protoRepo.getSession(sessionId);
      if (!session) return res.sendStatus(404);
      const verification = await protoRepo.getVerification(String(req.params.verId));
      if (!verification || verification.sessionId !== session.id) return res.sendStatus(404);
      return res.json(verification);
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/checkpoints/:checkpointId/verify
  app.post('/prototype/sessions/:id/checkpoints/:checkpointId/verify', authService.requireSessionRole('MEMBER'), async (req, res, next) => {
    try {
      const sessionId = String(req.params.id);
      const checkpointId = String(req.params.checkpointId);
      const session = await protoRepo.getSession(sessionId);
      if (!session) return res.sendStatus(404);

      const resolvedWorkspace = session.workspacePath ?? repoPath(session.id);
      const expectedCurrentSha = session.lastCheckpointSha;
      const verification = await verificationGate.verify(sessionId, checkpointId, resolvedWorkspace);
      if (verification.status === 'PASSED') {
        await verificationGate.promoteIfValid(
          sessionId,
          checkpointId,
          resolvedWorkspace,
          session.previewUrl || `/prototype/sessions/${sessionId}/preview/`,
          undefined,
          expectedCurrentSha
        );
      }
      return res.json(verification);
    } catch (e) {
      return next(e);
    }
  });

  // POST /prototype/sessions/:id/promote
  app.post('/prototype/sessions/:id/promote', authService.requireSessionRole('MEMBER'), async (req, res, next) => {
    try {
      const input: PrototypeHandoffInput = {
        sessionId: String(req.params.id),
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

  // 404 handler for nonexistent routes
  app.use((req, res, next) => {
    const err = new Error(`Not Found: ${req.method} ${req.originalUrl}`);
    (err as any).status = 404;
    next(err);
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
