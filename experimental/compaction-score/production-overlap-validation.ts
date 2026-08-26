import { validateCampaignRepetitions } from "./campaign-limits";
import { validateProductionOverlapAggregates } from "./production-overlap-aggregate-validation";
import {
  array,
  finite,
  object,
  positiveInteger,
  productionOverlapScenario,
  productionOverlapTimestamps,
  string,
} from "./production-overlap-parse";
import type {
  ProductionOverlapAttempt,
  ProductionOverlapPair,
} from "./production-overlap-types";
import {
  attemptKey,
  close,
  pairKey,
  pairMetric,
  validateMethodology,
} from "./production-overlap-validation-support";
import {
  isRuntimeUserBlockZero,
  type RuntimeSummarySpan,
} from "./runtime-block-time-metrics";

const SCENARIOS = [
  "overlap-nonblocking",
  "prepared-hit",
  "candidate-fit-late-hit",
  "candidate-too-broad-fallback",
  "summary-failure-retry-hit",
  "repeated-failure-overflow-recovery",
] as const;

interface ProductionOverlapEvidence {
  readonly attempts: readonly ProductionOverlapAttempt[];
  readonly attemptTimeoutMs: number;
  readonly mode: "deterministic" | "live";
  readonly model: string;
  readonly pairs: readonly ProductionOverlapPair[];
  readonly repetitions: number;
}

export interface ProductionOverlapValidationResult {
  readonly attemptErrors: number;
  readonly evidence: ProductionOverlapEvidence;
  readonly model: string;
  readonly pairs: number;
  readonly valid: true;
}

export function validateProductionOverlapArtifact(
  raw: unknown
): ProductionOverlapValidationResult {
  const report = object(raw, "production overlap");
  if (
    report.schemaVersion !== "production-overlap-v1" ||
    (report.mode !== "deterministic" && report.mode !== "live")
  ) {
    throw new TypeError("Invalid production overlap identity.");
  }
  const attemptTimeoutMs = positiveInteger(
    report.attemptTimeoutMs,
    "attemptTimeoutMs"
  );
  const mode = report.mode;
  const model = string(report.model, "model");
  const repetitions = positiveInteger(report.repetitions, "repetitions");
  validateCampaignRepetitions(repetitions, "repetitions");
  const attempts = array(report.attempts, "attempts").map(
    parseProductionOverlapAttempt
  );
  const expected = SCENARIOS.flatMap((scenarioValue) =>
    Array.from(
      { length: repetitions },
      (_, index) => `${scenarioValue}:${index + 1}`
    )
  );
  const attemptKeys = attempts.map(attemptKey);
  if (
    attemptKeys.length !== expected.length ||
    new Set(attemptKeys).size !== attemptKeys.length ||
    expected.some((key) => !attemptKeys.includes(key))
  ) {
    throw new TypeError("Production overlap attempt grid is incomplete.");
  }
  const completed = new Set(
    attempts.filter((attempt) => attempt.status === "completed").map(attemptKey)
  );
  const pairs = array(report.pairs, "pairs").map(parseProductionOverlapPair);
  const pairKeys = pairs.map(pairKey);
  if (
    pairKeys.length !== completed.size ||
    new Set(pairKeys).size !== pairKeys.length ||
    pairKeys.some((key) => !completed.has(key))
  ) {
    throw new TypeError("Production overlap pairs do not match attempts.");
  }
  validateProductionOverlapAggregates(report.aggregates, pairs);
  validateMethodology(report.methodology);
  return {
    attemptErrors: attempts.filter((attempt) => attempt.status === "error")
      .length,
    evidence: {
      attempts,
      attemptTimeoutMs,
      mode,
      model,
      pairs,
      repetitions,
    },
    model,
    pairs: pairs.length,
    valid: true,
  };
}

export function parseProductionOverlapAttempt(
  raw: unknown
): ProductionOverlapAttempt {
  const attempt = object(raw, "attempt");
  const repetition = positiveInteger(attempt.repetition, "attempt.repetition");
  const scenarioValue = productionOverlapScenario(attempt.scenario);
  switch (attempt.status) {
    case "completed":
      return typeof attempt.message === "string"
        ? {
            message: attempt.message,
            repetition,
            scenario: scenarioValue,
            status: "completed",
          }
        : { repetition, scenario: scenarioValue, status: "completed" };
    case "error":
      if (typeof attempt.message === "string") {
        return {
          message: attempt.message,
          repetition,
          scenario: scenarioValue,
          status: "error",
        };
      }
      throw new TypeError("Production overlap attempt status is invalid.");
    default:
      throw new TypeError("Production overlap attempt status is invalid.");
  }
}

