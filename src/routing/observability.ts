// src/routing/observability.ts
import type { AttemptTrace, WorkerExecutionTrace } from '../domain.js';
import type { Task } from '../domain.js';
import type { TaskRoutingProfile, ModelTier, FallbackType } from './types.js';

export type RootErrorCategory =
  | 'RATE_LIMIT'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'TOOL_CALLING_FAILURE'
  | 'CONTEXT_FAILURE'
  | 'EMPTY_RESPONSE'
  | 'INVALID_RESPONSE'
  | 'AUTH_FAILURE'
  | 'UNKNOWN';

export interface TaskTraceSummary {
  taskId: string;
  profile: TaskRoutingProfile;
  winner: {
    provider: string;
    model: string;
    tier: ModelTier;
    durationMs: number;
    totalTokens: number;
    costUsd: number;
  } | null;
  attempts: number;
  retries: number;
  modelSwitches: number;
  tierEscalations: number;
  totalDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  outcome: 'COMPLETED' | 'FAILED' | 'UNKNOWN';
}

export interface ModelMetricsSummary {
  model: string;
  tier: ModelTier;
  totalAttempts: number;
  completedAttempts: number;
  failedAttempts: number;
  winCount: number;
  winRate: number;
  successRate: number;
  totalDurationMs: number;
  averageDurationMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  averageTokens: number;
  totalCostUsd: number;
  averageCostUsd: number;
  retryCount: number;
  modelSwitchCount: number;
  tierEscalationCount: number;
  toolCalls: number;
  toolFailureRate: number;
  errorCounts: Record<string, number>;
  rootErrorCategoryCounts: Record<RootErrorCategory, number>;
}

export interface ProfileMetricsSummary {
  profile: TaskRoutingProfile;
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  successRate: number;
  tier1Attempts: number;
  tier2Attempts: number;
  tier3Attempts: number;
  totalCostUsd: number;
  totalTokens: number;
  modelRankings: ModelMetricsSummary[];
}

export interface SystemObservabilityReport {
  generatedAt: string;
  totalTasksAnalyzed: number;
  totalCompletedTasks: number;
  totalFailedTasks: number;
  globalSuccessRate: number;
  profileBreakdown: Record<TaskRoutingProfile, ProfileMetricsSummary>;
  tierBreakdown: {
    tier1Attempts: number;
    tier2Attempts: number;
    tier3Attempts: number;
    tier1Wins: number;
    tier2Wins: number;
    tier3Wins: number;
  };
  totalCostUsd: number;
  totalTokens: number;
  modelRankingsGlobal: ModelMetricsSummary[];
  topRootErrors: Record<RootErrorCategory, number>;
}

/**
 * Deterministically classify any error into standard diagnostic categories.
 */
export function classifyRootError(
  httpStatus?: number,
  errorCode?: string | null,
  errorMessage?: string | null
): RootErrorCategory {
  const msg = (errorMessage || '').toLowerCase();
  const code = (errorCode || '').toUpperCase();

  if (httpStatus === 429 || code.includes('RATE_LIMIT') || msg.includes('rate limit') || msg.includes('429') || msg.includes('quota') || msg.includes('exhausted')) {
    return 'RATE_LIMIT';
  }
  if (httpStatus === 401 || httpStatus === 403 || code.includes('AUTH') || msg.includes('unauthorized') || msg.includes('api key') || msg.includes('forbidden')) {
    return 'AUTH_FAILURE';
  }
  if (httpStatus === 408 || httpStatus === 504 || code.includes('TIMEOUT') || msg.includes('timeout') || msg.includes('abort') || msg.includes('timed out')) {
    return 'TIMEOUT';
  }
  if (
    code.includes('TOOL') ||
    code.includes('CAPABILITY_ERROR') ||
    msg.includes('tool') ||
    msg.includes('function call') ||
    msg.includes('arguments') ||
    msg.includes('tool_calls')
  ) {
    return 'TOOL_CALLING_FAILURE';
  }
  if (msg.includes('context') || msg.includes('too long') || msg.includes('maximum context length') || msg.includes('token limit')) {
    return 'CONTEXT_FAILURE';
  }
  if (code.includes('EMPTY_RESPONSE') || msg.includes('empty response')) {
    return 'EMPTY_RESPONSE';
  }
  if (code.includes('INVALID_RESPONSE') || msg.includes('invalid json') || msg.includes('parse')) {
    return 'INVALID_RESPONSE';
  }
  if ((httpStatus !== undefined && httpStatus >= 500) || code.includes('SERVER_ERROR') || msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('bad gateway')) {
    return 'SERVER_ERROR';
  }

  return 'UNKNOWN';
}

