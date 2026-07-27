import {
  compareTrialSummaries,
  inspectTrialSummary,
  type ReportFactIssue,
  type ReportRole,
  type StabilityComparisonFacts,
} from "./stability-comparison";
import {
  addCompressionFailures,
  addDisagreementFailures,
  addInvalidAttemptFailures,
} from "./stability-gate-candidate-evaluator";
import { STABILITY_GATE_POLICY as POLICY } from "./stability-gate-policy";
import {
  addAttemptFailures,
  addRecallFailures,
  addShapeFailures,
} from "./stability-gate-report-evaluator";
import type {
  StabilityGateCode as StabilityGateCodeShape,
  StabilityGateDecision as StabilityGateDecisionShape,
  StabilityGateFailure as StabilityGateFailureShape,
} from "./stability-gate-types";

export const STABILITY_GATE_POLICY = POLICY;
export type StabilityGateCode = StabilityGateCodeShape;
export type StabilityGateDecision = StabilityGateDecisionShape;
export type StabilityGateFailure = StabilityGateFailureShape;

export function evaluateStabilityComparison(
  baseline: unknown,
  candidate: unknown
): StabilityGateDecision {
  const baselineInspection = inspectTrialSummary(baseline, "baseline");
  const candidateInspection = inspectTrialSummary(candidate, "candidate");
  const validationFailures: StabilityGateFailure[] = [];
  if (!baselineInspection.valid) {
    validationFailures.push(failureForIssue(baselineInspection.issue));
  }
  if (!candidateInspection.valid) {
    validationFailures.push(failureForIssue(candidateInspection.issue));
  }
  if (!(baselineInspection.valid && candidateInspection.valid)) {
    return decision(validationFailures);
  }

  return evaluateStabilityGates(
    compareTrialSummaries(
      baselineInspection.summary,
      candidateInspection.summary
    )
  );
}

export function evaluateStabilityGates(
  facts: StabilityComparisonFacts
): StabilityGateDecision {
  const failures: StabilityGateFailure[] = [];
  addAttemptFailures(facts, failures);
  addShapeFailures(facts, failures);
  addRecallFailures(facts, failures);
  addInvalidAttemptFailures(facts, failures);
  addCompressionFailures(facts, failures);
  addDisagreementFailures(facts, failures);
  return decision(failures);
}

export function reportJsonInvalidFailure(
  report: ReportRole,
  path: string
): StabilityGateFailure {
  return { code: "REPORT_JSON_INVALID", payload: { path, report } };
}

export function reportReadFailure(
  report: ReportRole,
  path: string
): StabilityGateFailure {
  return { code: "REPORT_READ_FAILED", payload: { path, report } };
}

function failureForIssue(issue: ReportFactIssue): StabilityGateFailure {
  if (issue.kind === "missing") {
    return {
      code: "REPORT_METRIC_MISSING",
      payload: { path: issue.path, report: issue.report },
    };
  }
  if (issue.kind === "unknown-scenario") {
    return {
      code: "REPORT_SCENARIO_UNKNOWN",
      payload: {
        path: issue.path,
        report: issue.report,
        scenario: issue.scenario,
      },
    };
  }
  return {
    code: "REPORT_METRIC_INVALID",
    payload: {
      actual: issue.actual,
      expected: issue.expected,
      path: issue.path,
      report: issue.report,
    },
  };
}

function decision(
  failures: readonly StabilityGateFailure[]
): StabilityGateDecision {
  return { failures, passed: failures.length === 0 };
}
