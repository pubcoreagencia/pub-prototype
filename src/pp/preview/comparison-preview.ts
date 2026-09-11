import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PreviewRuntime, PreviewRuntimeInfo } from './preview-runtime.js';

export interface ComparisonPreview {
  id: string;
  sessionId: string;
  checkpointId: string;
  workspace: string;
  runtimeId: string;
  info: PreviewRuntimeInfo;
  createdAt: Date;
}

const WORKTREE_ROOT = process.env.PROTOTYPE_COMPARISON_ROOT ?? '/tmp/pub-prototype-comparison';

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export class PrototypeComparisonPreviewManager {
  private readonly previews = new Map<string, ComparisonPreview>();

  constructor(private readonly runtime: PreviewRuntime) {}

  async create(input: {
    sessionId: string;
    checkpointId: string;
    repositoryWorkspace: string;
    commitSha: string;
    command: string;
    args: string[];
    publicBaseUrl?: string;
  }): Promise<ComparisonPreview> {
    const id = randomUUID();
    const workspace = path.join(WORKTREE_ROOT, input.sessionId, id);
    await mkdir(path.dirname(workspace), { recursive: true });

    git(['worktree', 'add', '--detach', workspace, input.commitSha], input.repositoryWorkspace);

    try {
      const created = await this.runtime.create({
        workspace,
        command: input.command,
        args: input.args,
        port: 0,
        publicBaseUrl: input.publicBaseUrl,
        startupTimeoutMs: Number(process.env.PROTOTYPE_PREVIEW_STARTUP_TIMEOUT_MS ?? 60000),
        environment: { NODE_ENV: 'development' },
        workspaceKind: 'node',
      });
      const started = await this.runtime.start(created.id);
      const comparison: ComparisonPreview = {
        id,
        sessionId: input.sessionId,
        checkpointId: input.checkpointId,
        workspace,
        runtimeId: created.id,
        info: started,
        createdAt: new Date(),
      };
      this.previews.set(id, comparison);
      return comparison;
    } catch (error) {
      await this.removeWorktree(input.repositoryWorkspace, workspace);
      throw error;
    }
  }

  async get(id: string): Promise<ComparisonPreview | null> {
    const preview = this.previews.get(id);
    if (!preview) return null;
    const info = await this.runtime.get(preview.runtimeId);
    if (info) preview.info = info;
    return { ...preview };
  }

  async destroy(id: string, repositoryWorkspace: string): Promise<void> {
    const preview = this.previews.get(id);
    if (!preview) return;
    await this.runtime.destroy(preview.runtimeId);
    await this.removeWorktree(repositoryWorkspace, preview.workspace);
    this.previews.delete(id);
  }

  private async removeWorktree(repositoryWorkspace: string, workspace: string): Promise<void> {
    try {
      git(['worktree', 'remove', '--force', workspace], repositoryWorkspace);
    } catch {
      // Best effort cleanup; the runtime remains authoritative for process lifecycle.
    }
  }
}
