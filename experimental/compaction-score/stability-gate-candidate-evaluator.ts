import type { StabilityComparisonFacts } from "./stability-comparison-types";
import { STABILITY_GATE_POLICY } from "./stability-gate-policy";
import type { StabilityGateFailure } from "./stability-gate-types";

export function addInvalidAttemptFailures(
  facts: StabilityComparisonFacts,
  failures: StabilityGateFailure[]
): void {
  const { attempted, blocking, byStatus, providerEvaluator } =
    facts.candidate.invalidAttempts;
  const blockingFailures = [
    {
      code: "COMPACTION_PROMPT_FAILURE" as const,
      count: blocking.compactionPrompt,
      status: "compaction-prompt-failure" as const,
    },
    {
      code: "NON_COMPRESSING_SUMMARY" as const,
      count: blocking.nonCompressing,
      status: "non-compressing-summary" as const,
    },
    {
      code: "PROTOCOL_FAILURE" as const,
      count: blocking.protocol,
      status: "protocol-failure" as const,
    },
  ];
  for (const { code, count, status } of blockingFailures) {
    if (count > 0) {
      failures.push({ code, payload: { attempted, count, status } });
    }
  }

  if (
    providerEvaluator.rate !== null &&
    providerEvaluator.rate >
      STABILITY_GATE_POLICY.maximumProviderEvaluatorInvalidRate
  ) {
    failures.push({
      code: "PROVIDER_EVALUATOR_INVALID_RATE_EXCEEDED",
      payload: {
        attempted,
        count: providerEvaluator.count,
        maximum: STABILITY_GATE_POLICY.maximumProviderEvaluatorInvalidRate,
        rate: providerEvaluator.rate,
        statuses: {
          "evaluation-provider-failure":
            byStatus["evaluation-provider-failure"] ?? 0,
          "invalid-full-control": byStatus["invalid-full-control"] ?? 0,
          "summary-provider-failure": byStatus["summary-provider-failure"] ?? 0,
        },
      },
    });
  }
}

export function addCompressionFailures(
  facts: StabilityComparisonFacts,
  failures: StabilityGateFailure[]
): void {
  const compression = facts.candidate.compression;
  if (!compression) {
    return;
  }
  for (const { hop, ratio } of compression.byHop) {
    if (ratio.max >= STABILITY_GATE_POLICY.requiredRatioUpperBound) {
      failures.push({
        code: "HOP_RATIO_NOT_BELOW_ONE",
        payload: {
          actual: ratio.max,
          hop,
          requiredBelow: STABILITY_GATE_POLICY.requiredRatioUpperBound,
        },
      });
    }
  }
  if (compression.savings.min <= 0) {
    failures.push({
      code: "POSITIVE_SAVINGS_REQUIRED",
      payload: { actual: compression.savings.min, requiredAbove: 0 },
    });
  }

  const aggregateDelta = facts.compressionDelta.aggregateMean;
  const baselineCompression = facts.baseline.compression;
  if (
    aggregateDelta !== null &&
    baselineCompression &&
    aggregateDelta > STABILITY_GATE_POLICY.maximumAggregateMeanRatioDelta
  ) {
    failures.push({
      code: "AGGREGATE_MEAN_RATIO_REGRESSION",
      payload: {
        baseline: baselineCompression.aggregate.mean,
        candidate: compression.aggregate.mean,
        delta: aggregateDelta,
        maximumDelta: STABILITY_GATE_POLICY.maximumAggregateMeanRatioDelta,
      },
    });
  }

  for (const row of facts.compressionDelta.byScenario) {
    if (row.delta > STABILITY_GATE_POLICY.maximumScenarioMeanRatioDelta) {
      failures.push({
        code: "SCENARIO_MEAN_RATIO_REGRESSION",
        payload: {
          baseline: row.baseline,
          candidate: row.candidate,
          delta: row.delta,
          maximumDelta: STABILITY_GATE_POLICY.maximumScenarioMeanRatioDelta,
          scenario: row.scenario,
        },
      });
    }
  }
}

export function addDisagreementFailures(
  facts: StabilityComparisonFacts,
  failures: StabilityGateFailure[]
): void {
  for (const disagreement of facts.disagreementDrift) {
    failures.push({
      code: "DISAGREEMENT_DRIFT",
      payload: disagreement,
    });
  }
}
