import { describe, expect, it } from 'vitest';
import { PREVIEW_SYSTEM_INSTRUCTIONS } from '../src/pp/worker/prompts.js';
const PDL_SYSTEM_INSTRUCTIONS = ['You are an agent working on PUB DEV LOOP. Follow instructions strictly.'];
import { NEUTRAL_TOOL_INSTRUCTIONS } from '../src/providers/shared.js';
import type { ProviderTaskInput } from '../src/providers/types.js';

/**
 * These tests verify the previewability instructions and system prompt injection
 * under Phase 5J domain separation.
 *
 * Workers (PDL RouterWorker, PP PrototypeWorker) inject their domain-specific
 * system instructions via `ProviderTaskInput.systemInstructions`.
 * The shared providers (9Router, OpenRouter) remain strictly neutral and simply
 * append `task.systemInstructions` to the neutral prompt base.
 */

// ── Helper: minimal ProviderTaskInput object ─────────────────────────────

function makeTask(objective: string, systemInstructions?: string[]): ProviderTaskInput {
  return {
    id: 'TASK-TEST',
    project: 'p',
    repository: 'r',
    objective,
    prompt: 'do it',
    systemInstructions,
  };
}

// ── PREVIEW_SYSTEM_INSTRUCTIONS content (PP Domain) ─────────────────────

describe('PREVIEW_SYSTEM_INSTRUCTIONS (PP domain)', () => {
  it('contains STATIC guidance (index.html)', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toContain('STATIC');
    expect(text).toContain('index.html');
    expect(text).toContain('styles.css');
    expect(text).toContain('script.js');
  });

  it('contains NODE guidance (package.json + dev script)', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toContain('NODE');
    expect(text).toContain('package.json');
    expect(text.toLowerCase()).toContain('script "dev"');
    expect(text).toContain('index.js');
    expect(text).toContain('server.js');
  });

  it('explicitly says NOT to generate non-previewable projects for web requests', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text.toLowerCase()).toMatch(/não.*previewáveis|not.*previewable/i);
  });

  it('says to verify the project can be started/served after generating', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toMatch(/verifique|verify/i);
    expect(text).toContain('npm run dev');
  });

  it('explicitly says the user must NOT start servers manually', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text.toLowerCase()).toMatch(/não.*manualmente|not.*manually/i);
    expect(text).toMatch(/http-server|serve/);
    expect(text.toLowerCase()).toMatch(/usuário|user/);
  });

  it('7. favors STATIC for simple web apps (no unnecessary package.json)', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text.toLowerCase()).toMatch(/prefira.*static|prefer.*static/i);
    expect(text).toMatch(/sem package.json|without package.json/i);
  });

  it('8. forbids live-server in dev script', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toMatch(/live-server/);
    expect(text.toLowerCase()).toMatch(/nunca.*live-server|never.*live-server/i);
  });

  it('8. forbids http-server in dev script', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toMatch(/http-server/);
    expect(text.toLowerCase()).toMatch(/nunca.*http-server|never.*http-server/i);
  });

  it('8. forbids serve in dev script', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toMatch(/serve/);
    expect(text.toLowerCase()).toMatch(/nunca.*serve|never.*serve/i);
  });

  it('8. forbids pipe "|" in dev script', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toMatch(/\|/);
    expect(text.toLowerCase()).toMatch(/pipeline|pipe/i);
  });

  it('9. requires verifying package.json before finalizing NODE project', () => {
    const text = PREVIEW_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text.toLowerCase()).toMatch(/antes de finalizar|before finalizing/i);
    expect(text.toLowerCase()).toMatch(/verifique|verify/i);
    expect(text).toMatch(/package.json/);
  });
});

// ── PDL_SYSTEM_INSTRUCTIONS content (PDL Domain) ─────────────────────────

describe('PDL_SYSTEM_INSTRUCTIONS (PDL domain)', () => {
  it('identifies agent for PUB DEV LOOP', () => {
    const text = PDL_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).toContain('PUB DEV LOOP');
  });

  it('does NOT contain preview/web-specific instructions', () => {
    const text = PDL_SYSTEM_INSTRUCTIONS.join('\n');
    expect(text).not.toContain('STATIC');
    expect(text).not.toContain('package.json');
    expect(text).not.toContain('index.html');
  });
});

// ── NEUTRAL_TOOL_INSTRUCTIONS regression (Shared Provider) ───────────────

describe('NEUTRAL_TOOL_INSTRUCTIONS regression', () => {
  it('does NOT contain preview/web-specific instructions', () => {
    const text = NEUTRAL_TOOL_INSTRUCTIONS.join('\n');
    expect(text).not.toContain('STATIC');
    expect(text).not.toContain('package.json');
    expect(text).not.toContain('index.html');
    expect(text).not.toContain('npm run dev');
  });

  it('does NOT contain domain-specific branding or identities', () => {
    const text = NEUTRAL_TOOL_INSTRUCTIONS.join('\n');
    expect(text).not.toContain('PUB DEV LOOP');
    expect(text).not.toContain('PUB Prototype');
  });

  it('contains neutral tool guidance', () => {
    const text = NEUTRAL_TOOL_INSTRUCTIONS.join('\n');
    expect(text).toContain('workspace');
    expect(text).toContain('git_commit');
    expect(text).toContain('git operations');
  });
});

// ── Integration: system prompt includes/excludes injected instructions ──

describe('System prompt instruction injection integration', () => {
  function buildSystemPromptContent(workspace: string, task: ProviderTaskInput) {
    return [
      `Workspace: ${workspace}`,
      `Task ID: ${task.id}`,
      `Objective: ${task.objective}`,
      ...NEUTRAL_TOOL_INSTRUCTIONS,
      ...(task.systemInstructions ?? []),
    ].join('\n');
  }

  it('includes previewability instructions when PP worker injects them', () => {
    const task = makeTask('Prototype MVP iteration', [...PREVIEW_SYSTEM_INSTRUCTIONS]);
    const prompt = buildSystemPromptContent('/tmp/test-workspace', task);
    expect(prompt).toContain('STATIC');
    expect(prompt).toContain('package.json');
    expect(prompt).toContain('index.html');
    expect(prompt).toContain('Workspace: /tmp/test-workspace');
    expect(prompt).toContain('Task ID: TASK-TEST');
  });

  it('includes PDL instructions when PDL worker injects them', () => {
    const task = makeTask('Fix bug in API', [...PDL_SYSTEM_INSTRUCTIONS]);
    const prompt = buildSystemPromptContent('/tmp/test-workspace', task);
    expect(prompt).toContain('PUB DEV LOOP');
    expect(prompt).not.toContain('STATIC');
    expect(prompt).not.toContain('package.json');
  });

  it('contains only neutral instructions when no domain instructions are provided', () => {
    const task = makeTask('Generic task without domain instructions');
    const prompt = buildSystemPromptContent('/tmp/test-workspace', task);
    expect(prompt).not.toContain('STATIC');
    expect(prompt).not.toContain('package.json');
    expect(prompt).not.toContain('PUB DEV LOOP');
    expect(prompt).toContain('workspace');
    expect(prompt).toContain('git operations');
  });
});
