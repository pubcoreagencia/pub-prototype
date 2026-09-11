import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PrototypeComparisonPreviewManager } from '../src/pp/preview/comparison-preview.js';
import type { PreviewRuntime, PreviewRuntimeConfig, PreviewRuntimeInfo, PreviewLogEvent } from '../src/pp/preview/preview-runtime.js';

class FakePreviewRuntime implements PreviewRuntime {
  private readonly records = new Map<string, PreviewRuntimeInfo>();
  private counter = 0;

  async create(_config: PreviewRuntimeConfig): Promise<PreviewRuntimeInfo> {
    const id = `fake-${++this.counter}`;
    const info: PreviewRuntimeInfo = { id, status: 'CREATING', url: null, port: 4100 + this.counter, pid: null, startedAt: null, stoppedAt: null, error: null };
    this.records.set(id, info);
    return info;
  }
  async start(runtimeId: string): Promise<PreviewRuntimeInfo> {
    const previous = this.records.get(runtimeId)!;
    const info = { ...previous, status: 'READY' as const, url: `http://127.0.0.1:${previous.port}`, startedAt: new Date() };
    this.records.set(runtimeId, info);
    return info;
  }
  async get(runtimeId: string) { return this.records.get(runtimeId) ?? null; }
  async stop(runtimeId: string) { return this.records.get(runtimeId) ?? null; }
  async destroy(runtimeId: string) { this.records.delete(runtimeId); }
  subscribe(_runtimeId: string, _listener: (event: PreviewLogEvent) => void) { return () => undefined; }
}

function git(args: string[], cwd: string) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('PrototypeComparisonPreviewManager', () => {
  it('creates an isolated worktree from the requested checkpoint commit', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pp-comparison-test-'));
    const repo = path.join(root, 'repo');
    await execFileSync('git', ['init', repo], { encoding: 'utf8' });
    git(['config', 'user.email', 'test@example.com'], repo);
    git(['config', 'user.name', 'Prototype Test'], repo);

    await writeFile(path.join(repo, 'version.txt'), 'v1');
    git(['add', '.'], repo);
    const firstCommit = git(['commit', '-m', 'v1'], repo);
    const firstSha = git(['rev-parse', 'HEAD'], repo);
    expect(firstSha).toBeTruthy();
    expect(firstCommit).toContain('v1');

    await writeFile(path.join(repo, 'version.txt'), 'v2');
    git(['add', '.'], repo);
    git(['commit', '-m', 'v2'], repo);

    const runtime = new FakePreviewRuntime();
    const manager = new PrototypeComparisonPreviewManager(runtime);
    const comparison = await manager.create({
      sessionId: 'session-1',
      checkpointId: 'checkpoint-1',
      repositoryWorkspace: repo,
      commitSha: firstSha,
      command: 'npm',
      args: ['run', 'dev'],
    });

    expect(comparison.info.status).toBe('READY');
    expect(comparison.info.url).toContain('127.0.0.1');
    expect(await readFile(path.join(comparison.workspace, 'version.txt'), 'utf8')).toBe('v1');

    await manager.destroy(comparison.id, repo);
    await rm(root, { recursive: true, force: true });
  });
});
