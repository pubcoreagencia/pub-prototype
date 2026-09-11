// src/routing/calibration.ts
import type { TaskRoutingProfile, ModelTier } from './types.js';
import type { ModelMetricsSummary, SystemObservabilityReport } from './observability.js';

export type CalibrationRecommendation =
  | 'preferred'
  | 'acceptable'
  | 'fallback'
  | 'deprioritize'
  | 'insufficient_data';

export interface ModelCalibrationScore {
  model: string;
  profile: TaskRoutingProfile;
  tier: ModelTier;
  score: number;
  confidence: number;
  sampleSize: number;
  winRate: number;
  successRate: number;
  averageDurationMs: number;
  toolFailureRate: number;
  totalCostUsd: number;
  recommendation: CalibrationRecommendation;
}

export interface CalibrationOptions {
  enabled?: boolean;
  minSampleSize?: number;
  priorWeight?: number;
  basePriorSuccessRate?: number;
  targetDurationMs?: number;
}

export const DEFAULT_CALIBRATION_OPTIONS: Required<CalibrationOptions> = {
  enabled: false,
  minSampleSize: 10,
  priorWeight: 5,
  basePriorSuccessRate: 0.5,
  targetDurationMs: 20000,
};

/**
 * Calculate deterministic empirical calibration score for a model and profile.
 *
 * Algorithm breakdown:
 * 1. Filtering: models without valid model name, or models marked 'unknown' are filtered out.
 * 2. Bayesian Shrinkage: smoothedSuccessRate = (wins + priorWeight * basePrior) / (samples + priorWeight).
 * 3. Confidence: sampleSize / (sampleSize + minSampleSize).
 * 4. Latency Penalty: max(0, min(0.3, (avgDuration - targetDuration) / 60000)).
 * 5. Tool Failure Penalty: (toolFailureRate / 100) * 0.4.
 * 6. Combined Score: (smoothedSuccessRate * 0.7 + (winRate / 100) * 0.3) * (0.5 + 0.5 * confidence) - latencyPenalty - toolPenalty.
 */
