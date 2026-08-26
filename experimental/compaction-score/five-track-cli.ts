import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateDeadlineSweepInputEvidence } from "./deadline-sweep-receipt";
import {
  createFiveTrackReport,
  fiveTrackEvidence,
} from "./five-track-analysis";
import { renderFiveTrackReport } from "./five-track-report";
import {
  validateDeadlineSweepArtifact,
  validateFiveTrackReport,
} from "./five-track-validation";
import { validateHumanCalibrationReport } from "./human-calibration-report-validation";
import type { HumanCalibrationReport } from "./human-calibration-types";
import { sha256 } from "./human-calibration-utils";
import { validateProductionOverlapReceipt } from "./production-overlap-receipt";
import type { ProductionOverlapReport } from "./production-overlap-types";
import { validateProductionOverlapArtifact } from "./production-overlap-validation";
import { validateQualitySweepReceipt } from "./quality-sweep-receipt";
import type { QualitySweepReport } from "./quality-sweep-types";
import { validateQualitySweepArtifact } from "./quality-sweep-validation";
import { validateTaskUtilityArtifact } from "./task-utility-artifact-validation";
import { validateTaskUtilityEvidence } from "./task-utility-evidence-validation";
import { validateTaskUtilityReceipt } from "./task-utility-receipt";
import type { TaskUtilityReport } from "./task-utility-types";
import { formatTerminalReportLocation } from "./terminal-text";

interface CliOptions {
  readonly deadline: string;
  readonly human: string;
  readonly output: string;
  readonly production: string;
  readonly quality: string;
  readonly task: string;
}

type InputValidator<T> = (raw: unknown) => asserts raw is T;

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const [qualityInput, taskInput, humanInput, productionInput, deadlineInput] =
    await Promise.all([
      loadInput(options.quality, validateQualityInput),
      loadInput(options.task, validateTaskInput),
      loadInput(options.human, validateHumanInput),
      loadInput(options.production, validateProductionInput),
      loadInput(options.deadline, validateDeadlineSweepArtifact),
    ]);
  await validateTaskUtilityEvidence(taskInput.raw, {
    artifactPath: taskInput.path,
    requireCompletedReceipt: true,
  });
  const [qualityReceipt, taskReceipt, productionReceipt] = await Promise.all([
    validateQualitySweepReceipt(qualityInput.path, qualityInput.value),
    validateTaskUtilityReceipt(taskInput.path, taskInput.value),
    validateProductionOverlapReceipt(
      productionInput.path,
      productionInput.value
    ),
    validateDeadlineSweepInputEvidence(deadlineInput.value),
  ]);
  assertLiveInputs([
    qualityInput.value.mode,
    taskInput.value.mode,
    productionInput.value.mode,
    deadlineInput.value.mode,
  ]);
  const report = createFiveTrackReport({
    deadline: deadlineInput.value,
    human: humanInput.value,
    inputs: {
      deadline: inputEvidence(
        deadlineInput,
        "deadline-sweep",
        deadlineInput.value.schemaVersion,
        deadlineInput.value.model,
        deadlineInput.value.mode,
        null
      ),
      human: inputEvidence(
        humanInput,
        "human-calibration",
        humanInput.value.schemaVersion,
        null,
        null,
        null
      ),
      production: inputEvidence(
        productionInput,
        "production-overlap",
        productionInput.value.schemaVersion,
        productionInput.value.model,
        productionInput.value.mode,
        productionReceipt.sha256
      ),
      quality: inputEvidence(
        qualityInput,
        "quality-sweep",
        qualityInput.value.schemaVersion,
        qualityInput.value.model,
        qualityInput.value.mode,
        qualityReceipt.sha256
      ),
      task: inputEvidence(
        taskInput,
        "task-utility",
        taskInput.value.schemaVersion,
        taskInput.value.model,
        taskInput.value.mode,
        taskReceipt.sha256
      ),
    },
    production: productionInput.value,
    quality: qualityInput.value,
    task: taskInput.value,
  });
  validateFiveTrackReport(report);
  await mkdir(options.output, { recursive: true });
  await Promise.all([
    writeFile(
      resolve(options.output, "five-track-report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    writeFile(
      resolve(options.output, "five-track-report.ko.md"),
      renderFiveTrackReport(report)
    ),
  ]);
  console.log(formatTerminalReportLocation(options.output));
}

async function loadInput<T>(
  path: string,
  validate: InputValidator<T>
): Promise<{
  readonly path: string;
  readonly raw: unknown;
  readonly sha256: string;
  readonly value: T;
}> {
  const resolved = resolve(path);
  const contents = await readFile(resolved, "utf8");
  const raw: unknown = JSON.parse(contents);
  validate(raw);
  return { path: resolved, raw, sha256: sha256(contents), value: raw };
}

const validateQualityInput: InputValidator<QualitySweepReport> = (raw) => {
  validateQualitySweepArtifact(raw);
};

const validateTaskInput: InputValidator<TaskUtilityReport> = (raw) => {
  validateTaskUtilityArtifact(raw);
};

const validateHumanInput: InputValidator<HumanCalibrationReport> = (raw) => {
  validateHumanCalibrationReport(raw);
};

const validateProductionInput: InputValidator<ProductionOverlapReport> = (
  raw
) => {
  validateProductionOverlapArtifact(raw);
};

function inputEvidence<
  T extends { readonly path: string; readonly sha256: string },
>(
  input: T,
  track:
    | "deadline-sweep"
    | "human-calibration"
    | "production-overlap"
    | "quality-sweep"
    | "task-utility",
  schemaVersion: string,
  model: string | null,
  mode: "deterministic" | "live" | null,
  receiptSha256: string | null
) {
  return fiveTrackEvidence({
    mode,
    model,
    path: input.path,
    receiptSha256,
    schemaVersion,
    sha256: input.sha256,
    track,
  });
}

function assertLiveInputs(modes: readonly ("deterministic" | "live")[]): void {
  if (modes.some((mode) => mode !== "live")) {
    throw new TypeError("Five-track report requires live input artifacts.");
  }
}

function parseOptions(args: readonly string[]): CliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    console.log(
      "Usage: five-track-report --quality FILE --task FILE --human FILE --production FILE --deadline FILE --output DIR"
    );
    process.exit(0);
  }
  const values = new Map<string, string>();
  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index];
    const value = normalized[index + 1];
    if (
      ![
        "--deadline",
        "--human",
        "--output",
        "--production",
        "--quality",
        "--task",
      ].includes(flag ?? "") ||
      typeof flag !== "string" ||
      value === undefined ||
      value.length === 0
    ) {
      throw new TypeError(`Invalid five-track option: ${flag ?? ""}`);
    }
    values.set(flag, value);
  }
  const deadline = values.get("--deadline");
  const human = values.get("--human");
  const output = values.get("--output");
  const production = values.get("--production");
  const quality = values.get("--quality");
  const task = values.get("--task");
  if (
    deadline === undefined ||
    human === undefined ||
    output === undefined ||
    production === undefined ||
    quality === undefined ||
    task === undefined
  ) {
    throw new TypeError("Five-track report requires all five artifacts.");
  }
  return { deadline, human, output, production, quality, task };
}

try {
  await main();
} catch {
  process.stderr.write("five-track-failure\n");
  process.exitCode = 1;
}
