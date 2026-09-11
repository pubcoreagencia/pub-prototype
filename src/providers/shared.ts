import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { URL } from 'node:url';

export const DEFAULT_ROUTER_BASE_URL = 'http://localhost:20128/v1';
export const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function normalizeBaseUrl(value: string | undefined, fallback: string): string {
  const candidate = (value && value.trim() ? value : fallback).trim();
  const normalized = candidate.endsWith('/') ? candidate.slice(0, -1) : candidate;
  new URL(normalized);
  return normalized;
}

/**
 * Resolves the OpenRouter API key in local / Cloudflare environments.
 * Resolution precedence:
 * 1. Explicitly passed key (argument)
 * 2. process.env.OPENROUTER_API_KEY
 * 3. Local Hermes User AppData environment bridge (AppData/Local/hermes/.env)
 * 4. Local Hermes User Profile environment bridge (~/.hermes/.env)
 *
 * Never logs, exposes, or writes the key. Pure runtime bridge.
 */
export function resolveOpenRouterApiKey(explicitKey?: string): string | undefined {
  const direct = explicitKey?.trim() || process.env.OPENROUTER_API_KEY?.trim();
  if (direct) {
    return direct;
  }

  try {
    const candidatePaths = [
      process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'hermes', '.env') : null,
      join(homedir(), '.hermes', '.env'),
    ].filter(Boolean) as string[];

    for (const p of candidatePaths) {
      if (existsSync(p)) {
        const content = readFileSync(p, 'utf8');
        for (const line of content.split('\n')) {
          const trimmed = line.trim();
          if (trimmed.startsWith('OPENROUTER_API_KEY=')) {
            const val = trimmed.slice('OPENROUTER_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
            if (val && val.length > 20) {
              return val;
            }
          }
        }
      }
    }
  } catch {
    // Non-blocking fallback
  }

  return undefined;
}

export async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Neutral system-prompt instructions for tool operation.
 * Used by OpenAI-compatible providers (9Router, OpenRouter).
 *
 * Strictly neutral: no domain knowledge of PDL or PP.
 */
export const NEUTRAL_TOOL_INSTRUCTIONS: string[] = [
  'You have access to the following tools. Use them to complete the task.',
  'Always resolve file paths within the workspace. Never write outside it.',
  'After writing a file, read it back to verify contents.',
  'IMPORTANT: Do NOT use git_commit tool — the worker will automatically commit changes after you complete.',
  'IMPORTANT: Do NOT run git commands (git add, git status, etc.) — the worker handles git operations.',
  'After completing all work, provide a final summary without further tool calls.',
];

