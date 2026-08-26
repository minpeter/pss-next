import {
  DEADLINE_SWEEP_SCENARIOS,
  type DeadlineSweepReport,
} from "./deadline-sweep-types";
import type { FiveTrackReport } from "./five-track-types";
import {
  array,
  finite,
  object,
  positiveInteger,
  string,
} from "./production-overlap-parse";

const DEADLINES = [5000, 10_000, 15_000, 20_000] as const;
const LIVE_DEADLINES = [10_000, 15_000, 20_000] as const;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PREFIXED_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function validateDeadlineSweepArtifact(
  raw: unknown
): asserts raw is DeadlineSweepReport {
  const report = object(raw, "deadline sweep");
  if (
    report.schemaVersion !== "deadline-sweep-v1" ||
    JSON.stringify(report.deadlinesMs) !== JSON.stringify(DEADLINES) ||
    report.mode !== "live" ||
    typeof report.model !== "string" ||
    report.model.length === 0
  ) {
    throw new TypeError("Deadline sweep identity is invalid.");
  }
  validateDeadlineMethodology(report.methodology);
  validateDeadlineArms(report.arms);
  validateDeadlineInputs(report.inputEvidence);
  const scenarios = object(report.scenarios, "deadline scenarios");
  for (const scenario of DEADLINE_SWEEP_SCENARIOS) {
    const grid = object(scenarios[scenario], `deadline scenario ${scenario}`);
    for (const deadline of DEADLINES) {
      validateDeadlineAggregate(grid[String(deadline)], deadline);
    }
  }
  validateDeadlinePareto(report.pareto, false);
  validateDeadlinePareto(report.historicalPareto, true);
  if (
    !Array.isArray(report.paired) ||
    report.paired.length === 0 ||
    !SHA256_PATTERN.test(
      string(
        object(report.historical, "deadline historical").sha256,
        "historical sha256"
      )
    )
  ) {
    throw new TypeError("Deadline sweep comparison evidence is incomplete.");
  }
}

function validateDeadlineInputs(raw: unknown): void {
  const inputs = object(raw, "deadline input evidence");
  for (const deadline of DEADLINES) {
    const input = object(
      inputs[String(deadline)],
      `deadline input ${deadline}`
    );
    if (
      !PREFIXED_SHA256_PATTERN.test(
        string(input.artifactSha256, "deadline artifact hash")
      ) ||
      string(input.source, "deadline input source").length === 0
    ) {
      throw new TypeError("Deadline input evidence is invalid.");
    }
    const live = deadline >= 10_000;
    if (
      input.receiptPolicy !==
        (live ? "exact-live-command" : "legacy-unverified") ||
      (live
        ? !PREFIXED_SHA256_PATTERN.test(
            string(input.receiptSha256, "deadline receipt hash")
          )
        : input.receiptSha256 !== null)
    ) {
      throw new TypeError("Deadline receipt evidence is invalid.");
    }
  }
}

export function validateFiveTrackReport(
  raw: unknown
): asserts raw is FiveTrackReport {
  const report = object(raw, "five-track report");
  const methodology = object(report.methodology, "methodology");
  if (
    report.schemaVersion !== "five-track-report-v1" ||
    "aggregateScore" in report ||
    methodology.aggregateScore !== "forbidden" ||
    methodology.qualityOutputBudgetEnforcement !==
      "local-four-characters-per-token-hard-cap"
  ) {
    throw new TypeError("Five-track report identity is invalid.");
  }
  const inputs = object(report.inputs, "inputs");
  const tracks = ["deadline", "human", "production", "quality", "task"];
  for (const track of tracks) {
    const input = object(inputs[track], `input.${track}`);
    if (
      input.status !== "measured" ||
      !string(input.sha256, `input.${track}.sha256`).startsWith("sha256:") ||
      (["production", "quality", "task"].includes(track)
        ? !PREFIXED_SHA256_PATTERN.test(
            string(input.receiptSha256, `input.${track}.receiptSha256`)
          )
        : input.receiptSha256 !== null)
    ) {
      throw new TypeError("Five-track input provenance is invalid.");
    }
  }
  const deadline = object(inputs.deadline, "input.deadline");
  const human = object(inputs.human, "input.human");
  for (const track of ["production", "quality", "task"]) {
    const input = object(inputs[track], `input.${track}`);
    if (
      deadline.mode !== "live" ||
      input.mode !== deadline.mode ||
      typeof deadline.model !== "string" ||
      deadline.model.length === 0 ||
      input.model !== deadline.model
    ) {
      throw new TypeError("Five-track input compatibility is invalid.");
    }
  }
  if (human.mode !== null || human.model !== null) {
    throw new TypeError("Five-track input compatibility is invalid.");
  }
}

function validateDeadlineMethodology(raw: unknown): void {
  const methodology = object(raw, "deadline methodology");
  if (
    methodology.bootstrapIterations !== 10_000 ||
    methodology.bootstrapSeed !== 15_081 ||
    methodology.pairedResampling !== "whole-scenario-repetition-cells" ||
    methodology.rateInterval !== "wilson-95"
  ) {
    throw new TypeError("Deadline methodology is invalid.");
  }
}

function validateDeadlineArms(raw: unknown): void {
  const arms = object(raw, "deadline arms");
  for (const deadline of LIVE_DEADLINES) {
    const arm = object(arms[String(deadline)], `deadline arm ${deadline}`);
    const completed = nonnegativeInteger(arm.completed, "arm.completed");
    const errors = nonnegativeInteger(arm.attemptErrors, "arm.attemptErrors");
    if (
      arm.cells !== 60 ||
      arm.uniqueCells !== 60 ||
      arm.finiteLatencies !== true ||
      arm.typedTimeouts !== true ||
      arm.pathPolicy !== "required" ||
      completed + errors !== 60
    ) {
      throw new TypeError(`Deadline arm ${deadline} is invalid.`);
    }
  }
}

function validateDeadlineAggregate(raw: unknown, deadline: number): void {
  const aggregate = object(raw, "deadline aggregate");
  const attempts = positiveInteger(aggregate.attempts, "deadline attempts");
  const completed = nonnegativeInteger(
    aggregate.completed,
    "deadline completed"
  );
  const errors = nonnegativeInteger(aggregate.attemptErrors, "deadline errors");
  if (
    (deadline >= 10_000 && attempts !== 10) ||
    completed + errors !== attempts
  ) {
    throw new TypeError("Deadline aggregate accounting is invalid.");
  }
}

function validateDeadlinePareto(raw: unknown, labels: boolean): void {
  const pareto = object(raw, "deadline pareto");
  for (const scenario of DEADLINE_SWEEP_SCENARIOS) {
    const values = array(pareto[scenario], `pareto.${scenario}`);
    if (
      values.some((value) =>
        labels
          ? typeof value !== "string"
          : typeof value !== "number" ||
            !DEADLINES.some((deadline) => deadline === value)
      )
    ) {
      throw new TypeError("Deadline Pareto evidence is invalid.");
    }
  }
}

function nonnegativeInteger(value: unknown, path: string): number {
  const parsed = finite(value, path);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${path} must be a nonnegative integer.`);
  }
  return parsed;
}
