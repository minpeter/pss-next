import {
  array,
  boolean,
  finite,
  nonnegativeInteger,
  object,
  positiveInteger,
  rate,
  string,
  unique,
} from "./deadline-sweep-parse";
import {
  DEADLINE_SWEEP_SCENARIOS,
  type DeadlineArm,
  type DeadlineArmAttempt,
  type DeadlineArmTrial,
  type DeadlineHistoricalEvidence,
  type DeadlineHistoricalScenario,
} from "./deadline-sweep-types";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";
import {
  parseDeadlineSummarySpans,
  validateDeadlinePath,
} from "./runtime-deadline-outcome-path";

const NEW_LIVE_DEADLINES = new Set([10_000, 15_000, 20_000]);

export function parseDeadlineArm(raw: unknown, source: string): DeadlineArm {
  const value = object(raw, source);
  const arm: DeadlineArm = {
    attempts: array(value.attempts, `${source}.attempts`).map(
      (attempt, index) => parseAttempt(attempt, `${source}.attempts[${index}]`)
    ),
    createdAt: string(value.createdAt, `${source}.createdAt`),
    deadlineMs: positiveInteger(value.deadlineMs, `${source}.deadlineMs`),
    mode: mode(value.mode, `${source}.mode`),
    model: string(value.model, `${source}.model`),
    source,
    trials: array(value.trials, `${source}.trials`).map((trial, index) =>
      parseTrial(trial, `${source}.trials[${index}]`)
    ),
  };
  validateArm(arm);
  return arm;
}

export function parseHistoricalEvidence(
  raw: unknown,
  source: string,
  sha256: string
): DeadlineHistoricalEvidence {
  const root = object(raw, source);
  const metadata = object(root.metadata, `${source}.metadata`);
  const rawScenarios = object(root.scenarios, `${source}.scenarios`);
  const scenarios: Partial<
    Record<RuntimeBlockScenario, DeadlineHistoricalScenario>
  > = {};
  for (const scenario of DEADLINE_SWEEP_SCENARIOS) {
    const entry = rawScenarios[scenario];
    if (entry === undefined) {
      continue;
    }
    const old = object(object(entry, scenario).old, `${scenario}.old`);
    scenarios[scenario] = {
      candidateAppliedRate: rate(old.candidateAppliedRate, scenario),
      decisionMeanMs: finite(old.decisionMeanMs, scenario),
      providerStartRate: rate(old.providerStartRate, scenario),
      userBlockMeanMs: finite(old.userBlockMeanMs, scenario),
    };
  }
  if (Object.keys(scenarios).length === 0) {
    throw new TypeError("Historical evidence has no comparable scenarios.");
  }
  return {
    createdAt: string(
      metadata.historicalCreatedAt,
      `${source}.metadata.historicalCreatedAt`
    ),
    deadlineMs: positiveInteger(
      metadata.deadlineMs,
      `${source}.metadata.deadlineMs`
    ),
    model: string(metadata.model, `${source}.metadata.model`),
    scenarios,
    sha256,
    source,
  };
}

function validateArm(arm: DeadlineArm): void {
  const attemptKeys = arm.attempts.map(attemptKey);
  const trialKeys = arm.trials.map(trialKey);
  unique(attemptKeys, `${arm.source} attempt`);
  unique(trialKeys, `${arm.source} trial`);
  const completed = new Set(
    arm.attempts
      .filter((attempt) => attempt.status === "completed")
      .map(attemptKey)
  );
  if (
    trialKeys.some((key) => !completed.has(key)) ||
    completed.size !== trialKeys.length
  ) {
    throw new TypeError(`${arm.source} attempts and trials do not correspond.`);
  }
  if (arm.mode === "live") {
    validateLiveCoverage(arm, attemptKeys);
  }
  for (const trial of arm.trials) {
    validateTrial(arm, trial);
  }
}

function validateLiveCoverage(
  arm: DeadlineArm,
  attemptKeys: readonly string[]
): void {
  const expected = DEADLINE_SWEEP_SCENARIOS.flatMap((scenario) =>
    Array.from({ length: 10 }, (_, index) => `${scenario}:${index + 1}`)
  );
  if (
    attemptKeys.length !== expected.length ||
    expected.some((key) => !attemptKeys.includes(key))
  ) {
    throw new TypeError(`${arm.source} must contain exactly 60 live cells.`);
  }
}

