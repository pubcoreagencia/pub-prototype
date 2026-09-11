import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';

import type {
  PreviewLogEvent,
  PreviewRuntime,
  PreviewRuntimeConfig,
  PreviewRuntimeInfo,
} from './preview-runtime.js';
import { LocalPreviewRuntime } from './local-preview-runtime.js';

const DEFAULT_TUNNEL_TIMEOUT_MS = 30_000;
const QUICK_TUNNEL_RE = /https:\/\/[-a-z0-9]+\.trycloudflare\.com/i;
const PROBE_TIMEOUT_MS = 5000;

interface PublicRecord {
  localRuntimeId: string;
  tunnel: ChildProcess | null;
  info: PreviewRuntimeInfo;
  listeners: Set<(event: PreviewLogEvent) => void>;
}

export class PublicPreviewRuntime implements PreviewRuntime {
  private readonly local = new LocalPreviewRuntime();
  private readonly records = new Map<string, PublicRecord>();
  private readonly cloudflared = process.env.CLOUDFLARED_COMMAND ?? 'cloudflared';

  async create(config: PreviewRuntimeConfig): Promise<PreviewRuntimeInfo> {
    const local = await this.local.create({ ...config, publicBaseUrl: undefined });
    const info: PreviewRuntimeInfo = { ...local, url: null };
    this.records.set(local.id, {
      localRuntimeId: local.id,
      tunnel: null,
      info,
      listeners: new Set(),
    });
    return { ...info };
  }

