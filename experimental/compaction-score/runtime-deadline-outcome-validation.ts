import type { DeadlineArmTrial } from "./deadline-sweep-types";
import { parseDeadlineArm } from "./deadline-sweep-validation";
import type { RuntimeDeadlineReport } from "./runtime-deadline-outcome-cli-support";
import { createRuntimeDeadlineOutcomeSummary } from "./runtime-deadline-outcome-summary";
import type { RuntimeDeadlineTrial } from "./runtime-deadline-outcome-types";

const REQUIRED_DEADLINES = new Set([10_000, 15_000, 20_000]);

export function validateRuntimeDeadlineOutcomeReport(
  raw: unknown,
  source = "runtime deadline outcome"
): RuntimeDeadlineReport {
  if (!isRecord(raw) || raw.schemaVersion !== "runtime-deadline-outcome-v2") {
    throw new TypeError(`${source} has an unsupported schema version.`);
  }
  if (
    typeof raw.deadlineMs !== "number" ||
    !REQUIRED_DEADLINES.has(raw.deadlineMs)
  ) {
    throw new TypeError(`${source} must use a 10s, 15s, or 20s deadline.`);
  }
  const arm = parseDeadlineArm(raw, source);
  if (arm.attempts.length !== 60) {
    throw new TypeError(`${source} must contain 60 scenario/repetition cells.`);
  }
  const summary = raw.summary;
  if (!isRecord(summary)) {
    throw new TypeError(`${source} is missing its auditable summary.`);
  }
  const expected = createRuntimeDeadlineOutcomeSummary(arm);
  if (JSON.stringify(summary) !== JSON.stringify(expected)) {
    throw new TypeError(`${source} summary is inconsistent with its trials.`);
  }
  if (
    typeof raw.attemptTimeoutMs !== "number" ||
    !Number.isFinite(raw.attemptTimeoutMs)
  ) {
    throw new TypeError(`${source} attempt timeout is invalid.`);
  }
  return {
    attempts: arm.attempts,
    attemptTimeoutMs: raw.attemptTimeoutMs,
    createdAt: arm.createdAt,
    deadlineMs: arm.deadlineMs,
    mode: arm.mode,
    model: arm.model,
    schemaVersion: "runtime-deadline-outcome-v2",
    summary: expected,
    trials: arm.trials.map((trial) => parseRuntimeTrial(trial, source)),
  };
}

function parseRuntimeTrial(
  trial: DeadlineArmTrial,
  source: string
): RuntimeDeadlineTrial {
  if (trial.pathValid !== true || trial.providerStartedAtMs === undefined) {
    throw new TypeError(`${source} lacks required causal path evidence.`);
  }
  return {
    candidateApplied: trial.candidateApplied,
    deadlineMs: trial.deadlineMs,
    decisionLatencyMs: trial.decisionLatencyMs,
    ...(trial.errorCategory === undefined
      ? {}
      : { errorCategory: trial.errorCategory }),
    ...(trial.errorCode === undefined ? {} : { errorCode: trial.errorCode }),
    outcome: trial.outcome,
    pathValid: true,
    providerStarted: trial.providerStarted,
    providerStartedAtMs: trial.providerStartedAtMs,
    repetition: trial.repetition,
    scenario: trial.scenario,
    summaryCallsStarted: trial.summaryCallsStarted,
    summarySpans: trial.summarySpans,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