/**
 * Summarize an individual Task and its Execution Trace deterministically.
 */
export function summarizeTaskTrace(task: Partial<Task>): TaskTraceSummary {
  const taskId = task.id || 'unknown-task';
  const rawResult = task.result as { trace?: WorkerExecutionTrace } | undefined;
  const trace = rawResult?.trace;

  const attempts: AttemptTrace[] = trace?.attempts || [];
  const profile: TaskRoutingProfile = (attempts[0]?.profile as TaskRoutingProfile) || 'general';

  let retries = 0;
  let modelSwitches = 0;
  let tierEscalations = 0;
  let totalDurationMs = trace?.totalDurationMs ?? 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let winnerSummary: TaskTraceSummary['winner'] = null;

  if (attempts.length === 0) {
    totalDurationMs = typeof (task.result as any)?.durationMs === 'number' ? (task.result as any).durationMs : 0;
  }

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    if (a.fallbackType === 'retry') retries++;
    if (a.fallbackType === 'model_switch') modelSwitches++;
    if (a.fallbackType === 'tier_escalation') tierEscalations++;

    if (a.promptTokens) totalPromptTokens += a.promptTokens;
    if (a.completionTokens) totalCompletionTokens += a.completionTokens;
    if (a.totalTokens) totalTokens += a.totalTokens;
    if (a.costUsd) totalCostUsd += a.costUsd;

    if (a.isWinner || (trace?.winningAttempt !== null && trace?.winningAttempt === a.attempt)) {
      winnerSummary = {
        provider: a.provider,
        model: a.model || 'unknown',
        tier: a.tier || (a.model?.includes(':free') ? 1 : 3),
        durationMs: a.durationMs,
        totalTokens: a.totalTokens || 0,
        costUsd: a.costUsd || 0,
      };
    }
  }

  const outcome: TaskTraceSummary['outcome'] =
    task.status === 'COMPLETED' || trace?.finalStatus === 'COMPLETED'
      ? 'COMPLETED'
      : task.status === 'FAILED' || trace?.finalStatus === 'FAILED'
      ? 'FAILED'
      : 'UNKNOWN';

  return {
    taskId,
    profile,
    winner: winnerSummary,
    attempts: Math.max(attempts.length, 1),
    retries,
    modelSwitches,
    tierEscalations,
    totalDurationMs,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    totalCostUsd,
    outcome,
  };
}

/**
 * Aggregate multiple tasks and traces to compute empirical metrics per model and profile.
 */
