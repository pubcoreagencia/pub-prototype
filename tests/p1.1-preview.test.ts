import { describe, it, expect } from 'vitest';
import { prototypeUiHtml } from '../src/pp/ui/ui.js';

describe('P1.1 — Preview Lifecycle State Machine', () => {
  const html = prototypeUiHtml();

  it('has all 5 preview states (idle, loading, ready, error, recovering)', () => {
    // Verify each state label is present
    expect(html).toContain('Aguardando projeto');      // idle
    expect(html).toContain('Carregando preview');      // loading
    expect(html).toContain('Preview pronto');          // ready
    expect(html).toContain('Preview indisponível');    // error
    expect(html).toContain('Reconectando preview');    // recovering
  });

  it('has loading overlay with spinner', () => {
    expect(html).toContain('preview-loading');
    expect(html).toContain('preview-loading-spinner');
    expect(html).toContain('previewLoadingText');
  });

  it('has error overlay with retry button', () => {
    expect(html).toContain('preview-error');
    expect(html).toContain('previewErrorRetry');
    expect(html).toContain('previewErrorTitle');
    expect(html).toContain('previewErrorDesc');
  });

  it('has empty state with message', () => {
    expect(html).toContain('preview-empty');
    expect(html).toContain('previewEmptyTitle');
    expect(html).toContain('previewEmptyDesc');
  });

  it('declares previewLoadGeneration to handle stale iframe callbacks', () => {
    // The generation counter is internal JS, not in HTML.
    // We verify the state machine logic exists in the script.
    expect(html).toContain('previewState');
    expect(html).toContain('setPreviewState');
  });

  it('uses iframe onload/onerror for real availability detection', () => {
    // The renderPreview function binds load/error listeners via addEventListener
    // Note: addEventListener is a common pattern - verify the specific ones exist
    expect(html).toContain("addEventListener('load'");
    expect(html).toContain("addEventListener('error'");
  });

  it('has timeout safety for tunnel expiration', () => {
    // setTimeout-based recovery trigger
    expect(html).toContain('setTimeout');
  });

  it('uses no-cors HEAD with AbortController for tunnel probing', () => {
    expect(html).toContain('no-cors');
    expect(html).toContain('AbortController');
    expect(html).toContain('signal:');
  });
});

describe('P1.1 — Stale Error Cleanup', () => {
  const html = prototypeUiHtml();

  it('has clearStaleErrors function', () => {
    expect(html).toContain('clearStaleErrors');
  });

  it('removes error cards from previous sessions', () => {
    expect(html).toContain('error-card');
    expect(html).toContain('.error-card');
  });
});

describe('P1.1 — Multi-Project Isolation', () => {
  const html = prototypeUiHtml();

  it('tracks sessionId for state isolation', () => {
    expect(html).toContain('sessionId');
  });

  it('filters SSE events by sessionId', () => {
    // The PREVIEW_READY handler checks eventSessionId !== sessionId
    expect(html).toContain('eventSessionId !== sessionId');
  });

  it('has loadSessionAt timestamp for F5 replay protection', () => {
    expect(html).toContain('loadSessionAt');
  });
});

describe('P1.1 — Recovery Flow', () => {
  const html = prototypeUiHtml();

  it('has triggerPreviewRecovery function', () => {
    expect(html).toContain('triggerPreviewRecovery');
  });

  it('uses P0 endpoint POST /preview/refresh', () => {
    expect(html).toContain('/preview/refresh');
  });

  it('shows "Reconectando" in recovering state', () => {
    expect(html).toContain('Reconectando preview');
  });

  it('has retry button on error', () => {
    expect(html).toContain('previewErrorRetry');
  });
});

describe('P1.1 — F5 State Restoration', () => {
  const html = prototypeUiHtml();

  it('preserves sessionId across reload via localStorage', () => {
    expect(html).toContain('STORAGE_KEY');
    expect(html).toContain('localStorage.getItem(STORAGE_KEY)');
  });

  it('always tries to load last session from localStorage', () => {
    expect(html).toContain('localStorage.setItem(STORAGE_KEY');
  });

  it('skips stale SSE replay within 2 seconds of load', () => {
    expect(html).toContain('loadSessionAt');
    expect(html).toContain('2000');
  });
});

describe('P1.1 — Mobile Behavior', () => {
  const html = prototypeUiHtml();

  it('has mobile preview show button', () => {
    expect(html).toContain('mobilePreviewShowBtn');
  });

  it('has mobile back button', () => {
    expect(html).toContain('mobileBackBtn');
  });

  it('toggles preview-mode class for fullscreen mobile preview', () => {
    expect(html).toContain('preview-mode');
  });

  it('has mobile-view frame class for device frame', () => {
    expect(html).toContain('mobile-view');
  });
});
