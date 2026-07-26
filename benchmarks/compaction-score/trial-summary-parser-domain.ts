import type { BenchmarkScenario } from "./fixture";
import type { DisagreementFingerprint } from "./report";
import { BENCHMARK_SCENARIOS } from "./scenario-fixtures";
import type { ReportRole } from "./stability-comparison-types";
import {
  InvalidReportFact,
  invalid,
  stringField,
} from "./trial-summary-parser-values";

const QUESTION_CATEGORIES = [
  "boundary-recall",
  "constraint-retention",
  "distractor-resolution",
  "exact-recall",
  "file-state",
  "hallucination-resistance",
  "negative-knowledge",
  "task-continuation",
  "temporal-resolution",
  "tool-history",
] as const satisfies readonly DisagreementFingerprint["category"][];

export function categoryField(
  record: Readonly<Record<string, unknown>>,
  path: string,
  report: ReportRole
): DisagreementFingerprint["category"] {
  const category = stringField(record, "category", `${path}.category`, report);
  const knownCategory = QUESTION_CATEGORIES.find((known) => known === category);
  return (
    knownCategory ??
    invalid(`${path}.category`, "known question category", category, report)
  );
}

export function disagreementArmField(
  record: Readonly<Record<string, unknown>>,
  path: string,
  report: ReportRole
): DisagreementFingerprint["arm"] {
  const arm = stringField(record, "arm", `${path}.arm`, report);
  if (arm === "compacted" || arm === "full") {
    return arm;
  }
  return invalid(`${path}.arm`, "compacted or full", arm, report);
}

export function scenarioField(
  record: Readonly<Record<string, unknown>>,
  path: string,
  report: ReportRole
): BenchmarkScenario {
  const scenario = stringField(record, "scenario", `${path}.scenario`, report);
  const knownScenario = BENCHMARK_SCENARIOS.find(
    (candidate) => candidate === scenario
  );
  if (knownScenario) {
    return knownScenario;
  }
  throw new InvalidReportFact({
    kind: "unknown-scenario",
    path: `${path}.scenario`,
    report,
    scenario,
  });
}
