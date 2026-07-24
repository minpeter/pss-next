import type { StabilityComparisonFacts } from "./stability-comparison-types";
import { STABILITY_GATE_POLICY } from "./stability-gate-policy";
import type { StabilityGateFailure } from "./stability-gate-types";

export function addAttemptFailures(
  facts: StabilityComparisonFacts,
  failures: StabilityGateFailure[]
): void {
  for (const [report, summary] of [
    ["baseline", facts.baseline],
    ["candidate", facts.candidate],
  ] as const) {
    if (summary.invalidAttempts.attempted === 0) {
      failures.push({
        code: "ATTEMPTS_MISSING",
        payload: { attempted: 0, report },
      });
    }
  }
}

export function addShapeFailures(
  facts: StabilityComparisonFacts,
  failures: StabilityGateFailure[]
): void {
  addScenarioShapeFailures(facts, "retention", failures);
  addScenarioShapeFailures(facts, "compression", failures);
}

export function addRecallFailures(
  facts: StabilityComparisonFacts,
  failures: StabilityGateFailure[]
): void {
  const retention = facts.candidate.retention;
  if (!retention) {
    return;
  }
  const rows = [
    { ...retention.aggregate, scope: "aggregate" as const },
    ...retention.byScenario.map((row) => ({
      ...row,
      scope: "scenario" as const,
    })),
    ...retention.byCategory.map((row) => ({
      ...row,
      scope: "category" as const,
    })),
  ];
  for (const { accuracy, correct, id, scope, total } of rows) {
    if (accuracy < STABILITY_GATE_POLICY.requiredRecall) {
      failures.push({
        code: "RECALL_BELOW_REQUIRED",
        payload: {
          actual: accuracy,
          correct,
          ...(id === undefined ? {} : { id }),
          required: STABILITY_GATE_POLICY.requiredRecall,
          scope,
          total,
        },
      });
    }
  }
}

function addScenarioShapeFailures(
  facts: StabilityComparisonFacts,
  metric: "compression" | "retention",
  failures: StabilityGateFailure[]
): void {
  const baselineScenarios = new Set(
    metric === "compression"
      ? facts.baseline.compression?.byScenario.map(({ scenario }) => scenario)
      : facts.baseline.retention?.byScenario.map(({ id }) => id)
  );
  const candidateScenarios = new Set(
    metric === "compression"
      ? facts.candidate.compression?.byScenario.map(({ scenario }) => scenario)
      : facts.candidate.retention?.byScenario.map(({ id }) => id)
  );

  for (const scenario of baselineScenarios) {
    if (!candidateScenarios.has(scenario)) {
      failures.push({
        code: "REPORT_SCENARIO_MISSING",
        payload: { metric, report: "candidate", scenario },
      });
    }
  }
  for (const scenario of candidateScenarios) {
    if (!baselineScenarios.has(scenario)) {
      failures.push({
        code: "REPORT_SCENARIO_MISSING",
        payload: { metric, report: "baseline", scenario },
      });
    }
  }
}