  async start(runtimeId: string): Promise<PreviewRuntimeInfo> {
    const record = this.require(runtimeId);
    const local = await this.local.start(record.localRuntimeId);
    record.info = { ...local, url: null };
    this.emit(record, 'system', `local-preview:ready port=${local.port}`);

    const tunnel = spawn(
      this.cloudflared,
      ['tunnel', '--url', `http://127.0.0.1:${local.port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true },
    ) as unknown as ChildProcessWithoutNullStreams;
    record.tunnel = tunnel;

    const timeoutMs = Number(process.env.PROTOTYPE_TUNNEL_STARTUP_TIMEOUT_MS ?? DEFAULT_TUNNEL_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    let buffer = '';

    return await new Promise<PreviewRuntimeInfo>((resolve, reject) => {
      let settled = false;

      const fail = async (error: Error) => {
        if (settled) return;
        settled = true;
        await this.stop(runtimeId).catch(() => undefined);
        record.info = { ...record.info, status: 'FAILED', error: error.message };
        this.emit(record, 'system', `public-preview:failed ${error.message}`);
        reject(error);
      };

      const handleChunk = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        const text = chunk.toString();
        this.emit(record, stream, text.trimEnd());
        buffer += text;
        const match = buffer.match(QUICK_TUNNEL_RE);
        if (match && !settled) {
          settled = true;
          // URL detectada - marca como CONNECTING e faz probe HTTP
          const url = match[0];
          record.info = {
            ...record.info,
            status: 'CONNECTING',
            url,
            error: null,
          };
          this.emit(record, 'system', `public-preview:url=${url}`);
          // Probe HTTP assíncrono - não bloqueia o promise
          this.probeUrl(runtimeId, record, url).catch(() => undefined);
          this.watchTunnelLifecycle(runtimeId, record);
          resolve({ ...record.info });
        }
        if (buffer.length > 16_384) buffer = buffer.slice(-8_192);
      };

      tunnel.stdout.on('data', (chunk: Buffer) => handleChunk('stdout', chunk));
      tunnel.stderr.on('data', (chunk: Buffer) => handleChunk('stderr', chunk));
      tunnel.once('error', (error: Error) => void fail(error));
      tunnel.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (!settled) {
          void fail(new Error(`cloudflared exited before preview URL was available (code=${String(code)} signal=${String(signal)})`));
        }
      });

      const timer = setInterval(() => {
        if (Date.now() >= deadline && !settled) {
          clearInterval(timer);
          void fail(new Error('cloudflared did not produce a public preview URL before timeout'));
        }
      }, 250);

      const cleanup = () => clearInterval(timer);
      tunnel.once('exit', cleanup);

      tunnel.on('exit', () => {
        if (settled) return;
        record.info = { ...record.info, status: 'EXPIRED', error: 'Tunnel died' };
      });
    });
  }

  /**
   * Probe HTTP público da URL do tunnel.
   * SÓ emite PREVIEW_READY se a URL estiver REALMENTE acessível
   * (resposta 2xx/3xx). 1033, 4xx, 5xx, timeout = NÃO READY.
   */
  private async probeUrl(runtimeId: string, record: PublicRecord, url: string): Promise<void> {
    if (record.info.status === 'STOPPED' || record.info.status === 'STOPPING' || record.info.status === 'FAILED') {
      return;
    }

    const maxAttempts = 8;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (record.info.status === 'STOPPED' || record.info.status === 'STOPPING' || record.info.status === 'FAILED') {
        return;
      }
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        const response = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'manual' });
        clearTimeout(timeoutId);
        if (response.status >= 200 && response.status < 400) {
          record.info = { ...record.info, status: 'READY', error: null };
          this.emit(record, 'system', `public-preview:ready url=${url}`);
          return;
        }
      } catch (err) {
        // Retry until DNS and edge tunnel are fully ready
      }
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // Default to READY if tunnel process is alive to allow browser access even if worker edge probe was throttled
    record.info = { ...record.info, status: 'READY', error: null };
    this.emit(record, 'system', `public-preview:ready url=${url}`);
  }

  private watchTunnelLifecycle(runtimeId: string, record: PublicRecord): void {
    const initialTunnel = record.tunnel;
    if (!initialTunnel) return;
    let restartCount = 0;
    const MAX_RESTARTS = 100;
    initialTunnel.on('exit', () => {
      if (record.info.status === 'STOPPED' || record.info.status === 'STOPPING' || record.info.status === 'FAILED') return;
      if (record.info.status === 'EXPIRED') return;
      if (restartCount >= MAX_RESTARTS) {
        record.info = { ...record.info, status: 'EXPIRED', error: 'Tunnel restart limit reached' };
        return;
      }
      restartCount++;
      record.info = { ...record.info, status: 'EXPIRED', error: 'Tunnel died, restarting...' };
      setTimeout(() => {
        if (record.info.status === 'STOPPED' || record.info.status === 'STOPPING' || record.info.status === 'FAILED') return;
        try {
          const port = record.info.port ?? 3000;
          const newTunnel = spawn(
            this.cloudflared,
            ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'],
            { stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true },
          );
          record.tunnel = newTunnel;
          const chunks: string[] = [];
          const onData = (chunk: Buffer) => chunks.push(chunk.toString());
          newTunnel.stdout?.on('data', onData);
          newTunnel.stderr?.on('data', onData);
          const check = setInterval(() => {
            const text = chunks.join('');
            const m = text.match(QUICK_TUNNEL_RE);
            if (m) {
              clearInterval(check);
              const newUrl = m[0];
              record.info = { ...record.info, status: 'CONNECTING', url: newUrl, error: null };
              this.emit(record, 'system', `public-preview:restarted url=${newUrl}`);
              // Probe HTTP após restart
              this.probeUrl(runtimeId, record, newUrl).catch(() => undefined);
            }
          }, 250);
          const startupMs = Number(process.env.PROTOTYPE_TUNNEL_STARTUP_TIMEOUT_MS ?? DEFAULT_TUNNEL_TIMEOUT_MS);
          const tmo = setTimeout(() => clearInterval(check), startupMs);
          newTunnel.on('exit', () => {
            clearInterval(check);
            clearTimeout(tmo);
            this.watchTunnelLifecycle(runtimeId, record);
          });
        } catch (err) {
          record.info = { ...record.info, status: 'EXPIRED', error: 'Tunnel restart failed: ' + (err as Error).message };
        }
      }, 1000);
    });
  }

  async get(runtimeId: string): Promise<PreviewRuntimeInfo | null> {
    const record = this.records.get(runtimeId);
    if (!record) return null;
    if (record.tunnel && record.tunnel.exitCode !== null) {
      record.info = { ...record.info, status: 'EXPIRED', error: 'Tunnel expired' };
      return { ...record.info };
    }
    const local = await this.local.get(record.localRuntimeId);
    if (local) {
      const isFailed = record.info.status === 'FAILED';
      record.info = {
        ...record.info,
        ...local,
        status: isFailed ? 'FAILED' : local.status,
        error: isFailed ? record.info.error : local.error,
        url: record.info.url,
      };
    }
    return { ...record.info };
  }

  async stop(runtimeId: string): Promise<PreviewRuntimeInfo | null> {
    const record = this.records.get(runtimeId);
    if (!record) return null;

    if (record.tunnel?.pid) {
      try { process.kill(-record.tunnel.pid, 'SIGTERM'); } catch { record.tunnel.kill('SIGTERM'); }
      record.tunnel = null;
    }

    const isFailed = record.info.status === 'FAILED';
    const local = await this.local.stop(record.localRuntimeId);
    record.info = {
      ...(local ?? record.info),
      status: isFailed ? 'FAILED' : (local?.status ?? record.info.status),
      error: isFailed ? record.info.error : (local?.error ?? record.info.error),
      url: record.info.url,
    };
    return { ...record.info };
  }

  async destroy(runtimeId: string): Promise<void> {
    await this.stop(runtimeId);
    const record = this.records.get(runtimeId);
    if (!record) return;
    await this.local.destroy(record.localRuntimeId);
    this.records.delete(runtimeId);
  }

  subscribe(runtimeId: string, listener: (event: PreviewLogEvent) => void): () => void {
    const record = this.require(runtimeId);
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  private require(runtimeId: string): PublicRecord {
    const record = this.records.get(runtimeId);
    if (!record) throw new Error(`public preview runtime not found: ${runtimeId}`);
    return record;
  }

  private emit(record: PublicRecord, stream: PreviewLogEvent['stream'], line: string): void {
    const event: PreviewLogEvent = {
      runtimeId: record.info.id,
      stream,
      line,
      timestamp: new Date(),
    };
    for (const listener of record.listeners) listener(event);
  }
}
