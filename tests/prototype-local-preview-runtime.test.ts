import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { LocalPreviewRuntime } from '../src/pp/preview/local-preview-runtime.js';

const runningRuntimes: Array<{ runtime: LocalPreviewRuntime; id: string }> = [];

async function makeWorkspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'pub-prototype-preview-test-'));
}

afterEach(async () => {
  for (const item of runningRuntimes.splice(0)) {
    await item.runtime.destroy(item.id).catch(() => undefined);
  }
});

function rawRequest(port: number, rawPath: string): Promise<number> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.connect(port, '127.0.0.1', () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let chunks = '';
    socket.on('data', (c) => { chunks += c.toString(); });
    socket.on('close', () => {
      const statusLine = chunks.split('\r\n')[0];
      const status = Number(statusLine.split(' ')[1]);
      resolve(status);
    });
  });
}

describe('LocalPreviewRuntime', () => {
  it('starts a dev server, exposes localhost preview, streams logs, and stops it', async () => {
    const runtime = new LocalPreviewRuntime();
    const workspace = await makeWorkspace();
    const info = await runtime.create({
      workspace,
      command: process.execPath,
      args: ['-e', `require('http').createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end('PUB PREVIEW OK')}).listen(Number(process.env.PORT),'127.0.0.1'); console.log('PREVIEW_STARTED')`],
      port: 0,
      startupTimeoutMs: 5_000,
      workspaceKind: 'node',
    });
    runningRuntimes.push({ runtime, id: info.id });

    const logs: string[] = [];
    const unsubscribe = runtime.subscribe(info.id, event => logs.push(`${event.stream}:${event.line}`));

    const ready = await runtime.start(info.id);
    expect(ready.status).toBe('READY');
    expect(ready.url).toBe(`http://127.0.0.1:${info.port}`);

    const response = await fetch(ready.url!);
    expect(await response.text()).toBe('PUB PREVIEW OK');
    expect(logs.some(line => line.includes('PREVIEW_STARTED'))).toBe(true);

    unsubscribe();
    const stopped = await runtime.stop(info.id);
    expect(stopped?.status).toBe('STOPPED');
    expect((await runtime.get(info.id))?.pid).toBeNull();

    await rm(workspace, { recursive: true, force: true });
  });

  it('serves static HTML, CSS and JS from index.html without package.json', async () => {
    const runtime = new LocalPreviewRuntime();
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>static</h1></body></html>', 'utf8');
    await writeFile(join(workspace, 'styles.css'), 'body{color:red}', 'utf8');
    await writeFile(join(workspace, 'script.js'), 'console.log(1)', 'utf8');

    const info = await runtime.create({
      workspace,
      command: '',
      args: [],
      port: 0,
      startupTimeoutMs: 5_000,
      workspaceKind: 'static',
    });
    runningRuntimes.push({ runtime, id: info.id });

    const ready = await runtime.start(info.id);
    expect(ready.status).toBe('READY');

    const base = ready.url!;
    const html = await fetch(base).then(r => r.text());
    expect(html).toContain('<h1>static</h1>');

    const css = await fetch(`${base}/styles.css`).then(r => r.text());
    expect(css).toBe('body{color:red}');

    const js = await fetch(`${base}/script.js`).then(r => r.text());
    expect(js).toBe('console.log(1)');

    await rm(workspace, { recursive: true, force: true });
  });

  it('serves / and /index.html and returns 404 for missing files', async () => {
    const runtime = new LocalPreviewRuntime();
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'index.html'), '<html><body>root</body></html>', 'utf8');

    const info = await runtime.create({
      workspace,
      command: '',
      args: [],
      port: 0,
      startupTimeoutMs: 5_000,
      workspaceKind: 'static',
    });
    runningRuntimes.push({ runtime, id: info.id });

    const ready = await runtime.start(info.id);
    const base = ready.url!;
    expect(await fetch(base).then(r => r.text())).toContain('root');
    expect(await fetch(`${base}/index.html`).then(r => r.text())).toContain('root');
    expect(await fetch(`${base}/missing.txt`).then(r => r.status)).toBe(404);

    await rm(workspace, { recursive: true, force: true });
  });

  it('rejects path traversal attempts with 400', async () => {
    const runtime = new LocalPreviewRuntime();
    const workspace = await makeWorkspace();
    await writeFile(join(workspace, 'index.html'), '<html><body><h1>safe</h1></body></html>', 'utf8');
    await writeFile(join(workspace, 'secret.txt'), 'secret', 'utf8');

    const info = await runtime.create({
      workspace,
      command: '',
      args: [],
      port: 0,
      startupTimeoutMs: 5_000,
      workspaceKind: 'static',
    });
    runningRuntimes.push({ runtime, id: info.id });

    const ready = await runtime.start(info.id);
    const base = ready.url!;
    const port = Number(new URL(base).port);

    // literal ../ via raw HTTP (fetch and Node.js normalize ../ client-side before sending)
    expect(await rawRequest(port, '/../secret.txt')).toBe(400);
    expect(await rawRequest(port, '/styles.css/../../../secret.txt')).toBe(400);

    // URL-encoded traversal variants (fetch preserves these, they reach the server)
    expect(await fetch(`${base}/%2e%2e%2fsecret.txt`).then(r => r.status)).toBe(400);
    expect(await fetch(`${base}/%2e%2e%5csecret.txt`).then(r => r.status)).toBe(400);
    expect(await fetch(`${base}/%2e%2e%2e%2e/secret.txt`).then(r => r.status)).toBe(400);
    expect(await rawRequest(port, '/%2e%2e/secret.txt')).toBe(400);
    expect(await rawRequest(port, '/%2e%2e%2fsecret.txt')).toBe(400);

    // legitimate requests still work
    expect(await fetch(`${base}/index.html`).then(r => r.status)).toBe(200);
    expect(await fetch(`${base}/missing.txt`).then(r => r.status)).toBe(404);

    await rm(workspace, { recursive: true, force: true });
  });

  it('reports real process failure instead of only fetch failed', async () => {
    const runtime = new LocalPreviewRuntime();
    const workspace = await makeWorkspace();
    const info = await runtime.create({
      workspace,
      command: process.execPath,
      args: ['-e', 'process.stderr.write("npm error Missing script: dev\\n"); process.exit(1);'],
      port: 0,
      startupTimeoutMs: 5_000,
      workspaceKind: 'node',
    });
    runningRuntimes.push({ runtime, id: info.id });

    const logs: string[] = [];
    runtime.subscribe(info.id, event => logs.push(`${event.stream}:${event.line}`));

    await expect(runtime.start(info.id)).rejects.toThrow(/preview failed to become ready: preview process exited with code=1/);

    const status = await runtime.get(info.id);
    expect(status?.status).toBe('FAILED');
    expect(status?.error).toMatch(/preview process exited with code=1/);

    await rm(workspace, { recursive: true, force: true });
  });
});
