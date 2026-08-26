import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import type { LanguageModel } from "ai";
import { createDeterministicRuntimeBlockModel } from "./runtime-block-time-deterministic";
import type { RuntimeBlockLanguageModel } from "./runtime-block-time-instrumentation";
import {
  calculateRuntimeBlockTrial,
  type RuntimeBlockObservation,
  type RuntimeBlockScenario,
  type RuntimeBlockTrial,
} from "./runtime-block-time-metrics";
import { parseRuntimeBlockRepetitions } from "./runtime-block-time-options";
import {
  admitRuntimeBlockTerminalText,
  createRuntimeBlockTimeReport,
  RUNTIME_BLOCK_MODEL_LABEL_MAX_LENGTH,
  RUNTIME_BLOCK_OUTPUT_PATH_MAX_LENGTH,
  renderRuntimeBlockTimeMarkdown,
} from "./runtime-block-time-report";
import { runRuntimeBlockTrial } from "./runtime-block-time-runner";
import { createRuntimeBlockScenarioModel } from "./runtime-block-time-scenario-model";

const SCENARIOS = [
  "overlap-nonblocking",
  "prepared-hit",
  "candidate-fit-late-hit",
  "candidate-too-broad-fallback",
  "summary-failure-retry-hit",
  "repeated-failure-overflow-recovery",
] as const satisfies readonly RuntimeBlockScenario[];

interface CliOptions {
  readonly mode: "deterministic" | "live";
  readonly outputDirectory: string;
  readonly repetitions: number;
}

async function main(options: CliOptions): Promise<void> {
  const liveModel =
    options.mode === "live"
      ? requireConcreteModel(
          createCodingLanguageModel({ providerName: "runtime-block-time" })
        )
      : undefined;
  const modelName = admitRuntimeBlockTerminalText(
    liveModel?.modelId ?? "deterministic-mock",
    RUNTIME_BLOCK_MODEL_LABEL_MAX_LENGTH
  );
  const observations: RuntimeBlockObservation[] = [];
  const trials: RuntimeBlockTrial[] = [];

  for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    for (const scenario of SCENARIOS) {
      let logicalNow = 0;
      const treatmentDeterministic =
        options.mode === "deterministic"
          ? createDeterministicRuntimeBlockModel(scenario, (milliseconds) => {
              logicalNow += milliseconds;
            })
          : undefined;
      const controlDeterministic =
        options.mode === "deterministic"
          ? createDeterministicRuntimeBlockModel(scenario, (milliseconds) => {
              logicalNow += milliseconds;
            })
          : undefined;
      const treatmentModel = createRuntimeBlockScenarioModel(
        requireConcreteModel(liveModel ?? treatmentDeterministic?.model),
        scenario
      );
      const controlModel = createRuntimeBlockScenarioModel(
        requireConcreteModel(liveModel ?? controlDeterministic?.model),
        scenario
      );
      const observation = await runRuntimeBlockTrial({
        controlModel: controlModel.model,
        model: treatmentModel.model,
        now:
          options.mode === "deterministic"
            ? () => logicalNow
            : performance.now.bind(performance),
        onTargetStepStart: treatmentDeterministic?.onTargetStepStart,
        repetition,
        scenario,
        summaryTimeOffsetMs: treatmentDeterministic?.summaryTimeOffsetMs,
        treatmentModel: treatmentModel.model,
      });
      const trial = calculateRuntimeBlockTrial(observation);
      observations.push(observation);
      trials.push(trial);
      console.log(
        `[${scenario} r${repetition}] block=${trial.userBlockMs.toFixed(
          2
        )}ms avoided=${(trial.blockAvoidanceRatio * 100).toFixed(
          2
        )}% summaries=${trial.summaryCalls}`
      );
    }
  }

  const report = createRuntimeBlockTimeReport({
    mode: options.mode,
    model: modelName,
    observations,
    trials,
  });
  const markdown = renderRuntimeBlockTimeMarkdown(report);
  await mkdir(options.outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(options.outputDirectory, "runtime-block-time.json"),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    writeFile(join(options.outputDirectory, "runtime-block-time.md"), markdown),
  ]);
  console.log(markdown);
  console.log(`report: ${options.outputDirectory}`);
}

function requireConcreteModel(
  model: LanguageModel | undefined
): RuntimeBlockLanguageModel {
  if (model === undefined || typeof model === "string") {
    throw new TypeError(
      "Runtime block-time benchmark requires a model object."
    );
  }
  return model;
}

function parseOptions(args: readonly string[]): CliOptions {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  if (normalizedArgs.includes("--help")) {
    console.log(
      [
        "Usage: runtime-block-time [--mode deterministic|live] [--repetitions N (1-100)] [--output DIR]",
        "",
        "Scenarios:",
        "  overlap-nonblocking       summary active; target uses original context",
        "  prepared-hit              ready candidate auto-promoted before provider",
        "  candidate-fit-late-hit    widened candidate reused without fallback",
        "  candidate-too-broad-fallback  in-flight fitting candidate blocks target",
        "  summary-failure-retry-hit one background failure recovered before target",
        "  repeated-failure-overflow-recovery  two failures then overflow recovery",
      ].join("\n")
    );
    process.exit(0);
  }
  let mode: CliOptions["mode"] = "deterministic";
  let outputDirectory = `/tmp/runtime-block-time-${new Date().toISOString()}`;
  let repetitions = 3;
  for (let index = 0; index < normalizedArgs.length; index += 2) {
    const flag = normalizedArgs[index];
    const value = normalizedArgs[index + 1];
    if (flag === "--mode" && (value === "deterministic" || value === "live")) {
      mode = value;
    } else if (flag === "--output" && value) {
      outputDirectory = admitRuntimeBlockTerminalText(
        value,
        RUNTIME_BLOCK_OUTPUT_PATH_MAX_LENGTH
      );
    } else if (flag === "--repetitions" && value) {
      repetitions = parseRuntimeBlockRepetitions(value);
    } else {
      throw new TypeError(`Invalid runtime block-time option: ${flag ?? ""}`);
    }
  }
  return { mode, outputDirectory, repetitions };
}

async function runCli(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch {
    process.stderr.write("RUNTIME_BLOCK_TIME_OPTIONS_INVALID\n");
    process.exitCode = 1;
    return;
  }

  await main(options).then(undefined, () => {
    process.stderr.write("RUNTIME_BLOCK_TIME_EXECUTION_FAILED\n");
    process.exitCode = 1;
  });
}

await runCli();