export function parseProductionOverlapPair(
  raw: unknown
): ProductionOverlapPair {
  const pair = object(raw, "pair");
  const control = productionOverlapTimestamps(pair.control, "control");
  const treatment = productionOverlapTimestamps(pair.treatment, "treatment");
  const actualTurnDeltaMs = pairMetric(pair.actualTurnDeltaMs);
  const actualUserBlockMs = finite(
    pair.actualUserBlockMs,
    "pair.actualUserBlockMs"
  );
  const dispatchDeltaMs = pairMetric(pair.dispatchDeltaMs);
  const dispatchBlockMs = pairMetric(pair.dispatchBlockMs);
  const decisionDeltaMs = pairMetric(pair.decisionDeltaMs);
  const completionDeltaMs = pairMetric(pair.completionDeltaMs);
  const actualDelta =
    treatment.firstVisibleAtMs -
    treatment.sentAtMs -
    (control.firstVisibleAtMs - control.sentAtMs);
  const dispatchDelta =
    treatment.providerStartedAtMs -
    treatment.sentAtMs -
    (control.providerStartedAtMs - control.sentAtMs);
  const decisionDelta =
    treatment.providerStartedAtMs -
    treatment.stepStartedAtMs -
    (control.providerStartedAtMs - control.stepStartedAtMs);
  const completionDelta =
    treatment.turnEndedAtMs -
    treatment.sentAtMs -
    (control.turnEndedAtMs - control.sentAtMs);
  if (
    ![
      close(actualTurnDeltaMs, actualDelta),
      close(actualUserBlockMs, Math.max(0, actualDelta)),
      close(dispatchDeltaMs, dispatchDelta),
      close(dispatchBlockMs, Math.max(0, dispatchDelta)),
      close(decisionDeltaMs, decisionDelta),
      close(completionDeltaMs, completionDelta),
    ].every(Boolean) ||
    pair.zeroBlock !== isRuntimeUserBlockZero(actualUserBlockMs) ||
    pair.pathValid !== true
  ) {
    throw new TypeError("Production overlap pair metrics are inconsistent.");
  }
  if (
    pair.order !== "control-treatment" &&
    pair.order !== "treatment-control"
  ) {
    throw new TypeError("Production overlap pair order is invalid.");
  }
  const summarySpans = array(pair.summarySpans, "summarySpans").map(parseSpan);
  const overlapAtProviderStart = summarySpans.some(
    ({ endedAtMs, startedAtMs }) =>
      startedAtMs <= treatment.providerStartedAtMs &&
      treatment.providerStartedAtMs < endedAtMs
  );
  if (
    typeof pair.candidateApplied !== "boolean" ||
    typeof pair.overlapAtProviderStart !== "boolean" ||
    pair.overlapAtProviderStart !== overlapAtProviderStart
  ) {
    throw new TypeError("Production overlap path evidence is inconsistent.");
  }
  return {
    actualTurnDeltaMs,
    actualUserBlockMs,
    candidateApplied: pair.candidateApplied,
    completionDeltaMs,
    control,
    decisionDeltaMs,
    dispatchBlockMs,
    dispatchDeltaMs,
    order: pair.order,
    overlapAtProviderStart: pair.overlapAtProviderStart,
    pathValid: true,
    repetition: positiveInteger(pair.repetition, "pair.repetition"),
    scenario: productionOverlapScenario(pair.scenario),
    summarySpans,
    treatment,
    zeroBlock: pair.zeroBlock,
  };
}

function parseSpan(raw: unknown): RuntimeSummarySpan {
  const span = object(raw, "summarySpan");
  const startedAtMs = finite(span.startedAtMs, "summarySpan.startedAtMs");
  const endedAtMs = finite(span.endedAtMs, "summarySpan.endedAtMs");
  if (
    span.kind !== "summary" ||
    (span.status !== "completed" && span.status !== "error") ||
    endedAtMs < startedAtMs
  ) {
    throw new TypeError("Production overlap summary span is invalid.");
  }
  return { endedAtMs, kind: "summary", startedAtMs, status: span.status };
}
