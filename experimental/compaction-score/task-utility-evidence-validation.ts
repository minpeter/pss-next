import { readFile } from "node:fs/promises";
import { validateTaskUtilityArtifact } from "./task-utility-artifact-validation";
import { TASK_UTILITY_FIXTURES } from "./task-utility-fixtures";
import { validateTaskUtilityReceipt } from "./task-utility-receipt";
import type {
  TaskArmResult,
  TaskLatencyMetric,
  TaskRateMetric,
  TaskUtilityPair,
  TaskUtilityReport,
} from "./task-utility-types";
import { validateTaskWorkspace } from "./task-utility-validator";
import {
  validatedTaskEvidenceFile,
  validatedTaskWorkspacePath,
} from "./task-utility-workspace-path";

export async function validateTaskUtilityEvidence(
  raw: unknown,
  options: {
    readonly artifactPath: string;
    readonly requireCompletedReceipt: boolean;
  }
): Promise<void> {
  const report = parseTaskUtilityReport(raw);
  for (const pair of report.pairs) {
    const fixture = TASK_UTILITY_FIXTURES.find(
      (candidate) => candidate.id === pair.fixture
    );
    if (fixture === undefined) {
      throw new TypeError("Task utility fixture evidence is invalid.");
    }
    for (const arm of pair.arms) {
      await validateArmEvidence(fixture, arm, options.artifactPath);
    }
  }
  if (options.requireCompletedReceipt) {
    await validateTaskUtilityReceipt(options.artifactPath, report);
  }
}

export function parseTaskUtilityReport(raw: unknown): TaskUtilityReport {
  validateTaskUtilityArtifact(raw);
  if (!isTaskUtilityReport(raw)) {
    throw new TypeError("Task utility report schema is invalid.");
  }
  return raw;
}

export function parseTaskUtilityPairs(
  raw: unknown
): readonly TaskUtilityPair[] {
  if (!(Array.isArray(raw) && raw.every(isTaskUtilityPair))) {
    throw new TypeError("Task utility pairs are invalid.");
  }
  return raw;
}

function isTaskUtilityReport(value: unknown): value is TaskUtilityReport {
  if (!isObject(value)) {
    return false;
  }
  const methodology = Reflect.get(value, "methodology");
  const summary = Reflect.get(value, "summary");
  return (
    Reflect.get(value, "schemaVersion") === "task-utility-v1" &&
    typeof Reflect.get(value, "attemptTimeoutMs") === "number" &&
    typeof Reflect.get(value, "createdAt") === "string" &&
    isStringArray(Reflect.get(value, "fixtures")) &&
    isObject(methodology) &&
    Reflect.get(methodology, "compactSuccessCondition") ===
      "conditioned-on-full-success" &&
    Reflect.get(methodology, "costPolicy") === "null-without-explicit-rates" &&
    Reflect.get(methodology, "interval") === "wilson-95" &&
    isTaskUtilityMode(Reflect.get(value, "mode")) &&
    typeof Reflect.get(value, "model") === "string" &&
    Array.isArray(Reflect.get(value, "pairs")) &&
    Reflect.get(value, "pairs").every(isTaskUtilityPair) &&
    typeof Reflect.get(value, "repetitions") === "number" &&
    isTaskUtilitySummary(summary)
  );
}

function isTaskUtilityPair(value: unknown): value is TaskUtilityPair {
  if (!isObject(value)) {
    return false;
  }
  const classification = Reflect.get(value, "classification");
  const order = Reflect.get(value, "order");
  const arms = Reflect.get(value, "arms");
  return (
    Array.isArray(arms) &&
    arms.every(isTaskArmResult) &&
    (classification === "context-loss-failure" ||
      classification === "downstream-execution-variance" ||
      classification === "invalid-full-control" ||
      classification === "retained-success") &&
    typeof Reflect.get(value, "compactPassed") === "boolean" &&
    typeof Reflect.get(value, "fixture") === "string" &&
    typeof Reflect.get(value, "fullPassed") === "boolean" &&
    (order === "compact-full" || order === "full-compact") &&
    typeof Reflect.get(value, "repetition") === "number"
  );
}

