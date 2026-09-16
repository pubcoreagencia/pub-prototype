import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as sovereignAuth from '../src/pp/ui/sovereign-auth.js';
import * as apiClient from '../src/pp/ui/api-client.js';
import { prototypeUiHtml } from '../src/pp/ui/ui.js';

describe('PP Sovereign Auth Phase 4.1 — Browser UX Integration & Independence', () => {
  beforeEach(() => {
    sovereignAuth.clearAuthSession();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    sovereignAuth.clearAuthSession();
    vi.restoreAllMocks();
  });

  it('prototypeUiHtml renders all required Sovereign Auth UI overlays', () => {
    const html = prototypeUiHtml();

    // 1. Session bootstrap splash
    expect(html).toContain('id="authBootstrapScreen"');
    expect(html).toContain('Carregando PUB Prototype...');

    // 2. Login screen
    expect(html).toContain('id="sovereignLoginOverlay"');
    expect(html).toContain('id="loginForm"');
    expect(html).toContain('id="loginEmail"');
    expect(html).toContain('id="loginPassword"');
    expect(html).toContain('id="loginSubmitBtn"');
    expect(html).toContain('id="goToSignupLink"');

    // 3. Signup screen
    expect(html).toContain('id="sovereignSignupOverlay"');
    expect(html).toContain('id="signupForm"');
    expect(html).toContain('id="signupName"');
    expect(html).toContain('id="signupEmail"');
    expect(html).toContain('id="signupPassword"');
    expect(html).toContain('id="signupPasswordConfirm"');
    expect(html).toContain('id="signupSubmitBtn"');
    expect(html).toContain('id="goToLoginLink"');

    // 4. Workspace Onboarding screen
    expect(html).toContain('id="sovereignOnboardingOverlay"');
    expect(html).toContain('id="onboardingForm"');
    expect(html).toContain('id="onboardingWsName"');
    expect(html).toContain('id="onboardingWsSlug"');
    expect(html).toContain('id="onboardingSubmitBtn"');

    // 5. User dropdown & logout
    expect(html).toContain('id="userPillBtn"');
    expect(html).toContain('id="userMenuDropdown"');
    expect(html).toContain('id="userLogoutBtn"');

    // 6. Scripts include sovereign bootstrap and recovery
    expect(html).toContain('bootstrapSovereignAppSession');
    expect(html).toContain('refreshSovereignSession');
    expect(html).toContain('handleSovereignLogin');
    expect(html).toContain('handleSovereignSignup');
    expect(html).toContain('handleSovereignOnboarding');
    expect(html).toContain('handleSovereignLogout');
  });

  it('apiClient prioritizes sovereign in-memory token and sovereignFetch', async () => {
    sovereignAuth.setAccessToken('sovereign-in-memory-jwt-xyz');

    expect(apiClient.getAuthToken()).toBe('sovereign-in-memory-jwt-xyz');

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => ({ ok: true }),
      } as any;
    });
    globalThis.fetch = fetchMock;

    await apiClient.apiFetch('/prototype/projects');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0];
    const calledInit = fetchMock.mock.calls[0][1];
    expect(calledUrl).toBe('/prototype/projects');
    expect(calledInit?.credentials).toBe('include');
    expect(new Headers(calledInit?.headers).get('Authorization')).toBe('Bearer sovereign-in-memory-jwt-xyz');
  });

  it('sovereignFetch executes single retry upon 401 without infinite loop', async () => {
    sovereignAuth.setAccessToken('expired-access-token');

    let fetchCount = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/prototype/auth/refresh') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ accessToken: 'new-valid-access-token' }),
        } as any;
      }
      if (url === '/prototype/projects') {
        fetchCount++;
        const auth = new Headers(init?.headers).get('Authorization');
        if (auth === 'Bearer expired-access-token') {
          return { ok: false, status: 401 } as any;
        }
        if (auth === 'Bearer new-valid-access-token') {
          return { ok: true, status: 200, json: async () => ({ projects: [] }) } as any;
        }
      }
      return { ok: false, status: 500 } as any;
    });

    globalThis.fetch = fetchMock;

    const res = await sovereignAuth.sovereignFetch('/prototype/projects');
    expect(res.ok).toBe(true);
    expect(fetchCount).toBe(2);
    expect(sovereignAuth.getAccessToken()).toBe('new-valid-access-token');
  });

  it('sovereignFetch stops immediately if refreshed token also fails 401 (no infinite loop)', async () => {
    sovereignAuth.setAccessToken('bad-token');

    let projectCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === '/prototype/auth/refresh') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ accessToken: 'another-still-bad-token' }),
        } as any;
      }
      if (url === '/prototype/projects') {
        projectCalls++;
        return { ok: false, status: 401 } as any;
      }
      return { ok: false, status: 500 } as any;
    });

    globalThis.fetch = fetchMock;

    const res = await sovereignAuth.sovereignFetch('/prototype/projects');
    expect(res.status).toBe(401);
    expect(projectCalls).toBe(2); // Initial attempt + exactly 1 retry
  });

  it('proves complete independence from pubcore.site and postMessage in sovereign mode', () => {
    sovereignAuth.setAccessToken('purely-sovereign-token');

    // Does not require pubcore.site postMessage to establish session
    expect(apiClient.getAuthToken()).toBe('purely-sovereign-token');

    // Untrusted postMessage is rejected and does not overwrite sovereign auth
    const falseEvent = { origin: 'https://attacker.com', data: { type: 'PUB_AUTH_TOKEN_UPDATE', token: 'evil' } };
    const handled = apiClient.handleHostPostMessage(falseEvent);
    expect(handled).toBe(false);
    expect(apiClient.getAuthToken()).toBe('purely-sovereign-token');
  });
});
