import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResendEmailAdapter, ProductionEmailAdapter } from '../src/pp/auth/sovereign/claim.js';

describe('ResendEmailAdapter (Phase 4.4.2)', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('fails with RESEND_API_KEY_MISSING when apiKey is empty', async () => {
    const adapter = new ResendEmailAdapter({ apiKey: '', fromAddress: 'auth@pubcore.site' });
    const res = await adapter.sendClaimEmail({
      to: 'delivered@resend.dev',
      claimToken: 'clm_123',
      claimUrl: 'https://prototype.pubcore.internal/claim?token=clm_123',
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('RESEND_API_KEY_MISSING');
  });

  it('fails with EMAIL_FROM_MISSING when fromAddress is empty', async () => {
    const adapter = new ResendEmailAdapter({ apiKey: 're_test_123', fromAddress: '' });
    const res = await adapter.sendClaimEmail({
      to: 'delivered@resend.dev',
      claimToken: 'clm_123',
      claimUrl: 'https://prototype.pubcore.internal/claim?token=clm_123',
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('EMAIL_FROM_MISSING');
  });

  it('sends claim email via Resend REST API and parses message id', async () => {
    let capturedUrl = '';
    let capturedInit: any = null;

    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedInit = init;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'resend_msg_abc123' }),
      } as any;
    });

    const adapter = new ResendEmailAdapter({
      apiKey: 're_test_key_xyz',
      fromAddress: 'auth@pubcore.site',
    });

    const res = await adapter.sendClaimEmail({
      to: 'delivered@resend.dev',
      claimToken: 'clm_test_secret_token',
      claimUrl: 'https://prototype.pubcore.internal/claim?token=clm_test_secret_token',
    });

    expect(res.success).toBe(true);
    expect(res.messageId).toBe('resend_msg_abc123');
    expect(capturedUrl).toBe('https://api.resend.com/emails');
    expect(capturedInit.method).toBe('POST');
    expect(capturedInit.headers['Authorization']).toBe('Bearer re_test_key_xyz');

    const body = JSON.parse(capturedInit.body);
    expect(body.from).toBe('auth@pubcore.site');
    expect(body.to).toEqual(['delivered@resend.dev']);
    expect(body.subject).toContain('Ativação de Conta');
    expect(body.html).toContain('https://prototype.pubcore.internal/claim?token=clm_test_secret_token');
    expect(body.text).toContain('https://prototype.pubcore.internal/claim?token=clm_test_secret_token');
  });

  it('handles Resend API error responses gracefully', async () => {
    globalThis.fetch = vi.fn(async () => {
      return {
        ok: false,
        status: 403,
        json: async () => ({ message: 'Domain not verified' }),
      } as any;
    });

    const adapter = new ResendEmailAdapter({
      apiKey: 're_test_key_xyz',
      fromAddress: 'unverified@pubcore.site',
    });

    const res = await adapter.sendClaimEmail({
      to: 'delivered@resend.dev',
      claimToken: 'clm_123',
      claimUrl: 'https://prototype.pubcore.internal/claim?token=clm_123',
    });

    expect(res.success).toBe(false);
    expect(res.error).toBe('Domain not verified');
  });

  it('ProductionEmailAdapter delegates to ResendEmailAdapter when EMAIL_PROVIDER=resend', async () => {
    process.env.EMAIL_PROVIDER = 'resend';
    process.env.RESEND_API_KEY = 're_env_key';
    process.env.EMAIL_FROM = 'auth@pubcore.site';

    globalThis.fetch = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'resend_delegated_999' }),
      } as any;
    });

    const prodAdapter = new ProductionEmailAdapter();
    const res = await prodAdapter.sendClaimEmail({
      to: 'delivered@resend.dev',
      claimToken: 'clm_123',
      claimUrl: 'https://prototype.pubcore.internal/claim?token=clm_123',
    });

    expect(res.success).toBe(true);
    expect(res.messageId).toBe('resend_delegated_999');
  });
});
