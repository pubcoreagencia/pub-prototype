import 'dotenv/config';
import http from 'node:http';
import { Pool } from 'pg';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createProvider } from '../../agent.js';
import { PostgresPpTaskRepository } from '../persistence/task-repository.js';
import { PostgresPrototypeRepository } from '../persistence/repository.js';
import { PostgresPrototypeEventPublisher } from '../events/events.js';
import { PrototypeWorker } from './prototype-worker.js';
import { configureGitCredentials } from '../../worker.js';

const PORT = Number(process.env.PP_WORKER_PORT ?? process.env.PORT ?? 3002);
const POLL_INTERVAL_MS = Number(process.env.PP_WORKER_POLL_INTERVAL_MS ?? process.env.WORKER_POLL_INTERVAL_MS ?? 3000);

export function createPrototypeWorkerDaemon(pool: Pool): PrototypeWorker {
  const tasks = new PostgresPpTaskRepository(pool);
  const prototypes = new PostgresPrototypeRepository(pool);
  const events = new PostgresPrototypeEventPublisher(pool);
  const providerName = process.env.AGENT_PROVIDER ?? 'gateway';
  const provider = createProvider(providerName);
  return new PrototypeWorker(tasks, prototypes, provider, events);
}

export function startPrototypeHealthServer(port = PORT): http.Server {
  const server = http.createServer(async (req, res) => {
    // Internal endpoint for preview recovery (called by API Worker)
    if (req.method === 'POST' && req.url === '/internal/prototype/preview/refresh') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { sessionId } = JSON.parse(body);
          if (!sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'sessionId is required', code: 'MISSING_SESSION_ID' }));
            return;
          }

          const { PreviewRecoveryService } = await import('../preview/preview-recovery.js');
          const { PostgresPrototypeRepository } = await import('../persistence/repository.js');
          const pg = await import('pg');

          const databaseUrl = process.env.DATABASE_URL || '';
          if (!databaseUrl) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'DATABASE_URL not configured', code: 'NO_DATABASE' }));
            return;
          }

          const pool = new pg.default.Pool({ connectionString: databaseUrl });
          const prototypes = new PostgresPrototypeRepository(pool);
          const recovery = new PreviewRecoveryService(prototypes);
          const result = await recovery.refresh(sessionId);

          await pool.query(
            `UPDATE prototype_sessions SET preview_url = $1, preview_runtime = $2, updated_at = NOW() WHERE id = $3`,
            [result.previewUrl, result.previewRuntime, sessionId]
          );
          await pool.end();

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            sessionId: result.sessionId,
            previewUrl: result.previewUrl,
            previewRuntime: result.previewRuntime,
          }));
        } catch (error: any) {
          console.error('[PP Worker] Recovery error:', error.message);
          const code = error?.code || 'RECOVERY_FAILED';
          const status =
            code === 'SESSION_NOT_FOUND' ? 404
            : code === 'NOT_READY' ? 409
            : code === 'NO_CHECKPOINT' ? 409
            : code === 'WORKSPACE_MISSING' ? 422
            : code === 'GIT_CLONE_FAILED' || code === 'GIT_CHECKOUT_FAILED' ? 502
            : code === 'NPM_INSTALL_FAILED' ? 502
            : code === 'PREVIEW_START_FAILED' ? 502
            : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: error?.message || 'Recovery failed', code }));
        }
      });
      return;
    }

    // Default health check
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      worker: 'PUB Prototype Dedicated Worker',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      service: 'pp-worker',
      env: {
        DATABASE_URL: process.env.DATABASE_URL ? 'SET' : 'EMPTY',
        PROTOTYPE_BOT_TOKEN: process.env.PROTOTYPE_BOT_TOKEN ? 'SET' : 'EMPTY',
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY ? 'SET' : 'EMPTY',
      },
    }));
  });

  server.on('error', (err: any) => {
    console.warn(`[PP Worker] Health server warning on port ${port}:`, err.message);
  });

  server.listen(port, '0.0.0.0', () => {
    console.log(`[PP Worker] Dedicated health server listening on 0.0.0.0:${port}`);
  });

  return server;
}

const currentFile = fileURLToPath(import.meta.url);
const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isMain = Boolean(entryFile && currentFile === entryFile) || process.env.RUN_PP_WORKER === 'true';

if (isMain) {
  startPrototypeHealthServer();

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error('[PP Worker] FATAL: DATABASE_URL is not configured. Worker cannot start.');
  } else {
    try {
      configureGitCredentials();
      const isLocal = dbUrl.includes('localhost') || dbUrl.includes('127.0.0.1');
      const pool = new Pool({
        connectionString: dbUrl,
        ssl: isLocal ? false : { rejectUnauthorized: false },
      });

      const worker = createPrototypeWorkerDaemon(pool);

      console.log(JSON.stringify({
        event: 'PP_WORKER_STARTED',
        timestamp: new Date().toISOString(),
        intervalMs: POLL_INTERVAL_MS,
      }));

      const runCycle = async () => {
        try {
          await worker.executeOnce();
        } catch (e) {
          console.error('[PP Worker] Cycle error:', (e as Error).message);
        } finally {
          setTimeout(runCycle, POLL_INTERVAL_MS);
        }
      };

      runCycle();
    } catch (err) {
      console.error('[PP Worker] Initialization error:', (err as Error).message);
    }
  }
}
