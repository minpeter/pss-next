import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { parseCampaignRepetitions } from "./campaign-limits";
import { validateTaskUtilityArtifact } from "./task-utility-artifact-validation";
import { validateTaskUtilityEvidence } from "./task-utility-evidence-validation";
import {
  createTaskUtilityReport,
  renderTaskUtilityReport,
} from "./task-utility-report";
import { runTaskUtilityCampaign } from "./task-utility-runner";
import {
  writeTaskUtilityReceipt,
  writeTaskUtilityReport,
} from "./task-utility-storage";
import type { TaskUtilityMode } from "./task-utility-types";
import { formatTerminalReportLocation } from "./terminal-text";

interface CliOptions {
  readonly attemptTimeoutMs: number;
  readonly mode: TaskUtilityMode;
  readonly outputDirectory: string;
  readonly repetitions: number;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.outputDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeReceipt(options, startedAt, "running", null);
  try {
    const pairs = await runTaskUtilityCampaign(options);
    const model =
      options.mode === "live"
        ? readOpenAICompatibleModelEnv().AI_MODEL
        : "deterministic-mock";
    const report = createTaskUtilityReport({
      attemptTimeoutMs: options.attemptTimeoutMs,
      mode: options.mode,
      model,
      pairs,
      repetitions: options.repetitions,
    });
    await writeTaskUtilityReport(
      options.outputDirectory,
      report,
      renderTaskUtilityReport(report)
    );
    validateTaskUtilityArtifact(report);
    await validateTaskUtilityEvidence(report, {
      artifactPath: join(options.outputDirectory, "task-utility.json"),
      requireCompletedReceipt: false,
    });
    await writeReceipt(options, startedAt, "completed", null);
    console.log(formatTerminalReportLocation(options.outputDirectory));
  } catch (error) {
    await writeReceipt(
      options,
      startedAt,
      "failed",
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

async function writeReceipt(
  options: CliOptions,
  startedAt: string,
  status: "completed" | "failed" | "running",
  error: string | null
): Promise<void> {
  await writeTaskUtilityReceipt(options.outputDirectory, {
    argv: taskUtilityReceiptArguments(options),
    completedAt: status === "running" ? null : new Date().toISOString(),
    error,
    startedAt,
    status,
  });
}

function taskUtilityReceiptArguments(options: CliOptions): readonly string[] {
  return [
    "--mode",
    options.mode,
    "--output",
    options.outputDirectory,
    "--repetitions",
    String(options.repetitions),
    "--attempt-timeout-ms",
    String(options.attemptTimeoutMs),
  ];
}

function parseOptions(args: readonly string[]): CliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    printHelpAndExit();
  }
  let mode: TaskUtilityMode = "deterministic";
  let attemptTimeoutMs = 10 * 60 * 1000;
  let repetitions = 3;
  let outputDirectory = `/tmp/task-utility-${new Date().toISOString()}`;
  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index];
    const value = normalized[index + 1];
    if (flag === "--mode" && (value === "deterministic" || value === "live")) {
      mode = value;
    } else if (flag === "--repetitions") {
      repetitions = parseCampaignRepetitions(value, "Task utility repetitions");
    } else if (flag === "--output" && value) {
      outputDirectory = value;
    } else if (
      flag === "--attempt-timeout-ms" &&
      value &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) > 0
    ) {
      attemptTimeoutMs = Number(value);
    } else {
      throw new TypeError(`Invalid task-utility option: ${flag ?? ""}`);
    }
  }
  return { attemptTimeoutMs, mode, outputDirectory, repetitions };
}

function printHelpAndExit(): never {
  console.log(
    "Usage: task-utility [--mode deterministic|live] [--repetitions N] [--attempt-timeout-ms N] [--output DIR]"
  );
  process.exit(0);
}

try {
  await main();
} catch {
  process.stderr.write("task-utility-failure\n");
  process.exitCode = 1;
}