function isTaskArmResult(value: unknown): value is TaskArmResult {
  if (!isObject(value)) {
    return false;
  }
  const arm = Reflect.get(value, "arm");
  const summary = Reflect.get(value, "summary");
  return (
    (arm === "compact" || arm === "full") &&
    typeof Reflect.get(value, "assistantOutput") === "string" &&
    Reflect.get(value, "costUsd") === null &&
    typeof Reflect.get(value, "durationMs") === "number" &&
    Array.isArray(Reflect.get(value, "events")) &&
    isTaskValidation(Reflect.get(value, "initialValidation")) &&
    typeof Reflect.get(value, "passed") === "boolean" &&
    (summary === null || typeof summary === "string") &&
    isTaskValidation(Reflect.get(value, "validation")) &&
    typeof Reflect.get(value, "workspace") === "string"
  );
}

function isTaskValidation(value: unknown): boolean {
  if (!isObject(value)) {
    return false;
  }
  const checks = Reflect.get(value, "checks");
  return (
    typeof Reflect.get(value, "passed") === "boolean" &&
    Array.isArray(checks) &&
    checks.every(
      (check) =>
        isObject(check) &&
        typeof Reflect.get(check, "id") === "string" &&
        typeof Reflect.get(check, "passed") === "boolean"
    )
  );
}

function isTaskUtilitySummary(value: unknown): boolean {
  return (
    isObject(value) &&
    isRateMetric(Reflect.get(value, "compactConditionalSuccess")) &&
    Reflect.get(value, "compactCostUsd") === null &&
    isLatencyMetric(Reflect.get(value, "compactLatencyMs")) &&
    isRateMetric(Reflect.get(value, "compactQuality")) &&
    typeof Reflect.get(value, "contextLossFailures") === "number" &&
    isRateMetric(Reflect.get(value, "fullControlSuccess")) &&
    Reflect.get(value, "fullCostUsd") === null &&
    isLatencyMetric(Reflect.get(value, "fullLatencyMs")) &&
    isRateMetric(Reflect.get(value, "fullQuality")) &&
    typeof Reflect.get(value, "invalidFullControls") === "number" &&
    typeof Reflect.get(value, "retainedSuccesses") === "number"
  );
}

function isRateMetric(value: unknown): value is TaskRateMetric {
  return (
    isObject(value) &&
    typeof Reflect.get(value, "denominator") === "number" &&
    typeof Reflect.get(value, "rate") === "number" &&
    isNumberPair(Reflect.get(value, "wilson95"))
  );
}

function isLatencyMetric(value: unknown): value is TaskLatencyMetric {
  return (
    isObject(value) &&
    typeof Reflect.get(value, "max") === "number" &&
    typeof Reflect.get(value, "mean") === "number" &&
    isNumberPair(Reflect.get(value, "meanCi95")) &&
    typeof Reflect.get(value, "p95") === "number"
  );
}

function isNumberPair(value: unknown): value is readonly [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isTaskUtilityMode(value: unknown): value is TaskUtilityReport["mode"] {
  return value === "deterministic" || value === "live";
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function validateArmEvidence(
  fixture: (typeof TASK_UTILITY_FIXTURES)[number],
  arm: TaskArmResult,
  artifactPath: string
): Promise<void> {
  const workspace = await validatedTaskWorkspacePath(
    artifactPath,
    arm.workspace
  );
  const receiptPath = await validatedTaskEvidenceFile(
    workspace,
    "task-utility-receipt.json"
  );
  const receipt: unknown = JSON.parse(await readFile(receiptPath, "utf8"));
  if (JSON.stringify(receipt) !== JSON.stringify(arm)) {
    throw new TypeError(
      "Task utility workspace receipt does not match report."
    );
  }
  const validation = await validateTaskWorkspace(fixture, workspace);
  if (
    validation.passed !== arm.validation.passed ||
    JSON.stringify(validation.checks) !== JSON.stringify(arm.validation.checks)
  ) {
    throw new TypeError("Task utility workspace validation is stale.");
  }
}
