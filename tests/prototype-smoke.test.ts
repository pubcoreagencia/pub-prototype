import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PrototypeEventStream } from '../src/pp/events/events.js';
import { LocalPreviewRuntime } from '../src/pp/preview/local-preview-runtime.js';

const running: Array<{ runtime: LocalPreviewRuntime; id: string; workspace: string }> = [];

async function cleanup(): Promise<void> {
  for (const item of running.splice(0)) {
    await item.runtime.destroy(item.id).catch(() => undefined);
    await rm(item.workspace, { recursive: true, force: true });
  }
}

afterEach(cleanup);

describe('PUB Prototype deterministic smoke flow', () => {
  it('creates a preview, exposes the app, emits lifecycle events, and stops cleanly', async () => {
    const runtime = new LocalPreviewRuntime();
    const events = new PrototypeEventStream();
    const workspace = await mkdtemp(join(tmpdir(), 'pub-prototype-smoke-'));

    const port = 0;
    const source = [
      "const http = require('node:http');",
      "const port = Number(process.env.PORT);",
      "http.createServer((_req, res) => { res.writeHead(200, {'content-type':'text/plain'}); res.end('BARBER PROTOTYPE OK'); }).listen(port, '127.0.0.1', () => console.log('PREVIEW_READY'));",
    ].join('\n');
    await writeFile(join(workspace, 'server.cjs'), source, 'utf8');

    const received: string[] = [];
    events.subscribe(event => received.push(event.type));
    events.emit({ sessionId: 'smoke-session', type: 'PREVIEW_STARTED', payload: { phase: 'smoke' } });

    const created = await runtime.create({
      workspace,
      command: process.execPath,
      args: ['server.cjs'],
      port,
      startupTimeoutMs: 5_000,
      workspaceKind: 'node',
    });
    running.push({ runtime, id: created.id, workspace });

    const ready = await runtime.start(created.id);
    expect(ready.status).toBe('READY');
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

    const response = await fetch(ready.url!);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('BARBER PROTOTYPE OK');

    events.emit({ sessionId: 'smoke-session', type: 'PREVIEW_READY', payload: { url: ready.url } });
    expect(received).toEqual(['PREVIEW_STARTED', 'PREVIEW_READY']);

    const stopped = await runtime.stop(created.id);
    expect(stopped?.status).toBe('STOPPED');
  });
});
