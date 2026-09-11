import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { stat, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import type {
  PreviewLogEvent,
  PreviewRuntime,
  PreviewRuntimeConfig,
  PreviewRuntimeInfo,
  PreviewRuntimeStatus,
} from './preview-runtime.js';

type WorkspaceKind = 'node' | 'static';

function detectWorkspaceKind(workspace: string): WorkspaceKind {
  const packageJsonPath = path.join(workspace, 'package.json');
  const hasPackageJson = existsSync(packageJsonPath);

  if (hasPackageJson) return 'node';

  const hasIndexHtml = existsSync(path.join(workspace, 'index.html'));
  if (hasIndexHtml) return 'static';

  return 'node';
}

interface RuntimeRecord {
  config: PreviewRuntimeConfig;
  info: PreviewRuntimeInfo;
  child: ChildProcess | null;
  server: http.Server | null;
  listeners: Set<(event: PreviewLogEvent) => void>;
  stderrLines: string[];
}

const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const HEALTHCHECK_INTERVAL_MS = 250;

function createId(): string {
  return `preview_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function emit(record: RuntimeRecord, stream: PreviewLogEvent['stream'], line: string): void {
  if (stream === 'stderr') {
    record.stderrLines.push(line);
    if (record.stderrLines.length > 50) record.stderrLines.shift();
  }
  const event: PreviewLogEvent = {
    runtimeId: record.info.id,
    stream,
    line,
    timestamp: new Date(),
  };
  for (const listener of record.listeners) listener(event);
}

function setStatus(record: RuntimeRecord, status: PreviewRuntimeStatus, error: string | null = null): void {
  record.info = {
    ...record.info,
    status,
    error,
    stoppedAt: status === 'STOPPED' || status === 'FAILED' ? new Date() : record.info.stoppedAt,
  };
  emit(record, 'system', `status:${status}`);
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('failed to allocate preview port'));
        return;
      }
      const port = address.port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function resolveUrl(config: PreviewRuntimeConfig, port: number): string {
  const base = (config.publicBaseUrl ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  if (base.includes('{PORT}')) return base.replaceAll('{PORT}', String(port));
  if (config.publicBaseUrl) return base;
  return `http://127.0.0.1:${port}`;
}

function resolveArgs(args: string[], port: number): string[] {
  return args.map(arg => arg.replaceAll('{PORT}', String(port)));
}

async function waitForHttp(url: string, timeoutMs: number, record?: RuntimeRecord): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'preview health check did not succeed';

  while (Date.now() < deadline) {
    if (record?.info.status === 'FAILED') {
      throw new Error(record.info.error ?? 'preview process failed');
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(Math.min(1000, Math.max(100, deadline - Date.now()))) });
      if (response.ok || response.status < 500) return;
      lastError = `preview returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise(resolve => setTimeout(resolve, HEALTHCHECK_INTERVAL_MS));
  }

  throw new Error(lastError);
}

export class LocalPreviewRuntime implements PreviewRuntime {
  private readonly runtimes = new Map<string, RuntimeRecord>();

  private async createStaticRecord(config: PreviewRuntimeConfig): Promise<{ record: RuntimeRecord; id: string; port: number }> {
    const port = config.port === 0 ? await allocatePort() : config.port;
    const id = createId();
    const record: RuntimeRecord = {
      config: { ...config, port, workspaceKind: 'static' },
      info: {
        id,
        status: 'CREATING',
        url: resolveUrl(config, port),
        port,
        pid: null,
        startedAt: null,
        stoppedAt: null,
        error: null,
      },
      child: null,
      server: null,
      listeners: new Set(),
      stderrLines: [],
    };
    this.runtimes.set(id, record);
    emit(record, 'system', `runtime:created port=${port}`);
    return { record, id, port };
  }

  private async createNodeRecord(config: PreviewRuntimeConfig, port: number): Promise<{ record: RuntimeRecord; id: string }> {
    const id = createId();
    const record: RuntimeRecord = {
      config: { ...config, port, workspaceKind: 'node' },
      info: {
        id,
        status: 'CREATING',
        url: resolveUrl(config, port),
        port,
        pid: null,
        startedAt: null,
        stoppedAt: null,
        error: null,
      },
      child: null,
      server: null,
      listeners: new Set(),
      stderrLines: [],
    };
    this.runtimes.set(id, record);
    emit(record, 'system', `runtime:created port=${port}`);
    return { record, id };
  }

  async create(config: PreviewRuntimeConfig): Promise<PreviewRuntimeInfo> {
    if (!config.workspace) throw new Error('workspace is required');
    if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
      throw new Error('port must be 0 or an integer between 1 and 65535');
    }

    const kind = detectWorkspaceKind(config.workspace);
    if (kind === 'node' && !config.command) {
      throw new Error('command is required for node preview workspaces');
    }

    if (kind === 'static') {
      const { record } = await this.createStaticRecord(config);
      return { ...record.info };
    }

    const port = config.port === 0 ? await allocatePort() : config.port;
    const { record } = await this.createNodeRecord(config, port);
    return { ...record.info };
  }

  async start(runtimeId: string): Promise<PreviewRuntimeInfo> {
    const record = this.runtimes.get(runtimeId);
    if (!record) throw new Error(`preview runtime not found: ${runtimeId}`);
    if (record.info.status === 'READY' || record.info.status === 'STARTING') return { ...record.info };
    if (record.info.status === 'STOPPING') throw new Error('preview runtime is stopping');

    setStatus(record, 'STARTING', null);

    const currentKind = detectWorkspaceKind(record.config.workspace);
    if (currentKind === 'static' || record.config.workspaceKind === 'static') {
      record.config.workspaceKind = 'static';
      return this.startStaticServer(record);
    }

    const env = { ...process.env, ...(record.config.environment ?? {}), PORT: String(record.config.port) };
    const child = spawn(record.config.command, resolveArgs(record.config.args, record.config.port), {
      cwd: record.config.workspace,
      env,
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    }) as unknown as ChildProcessWithoutNullStreams;
    record.child = child;

    record.info = { ...record.info, pid: child.pid ?? null, startedAt: new Date(), error: null };

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) emit(record, 'stdout', line);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/).filter(Boolean)) emit(record, 'stderr', line);
    });

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (record.info.status === 'STOPPING' || record.info.status === 'STOPPED') {
        setStatus(record, 'STOPPED', null);
        return;
      }
      const stderrSummary = record.stderrLines.length
        ? record.stderrLines.slice(-3).join(' | ')
        : '';
      const errorMessage = [code === 0 ? null : `preview process exited with code=${String(code)}`, stderrSummary ? `stderr: ${stderrSummary}` : null].filter(Boolean).join(': ') || null;
      setStatus(record, code === 0 ? 'STOPPED' : 'FAILED', errorMessage);
    };

    child.on('exit', onExit);
    child.on('error', (error: Error) => setStatus(record, 'FAILED', error.message));


    try {
      const healthUrl = `http://127.0.0.1:${record.config.port}`;
      await waitForHttp(healthUrl, record.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, record);
      if (record.info.status === 'FAILED') throw new Error(record.info.error ?? 'preview process failed');
      setStatus(record, 'READY', null);
      return { ...record.info };
    } catch (error) {
      // Fallback: if Node command failed or crashed, but workspace contains any HTML files,
      // gracefully recover with the static HTTP server so preview is always available.
      if (existsSync(path.join(record.config.workspace, 'index.html')) || existsSync(path.join(record.config.workspace, 'public/index.html'))) {
        console.warn(`[LocalPreviewRuntime] Node preview failed, falling back to static server for ${record.config.workspace}`);
        await this.stop(runtimeId).catch(() => undefined);
        record.config.workspaceKind = 'static';
        return this.startStaticServer(record);
      }
      const message = error instanceof Error ? error.message : String(error);
      await this.stop(runtimeId).catch(() => undefined);
      const finalMessage = record.info.error ?? message;
      setStatus(record, 'FAILED', finalMessage);
      throw new Error(`preview failed to become ready: ${finalMessage}`);
    }
  }

  private async startStaticServer(record: RuntimeRecord): Promise<PreviewRuntimeInfo> {
    return new Promise((resolve, reject) => {
      const workspace = record.config.workspace;
      const port = record.config.port;

      const requestListener = (req: http.IncomingMessage, res: http.ServerResponse) => {
        if (res.headersSent) return;

        const finish = (status: number, body: string, contentType = 'text/plain; charset=utf-8') => {
          if (res.headersSent) return;
          res.writeHead(status, { 'content-type': contentType });
          res.end(body);
        };

        let requestPath: string;
        try {
          if (!req.url) throw new Error('no url');
          const rawPath = req.url.split('?')[0];
          if (!rawPath || !rawPath.startsWith('/')) throw new Error('invalid path');

          if (rawPath.includes('%2e') || rawPath.includes('%2E')) {
            throw new Error('encoded path traversal');
          }

          requestPath = decodeURIComponent(rawPath);

          const rawSegments = requestPath.split('/');
          for (const seg of rawSegments) {
            if (seg === '..') {
              throw new Error('path traversal');
            }
          }
        } catch {
          finish(400, 'invalid request url');
          return;
        }

        const segments = requestPath.split('/').filter(Boolean);

        const safePath = path.posix.normalize('/' + segments.join('/')).replace(/^\/+/, '');

        if (safePath.startsWith('..') || safePath.includes('/..')) {
          finish(400, 'invalid request url');
          return;
        }

        const workspaceReal = path.resolve(workspace);
        const resolvedReal = path.resolve(workspaceReal, safePath);

        if (resolvedReal !== workspaceReal && !resolvedReal.startsWith(workspaceReal + path.sep)) {
          finish(400, 'invalid request url');
          return;
        }

        const serveFile = async () => {
          let targetPath = resolvedReal;
          if (targetPath === workspaceReal) {
            targetPath = path.join(workspace, 'index.html');
          } else {
            try {
              const fileStats = await stat(resolvedReal);
              if (fileStats.isDirectory()) targetPath = path.join(resolvedReal, 'index.html');
            } catch {
              targetPath = resolvedReal;
            }
          }

          let contentType = 'application/octet-stream';
          const lower = targetPath.toLowerCase();
          if (lower.endsWith('.html')) contentType = 'text/html; charset=utf-8';
          else if (lower.endsWith('.css')) contentType = 'text/css; charset=utf-8';
          else if (lower.endsWith('.js')) contentType = 'application/javascript; charset=utf-8';
          else if (lower.endsWith('.json')) contentType = 'application/json; charset=utf-8';
          else if (lower.endsWith('.png')) contentType = 'image/png';
          else if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) contentType = 'image/jpeg';
          else if (lower.endsWith('.svg')) contentType = 'image/svg+xml';
          else if (lower.endsWith('.ico')) contentType = 'image/x-icon';

          try {
            const content = await readFile(targetPath);
            res.writeHead(200, { 'content-type': contentType });
            res.end(content);
          } catch {
            res.writeHead(404);
            res.end('not found');
          }
        };

        serveFile().catch(() => {
          if (!res.headersSent) {
            finish(500, 'internal server error');
          }
        });
      };

      const server = http.createServer(requestListener);
      server.maxConnections = 50;
      server.listen(port, '0.0.0.0', async () => {
        const healthUrl = `http://127.0.0.1:${port}`;
        try {
          await waitForHttp(healthUrl, record.config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS);
          record.server = server;
          record.info = { ...record.info, startedAt: new Date(), error: null };
          setStatus(record, 'READY', null);
          resolve({ ...record.info });
        } catch (error) {
          server.close();
          const message = error instanceof Error ? error.message : String(error);
          setStatus(record, 'FAILED', message);
          reject(new Error(`preview failed to become ready: ${message}`));
        }
      });

      server.on('error', (error: Error) => {
        server.close();
        setStatus(record, 'FAILED', error.message);
        reject(new Error(`preview failed to become ready: ${error.message}`));
      });
    });
  }

  async get(runtimeId: string): Promise<PreviewRuntimeInfo | null> {
    const record = this.runtimes.get(runtimeId);
    return record ? { ...record.info } : null;
  }

  async stop(runtimeId: string): Promise<PreviewRuntimeInfo | null> {
    const record = this.runtimes.get(runtimeId);
    if (!record) return null;

    if (record.server) {
      record.server.close();
      record.server = null;
    }

    if (!record.child || record.info.status === 'STOPPED' || record.info.status === 'FAILED') {
      if (record.info.status !== 'FAILED') setStatus(record, 'STOPPED', null);
      return { ...record.info };
    }

    setStatus(record, 'STOPPING', null);
    const child = record.child;
    try {
      if (child.pid) process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }

    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
        resolve();
      }, 1_500);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
    });

    record.child = null;
    record.info = { ...record.info, pid: null, stoppedAt: new Date() };
    if (record.info.status !== 'FAILED') setStatus(record, 'STOPPED', null);
    return { ...record.info };
  }

  async destroy(runtimeId: string): Promise<void> {
    await this.stop(runtimeId);
    this.runtimes.delete(runtimeId);
  }

  subscribe(runtimeId: string, listener: (event: PreviewLogEvent) => void): () => void {
    const record = this.runtimes.get(runtimeId);
    if (!record) throw new Error(`preview runtime not found: ${runtimeId}`);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }
}
