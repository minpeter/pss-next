import { mkdir } from "node:fs/promises";
import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import type { LanguageModel } from "ai";
import { productionOverlapPair } from "./production-overlap-analysis";
import { withProductionOverlapAttemptTimeout } from "./production-overlap-attempt";
import { writeProductionOverlapCommandReceipt } from "./production-overlap-cli-receipt";
import {
  type ProductionOverlapCliOptions,
  parseProductionOverlapOptions,
} from "./production-overlap-options";
import { createProductionOverlapReport } from "./production-overlap-report";
import {
  loadProductionOverlapResume,
  writeProductionOverlapReport,
} from "./production-overlap-storage";
import type {
  ProductionOverlapAttempt,
  ProductionOverlapPair,
  ProductionOverlapReport,
} from "./production-overlap-types";
import { validateProductionOverlapArtifact } from "./production-overlap-validation";
import { createDeterministicRuntimeBlockModel } from "./runtime-block-time-deterministic";
import type { RuntimeBlockLanguageModel } from "./runtime-block-time-instrumentation";
import {
  calculateRuntimeBlockTrial,
  type RuntimeBlockScenario,
} from "./runtime-block-time-metrics";
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

async function main(): Promise<void> {
  const options = parseProductionOverlapOptions(process.argv.slice(2));
  await mkdir(options.outputDirectory, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeProductionOverlapCommandReceipt(
    options,
    startedAt,
    "running",
    null
  );
  try {
    await runCampaign(options);
    await writeProductionOverlapCommandReceipt(
      options,
      startedAt,
      "completed",
      null
    );
  } catch (error) {
    await writeProductionOverlapCommandReceipt(
      options,
      startedAt,
      "failed",
      error instanceof Error ? error.message : String(error)
    );
    throw error;
  }
}

async function runCampaign(
  options: ProductionOverlapCliOptions
): Promise<void> {
  const env =
    options.mode === "live" ? readOpenAICompatibleModelEnv() : undefined;
  const liveModel =
    options.mode === "live"
      ? createCodingLanguageModel({ providerName: "production-overlap" })
      : undefined;
  const modelName = env?.AI_MODEL ?? "deterministic-mock";
  const resume = await loadProductionOverlapResume(options.outputDirectory, {
    mode: options.mode,
    model: modelName,
    repetitions: options.repetitions,
  });
  const attempts: ProductionOverlapAttempt[] = [...(resume?.attempts ?? [])];
  const pairs: ProductionOverlapPair[] = [...(resume?.pairs ?? [])];
  const finished = new Set(
    attempts.map((attempt) => `${attempt.scenario}:${attempt.repetition}`)
  );

  for (let repetition = 1; repetition <= options.repetitions; repetition += 1) {
    for (const scenario of SCENARIOS) {
      const key = `${scenario}:${repetition}`;
      if (finished.has(key)) {
        console.log(`[${scenario} r${repetition}] resume=preserved`);
        continue;
      }
      try {
        const pair = await runPairAttempt({
          attemptTimeoutMs: options.attemptTimeoutMs,
          compactionDeadlineMs: options.compactionDeadlineMs,
          liveModel,
          mode: options.mode,
          repetition,
          scenario,
        });
        pairs.push(pair);
        attempts.push({ repetition, scenario, status: "completed" });
        finished.add(key);
        console.log(
          `[${scenario} r${repetition}] dispatch=${pair.dispatchBlockMs.toFixed(2)}ms actual=${pair.actualUserBlockMs.toFixed(2)}ms`
        );
      } catch (cause) {
        attempts.push({
          message: cause instanceof Error ? cause.message : String(cause),
          repetition,
          scenario,
          status: "error",
        });
        finished.add(key);
      }
      await writeProductionReport({
        attempts,
        attemptTimeoutMs: options.attemptTimeoutMs,
        mode: options.mode,
        model: modelName,
        outputDirectory: options.outputDirectory,
        pairs,
        repetitions: options.repetitions,
      });
    }
  }
  await writeProductionReport({
    attempts,
    attemptTimeoutMs: options.attemptTimeoutMs,
    mode: options.mode,
    model: modelName,
    outputDirectory: options.outputDirectory,
    pairs,
    repetitions: options.repetitions,
    validate: true,
  });
}

async function runPairAttempt({
  attemptTimeoutMs,
  compactionDeadlineMs,
  liveModel,
  mode,
  repetition,
  scenario,
}: {
  readonly attemptTimeoutMs: number;
  readonly compactionDeadlineMs: number;
  readonly liveModel: LanguageModel | undefined;
  readonly mode: ProductionOverlapReport["mode"];
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
}): Promise<ProductionOverlapPair> {
  let logicalNow = 0;
  const advance = (milliseconds: number) => {
    logicalNow += milliseconds;
  };
  const treatmentDeterministic =
    mode === "deterministic"
      ? createDeterministicRuntimeBlockModel(scenario, advance)
      : undefined;
  const controlDeterministic =
    mode === "deterministic"
      ? createDeterministicRuntimeBlockModel(scenario, advance)
      : undefined;
  const treatmentModel = createRuntimeBlockScenarioModel(
    requireConcreteModel(liveModel ?? treatmentDeterministic?.model),
    scenario
  );
  const controlModel = createRuntimeBlockScenarioModel(
    requireConcreteModel(liveModel ?? controlDeterministic?.model),
    scenario
  );
  return await withProductionOverlapAttemptTimeout(
    attemptTimeoutMs,
    async (abortSignal) => {
      const observation = await runRuntimeBlockTrial({
        abortSignal,
        compactionDeadlineMs,
        controlModel: controlModel.model,
        model: treatmentModel.model,
        now:
          mode === "deterministic"
            ? () => logicalNow
            : performance.now.bind(performance),
        onTargetStepStart: treatmentDeterministic?.onTargetStepStart,
        repetition,
        scenario,
        treatmentModel: treatmentModel.model,
      });
      return productionOverlapPair(
        observation,
        calculateRuntimeBlockTrial(observation)
      );
    }
  );
}

async function writeProductionReport({
  attempts,
  attemptTimeoutMs,
  mode,
  model,
  outputDirectory,
  pairs,
  repetitions,
  validate = false,
}: {
  readonly attempts: readonly ProductionOverlapAttempt[];
  readonly attemptTimeoutMs: number;
  readonly mode: ProductionOverlapReport["mode"];
  readonly model: string;
  readonly outputDirectory: string;
  readonly pairs: readonly ProductionOverlapPair[];
  readonly repetitions: number;
  readonly validate?: boolean;
}): Promise<void> {
  const report = createProductionOverlapReport({
    attempts,
    attemptTimeoutMs,
    mode,
    model,
    pairs,
    repetitions,
  });
  if (validate) {
    validateProductionOverlapArtifact(report);
  }
  await writeProductionOverlapReport(outputDirectory, report);
}

function requireConcreteModel(
  model: LanguageModel | undefined
): RuntimeBlockLanguageModel {
  if (model === undefined || typeof model === "string") {
    throw new TypeError("Production overlap requires a model object.");
  }
  return model;
}

try {
  await main();
} catch {
  process.stderr.write("production-overlap-failure\n");
  process.exitCode = 1;
}