export function aggregateObservabilityMetrics(tasks: Partial<Task>[]): SystemObservabilityReport {
  const modelMap: Record<string, {
    model: string;
    tier: ModelTier;
    totalAttempts: number;
    completedAttempts: number;
    failedAttempts: number;
    winCount: number;
    totalDurationMs: number;
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalTokens: number;
    totalCostUsd: number;
    retryCount: number;
    modelSwitchCount: number;
    tierEscalationCount: number;
    toolCalls: number;
    toolFailures: number;
    errorCounts: Record<string, number>;
    rootErrorCategoryCounts: Record<RootErrorCategory, number>;
  }> = {};

  const profileMap: Record<TaskRoutingProfile, {
    profile: TaskRoutingProfile;
    totalTasks: number;
    completedTasks: number;
    failedTasks: number;
    tier1Attempts: number;
    tier2Attempts: number;
    tier3Attempts: number;
    totalCostUsd: number;
    totalTokens: number;
    tasks: Partial<Task>[];
  }> = {
    fast_prototype: { profile: 'fast_prototype', totalTasks: 0, completedTasks: 0, failedTasks: 0, tier1Attempts: 0, tier2Attempts: 0, tier3Attempts: 0, totalCostUsd: 0, totalTokens: 0, tasks: [] },
    coding: { profile: 'coding', totalTasks: 0, completedTasks: 0, failedTasks: 0, tier1Attempts: 0, tier2Attempts: 0, tier3Attempts: 0, totalCostUsd: 0, totalTokens: 0, tasks: [] },
    reasoning: { profile: 'reasoning', totalTasks: 0, completedTasks: 0, failedTasks: 0, tier1Attempts: 0, tier2Attempts: 0, tier3Attempts: 0, totalCostUsd: 0, totalTokens: 0, tasks: [] },
    general: { profile: 'general', totalTasks: 0, completedTasks: 0, failedTasks: 0, tier1Attempts: 0, tier2Attempts: 0, tier3Attempts: 0, totalCostUsd: 0, totalTokens: 0, tasks: [] },
  };

  const topRootErrors: Record<RootErrorCategory, number> = {
    RATE_LIMIT: 0,
    SERVER_ERROR: 0,
    TIMEOUT: 0,
    TOOL_CALLING_FAILURE: 0,
    CONTEXT_FAILURE: 0,
    EMPTY_RESPONSE: 0,
    INVALID_RESPONSE: 0,
    AUTH_FAILURE: 0,
    UNKNOWN: 0,
  };

  let globalTier1Attempts = 0;
  let globalTier2Attempts = 0;
  let globalTier3Attempts = 0;
  let globalTier1Wins = 0;
  let globalTier2Wins = 0;
  let globalTier3Wins = 0;
  let totalTasksCompleted = 0;
  let totalTasksFailed = 0;
  let globalTotalCostUsd = 0;
  let globalTotalTokens = 0;

  for (const t of tasks) {
    const summary = summarizeTaskTrace(t);
    const p = summary.profile;
    const profGroup = profileMap[p] || profileMap.general;

    profGroup.totalTasks++;
    if (summary.outcome === 'COMPLETED') {
      profGroup.completedTasks++;
      totalTasksCompleted++;
    } else if (summary.outcome === 'FAILED') {
      profGroup.failedTasks++;
      totalTasksFailed++;
    }

    profGroup.totalCostUsd += summary.totalCostUsd;
    profGroup.totalTokens += summary.totalTokens;
    globalTotalCostUsd += summary.totalCostUsd;
    globalTotalTokens += summary.totalTokens;
    profGroup.tasks.push(t);

    const rawResult = t.result as { trace?: WorkerExecutionTrace } | undefined;
    const attempts: AttemptTrace[] = rawResult?.trace?.attempts || [];

    // If task has no detailed trace array, construct fallback single attempt from task metadata
    if (attempts.length === 0) {
      const fallbackModel = (t.result as any)?.model || (t as any).model || 'unknown';
      const fallbackTier: ModelTier = fallbackModel === 'openrouter/free' ? 2 : fallbackModel.includes(':free') ? 1 : 3;
      const isComplete = t.status === 'COMPLETED';

      const entry = modelMap[fallbackModel] = modelMap[fallbackModel] || {
        model: fallbackModel,
        tier: fallbackTier,
        totalAttempts: 0,
        completedAttempts: 0,
        failedAttempts: 0,
        winCount: 0,
        totalDurationMs: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        retryCount: 0,
        modelSwitchCount: 0,
        tierEscalationCount: 0,
        toolCalls: 0,
        toolFailures: 0,
        errorCounts: {},
        rootErrorCategoryCounts: { RATE_LIMIT: 0, SERVER_ERROR: 0, TIMEOUT: 0, TOOL_CALLING_FAILURE: 0, CONTEXT_FAILURE: 0, EMPTY_RESPONSE: 0, INVALID_RESPONSE: 0, AUTH_FAILURE: 0, UNKNOWN: 0 },
      };

      entry.totalAttempts++;
      if (fallbackTier === 1) globalTier1Attempts++;
      if (fallbackTier === 2) globalTier2Attempts++;
      if (fallbackTier === 3) globalTier3Attempts++;

      if (isComplete) {
        entry.completedAttempts++;
        entry.winCount++;
        if (fallbackTier === 1) globalTier1Wins++;
        if (fallbackTier === 2) globalTier2Wins++;
        if (fallbackTier === 3) globalTier3Wins++;
      } else {
        entry.failedAttempts++;
        const cat = classifyRootError(undefined, t.error, t.error);
        entry.rootErrorCategoryCounts[cat]++;
        topRootErrors[cat]++;
      }
      continue;
    }

    for (const a of attempts) {
      const mName = a.model || 'unknown';
      const tier: ModelTier = a.tier || (mName === 'openrouter/free' ? 2 : mName.includes(':free') ? 1 : 3);

      if (tier === 1) {
        globalTier1Attempts++;
        profGroup.tier1Attempts++;
      } else if (tier === 2) {
        globalTier2Attempts++;
        profGroup.tier2Attempts++;
      } else {
        globalTier3Attempts++;
        profGroup.tier3Attempts++;
      }

      const entry = modelMap[mName] = modelMap[mName] || {
        model: mName,
        tier,
        totalAttempts: 0,
        completedAttempts: 0,
        failedAttempts: 0,
        winCount: 0,
        totalDurationMs: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        retryCount: 0,
        modelSwitchCount: 0,
        tierEscalationCount: 0,
        toolCalls: 0,
        toolFailures: 0,
        errorCounts: {},
        rootErrorCategoryCounts: { RATE_LIMIT: 0, SERVER_ERROR: 0, TIMEOUT: 0, TOOL_CALLING_FAILURE: 0, CONTEXT_FAILURE: 0, EMPTY_RESPONSE: 0, INVALID_RESPONSE: 0, AUTH_FAILURE: 0, UNKNOWN: 0 },
      };

      entry.totalAttempts++;
      entry.totalDurationMs += a.durationMs || 0;
      entry.totalPromptTokens += a.promptTokens || 0;
      entry.totalCompletionTokens += a.completionTokens || 0;
      entry.totalTokens += a.totalTokens || 0;
      entry.totalCostUsd += a.costUsd || 0;
      entry.toolCalls += a.toolCalls || 0;

      if (a.fallbackType === 'retry') entry.retryCount++;
      if (a.fallbackType === 'model_switch') entry.modelSwitchCount++;
      if (a.fallbackType === 'tier_escalation') entry.tierEscalationCount++;

      if (a.status === 'COMPLETED') {
        entry.completedAttempts++;
      } else {
        entry.failedAttempts++;
        const errKey = a.errorCode || (a.httpStatus ? `HTTP_${a.httpStatus}` : 'UNKNOWN_ERR');
        entry.errorCounts[errKey] = (entry.errorCounts[errKey] || 0) + 1;

        const cat = classifyRootError(a.httpStatus, a.errorCode, a.errorMessage);
        entry.rootErrorCategoryCounts[cat]++;
        topRootErrors[cat]++;

        if (cat === 'TOOL_CALLING_FAILURE') {
          entry.toolFailures++;
        }
      }

      if (a.isWinner) {
        entry.winCount++;
        if (tier === 1) globalTier1Wins++;
        if (tier === 2) globalTier2Wins++;
        if (tier === 3) globalTier3Wins++;
      }
    }
  }

  function formatModelMetrics(raw: typeof modelMap[string]): ModelMetricsSummary {
    const successRate = raw.totalAttempts > 0 ? (raw.completedAttempts / raw.totalAttempts) * 100 : 0;
    const winRate = raw.totalAttempts > 0 ? (raw.winCount / raw.totalAttempts) * 100 : 0;
    const averageDurationMs = raw.totalAttempts > 0 ? raw.totalDurationMs / raw.totalAttempts : 0;
    const averageTokens = raw.totalAttempts > 0 ? raw.totalTokens / raw.totalAttempts : 0;
    const averageCostUsd = raw.totalAttempts > 0 ? raw.totalCostUsd / raw.totalAttempts : 0;
    const toolFailureRate = raw.toolCalls > 0 ? (raw.toolFailures / raw.toolCalls) * 100 : 0;

    return {
      model: raw.model,
      tier: raw.tier,
      totalAttempts: raw.totalAttempts,
      completedAttempts: raw.completedAttempts,
      failedAttempts: raw.failedAttempts,
      winCount: raw.winCount,
      winRate: Number(winRate.toFixed(2)),
      successRate: Number(successRate.toFixed(2)),
      totalDurationMs: raw.totalDurationMs,
      averageDurationMs: Math.round(averageDurationMs),
      totalPromptTokens: raw.totalPromptTokens,
      totalCompletionTokens: raw.totalCompletionTokens,
      totalTokens: raw.totalTokens,
      averageTokens: Math.round(averageTokens),
      totalCostUsd: Number(raw.totalCostUsd.toFixed(6)),
      averageCostUsd: Number(averageCostUsd.toFixed(6)),
      retryCount: raw.retryCount,
      modelSwitchCount: raw.modelSwitchCount,
      tierEscalationCount: raw.tierEscalationCount,
      toolCalls: raw.toolCalls,
      toolFailureRate: Number(toolFailureRate.toFixed(2)),
      errorCounts: raw.errorCounts,
      rootErrorCategoryCounts: raw.rootErrorCategoryCounts,
    };
  }

  const modelRankingsGlobal: ModelMetricsSummary[] = Object.values(modelMap)
    .map(formatModelMetrics)
    .sort((a, b) => b.winCount - a.winCount || b.successRate - a.successRate);

  const profileBreakdown: Record<TaskRoutingProfile, ProfileMetricsSummary> = {} as any;

  for (const prof of ['fast_prototype', 'coding', 'reasoning', 'general'] as TaskRoutingProfile[]) {
    const grp = profileMap[prof];
    const sRate = grp.totalTasks > 0 ? (grp.completedTasks / grp.totalTasks) * 100 : 0;

    // Filter models specifically active in this profile
    const profileModelSummaries = aggregateObservabilityMetricsForTasksOnly(grp.tasks);

    profileBreakdown[prof] = {
      profile: prof,
      totalTasks: grp.totalTasks,
      completedTasks: grp.completedTasks,
      failedTasks: grp.failedTasks,
      successRate: Number(sRate.toFixed(2)),
      tier1Attempts: grp.tier1Attempts,
      tier2Attempts: grp.tier2Attempts,
      tier3Attempts: grp.tier3Attempts,
      totalCostUsd: Number(grp.totalCostUsd.toFixed(6)),
      totalTokens: grp.totalTokens,
      modelRankings: profileModelSummaries,
    };
  }

  const totalTasksAnalyzed = tasks.length;
  const globalSuccessRate = totalTasksAnalyzed > 0 ? (totalTasksCompleted / totalTasksAnalyzed) * 100 : 0;

  return {
    generatedAt: new Date().toISOString(),
    totalTasksAnalyzed,
    totalCompletedTasks: totalTasksCompleted,
    totalFailedTasks: totalTasksFailed,
    globalSuccessRate: Number(globalSuccessRate.toFixed(2)),
    profileBreakdown,
    tierBreakdown: {
      tier1Attempts: globalTier1Attempts,
      tier2Attempts: globalTier2Attempts,
      tier3Attempts: globalTier3Attempts,
      tier1Wins: globalTier1Wins,
      tier2Wins: globalTier2Wins,
      tier3Wins: globalTier3Wins,
    },
    totalCostUsd: Number(globalTotalCostUsd.toFixed(6)),
    totalTokens: globalTotalTokens,
    modelRankingsGlobal,
    topRootErrors,
  };
}

