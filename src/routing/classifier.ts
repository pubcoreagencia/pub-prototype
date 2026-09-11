// src/routing/classifier.ts
import type { Task } from '../domain.js';
import type { TaskRoutingProfile } from './types.js';

const REASONING_KEYWORDS = [
  'architecture', 'arquitetura', 'migration', 'migração', 'audit',
  'auditoria', 'investigate', 'investigar', 'root cause', 'causa raiz',
  'redesign', 'large refactor', 'security review', 'forensic', 'forense',
  'concurrency', 'deadlock', 'memory leak', 'benchmark'
];

const CODING_KEYWORDS = [
  'implementation', 'implement', 'implementar', 'code', 'coding', 'codigo', 'código',
  'typescript', 'javascript', 'react', 'next.js', 'nextjs', 'api', 'backend',
  'frontend', 'database', 'banco de dados', 'sql', 'postgres', 'integration',
  'integração', 'test', 'teste', 'bugfix', 'fix', 'correção', 'endpoint',
  'route', 'component', 'componente', 'refactor', 'refatoração', 'function',
  'função', 'class', 'service', 'worker', 'handler', 'schema', 'migration'
];

/**
 * Deterministic task classifier.
 *
 * If a routingProfile is explicitly supplied (by the caller/worker or as a profileHint),
 * it is returned directly.
 * Otherwise, evaluates objective and prompt for technical complexity (reasoning, coding)
 * and falls back to general.
 *
 * Strictly neutral: does NOT infer domain-specific profiles (e.g. fast_prototype)
 * through heuristics, keywords, or session IDs.
 */
export function classifyTaskProfile(
  task?: Partial<Task> | { routingProfile?: TaskRoutingProfile; [key: string]: unknown } | null,
  profileHint?: TaskRoutingProfile
): TaskRoutingProfile {
  if (profileHint) {
    return profileHint;
  }

  if (task && 'routingProfile' in task && typeof task.routingProfile === 'string' && task.routingProfile) {
    return task.routingProfile as TaskRoutingProfile;
  }

  if (!task) {
    return 'general';
  }

  const textToAnalyze = [
    typeof task.objective === 'string' ? task.objective : '',
    typeof task.prompt === 'string' ? task.prompt : '',
    typeof task.project === 'string' ? task.project : '',
  ].join(' ').toLowerCase();

  // Check for reasoning indicators first (high complexity/structural tasks)
  const hasReasoning = REASONING_KEYWORDS.some(kw => textToAnalyze.includes(kw));
  if (hasReasoning) {
    return 'reasoning';
  }

  // Check for coding indicators
  const hasCoding = CODING_KEYWORDS.some(kw => textToAnalyze.includes(kw));
  if (hasCoding) {
    return 'coding';
  }

  // Fallback default
  return 'general';
}
