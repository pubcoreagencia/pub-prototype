import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoisted mocks — must come before any import that uses child_process
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn());
const mockAccess = vi.hoisted(() => vi.fn());
const mockMkdir = vi.hoisted(() => vi.fn());
const mockRm = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));
vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  default: { existsSync: mockExistsSync },
}));
vi.mock('node:fs/promises', () => ({
  access: mockAccess,
  mkdir: mockMkdir,
  rm: mockRm,
}));

// Now import the service
import { PreviewRecoveryService } from '../src/pp/preview/preview-recovery.js';

// Mock PostgresPrototypeRepository (still constructed normally)
const createMockPrototypes = () => {
  const sessions: Map<string, any> = new Map();
  const updateSession = vi.fn(async (sessionId: string, patch: any) => {
    const existing = sessions.get(sessionId);
    if (!existing) return null;
    sessions.set(sessionId, { ...existing, ...patch });
    return sessions.get(sessionId);
  });
  const getSession = vi.fn(async (sessionId: string) => sessions.get(sessionId) || null);
  const listSessions = vi.fn(async () => Array.from(sessions.values()));

  return {
    getSession,
    updateSession,
    listSessions,
    addSession: (s: any) => sessions.set(s.id, s),
  };
};

function makeSession(overrides: any = {}) {
  return {
    status: 'READY',
    repository: 'https://github.com/pubcoreagencia/pub-dev-loop-prototypes.git',
    lastCheckpointSha: 'a'.repeat(40),
    branch: 'prototype/test-session',
    workspacePath: '/tmp/pub-prototype/test',
    previewRuntime: null,
    previewUrl: null,
    ...overrides,
  };
}

