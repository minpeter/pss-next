import type { TrialSummary } from "./report";
import type { StabilityReportFacts } from "./stability-comparison-types";

export function reportFacts(summary: TrialSummary): StabilityReportFacts {
  const providerStatuses = {
    "evaluation-provider-failure":
      summary.trials.invalidByStatus["evaluation-provider-failure"] ?? 0,
    "invalid-full-control":
      summary.trials.invalidByStatus["invalid-full-control"] ?? 0,
    "summary-provider-failure":
      summary.trials.invalidByStatus["summary-provider-failure"] ?? 0,
  };
  const providerCount =
    providerStatuses["evaluation-provider-failure"] +
    providerStatuses["invalid-full-control"] +
    providerStatuses["summary-provider-failure"];

  return {
    compression: summary.compression
      ? {
          aggregate: summary.compression.ratio,
          byHop: summary.compression.byHop,
          byScenario: summary.compression.byScenario,
          savings: summary.compression.savings,
        }
      : null,
    invalidAttempts: {
      attempted: summary.trials.attempted,
      blocking: {
        compactionPrompt:
          summary.trials.invalidByStatus["compaction-prompt-failure"] ?? 0,
        nonCompressing:
          summary.trials.invalidByStatus["non-compressing-summary"] ?? 0,
        protocol: summary.trials.invalidByStatus["protocol-failure"] ?? 0,
      },
      byStatus: summary.trials.invalidByStatus,
      providerEvaluator: {
        count: providerCount,
        rate:
          summary.trials.attempted === 0
            ? null
            : providerCount / summary.trials.attempted,
      },
      valid: summary.trials.valid,
    },
    retention: summary.retention
      ? {
          aggregate: summary.retention.aggregate,
          byCategory: summary.retention.byCategory.map((row) => ({
            accuracy: row.accuracy,
            correct: row.correct,
            id: row.category,
            total: row.total,
          })),
          byScenario: summary.retention.byScenario.map((row) => ({
            accuracy: row.accuracy,
            correct: row.correct,
            id: row.scenario,
            total: row.total,
          })),
          disagreements: summary.retention.disagreements,
          trialAccuracy: summary.retention.trialAccuracy,
        }
      : null,
  };
}
