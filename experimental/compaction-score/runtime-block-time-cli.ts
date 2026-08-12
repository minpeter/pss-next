import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import type { LanguageModel } from "ai";
import { createDeterministicRuntimeBlockModel } from "./runtime-block-time-deterministic";
import {
  calculateRuntimeBlockTrial,
  type RuntimeBlockObservation,
  type RuntimeBlockScenario,
  type RuntimeBlockTrial,
} from "./runtime-block-time-metrics";
import {
  createRuntimeBlockTimeReport,
  renderRuntimeBlockTimeMarkdown,
} from "./runtime-block-time-report";
import { createRuntimeBlockScenarioModel } from "./runtime-block-time-scenario-model";
import {
  runRuntimeBlockTrial,
  type RuntimeBlockLanguageModel,
} from "./runtime-block-time-runner";

const SCENARIOS = [
  "overlap-nonblocking",
  "prepared-hit",
  "late-overflow-miss",
  "summary-failure-recovery",
] as const satisfies readonly RuntimeBlockScenario[];

interface CliOptions {
  readonly mode: "deterministic" | "live";
  readonly outputDirectory: string;
  readonly repetitions: number;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const env =
    options.mode === "live" ? readOpenAICompatibleModelEnv() : undefined;
  const liveModel =
    options.mode === "live"
      ? createCodingLanguageModel({ providerName: "runtime-block-time" })
      : undefined;
  const modelName = env?.AI_MODEL ?? "deterministic-mock";
  const observations: RuntimeBlockObservation[] = [];
  const trials: RuntimeBlockTrial[] = [];

  for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    for (const scenario of SCENARIOS) {
      let logicalNow = 0;
      const deterministic =
        options.mode === "deterministic"
          ? createDeterministicRuntimeBlockModel(
              scenario,
              (milliseconds) => {
                logicalNow += milliseconds;
              }
            )
          : undefined;
      const scenarioModel = createRuntimeBlockScenarioModel(
        requireConcreteModel(liveModel ?? deterministic?.model),
        scenario
      );
      const observation = await runRuntimeBlockTrial({
        model: scenarioModel.model,
        now:
          options.mode === "deterministic"
            ? () => logicalNow
            : performance.now.bind(performance),
        onTargetStepStart: deterministic?.onTargetStepStart,
        repetition,
        scenario,
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
    writeFile(
      join(options.outputDirectory, "runtime-block-time.md"),
      markdown
    ),
  ]);
  console.log(markdown);
  console.log(`report: ${options.outputDirectory}`);
}

function requireConcreteModel(
  model: LanguageModel | undefined
): RuntimeBlockLanguageModel {
  if (model === undefined || typeof model === "string") {
    throw new TypeError("Runtime block-time benchmark requires a model object.");
  }
  return model;
}

function parseOptions(args: readonly string[]): CliOptions {
  const normalizedArgs = args[0] === "--" ? args.slice(1) : args;
  if (normalizedArgs.includes("--help")) {
    console.log(
      [
        "Usage: runtime-block-time [--mode deterministic|live] [--repetitions N] [--output DIR]",
        "",
        "Scenarios:",
        "  overlap-nonblocking       summary active; target uses original context",
        "  prepared-hit              ready candidate auto-promoted before provider",
        "  late-overflow-miss        late candidate plus broader overflow summary",
        "  summary-failure-recovery  failed background summary retried on overflow",
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
      outputDirectory = value;
    } else if (
      flag === "--repetitions" &&
      value &&
      Number.isInteger(Number(value)) &&
      Number(value) > 0
    ) {
      repetitions = Number(value);
    } else {
      throw new TypeError(`Invalid runtime block-time option: ${flag ?? ""}`);
    }
  }
  return { mode, outputDirectory, repetitions };
}

await main();