export function calculateModelCalibrationScore(
  metrics: ModelMetricsSummary,
  profile: TaskRoutingProfile,
  options?: CalibrationOptions
): ModelCalibrationScore {
  const opts: Required<CalibrationOptions> = {
    enabled: options?.enabled ?? DEFAULT_CALIBRATION_OPTIONS.enabled,
    minSampleSize: options?.minSampleSize ?? DEFAULT_CALIBRATION_OPTIONS.minSampleSize,
    priorWeight: options?.priorWeight ?? DEFAULT_CALIBRATION_OPTIONS.priorWeight,
    basePriorSuccessRate: options?.basePriorSuccessRate ?? DEFAULT_CALIBRATION_OPTIONS.basePriorSuccessRate,
    targetDurationMs: options?.targetDurationMs ?? DEFAULT_CALIBRATION_OPTIONS.targetDurationMs,
  };

  const sampleSize = metrics.totalAttempts;
  const wins = metrics.winCount;
  const winRate = metrics.winRate;
  const successRate = metrics.successRate;
  const avgDuration = metrics.averageDurationMs;
  const toolFailureRate = metrics.toolFailureRate;

  // Cold-start & Shrinkage calculation (Bayesian m-estimate)
  const smoothedRate = (wins + opts.priorWeight * opts.basePriorSuccessRate) / (sampleSize + opts.priorWeight);
  const confidence = sampleSize / (sampleSize + opts.minSampleSize);

  // Latency penalty: penalize runs exceeding target duration up to 0.3
  let latencyPenalty = 0;
  if (avgDuration > opts.targetDurationMs) {
    latencyPenalty = Math.min(0.3, (avgDuration - opts.targetDurationMs) / 60000);
  }

  // Tool failure penalty: up to 0.4
  const toolPenalty = (toolFailureRate / 100) * 0.4;

  // Normalized composite score [0 .. 1]
  const baseEmpiricalScore = smoothedRate * 0.7 + (winRate / 100) * 0.3;
  const weightedScore = baseEmpiricalScore * (0.6 + 0.4 * confidence);
  const finalScore = Math.max(0, Math.min(1, weightedScore - latencyPenalty - toolPenalty));

  // Determine Recommendation category
  let recommendation: CalibrationRecommendation;
  if (sampleSize < opts.minSampleSize) {
    recommendation = 'insufficient_data';
  } else if (toolFailureRate >= 50) {
    recommendation = 'deprioritize';
  } else if (finalScore >= 0.60 && toolFailureRate < 10) {
    recommendation = 'preferred';
  } else if (finalScore >= 0.45 && toolFailureRate < 25) {
    recommendation = 'acceptable';
  } else if (finalScore >= 0.25) {
    recommendation = 'fallback';
  } else {
    recommendation = 'deprioritize';
  }

  return {
    model: metrics.model,
    profile,
    tier: metrics.tier,
    score: Number(finalScore.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    sampleSize,
    winRate,
    successRate,
    averageDurationMs: avgDuration,
    toolFailureRate,
    totalCostUsd: metrics.totalCostUsd,
    recommendation,
  };
}

/**
 * Safely reorder Tier 1 models based on calibration scores.
 *
 * SAFETY INVARIANTS:
 * - Only reorders within Tier 1 models.
 * - Tier 2 ('openrouter/free') and Tier 3 (Paid models) are NEVER promoted or reordered here.
 * - If calibration is disabled or sample sizes are insufficient, original static order is strictly preserved.
 * - Deterministic tie-breaker by original static index.
 */
export function reorderTier1ModelsWithCalibration(
  originalTier1: string[],
  profile: TaskRoutingProfile,
  observabilityReport?: SystemObservabilityReport,
  options?: CalibrationOptions
): string[] {
  const isEnabled = options?.enabled ?? (process.env.OPENROUTER_CALIBRATION_ENABLED === 'true');
  if (!isEnabled || !observabilityReport) {
    return [...originalTier1];
  }

  const minSamples = options?.minSampleSize ?? Number(process.env.OPENROUTER_CALIBRATION_MIN_SAMPLES ?? DEFAULT_CALIBRATION_OPTIONS.minSampleSize);

  // Look up profile metrics or fallback to global metrics
  const profileMetrics = observabilityReport.profileBreakdown[profile]?.modelRankings || [];
  const globalMetrics = observabilityReport.modelRankingsGlobal || [];

  const metricsMap = new Map<string, ModelMetricsSummary>();
  for (const m of globalMetrics) {
    if (m.model && m.model !== 'unknown') {
      metricsMap.set(m.model, m);
    }
  }
  // Profile specific metrics take precedence if available
  for (const m of profileMetrics) {
    if (m.model && m.model !== 'unknown') {
      metricsMap.set(m.model, m);
    }
  }

  // Calculate calibration scores for all Tier 1 candidates
  const scoredCandidates = originalTier1.map((model, originalIndex) => {
    const metrics = metricsMap.get(model);
    if (!metrics) {
      return {
        model,
        originalIndex,
        score: 0.5 * (1 - originalIndex * 0.01), // Default neutral fallback preserving static order
        sampleSize: 0,
        recommendation: 'insufficient_data' as CalibrationRecommendation,
      };
    }

    const calibration = calculateModelCalibrationScore(metrics, profile, {
      ...options,
      enabled: true,
      minSampleSize: minSamples,
    });

    // If insufficient data, anchor score near its static ranking weight
    const effectiveScore = calibration.sampleSize < minSamples
      ? 0.5 * (1 - originalIndex * 0.01)
      : calibration.score;

    return {
      model,
      originalIndex,
      score: effectiveScore,
      sampleSize: calibration.sampleSize,
      recommendation: calibration.recommendation,
    };
  });

  // Sort by score DESC, tie-break deterministically by originalIndex ASC
  scoredCandidates.sort((a, b) => {
    if (Math.abs(b.score - a.score) > 0.0001) {
      return b.score - a.score;
    }
    return a.originalIndex - b.originalIndex;
  });

  return scoredCandidates.map(c => c.model);
}