describe('PreviewRecoveryService - Git-based reconstruction', () => {
  let service: PreviewRecoveryService;
  let mockPrototypes: ReturnType<typeof createMockPrototypes>;

  beforeEach(() => {
    vi.clearAllMocks();

    // Default mock behaviors
    mockExecFileSync.mockImplementation((cmd: string, args: any) => {
      if (cmd === 'git' && args?.[1] === 'HEAD') return 'a'.repeat(40);
      return '';
    });
    mockExistsSync.mockReturnValue(false); // sem package.json por padrão
    mockAccess.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);

    mockPrototypes = createMockPrototypes();
    service = new PreviewRecoveryService(mockPrototypes);
  });

  describe('validações de sessão', () => {
    it('deve falhar com SESSION_NOT_FOUND para sessão inexistente', async () => {
      await expect(service.refresh('inexistente')).rejects.toMatchObject({
        code: 'SESSION_NOT_FOUND',
      });
    });

    it('deve falhar com NOT_READY se status não for READY', async () => {
      const id = 'not-ready-' + Date.now();
      mockPrototypes.addSession(makeSession({ id, status: 'BUILDING' }));
      await expect(service.refresh(id)).rejects.toMatchObject({ code: 'NOT_READY' });
    });

    it('deve falhar com NO_CHECKPOINT se lastCheckpointSha for null', async () => {
      const id = 'no-checkpoint-' + Date.now();
      mockPrototypes.addSession(makeSession({ id, lastCheckpointSha: null }));
      await expect(service.refresh(id)).rejects.toMatchObject({ code: 'NO_CHECKPOINT' });
    });

    it('deve falhar com WORKSPACE_MISSING se repository for null', async () => {
      const id = 'no-repo-' + Date.now();
      mockPrototypes.addSession(makeSession({ id, repository: null }));
      await expect(service.refresh(id)).rejects.toMatchObject({ code: 'WORKSPACE_MISSING' });
    });
  });

  describe('reconstrução via Git (STATIC)', () => {
    it('deve fazer git clone + checkout + iniciar preview', async () => {
      const id = 'static-' + Date.now();
      const sha = 'a'.repeat(40);
      mockPrototypes.addSession(makeSession({ id, lastCheckpointSha: sha }));

      // Forçar workspace inexistente (mockAccess rejected)
      mockAccess.mockRejectedValue(new Error('ENOENT'));

      vi.spyOn(service['preview'], 'create').mockResolvedValue({
        id: 'rt-' + id, status: 'CREATING', url: null, port: 0,
      });
      vi.spyOn(service['preview'], 'start').mockResolvedValue({
        id: 'rt-' + id, status: 'READY', url: 'https://new.trycloudflare.com', port: 3000,
      });
      vi.spyOn(service['preview'], 'destroy').mockResolvedValue();

      const result = await service.refresh(id);

      expect(result.previewUrl).toBe('https://new.trycloudflare.com');
      expect(mockPrototypes.updateSession).toHaveBeenCalledWith(id, {
        previewUrl: 'https://new.trycloudflare.com',
        previewRuntime: 'rt-' + id,
      });

      // Validar comandos git executados
      const gitArgs = mockExecFileSync.mock.calls
        .filter((c: any) => c[0] === 'git')
        .map((c: any) => c[1]);
      expect(gitArgs.some((a: any) => a[0] === 'clone')).toBe(true);
      expect(gitArgs.some((a: any) => a[0] === 'checkout' && a[1] === sha)).toBe(true);
      expect(gitArgs.some((a: any) => a[0] === 'rev-parse' && a[1] === 'HEAD')).toBe(true);
    });

    it('deve reutilizar workspace existente se HEAD já é o SHA esperado', async () => {
      const id = 'reuse-' + Date.now();
      const sha = 'b'.repeat(40);
      mockPrototypes.addSession(makeSession({ id, lastCheckpointSha: sha }));

      // Simular que o workspace já existe e está no SHA correto
      mockAccess.mockResolvedValue(undefined); // .git existe
      mockExecFileSync.mockImplementation((cmd: string, args: any) => {
        if (cmd === 'git' && args?.[1] === 'HEAD') return sha; // mesmo SHA
        return '';
      });

      vi.spyOn(service['preview'], 'create').mockResolvedValue({
        id: 'rt', status: 'CREATING', url: null, port: 0,
      });
      vi.spyOn(service['preview'], 'start').mockResolvedValue({
        id: 'rt', status: 'READY', url: 'https://reuse.trycloudflare.com', port: 3000,
      });
      vi.spyOn(service['preview'], 'destroy').mockResolvedValue();

      await service.refresh(id);

      // Não deve ter feito clone (workspace já válido)
      const gitArgs = mockExecFileSync.mock.calls
        .filter((c: any) => c[0] === 'git')
        .map((c: any) => c[1]);
      expect(gitArgs.some((a: any) => a[0] === 'clone')).toBe(false);
    });
  });

  describe('reconstrução via Git (NODE)', () => {
    it('deve executar npm install para workspace com package.json', async () => {
      const id = 'node-' + Date.now();
      mockPrototypes.addSession(makeSession({ id }));

      // existsSync retorna true para package.json
      mockExistsSync.mockImplementation((p: any) => String(p).endsWith('package.json'));

      vi.spyOn(service['preview'], 'create').mockResolvedValue({
        id: 'rt-' + id, status: 'CREATING', url: null, port: 0,
      });
      vi.spyOn(service['preview'], 'start').mockResolvedValue({
        id: 'rt-' + id, status: 'READY', url: 'https://node.trycloudflare.com', port: 3000,
      });
      vi.spyOn(service['preview'], 'destroy').mockResolvedValue();

      await service.refresh(id);

      // Deve ter chamado npm install
      const npmCalls = mockExecFileSync.mock.calls
        .filter((c: any) => c[0] === 'npm')
        .map((c: any) => c[1]);
      expect(npmCalls.some((a: any) => a[0] === 'install')).toBe(true);
    });

    it('deve falhar com NPM_INSTALL_FAILED se npm install falhar', async () => {
      const id = 'node-fail-' + Date.now();
      mockPrototypes.addSession(makeSession({ id }));
      mockExistsSync.mockImplementation((p: any) => String(p).endsWith('package.json'));
      mockExecFileSync.mockImplementation((cmd: string, args: any) => {
        if (cmd === 'npm' && args?.[0] === 'install') throw new Error('EACCES');
        if (cmd === 'git' && args?.[1] === 'HEAD') return 'a'.repeat(40);
        return '';
      });

      await expect(service.refresh(id)).rejects.toMatchObject({ code: 'NPM_INSTALL_FAILED' });
    });
  });

  describe('validação de SHA', () => {
    it('deve falhar com GIT_CHECKOUT_FAILED se HEAD divergir do SHA esperado', async () => {
      const id = 'mismatch-' + Date.now();
      mockPrototypes.addSession(makeSession({ id, lastCheckpointSha: 'a'.repeat(40) }));

      mockExecFileSync.mockImplementation((cmd: string, args: any) => {
        if (cmd === 'git' && args?.[1] === 'HEAD') return 'z'.repeat(40); // divergente
        return '';
      });

      await expect(service.refresh(id)).rejects.toMatchObject({ code: 'GIT_CHECKOUT_FAILED' });
    });

    it('deve falhar com GIT_CLONE_FAILED se clone falhar', async () => {
      const id = 'clone-fail-' + Date.now();
      mockPrototypes.addSession(makeSession({ id }));

      mockExecFileSync.mockImplementation((cmd: string, args: any) => {
        if (cmd === 'git' && args?.[0] === 'clone') throw new Error('not found');
        return '';
      });

      await expect(service.refresh(id)).rejects.toMatchObject({ code: 'GIT_CLONE_FAILED' });
    });
  });

  describe('persistência', () => {
    it('deve atualizar apenas previewUrl e previewRuntime', async () => {
      const id = 'persist-' + Date.now();
      const sha = 'c'.repeat(40);
      mockPrototypes.addSession(makeSession({ id, lastCheckpointSha: sha }));

      // Forçar rev-parse a retornar o SHA específico desta sessão
      mockExecFileSync.mockImplementation((cmd: string, args: any) => {
        if (cmd === 'git' && args?.[1] === 'HEAD') return sha;
        return '';
      });

      vi.spyOn(service['preview'], 'create').mockResolvedValue({
        id: 'rt', status: 'CREATING', url: null, port: 0,
      });
      vi.spyOn(service['preview'], 'start').mockResolvedValue({
        id: 'rt', status: 'READY', url: 'https://new.trycloudflare.com', port: 3000,
      });
      vi.spyOn(service['preview'], 'destroy').mockResolvedValue();

      await service.refresh(id);

      const patch = mockPrototypes.updateSession.mock.calls[0][1];
      expect(patch.previewUrl).toBe('https://new.trycloudflare.com');
      expect(patch.previewRuntime).toBe('rt');
      expect(patch.lastCheckpointSha).toBeUndefined();
      expect(patch.promptCount).toBeUndefined();
    });
  });

  describe('concorrência', () => {
    it('deve evitar dois recoveries simultâneos para a mesma sessão', async () => {
      const id = 'concurrent-' + Date.now();
      mockPrototypes.addSession(makeSession({ id }));

      const createSpy = vi
        .spyOn(service['preview'], 'create')
        .mockImplementation(async () => {
          await new Promise((r) => setTimeout(r, 50));
          return { id: 'rt', status: 'CREATING', url: null, port: 0 };
        });
      vi.spyOn(service['preview'], 'start').mockResolvedValue({
        id: 'rt', status: 'READY', url: 'https://shared.trycloudflare.com', port: 3000,
      });
      vi.spyOn(service['preview'], 'destroy').mockResolvedValue();

      const [r1, r2] = await Promise.all([service.refresh(id), service.refresh(id)]);

      expect(r1.previewUrl).toBe('https://shared.trycloudflare.com');
      expect(r2.previewUrl).toBe('https://shared.trycloudflare.com');
      // create deve ter sido chamado uma única vez
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('deve permitir recoveries simultâneos para sessões diferentes', async () => {
      const id1 = 'sess-1-' + Date.now();
      const id2 = 'sess-2-' + Date.now();
      mockPrototypes.addSession(makeSession({ id: id1 }));
      mockPrototypes.addSession(makeSession({ id: id2 }));

      const createSpy = vi
        .spyOn(service['preview'], 'create')
        .mockImplementation(async (cfg: any) => ({
          id: 'rt-' + cfg.workspace,
          status: 'CREATING',
          url: null,
          port: 0,
        }));
      vi.spyOn(service['preview'], 'start').mockImplementation(async (rtId: string) => ({
        id: rtId,
        status: 'READY',
        url: 'https://' + rtId + '.trycloudflare.com',
        port: 3000,
      }));
      vi.spyOn(service['preview'], 'destroy').mockResolvedValue();

      const [r1, r2] = await Promise.all([service.refresh(id1), service.refresh(id2)]);

      expect(r1.sessionId).toBe(id1);
      expect(r2.sessionId).toBe(id2);
      expect(createSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('cleanup', () => {
    it('deve destruir runtime antigo antes de criar novo', async () => {
      const id = 'cleanup-' + Date.now();
      mockPrototypes.addSession(
        makeSession({ id, previewRuntime: 'old-runtime', previewUrl: 'https://old.com' })
      );

      const destroySpy = vi.spyOn(service['preview'], 'destroy').mockResolvedValue();
      vi.spyOn(service['preview'], 'create').mockResolvedValue({
        id: 'new', status: 'CREATING', url: null, port: 0,
      });
      vi.spyOn(service['preview'], 'start').mockResolvedValue({
        id: 'new', status: 'READY', url: 'https://new.com', port: 3000,
      });

      await service.refresh(id);

      expect(destroySpy).toHaveBeenCalledWith('old-runtime');
    });
  });

  describe('isPreviewReachable', () => {
    it('deve retornar true para URL acessível', async () => {
      global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
      expect(await service.isPreviewReachable('https://live.com')).toBe(true);
    });

    it('deve retornar false para fetch rejeitado', async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
      expect(await service.isPreviewReachable('https://dead.com')).toBe(false);
    });
  });
});
