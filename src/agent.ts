import type { Task } from './domain.js';
import { CodexApiProvider } from './providers/codex-api.js';
import { RouterProvider } from './providers/router.js';
import { OpenRouterProvider } from './providers/openrouter.js';
import { DualGatewayProvider } from './providers/gateway.js';
import type { AgentProvider, ProviderTaskResult, ProviderTaskInput } from './providers/types.js';
import { AgentExecutor } from './executor.js';

export class MockProvider implements AgentProvider {
  readonly kind = 'mock' as const;
  readonly model = null;
  async execute(task: Task | ProviderTaskInput, _workspace: string): Promise<ProviderTaskResult> {
    let changedFiles: string[] = [];
    if (_workspace) {
      try {
        const { writeFileSync, existsSync } = await import('node:fs');
        const { join } = await import('node:path');
        const htmlFile = join(_workspace, 'index.html');
        const content = existsSync(htmlFile)
          ? `<!DOCTYPE html><html><body><h1>Prototype Iteration</h1><p>${task.prompt || ''}</p></body></html>\n`
          : `<!DOCTYPE html><html><body><h1>Prototype MVP</h1><p>${task.prompt || ''}</p></body></html>\n`;
        writeFileSync(htmlFile, content, 'utf8');
        changedFiles = ['index.html'];
      } catch {}
    }
    return {
      status: 'COMPLETED',
      provider: this.kind,
      model: null,
      exitCode: 0,
      durationMs: 0,
      stdout: `Mock provider completed task ${task.id}; updated files: ${changedFiles.join(', ')}`,
      stderr: '',
      changedFiles,
      commit: null,
      errorCode: null,
      errorMessage: null,
    };
  }
  async health() {
    return { available: true, details: 'mock provider' };
  }
  capabilities() {
    return ['planning'];
  }
  metadata() {
    return { provider: 'mock' };
  }
}

export function createSingleProvider(providerName: string, modelOverride?: string): AgentProvider {
  if (providerName === 'mock') {
    return new MockProvider();
  }

  if (providerName === 'codex-api') {
    return new CodexApiProvider(new AgentExecutor());
  }

  if (providerName === '9router' || providerName === 'router') {
    return new RouterProvider(undefined, undefined, undefined, modelOverride);
  }

  if (providerName === 'openrouter') {
    return new OpenRouterProvider(undefined, undefined, undefined, modelOverride);
  }

  return new MockProvider();
}

export function createProvider(provider?: string): AgentProvider {
  const primaryGateway = process.env.PRIMARY_GATEWAY?.trim();
  const fallbackGateway = process.env.FALLBACK_GATEWAY?.trim();

  if (
    (!provider || provider === 'gateway' || provider === 'dual') &&
    primaryGateway &&
    fallbackGateway &&
    primaryGateway !== fallbackGateway
  ) {
    const primary = createSingleProvider(primaryGateway);
    const fallback = createSingleProvider(fallbackGateway);
    return new DualGatewayProvider(primary, fallback);
  }

  if ((!provider || provider === 'gateway' || provider === 'dual') && primaryGateway) {
    return createSingleProvider(primaryGateway);
  }

  const selected = provider ?? process.env.AGENT_PROVIDER ?? process.env.INFERENCE_GATEWAY ?? 'mock';
  return createSingleProvider(selected);
}
