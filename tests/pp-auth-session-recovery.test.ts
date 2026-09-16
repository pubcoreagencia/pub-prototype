import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { apiFetch, handleHostPostMessage, requestTokenRefreshFromHost, getAuthToken } from '../src/pp/ui/api-client.js';

describe('PP Auth Session Recovery & Resilient apiFetch', () => {
  let mockStorage: Record<string, string>;

  beforeEach(() => {
    mockStorage = {};
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => mockStorage[key] || null,
      setItem: (key: string, val: string) => { mockStorage[key] = String(val); },
      removeItem: (key: string) => { delete mockStorage[key]; },
      clear: () => { mockStorage = {}; },
      get length() { return Object.keys(mockStorage).length; },
      key: (i: number) => Object.keys(mockStorage)[i] || null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // TESTE 1: Request normal -> 200
  it('1. Token válido: request retorna 200 diretamente sem retry', async () => {
    mockStorage['pub-prototype:token'] = 'valid-token-123';
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://api.pubcore.site/prototype/sessions');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const callArgs = fetchMock.mock.calls[0];
    const headers = new Headers(callArgs[1].headers);
    expect(headers.get('Authorization')).toBe('Bearer valid-token-123');
  });

  // TESTE 2: 401 + token novo disponível no storage -> retry -> 200
  it('2. 401 com token já renovado no storage: executa exatamente 1 retry e tem sucesso', async () => {
    mockStorage['pub-prototype:token'] = 'old-expired-token';

    let calls = 0;
    const fetchMock = vi.fn().mockImplementation((url, opts) => {
      calls++;
      if (calls === 1) {
        // Durante a primeira chamada, o Host atualiza o token no storage
        mockStorage['pub-prototype:token'] = 'new-refreshed-token-456';
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://api.pubcore.site/prototype/sessions/123/prompts', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'test' }),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Primeira chamada com token antigo
    const headers1 = new Headers(fetchMock.mock.calls[0][1].headers);
    expect(headers1.get('Authorization')).toBe('Bearer old-expired-token');

    // Segunda chamada com token renovado
    const headers2 = new Headers(fetchMock.mock.calls[1][1].headers);
    expect(headers2.get('Authorization')).toBe('Bearer new-refreshed-token-456');
  });

  // TESTE 3: 401 + solicitação de refresh -> PUB_AUTH_TOKEN_UPDATE -> retry -> 200
  it('3. 401 com solicitação de refresh: simula postMessage do Host e completa retry único', async () => {
    mockStorage['pub-prototype:token'] = 'token-expired';

    // Mock window & postMessage
    const postMessageSpy = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: 'https://pp-api-production-24bc.up.railway.app' },
      parent: { postMessage: postMessageSpy },
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });

    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) {
        // Simula host respondendo a PUB_AUTH_REFRESH_REQUEST após 100ms
        setTimeout(() => {
          handleHostPostMessage({
            origin: 'https://pubcore.site',
            data: { type: 'PUB_AUTH_TOKEN_UPDATE', token: 'token-after-refresh' },
          });
        }, 100);
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 202 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://api.pubcore.site/prototype/sessions/abc/prompts', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'Create UI' }),
    });

    expect(res.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(postMessageSpy).toHaveBeenCalledWith(
      { type: 'PUB_AUTH_REFRESH_REQUEST' },
      'https://pubcore.site'
    );
  });

  // TESTE 4: 401 persistente -> exatamente 1 retry -> falha final
  it('4. 401 persistente: executa no máximo 1 retry e não entra em loop', async () => {
    mockStorage['pub-prototype:token'] = 'permanently-invalid';

    // Se o token mudar para outro token que também é 401
    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++;
      if (calls === 1) {
        mockStorage['pub-prototype:token'] = 'also-invalid-token';
      }
      return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await apiFetch('https://api.pubcore.site/prototype/sessions');
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2); // Exatamente 1 retry inicial, sem loop infinito
  });

  // TESTE 5: Proteção contra loop: se token não mudar, não faz retry repetido
  it('5. Proteção contra loop: se token não muda, retorna a resposta 401 sem disparar outro fetch', async () => {
    mockStorage['pub-prototype:token'] = 'unrefreshable-token';

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    // Encurta janela de timeout no teste
    vi.stubGlobal('window', {
      location: { origin: 'https://pp-api-production-24bc.up.railway.app' },
      parent: { postMessage: vi.fn() },
    });

    const res = await apiFetch('https://api.pubcore.site/test');
    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // TESTE 6: Validação de segurança em postMessage
  it('6. Segurança: rejeita PUB_AUTH_TOKEN_UPDATE de origin não autorizada', () => {
    mockStorage['pub-prototype:token'] = 'original-token';

    const acceptedEvil = handleHostPostMessage({
      origin: 'https://malicious-site.com',
      data: { type: 'PUB_AUTH_TOKEN_UPDATE', token: 'hacked-token' },
    });
    expect(acceptedEvil).toBe(false);
    expect(mockStorage['pub-prototype:token']).toBe('original-token');

    const acceptedGood = handleHostPostMessage({
      origin: 'https://pubcore.site',
      data: { type: 'PUB_AUTH_TOKEN_UPDATE', token: 'legit-refreshed-token' },
    });
    expect(acceptedGood).toBe(true);
    expect(mockStorage['pub-prototype:token']).toBe('legit-refreshed-token');
  });

  // TESTE 7: refresh_token nunca é aceito nem enviado
  it('7. Segurança: nunca transporta nem persiste refresh_token', () => {
    const accepted = handleHostPostMessage({
      origin: 'https://pubcore.site',
      data: {
        type: 'PUB_AUTH_TOKEN_UPDATE',
        token: 'access-jwt-only',
        refresh_token: 'secret-refresh-should-be-ignored',
      } as any,
    });
    expect(accepted).toBe(true);
    expect(mockStorage['pub-prototype:token']).toBe('access-jwt-only');
    expect(mockStorage['refresh_token']).toBeUndefined();
    expect(mockStorage['pub-prototype:refresh_token']).toBeUndefined();
  });

  // TESTE 8: Múltiplos 401 simultâneos compartilham uma única solicitação de refresh
  it('8. Concorrência: múltiplos requests com 401 compartilham uma única solicitação ao Host', async () => {
    mockStorage['pub-prototype:token'] = 'stale-token';

    const postMessageSpy = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: 'https://pp-api-production-24bc.up.railway.app' },
      parent: { postMessage: postMessageSpy },
    });

    let calls = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      calls++;
      if (calls <= 3) {
        // Simula atualização rápida após 50ms
        setTimeout(() => {
          mockStorage['pub-prototype:token'] = 'batch-refreshed-token';
        }, 50);
        return Promise.resolve(new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    // Dispara 3 requisições simultâneas
    const [res1, res2, res3] = await Promise.all([
      apiFetch('https://api.pubcore.site/req1'),
      apiFetch('https://api.pubcore.site/req2'),
      apiFetch('https://api.pubcore.site/req3'),
    ]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res3.status).toBe(200);

    // postMessage de refresh deve ter sido chamado no máximo UMA vez (desduplicado pela activeRefreshPromise)
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
  });
});
