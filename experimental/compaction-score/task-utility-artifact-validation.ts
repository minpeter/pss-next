import { validateCampaignRepetitions } from "./campaign-limits";

const FIXTURES = [
  "exec-committed-event-telemetry",
  "prompt-template-dollar-escape",
  "workspace-cache-ignore-correction",
] as const;

export interface TaskUtilityValidationResult {
  readonly fixtures: number;
  readonly model: string;
  readonly pairs: number;
  readonly valid: true;
}

export function validateTaskUtilityArtifact(
  raw: unknown
): TaskUtilityValidationResult {
  const report = object(raw, "task utility");
  if (
    report.schemaVersion !== "task-utility-v1" ||
    (report.mode !== "deterministic" && report.mode !== "live") ||
    JSON.stringify(report.fixtures) !== JSON.stringify(FIXTURES)
  ) {
    throw new TypeError("Invalid task utility artifact identity.");
  }
  const repetitions = positiveInteger(report.repetitions, "repetitions");
  validateCampaignRepetitions(repetitions, "repetitions");
  const model = string(report.model, "model");
  const pairs = array(report.pairs, "pairs");
  const expected = FIXTURES.flatMap((fixture) =>
    Array.from({ length: repetitions }, (_, index) => `${fixture}:${index + 1}`)
  );
  const actual: string[] = [];
  for (const [index, rawPair] of pairs.entries()) {
    const pair = object(rawPair, `pairs[${index}]`);
    const fixture = string(pair.fixture, "fixture");
    const repetition = positiveInteger(pair.repetition, "repetition");
    const expectedOrder =
      repetition % 2 === 1 ? "full-compact" : "compact-full";
    if (pair.order !== expectedOrder) {
      throw new TypeError("Task utility pair order is invalid.");
    }
    actual.push(`${fixture}:${repetition}`);
    if (pair.fullPassed !== true) {
      throw new TypeError("Task utility full-context control failed.");
    }
    const arms = array(pair.arms, "arms");
    if (arms.length !== 2) {
      throw new TypeError("Task utility pair must contain two arms.");
    }
    for (const rawArm of arms) {
      validateArm(rawArm, report.mode);
    }
  }
  if (
    actual.length !== expected.length ||
    new Set(actual).size !== actual.length ||
    expected.some((key) => !actual.includes(key))
  ) {
    throw new TypeError("Task utility pair grid is incomplete.");
  }
  const summary = object(report.summary, "summary");
  validateRate(summary.fullControlSuccess, "fullControlSuccess");
  validateRate(summary.compactConditionalSuccess, "compactConditionalSuccess");
  validateRate(summary.fullQuality, "fullQuality");
  validateRate(summary.compactQuality, "compactQuality");
  validateLatency(summary.fullLatencyMs, "fullLatencyMs");
  validateLatency(summary.compactLatencyMs, "compactLatencyMs");
  if (summary.fullCostUsd !== null || summary.compactCostUsd !== null) {
    throw new TypeError("Task utility cost policy must remain explicit.");
  }
  return {
    fixtures: FIXTURES.length,
    model,
    pairs: pairs.length,
    valid: true,
  };
}

function validateArm(raw: unknown, mode: unknown): void {
  const arm = object(raw, "arm");
  if (arm.arm !== "full" && arm.arm !== "compact") {
    throw new TypeError("Task utility arm identity is invalid.");
  }
  if (
    typeof arm.passed !== "boolean" ||
    typeof arm.assistantOutput !== "string" ||
    (mode === "live" &&
      arm.passed === true &&
      arm.assistantOutput.length === 0) ||
    !Number.isFinite(arm.durationMs)
  ) {
    throw new TypeError("Task utility arm output is not auditable.");
  }
  if (arm.costUsd !== null) {
    throw new TypeError("Task utility cost must be null without rates.");
  }
  const initial = object(arm.initialValidation, "initialValidation");
  const final = object(arm.validation, "validation");
  const initialChecks = array(initial.checks, "initialValidation.checks");
  if (
    initial.passed !== false ||
    initialChecks.length === 0 ||
    typeof final.passed !== "boolean"
  ) {
    throw new TypeError("Task utility RED/GREEN validation is invalid.");
  }
  const checks = array(final.checks, "validation.checks");
  if (
    checks.length === 0 ||
    checks.some((rawCheck) => {
      const check = object(rawCheck, "check");
      return typeof check.id !== "string" || typeof check.passed !== "boolean";
    })
  ) {
    throw new TypeError("Task utility machine checks are invalid.");
  }
  if (
    !Array.isArray(arm.events) ||
    (mode === "live" && arm.events.length === 0) ||
    typeof arm.workspace !== "string"
  ) {
    throw new TypeError("Task utility evidence receipt is incomplete.");
  }
  if (
    (arm.arm === "compact" &&
      (typeof arm.summary !== "string" || arm.summary.length === 0)) ||
    (arm.arm === "full" && arm.summary !== null)
  ) {
    throw new TypeError("Task utility compaction evidence is invalid.");
  }
}

function validateRate(raw: unknown, path: string): void {
  const metric = object(raw, path);
  if (
    typeof metric.denominator !== "number" ||
    !Number.isSafeInteger(metric.denominator) ||
    metric.denominator <= 0 ||
    !rate(metric.rate) ||
    !interval(metric.wilson95)
  ) {
    throw new TypeError(`${path} is invalid.`);
  }
}

function validateLatency(raw: unknown, path: string): void {
  const metric = object(raw, path);
  const values = [metric.mean, metric.max, metric.p95];
  if (!(values.every(finiteNonnegative) && interval(metric.meanCi95))) {
    throw new TypeError(`${path} is invalid.`);
  }
}

function interval(value: unknown): boolean {
  return (
    Array.isArray(value) && value.length === 2 && value.every(finiteNonnegative)
  );
}

function rate(value: unknown): boolean {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array.`);
  }
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${path} must be a nonempty string.`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${path} must be a positive safe integer.`);
  }
  return value;
}
