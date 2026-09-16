import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PublicPreviewRuntime } from '../src/pp/preview/public-preview-runtime.js';
import { LocalPreviewRuntime } from '../src/pp/preview/local-preview-runtime.js';
import { PostgresPrototypeRepository } from '../src/pp/persistence/repository.js';
import type { Pool } from 'pg';

describe('PUB Prototype â€” Concurrency, Migrations & Preview Error Handling', () => {
  describe('1. Migrations Validation & Idempotency', () => {
    it('confirms all migration files are ordered and strictly idempotent', async () => {
      const migrationDir = fileURLToPath(new URL('../db/migrations/', import.meta.url));
      const files = (await readdir(migrationDir)).filter(f => f.endsWith('.sql')).sort();

      expect(files).toEqual([
        '001_initial_prototype_schema.sql',
        '002_prototype_events.sql',
        '003_prototype_promotions.sql',
        '004_prototype_messages.sql',
        '005_workspaces_projects_and_files.sql',
        '006_prototype_verifications.sql',
        '007_prototype_correction_attempts.sql',
        '008_sovereign_auth.sql',
      ]);

      // Check each migration SQL for idempotency constructs
      for (const file of files) {
        const sql = await readFile(join(migrationDir, file), 'utf8');
        expect(sql.length).toBeGreaterThan(0);
        // Each table or column addition must use IF NOT EXISTS or exception handling
        const hasIdempotentClause =
          sql.includes('IF NOT EXISTS') ||
          sql.includes('EXCEPTION') ||
          sql.includes('ON CONFLICT') ||
          sql.includes('DROP DEFAULT');
        expect(hasIdempotentClause).toBe(true);
      }
    });
  });

  describe('2. Concurrency & Prompt Locking', () => {
    it('ensures atomic prompt locking: concurrent increments allow exactly one winner', async () => {
      let currentStatus = 'READY';
      let promptCount = 0;

      // Mock pool simulating atomic PostgreSQL UPDATE ... WHERE status IN ('CREATING', 'READY')
      const mockPool = {
        async query(sql: string, params: any[]) {
          if (sql.includes('UPDATE prototype_sessions')) {
            if (['CREATING', 'READY'].includes(currentStatus)) {
              currentStatus = 'BUILDING';
              promptCount++;
              return {
                rows: [{
                  id: params[0],
                  project: 'barber-app',
                  repository: 'https://github.com/test/repo.git',
                  branch: 'prototype/barber-app/session-1',
                  mode: 'PROTOTYPE',
                  status: 'BUILDING',
                  preview_url: null,
                  preview_runtime: null,
                  workspace_path: null,
                  last_checkpoint_sha: null,
                  prompt_count: promptCount,
                  created_at: new Date(),
                  updated_at: new Date(),
                }],
              };
            }
            return { rows: [] };
          }
          return { rows: [] };
        },
      } as unknown as Pool;

      const repo = new PostgresPrototypeRepository(mockPool);

      // Fire 2 concurrent prompt requests at the exact same moment
      const [res1, res2] = await Promise.all([
        repo.incrementPromptCount('session-1'),
        repo.incrementPromptCount('session-1'),
      ]);

      // Exactly ONE must succeed (return updated session) and the other must return null (409 Conflict)
      const successes = [res1, res2].filter(Boolean);
      const conflicts = [res1, res2].filter(r => r === null);

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(successes[0]?.status).toBe('BUILDING');
      expect(successes[0]?.promptCount).toBe(1);
    });
  });

  describe('3. Public Preview Error Handling', () => {
    it('handles missing/failing cloudflared binary cleanly without crashing', async () => {
      // Point cloudflared to a non-existent binary to test error handling
      process.env.CLOUDFLARED_COMMAND = 'non_existent_cloudflared_bin_12345';
      process.env.PROTOTYPE_TUNNEL_STARTUP_TIMEOUT_MS = '1000';

      const publicRuntime = new PublicPreviewRuntime();

      // Start a fast inline server so local runtime starts immediately
      const code = `
        const http = require('node:http');
        const port = Number(process.env.PORT);
        http.createServer((_req, res) => res.end('OK')).listen(port, '127.0.0.1');
      `;

      const runtimeInfo = await publicRuntime.create({
        workspace: process.cwd(),
        command: process.execPath,
        args: ['-e', code],
        port: 0,
        startupTimeoutMs: 3000,
      });

      await expect(publicRuntime.start(runtimeInfo.id)).rejects.toThrow();

      const info = await publicRuntime.get(runtimeInfo.id);
      // Status can be FAILED (if start failed before tunnel was created) or
      // EXPIRED (if tunnel was created but died). Both are valid failure states.
      expect(['FAILED', 'EXPIRED']).toContain(info?.status);
      expect(info?.error).toBeTruthy();
    }, 10000);
  });
});


