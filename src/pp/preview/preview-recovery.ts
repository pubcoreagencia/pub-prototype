import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, access } from 'node:fs/promises';
import path from 'node:path';

import { LocalPreviewRuntime } from './local-preview-runtime.js';
import { PublicPreviewRuntime } from './public-preview-runtime.js';
import type { PreviewRuntime, PreviewRuntimeInfo } from './preview-runtime.js';
import { PostgresPrototypeRepository } from '../persistence/repository.js';

export interface PreviewRecoveryResult {
  sessionId: string;
  previewUrl: string;
  previewRuntime: string;
  createdAt: Date;
}

export interface PreviewRecoveryError {
  code:
    | 'SESSION_NOT_FOUND'
    | 'NOT_READY'
    | 'NO_CHECKPOINT'
    | 'WORKSPACE_MISSING'
    | 'GIT_CLONE_FAILED'
    | 'GIT_CHECKOUT_FAILED'
    | 'NPM_INSTALL_FAILED'
    | 'PREVIEW_START_FAILED'
    | 'RECOVERY_FAILED';
  message: string;
}

interface PrototypeSession {
  id: string;
  status: string;
  repository?: string | null;
  branch?: string | null;
  lastCheckpointSha?: string | null;
  workspacePath?: string | null;
  previewUrl?: string | null;
  previewRuntime?: string | null;
  project?: string;
}

const WORKSPACE_ROOT = process.env.PROTOTYPE_WORKSPACES_ROOT ?? '/tmp/pub-prototype';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function directoryHasGit(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, '.git'));
    return true;
  } catch {
    return false;
  }
}

function getCurrentHead(workspacePath: string): string | null {
  try {
    return git(['rev-parse', 'HEAD'], workspacePath).trim();
  } catch {
    return null;
  }
}

function isNodeWorkspace(workspacePath: string): boolean {
  return existsSync(path.join(workspacePath, 'package.json'));
}

export class PreviewRecoveryService {
  private readonly local: LocalPreviewRuntime;
  private readonly preview: PreviewRuntime;
  private readonly prototypes: PostgresPrototypeRepository;
  private readonly refreshing = new Set<string>();

  constructor(prototypes: PostgresPrototypeRepository) {
    this.local = new LocalPreviewRuntime();
    this.preview = new PublicPreviewRuntime();
    this.prototypes = prototypes;
  }

