import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCampaignRepetitions } from "./campaign-limits";
import type { DeadlineArm } from "./deadline-sweep-types";
import { parseDeadlineArm } from "./deadline-sweep-validation";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";
import { requireRuntimeDeadlineTrials } from "./runtime-deadline-outcome-path";
import {
  createRuntimeDeadlineOutcomeSummary,
  type RuntimeDeadlineOutcomeSummary,
} from "./runtime-deadline-outcome-summary";
import type { RuntimeDeadlineTrial } from "./runtime-deadline-outcome-types";

export interface RuntimeDeadlineCliOptions {
  readonly attemptTimeoutMs: number;
  readonly deadlineMs: number;
  readonly mode: "deterministic" | "live";
  readonly outputDirectory: string;
  readonly repetitions: number;
  readonly startRepetition: number;
}

export interface RuntimeDeadlineAttempt {
  readonly errorCode?: string;
  readonly message?: string;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
  readonly status: "completed" | "error" | "setup-error";
}

export interface RuntimeDeadlineReport {
  readonly attempts: readonly RuntimeDeadlineAttempt[];
  readonly attemptTimeoutMs: number;
  readonly createdAt: string;
  readonly deadlineMs: number;
  readonly mode: RuntimeDeadlineCliOptions["mode"];
  readonly model: string;
  readonly schemaVersion: "runtime-deadline-outcome-v2";
  readonly summary: RuntimeDeadlineOutcomeSummary;
  readonly trials: readonly RuntimeDeadlineTrial[];
}

export function parseRuntimeDeadlineOptions(
  args: readonly string[]
): RuntimeDeadlineCliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    printHelpAndExit();
  }
  const mode: RuntimeDeadlineCliOptions["mode"] = "deterministic";
  const parsed = {
    attemptTimeoutMs: 0,
    deadlineMs: 5000,
    mode,
    outputDirectory: `/tmp/runtime-deadline-${new Date().toISOString()}`,
    repetitions: 3,
    startRepetition: 1,
  };
  for (let index = 0; index < normalized.length; index += 2) {
    applyOption(parsed, normalized[index], normalized[index + 1]);
  }
  if (parsed.startRepetition > parsed.repetitions) {
    throw new TypeError(
      "Runtime deadline start repetition must not exceed repetitions."
    );
  }
  if (parsed.attemptTimeoutMs === 0) {
    parsed.attemptTimeoutMs = Math.max(120_000, parsed.deadlineMs * 8);
  }
  return parsed;
}

export async function loadRuntimeDeadlineReport(
  outputDirectory: string,
  identity: {
    readonly deadlineMs: number;
    readonly mode: RuntimeDeadlineReport["mode"];
    readonly model: string;
  }
): Promise<RuntimeDeadlineReport | null> {
  const path = join(outputDirectory, "runtime-deadline-outcome.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
  const report = parseRuntimeDeadlineReport(raw);
  if (
    report.deadlineMs !== identity.deadlineMs ||
    report.mode !== identity.mode ||
    report.model !== identity.model
  ) {
    throw new TypeError("Existing runtime deadline report identity mismatch.");
  }
  const keys = report.attempts.map(runtimeDeadlineAttemptKey);
  if (new Set(keys).size !== keys.length) {
    throw new TypeError(
      "Existing runtime deadline report has duplicate cells."
    );
  }
  return report;
}

export async function writeRuntimeDeadlineReport(
  outputDirectory: string,
  report: Omit<RuntimeDeadlineReport, "schemaVersion" | "summary">
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  const arm: DeadlineArm = {
    attempts: report.attempts,
    createdAt: report.createdAt,
    deadlineMs: report.deadlineMs,
    mode: report.mode,
    model: report.model,
    source: "runtime deadline report",
    trials: report.trials,
  };
  const path = join(outputDirectory, "runtime-deadline-outcome.json");
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(
      temporary,
      `${JSON.stringify({ ...report, schemaVersion: "runtime-deadline-outcome-v2", summary: createRuntimeDeadlineOutcomeSummary(arm) }, null, 2)}\n`
    );
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeRuntimeDeadlineReceipt(
  outputDirectory: string,
  receipt: {
    readonly argv: readonly string[];
    readonly completedAt: string | null;
    readonly error: string | null;
    readonly startedAt: string;
    readonly status: "completed" | "failed" | "running";
  }
): Promise<void> {
  await mkdir(outputDirectory, { recursive: true });
  await atomicWrite(
    join(outputDirectory, "runtime-deadline-outcome-command.json"),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

export function runtimeDeadlineAttemptKey(value: {
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
}): string {
  return `${value.scenario}:${value.repetition}`;
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, contents);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function applyOption(
  parsed: {
    attemptTimeoutMs: number;
    deadlineMs: number;
    mode: RuntimeDeadlineCliOptions["mode"];
    outputDirectory: string;
    repetitions: number;
    startRepetition: number;
  },
  flag: string | undefined,
  value: string | undefined
): void {
  if (flag === "--mode" && (value === "deterministic" || value === "live")) {
    parsed.mode = value;
  } else if (flag === "--output" && value) {
    parsed.outputDirectory = value;
  } else if (flag === "--repetitions") {
    parsed.repetitions = parseCampaignRepetitions(
      value,
      "Runtime deadline repetitions"
    );
  } else if (flag === "--deadline-ms" && isPositiveSafeInteger(value)) {
    parsed.deadlineMs = Number(value);
  } else if (flag === "--start-repetition") {
    parsed.startRepetition = parseCampaignRepetitions(
      value,
      "Runtime deadline start repetition"
    );
  } else if (flag === "--attempt-timeout-ms" && isPositiveSafeInteger(value)) {
    parsed.attemptTimeoutMs = Number(value);
  } else {
    throw new TypeError(`Invalid runtime deadline option: ${flag ?? ""}`);
  }
}

function printHelpAndExit(): never {
  console.log(
    "Usage: runtime-deadline-outcome [--mode deterministic|live] [--deadline-ms N] [--start-repetition N] [--repetitions N] [--attempt-timeout-ms N] [--output DIR]"
  );
  process.exit(0);
}

function isPositiveSafeInteger(value: string | undefined): value is string {
  return (
    value !== undefined &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) > 0
  );
}

export function parseRuntimeDeadlineReport(
  raw: unknown
): RuntimeDeadlineReport {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TypeError("Runtime deadline report must be an object.");
  }
  if (Reflect.get(raw, "schemaVersion") !== "runtime-deadline-outcome-v2") {
    throw new TypeError("Runtime deadline report schema is invalid.");
  }
  const arm = parseDeadlineArm(raw, "runtime deadline report");
  const attemptTimeoutMs = Reflect.get(raw, "attemptTimeoutMs");
  if (
    typeof attemptTimeoutMs !== "number" ||
    !Number.isFinite(attemptTimeoutMs)
  ) {
    throw new TypeError("Runtime deadline attempt timeout is invalid.");
  }
  return {
    attempts: arm.attempts,
    attemptTimeoutMs,
    createdAt: arm.createdAt,
    deadlineMs: arm.deadlineMs,
    mode: arm.mode,
    model: arm.model,
    schemaVersion: "runtime-deadline-outcome-v2",
    summary: createRuntimeDeadlineOutcomeSummary(arm),
    trials: requireRuntimeDeadlineTrials(arm.trials),
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    Reflect.get(error, "code") === "ENOENT"
  );
}