/** Helper internal ranking generator for task subsets */
function aggregateObservabilityMetricsForTasksOnly(tasks: Partial<Task>[]): ModelMetricsSummary[] {
  if (tasks.length === 0) return [];
  const modelMap: Record<string, any> = {};

  for (const t of tasks) {
    const rawResult = t.result as { trace?: WorkerExecutionTrace } | undefined;
    const attempts: AttemptTrace[] = rawResult?.trace?.attempts || [];

    for (const a of attempts) {
      const mName = a.model || 'unknown';
      const tier: ModelTier = a.tier || (mName === 'openrouter/free' ? 2 : mName.includes(':free') ? 1 : 3);
      const entry = modelMap[mName] = modelMap[mName] || {
        model: mName,
        tier,
        totalAttempts: 0,
        completedAttempts: 0,
        failedAttempts: 0,
        winCount: 0,
        totalDurationMs: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        retryCount: 0,
        modelSwitchCount: 0,
        tierEscalationCount: 0,
        toolCalls: 0,
        toolFailures: 0,
        errorCounts: {},
        rootErrorCategoryCounts: { RATE_LIMIT: 0, SERVER_ERROR: 0, TIMEOUT: 0, TOOL_CALLING_FAILURE: 0, CONTEXT_FAILURE: 0, EMPTY_RESPONSE: 0, INVALID_RESPONSE: 0, AUTH_FAILURE: 0, UNKNOWN: 0 },
      };

      entry.totalAttempts++;
      entry.totalDurationMs += a.durationMs || 0;
      entry.totalPromptTokens += a.promptTokens || 0;
      entry.totalCompletionTokens += a.completionTokens || 0;
      entry.totalTokens += a.totalTokens || 0;
      entry.totalCostUsd += a.costUsd || 0;
      entry.toolCalls += a.toolCalls || 0;

      if (a.fallbackType === 'retry') entry.retryCount++;
      if (a.fallbackType === 'model_switch') entry.modelSwitchCount++;
      if (a.fallbackType === 'tier_escalation') entry.tierEscalationCount++;

      if (a.status === 'COMPLETED') {
        entry.completedAttempts++;
      } else {
        entry.failedAttempts++;
        const errKey = a.errorCode || (a.httpStatus ? `HTTP_${a.httpStatus}` : 'UNKNOWN_ERR');
        entry.errorCounts[errKey] = (entry.errorCounts[errKey] || 0) + 1;
        const cat = classifyRootError(a.httpStatus, a.errorCode, a.errorMessage);
        entry.rootErrorCategoryCounts[cat]++;
      }

      if (a.isWinner) {
        entry.winCount++;
      }
    }
  }

  return Object.values(modelMap)
    .map((raw: any) => ({
      model: raw.model,
      tier: raw.tier,
      totalAttempts: raw.totalAttempts,
      completedAttempts: raw.completedAttempts,
      failedAttempts: raw.failedAttempts,
      winCount: raw.winCount,
      winRate: Number((raw.totalAttempts > 0 ? (raw.winCount / raw.totalAttempts) * 100 : 0).toFixed(2)),
      successRate: Number((raw.totalAttempts > 0 ? (raw.completedAttempts / raw.totalAttempts) * 100 : 0).toFixed(2)),
      totalDurationMs: raw.totalDurationMs,
      averageDurationMs: Math.round(raw.totalAttempts > 0 ? raw.totalDurationMs / raw.totalAttempts : 0),
      totalPromptTokens: raw.totalPromptTokens,
      totalCompletionTokens: raw.totalCompletionTokens,
      totalTokens: raw.totalTokens,
      averageTokens: Math.round(raw.totalAttempts > 0 ? raw.totalTokens / raw.totalAttempts : 0),
      totalCostUsd: Number(raw.totalCostUsd.toFixed(6)),
      averageCostUsd: Number((raw.totalAttempts > 0 ? raw.totalCostUsd / raw.totalAttempts : 0).toFixed(6)),
      retryCount: raw.retryCount,
      modelSwitchCount: raw.modelSwitchCount,
      tierEscalationCount: raw.tierEscalationCount,
      toolCalls: raw.toolCalls,
      toolFailureRate: Number((raw.toolCalls > 0 ? (raw.toolFailures / raw.toolCalls) * 100 : 0).toFixed(2)),
      errorCounts: raw.errorCounts,
      rootErrorCategoryCounts: raw.rootErrorCategoryCounts,
    }))
    .sort((a, b) => b.winCount - a.winCount || b.successRate - a.successRate);
}



