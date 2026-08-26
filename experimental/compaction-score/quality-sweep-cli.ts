import { mkdir } from "node:fs/promises";
import { parseCampaignRepetitions } from "./campaign-limits";
import {
  aggregateQualityCells,
  matchedQualityEstimates,
  qualitySweepMethodology,
} from "./quality-sweep-analysis";
import { qualityCalibrationItems } from "./quality-sweep-calibration";
import { runLiveQualityBudget } from "./quality-sweep-live";
import {
  hasCompleteQualityBudget,
  loadQualitySweepResume,
  writeQualitySweepReceipt,
  writeQualitySweepReport,
} from "./quality-sweep-storage";
import type {
  QualitySweepMode,
  QualitySweepObservation,
  QualitySweepReport,
} from "./quality-sweep-types";
import { validateQualitySweepArtifact } from "./quality-sweep-validation";
import { formatTerminalReportLocation } from "./terminal-text";

const BUDGETS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 13_107] as const;
const QUALITY_TARGETS = [0.5, 0.6, 0.7] as const;

interface CliOptions {
  readonly mode: QualitySweepMode;
  readonly outputDirectory: string;
  readonly repetitions: number;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await mkdir(options.outputDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeQualitySweepReceipt(options.outputDirectory, {
    argv: qualitySweepReceiptArguments(options),
    completedAt: null,
    error: null,
    startedAt,
    status: "running",
  });
  try {
    await runCampaign(options);
    await writeQualitySweepReceipt(options.outputDirectory, {
      argv: qualitySweepReceiptArguments(options),
      completedAt: new Date().toISOString(),
      error: null,
      startedAt,
      status: "completed",
    });
  } catch (error) {
    await writeQualitySweepReceipt(options.outputDirectory, {
      argv: qualitySweepReceiptArguments(options),
      completedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
      startedAt,
      status: "failed",
    });
    throw error;
  }
}

async function runCampaign(options: CliOptions): Promise<void> {
  const resume =
    options.mode === "live"
      ? await loadQualitySweepResume(
          options.outputDirectory,
          options.repetitions
        )
      : null;
  const createdAt = resume?.createdAt ?? new Date().toISOString();
  let model = options.mode === "deterministic" ? "deterministic-mock" : "";
  if (resume !== null) {
    model = resume.model;
  }
  const observations: QualitySweepObservation[] = [
    ...(resume?.observations ?? []),
  ];
  if (options.mode === "deterministic") {
    observations.push(...deterministicObservations(options.repetitions));
  } else {
    for (const budget of BUDGETS) {
      if (hasCompleteQualityBudget(observations, budget, options.repetitions)) {
        console.log(`[quality-sweep] budget=${budget} resume=preserved`);
        continue;
      }
      console.log(`[quality-sweep] budget=${budget}`);
      const arm = await runLiveQualityBudget({
        budget,
        outputDirectory: options.outputDirectory,
        repetitions: options.repetitions,
      });
      if (model !== "" && model !== arm.model) {
        throw new TypeError("Quality sweep model changed between budgets.");
      }
      model = arm.model;
      observations.push(...arm.observations);
      await writeQualitySweepReport(
        createReport({ createdAt, model, observations, options }),
        options.outputDirectory
      );
    }
  }

  const report = createReport({ createdAt, model, observations, options });
  validateQualitySweepArtifact(report);
  await writeQualitySweepReport(report, options.outputDirectory);
  console.log(formatTerminalReportLocation(options.outputDirectory));
}

function createReport({
  createdAt,
  model,
  observations,
  options,
}: {
  readonly createdAt: string;
  readonly model: string;
  readonly observations: readonly QualitySweepObservation[];
  readonly options: CliOptions;
}): QualitySweepReport {
  return {
    budgets: BUDGETS,
    calibrationItems: qualityCalibrationItems(observations, options.mode),
    cells: aggregateQualityCells(observations),
    createdAt,
    matchedQuality: matchedQualityEstimates(observations, QUALITY_TARGETS),
    methodology: {
      ...qualitySweepMethodology,
      qualityTargets: QUALITY_TARGETS,
    },
    mode: options.mode,
    model,
    observations,
    repetitions: options.repetitions,
    schemaVersion: "quality-sweep-v2",
  };
}

function deterministicObservations(
  repetitions: number
): readonly QualitySweepObservation[] {
  const correctness = {
    pi: [35, 45, 55, 65, 75, 83, 89, 93, 95],
    pss: [45, 60, 70, 78, 84, 90, 94, 97, 98],
  } as const;
  return BUDGETS.flatMap((budget, budgetIndex) =>
    (["pss", "pi"] as const).flatMap((arm) => {
      const correct = correctness[arm][budgetIndex];
      if (correct === undefined) {
        throw new TypeError("Missing deterministic quality score.");
      }
      return Array.from({ length: repetitions }, (_, repetitionIndex) => ({
        arm,
        budget,
        compressionRatio: Math.min(0.95, budget / 16_384),
        controlCorrect: 100,
        controlPassed: true,
        controlTotal: 100,
        correct,
        costUsd: null,
        fixtureSeed: `deterministic-${repetitionIndex + 1}`,
        latencyMs: budget / (arm === "pss" ? 40 : 50),
        repetition: repetitionIndex + 1,
        scenario: "deterministic",
        sentOutputTokens: [budget],
        summarizerInputTokens: 4096,
        summaryTokens: budget,
        total: 100,
        valid: true,
      }));
    })
  );
}

function qualitySweepReceiptArguments(options: CliOptions): readonly string[] {
  return [
    "--mode",
    options.mode,
    "--output",
    options.outputDirectory,
    "--repetitions",
    String(options.repetitions),
  ];
}

function parseOptions(args: readonly string[]): CliOptions {
  const normalized = args[0] === "--" ? args.slice(1) : args;
  if (normalized.includes("--help")) {
    console.log(
      "Usage: quality-sweep --mode deterministic|live --repetitions N --output DIR"
    );
    process.exit(0);
  }
  let mode: QualitySweepMode = "deterministic";
  let outputDirectory = `/tmp/quality-sweep-${new Date().toISOString()}`;
  let repetitions = 3;
  for (let index = 0; index < normalized.length; index += 2) {
    const flag = normalized[index];
    const value = normalized[index + 1];
    if (flag === "--mode" && (value === "deterministic" || value === "live")) {
      mode = value;
    } else if (flag === "--output" && value) {
      outputDirectory = value;
    } else if (flag === "--repetitions") {
      repetitions = parseCampaignRepetitions(
        value,
        "Quality sweep repetitions"
      );
    } else {
      throw new TypeError(`Invalid quality-sweep option: ${flag ?? ""}`);
    }
  }
  return { mode, outputDirectory, repetitions };
}

try {
  await main();
} catch {
  process.stderr.write("quality-sweep-failure\n");
  process.exitCode = 1;
}