  async isPreviewReachable(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(url, {
        method: 'HEAD',
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      clearTimeout(timeout);
      return resp.ok || resp.status < 500;
    } catch {
      return false;
    }
  }

  async refresh(sessionId: string): Promise<PreviewRecoveryResult> {
    if (this.refreshing.has(sessionId)) {
      await this.waitForRefresh(sessionId);
      const session = await this.prototypes.getSession(sessionId);
      if (!session?.previewRuntime || !session.previewUrl) {
        throw { code: 'RECOVERY_FAILED', message: 'Preview refresh failed' } as PreviewRecoveryError;
      }
      return {
        sessionId,
        previewUrl: session.previewUrl,
        previewRuntime: session.previewRuntime,
        createdAt: new Date(),
      };
    }

    this.refreshing.add(sessionId);
    try {
      return await this.doRefresh(sessionId);
    } finally {
      this.refreshing.delete(sessionId);
    }
  }

  private async doRefresh(sessionId: string): Promise<PreviewRecoveryResult> {
    const session = await this.prototypes.getSession(sessionId);
    if (!session) {
      throw { code: 'SESSION_NOT_FOUND', message: 'Session not found' } as PreviewRecoveryError;
    }

    if (session.status !== 'READY') {
      throw { code: 'NOT_READY', message: `Session status is ${session.status}, expected READY` } as PreviewRecoveryError;
    }

    if (!session.lastCheckpointSha) {
      throw {
        code: 'NO_CHECKPOINT',
        message: 'Session has no checkpoint to recover preview from',
      } as PreviewRecoveryError;
    }

    if (!session.repository) {
      throw { code: 'WORKSPACE_MISSING', message: 'Session has no repository URL' } as PreviewRecoveryError;
    }

    // SECURITY: enforce hard whitelist for prototype recovery repository.
    // The recovery ALWAYS clones from the persistent repository
    // (pub-dev-loop-prototypes), not the template. This ensures we can
    // checkout the lastCheckpointSha, which is pushed to the persistent repo.
    const allowedRepo = 'pubcoreagencia/pub-dev-loop-prototypes';
    const sessionRepoPath = session.repository
      .replace('https://github.com/', '')
      .replace('.git', '');
    if (sessionRepoPath !== allowedRepo && !sessionRepoPath.endsWith('/' + allowedRepo)) {
      throw {
        code: 'WORKSPACE_MISSING',
        message: `Session repository ${session.repository} does not match persistent repo ${allowedRepo}. Cannot recover legacy sessions.`,
      } as PreviewRecoveryError;
    }

    const workspacePath = await this.reconstructWorkspace(session as PrototypeSession);

    if (session.previewRuntime) {
      try {
        await this.preview.destroy(session.previewRuntime);
      } catch {
        // Idempotente: runtime já pode estar morto (container anterior destruído)
      }
    }

    const previewCommand = process.env.PROTOTYPE_PREVIEW_COMMAND ?? 'npm';
    const previewArgs = (process.env.PROTOTYPE_PREVIEW_ARGS ?? 'run dev -- --host 0.0.0.0 --port {PORT}')
      .split(' ')
      .filter(Boolean);

    let runtimeInfo: PreviewRuntimeInfo;
    try {
      runtimeInfo = await this.preview.create({
        workspace: workspacePath,
        command: previewCommand,
        args: previewArgs,
        port: 0,
        publicBaseUrl: process.env.PROTOTYPE_PREVIEW_BASE_URL || undefined,
        startupTimeoutMs: Number(process.env.PROTOTYPE_PREVIEW_STARTUP_TIMEOUT_MS ?? 60000),
        environment: { NODE_ENV: 'development' },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw { code: 'PREVIEW_START_FAILED', message: `Failed to create runtime: ${message}` } as PreviewRecoveryError;
    }

    let info: PreviewRuntimeInfo;
    try {
      info = await this.preview.start(runtimeInfo.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw { code: 'PREVIEW_START_FAILED', message: `Failed to start runtime: ${message}` } as PreviewRecoveryError;
    }

    if (!info.url) {
      throw {
        code: 'PREVIEW_START_FAILED',
        message: 'Runtime started but no preview URL was produced',
      } as PreviewRecoveryError;
    }

    await this.prototypes.updateSession(sessionId, {
      previewUrl: info.url,
      previewRuntime: info.id,
    });

    return {
      sessionId,
      previewUrl: info.url,
      previewRuntime: info.id,
      createdAt: new Date(),
    };
  }

  /**
   * Reconstructs the workspace from Git for a given session.
   * - Validates repository + lastCheckpointSha
   * - Reuses existing workspace if HEAD matches lastCheckpointSha
   * - Otherwise: removes and re-clones
   * - For NODE workspaces: runs `npm install` after checkout
   */
  private async reconstructWorkspace(session: PrototypeSession): Promise<string> {
    const { id, repository, lastCheckpointSha, branch, workspacePath } = session;

    if (!repository) {
      throw { code: 'WORKSPACE_MISSING', message: 'Session has no repository' } as PreviewRecoveryError;
    }

    if (!lastCheckpointSha) {
      throw {
        code: 'NO_CHECKPOINT',
        message: 'Session has no lastCheckpointSha to reconstruct from',
      } as PreviewRecoveryError;
    }

    const target = workspacePath ?? path.join(WORKSPACE_ROOT, id);

    const exists = await directoryExists(target);
    const hasGit = exists ? await directoryHasGit(target) : false;

    if (exists && hasGit) {
      const currentHead = getCurrentHead(target);
      if (currentHead === lastCheckpointSha) {
        // Já está no SHA correto — reutiliza
        await this.installDepsIfNeeded(target);
        return target;
      }
      // SHA divergente — recria de forma segura
      await rm(target, { recursive: true, force: true });
    } else if (exists) {
      await rm(target, { recursive: true, force: true });
    }

    await mkdir(target, { recursive: true });

    try {
      // For private repos, embed the token in the clone URL.
      // Use PROTOTYPE_BOT_TOKEN or GITHUB_TOKEN from environment.
      const token = process.env.PROTOTYPE_BOT_TOKEN || process.env.GITHUB_TOKEN;
      let cloneUrl = repository;
      if (token && repository.startsWith('https://')) {
        cloneUrl = `https://x-access-token:${token}@${repository.replace('https://', '')}`;
      }
      git(['clone', cloneUrl, target]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw {
        code: 'GIT_CLONE_FAILED',
        message: `git clone failed: ${message}`,
      } as PreviewRecoveryError;
    }

    try {
      if (branch) {
        try {
          git(['checkout', branch], target);
        } catch {
          // branch pode não existir localmente — tenta com origin/<branch>
          git(['checkout', '-b', branch, `origin/${branch}`], target);
        }
      }
      // Forçar checkout no SHA exato
      git(['checkout', lastCheckpointSha], target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw {
        code: 'GIT_CHECKOUT_FAILED',
        message: `git checkout failed: ${message}`,
      } as PreviewRecoveryError;
    }

    // Validar que o HEAD corresponde ao SHA esperado
    const head = getCurrentHead(target);
    if (head !== lastCheckpointSha) {
      throw {
        code: 'GIT_CHECKOUT_FAILED',
        message: `HEAD after checkout (${head}) does not match expected SHA (${lastCheckpointSha})`,
      } as PreviewRecoveryError;
    }

    await this.installDepsIfNeeded(target);
    return target;
  }

  /**
   * For NODE workspaces (with package.json), run `npm install` so the
   * project is ready to be served by `npm run dev`.
   * We do NOT modify package.json or generate artifacts that would alter
   * the checkpoint state.
   */
  private async installDepsIfNeeded(workspacePath: string): Promise<void> {
    if (!isNodeWorkspace(workspacePath)) return;

    try {
      execFileSync('npm', ['install', '--no-audit', '--no-fund', '--prefer-offline'], {
        cwd: workspacePath,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 180_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw {
        code: 'NPM_INSTALL_FAILED',
        message: `npm install failed: ${message}`,
      } as PreviewRecoveryError;
    }
  }

  private async waitForRefresh(sessionId: string): Promise<void> {
    for (let i = 0; i < 50; i++) {
      if (!this.refreshing.has(sessionId)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