function validateTrial(arm: DeadlineArm, trial: DeadlineArmTrial): void {
  validateDeadlinePath({
    candidateApplied: trial.candidateApplied,
    providerStarted: trial.providerStarted,
    providerStartedAtMs: trial.providerStartedAtMs ?? null,
    spans: trial.summarySpans,
  });
  if (
    trial.deadlineMs !== arm.deadlineMs ||
    trial.decisionLatencyMs < 0 ||
    trial.decisionLatencyMs > arm.deadlineMs + 250 ||
    (trial.candidateApplied && !trial.providerStarted) ||
    (trial.outcome === "provider-started" && !trial.providerStarted) ||
    (trial.outcome === "timeout" &&
      (trial.providerStarted ||
        trial.errorCategory !== "timeout" ||
        trial.errorCode !== "COMPACTION_DEADLINE_EXCEEDED"))
  ) {
    throw new TypeError(`${arm.source} has an invalid deadline trial.`);
  }
  if (
    arm.mode === "live" &&
    NEW_LIVE_DEADLINES.has(arm.deadlineMs) &&
    (trial.pathValid !== true ||
      trial.summaryCallsStarted !== trial.summarySpans.length)
  ) {
    throw new TypeError(`${arm.source} lacks required causal path evidence.`);
  }
}

function parseAttempt(value: unknown, path: string): DeadlineArmAttempt {
  const item = object(value, path);
  const status = item.status;
  if (
    status !== "completed" &&
    status !== "error" &&
    status !== "setup-error"
  ) {
    throw new TypeError(`${path}.status is invalid.`);
  }
  return {
    ...(item.message === undefined
      ? {}
      : { message: string(item.message, `${path}.message`) }),
    repetition: positiveInteger(item.repetition, `${path}.repetition`),
    scenario: scenario(item.scenario, `${path}.scenario`),
    status,
  };
}

function parseTrial(value: unknown, path: string): DeadlineArmTrial {
  const item = object(value, path);
  const outcome = item.outcome;
  if (
    outcome !== "provider-started" &&
    outcome !== "timeout" &&
    outcome !== "turn-error"
  ) {
    throw new TypeError(`${path}.outcome is invalid.`);
  }
  return {
    candidateApplied: boolean(item.candidateApplied, path),
    deadlineMs: positiveInteger(item.deadlineMs, path),
    decisionLatencyMs: finite(item.decisionLatencyMs, path),
    ...(optionalString(item.errorCategory, path) ?? {}),
    ...(optionalCode(item.errorCode, path) ?? {}),
    outcome,
    ...(item.pathValid === undefined
      ? {}
      : { pathValid: boolean(item.pathValid, path) }),
    providerStarted: boolean(item.providerStarted, path),
    ...(item.providerStartedAtMs === undefined
      ? {}
      : {
          providerStartedAtMs:
            item.providerStartedAtMs === null
              ? null
              : finite(item.providerStartedAtMs, path),
        }),
    repetition: positiveInteger(item.repetition, path),
    scenario: scenario(item.scenario, path),
    summaryCallsStarted: nonnegativeInteger(item.summaryCallsStarted, path),
    summarySpans: parseDeadlineSummarySpans(
      item.summarySpans,
      `${path}.summarySpans`
    ),
  };
}

function optionalString(
  value: unknown,
  path: string
): { readonly errorCategory: string } | undefined {
  return value === undefined
    ? undefined
    : { errorCategory: string(value, `${path}.errorCategory`) };
}

function optionalCode(
  value: unknown,
  path: string
): { readonly errorCode: string } | undefined {
  return value === undefined
    ? undefined
    : { errorCode: string(value, `${path}.errorCode`) };
}

function attemptKey(value: DeadlineArmAttempt): string {
  return `${value.scenario}:${value.repetition}`;
}

function trialKey(value: DeadlineArmTrial): string {
  return `${value.scenario}:${value.repetition}`;
}

function scenario(value: unknown, path: string): RuntimeBlockScenario {
  switch (value) {
    case "candidate-fit-late-hit":
    case "candidate-too-broad-fallback":
    case "overlap-nonblocking":
    case "prepared-hit":
    case "repeated-failure-overflow-recovery":
    case "summary-failure-retry-hit":
      return value;
    default:
      throw new TypeError(`${path} is not a benchmark scenario.`);
  }
}

function mode(value: unknown, path: string): DeadlineArm["mode"] {
  if (value !== "deterministic" && value !== "live") {
    throw new TypeError(`${path} is not a benchmark mode.`);
  }
  return value;
}
