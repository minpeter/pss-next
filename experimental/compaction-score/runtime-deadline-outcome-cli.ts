import { readOpenAICompatibleModelEnv } from "@minpeter/pss-coding-agent/env";
import { createCodingLanguageModel } from "@minpeter/pss-coding-agent/model";
import type { LanguageModel } from "ai";
import { parseDeadlineArm } from "./deadline-sweep-validation";
import { createDeterministicRuntimeBlockModel } from "./runtime-block-time-deterministic";
import type { RuntimeBlockScenario } from "./runtime-block-time-metrics";
import { createRuntimeBlockScenarioModel } from "./runtime-block-time-scenario-model";
import {
  loadRuntimeDeadlineReport,
  parseRuntimeDeadlineOptions,
  type RuntimeDeadlineAttempt,
  type RuntimeDeadlineReport,
  runtimeDeadlineAttemptKey,
  writeRuntimeDeadlineReport,
} from "./runtime-deadline-outcome-cli-support";
import {
  AttemptWallTimeoutError,
  requireRuntimeDeadlineModel,
} from "./runtime-deadline-outcome-model";
import { recordRuntimeDeadlineReceipt } from "./runtime-deadline-outcome-receipt";
import { runRuntimeDeadlineTrial } from "./runtime-deadline-outcome-runner";
import type { RuntimeDeadlineTrial } from "./runtime-deadline-outcome-types";
import { formatTerminalReportLocation } from "./terminal-text";

const SCENARIOS = [
  "overlap-nonblocking",
  "prepared-hit",
  "candidate-fit-late-hit",
  "candidate-too-broad-fallback",
  "summary-failure-retry-hit",
  "repeated-failure-overflow-recovery",
] as const satisfies readonly RuntimeBlockScenario[];

async function main(): Promise<void> {
  const options = parseRuntimeDeadlineOptions(process.argv.slice(2));
  const startedAt = new Date().toISOString();
  await recordRuntimeDeadlineReceipt(
    options.outputDirectory,
    startedAt,
    "running",
    null,
    process.argv.slice(2)
  );
  try {
    await runCampaign(options);
    await recordRuntimeDeadlineReceipt(
      options.outputDirectory,
      startedAt,
      "completed",
      null,
      process.argv.slice(2)
    );
  } catch (error) {
    await recordRuntimeDeadlineReceipt(
      options.outputDirectory,
      startedAt,
      "failed",
      error instanceof Error ? error.message : String(error),
      process.argv.slice(2)
    );
    throw error;
  }
}

async function runCampaign(
  options: ReturnType<typeof parseRuntimeDeadlineOptions>
): Promise<void> {
  const env =
    options.mode === "live" ? readOpenAICompatibleModelEnv() : undefined;
  const modelName = env?.AI_MODEL ?? "deterministic-mock";
  const liveModel =
    options.mode === "live"
      ? createCodingLanguageModel({ providerName: "runtime-deadline-outcome" })
      : undefined;
  const existing = await loadRuntimeDeadlineReport(options.outputDirectory, {
    deadlineMs: options.deadlineMs,
    mode: options.mode,
    model: modelName,
  });
  const attempts = [...(existing?.attempts ?? [])];
  const trials = [...(existing?.trials ?? [])];
  const finished = new Set(attempts.map(runtimeDeadlineAttemptKey));
  const createdAt = existing?.createdAt ?? new Date().toISOString();

  for (
    let repetition = options.startRepetition;
    repetition <= options.repetitions;
    repetition += 1
  ) {
    for (const scenario of SCENARIOS) {
      const key = runtimeDeadlineAttemptKey({ repetition, scenario });
      if (finished.has(key)) {
        console.log(`[${scenario} r${repetition}] resume=preserved`);
        continue;
      }
      const result = await runAttempt({
        liveModel,
        options,
        repetition,
        scenario,
      });
      attempts.push(result.attempt);
      if (result.trial !== undefined) {
        trials.push(result.trial);
      }
      finished.add(key);
      await writeCurrent({
        attempts,
        attemptTimeoutMs: options.attemptTimeoutMs,
        createdAt,
        deadlineMs: options.deadlineMs,
        mode: options.mode,
        model: modelName,
        outputDirectory: options.outputDirectory,
        trials,
      });
      logResult(result);
    }
  }
  const finalReport = {
    attempts,
    attemptTimeoutMs: options.attemptTimeoutMs,
    createdAt,
    deadlineMs: options.deadlineMs,
    mode: options.mode,
    model: modelName,
    trials,
  };
  await writeCurrent({
    ...finalReport,
    outputDirectory: options.outputDirectory,
  });
  parseDeadlineArm(finalReport, options.outputDirectory);
  console.log(formatTerminalReportLocation(options.outputDirectory));
}

async function runAttempt({
  liveModel,
  options,
  repetition,
  scenario,
}: {
  readonly liveModel: LanguageModel | undefined;
  readonly options: ReturnType<typeof parseRuntimeDeadlineOptions>;
  readonly repetition: number;
  readonly scenario: RuntimeBlockScenario;
}): Promise<{
  readonly attempt: RuntimeDeadlineAttempt;
  readonly trial?: RuntimeDeadlineTrial;
}> {
  let logicalNow = 0;
  const deterministic =
    options.mode === "deterministic"
      ? createDeterministicRuntimeBlockModel(scenario, (milliseconds) => {
          logicalNow += milliseconds;
        })
      : undefined;
  const scenarioModel = createRuntimeBlockScenarioModel(
    requireRuntimeDeadlineModel(liveModel ?? deterministic?.model),
    scenario
  );
  const attempt = new AbortController();
  const timeout = setTimeout(
    () =>
      attempt.abort(
        new AttemptWallTimeoutError(
          `attempt exceeded ${options.attemptTimeoutMs}ms wall timeout`
        )
      ),
    options.attemptTimeoutMs
  );
  try {
    const trial = await runRuntimeDeadlineTrial({
      abortSignal: attempt.signal,
      deadlineMs: options.deadlineMs,
      model: scenarioModel.model,
      now:
        options.mode === "deterministic"
          ? () => logicalNow
          : performance.now.bind(performance),
      onTargetStepStart: deterministic?.onTargetStepStart,
      repetition,
      scenario,
    });
    return {
      attempt: { repetition, scenario, status: "completed" },
      trial,
    };
  } catch (error) {
    const failure =
      error instanceof Error
        ? error
        : new Error("Unknown runtime deadline failure.");
    return {
      attempt: classifyError(failure, repetition, scenario),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function classifyError(
  error: Error,
  repetition: number,
  scenario: RuntimeBlockScenario
): RuntimeDeadlineAttempt {
  const message = error.message;
  return {
    errorCode: errorCode(error, message),
    message,
    repetition,
    scenario,
    status: "error",
  };
}

function errorCode(error: unknown, message: string): string {
  if (error instanceof AttemptWallTimeoutError) {
    return "ATTEMPT_WALL_TIMEOUT";
  }
  return message.includes("runtime deadline setup")
    ? "SETUP_FAILURE"
    : "RUNTIME_PROTOCOL_FAILURE";
}

async function writeCurrent({
  outputDirectory,
  ...report
}: Omit<RuntimeDeadlineReport, "schemaVersion" | "summary"> & {
  readonly outputDirectory: string;
}): Promise<void> {
  await writeRuntimeDeadlineReport(outputDirectory, report);
}

function logResult(result: {
  readonly attempt: RuntimeDeadlineAttempt;
  readonly trial?: RuntimeDeadlineTrial;
}): void {
  if (result.trial === undefined) {
    console.error("runtime-deadline-attempt-failure");
    return;
  }
  console.log(
    `[${result.trial.scenario} r${result.trial.repetition}] outcome=${result.trial.outcome} decision=${result.trial.decisionLatencyMs.toFixed(2)}ms provider=${result.trial.providerStarted ? "yes" : "no"}`
  );
}

try {
  await main();
} catch {
  process.stderr.write("runtime-deadline-outcome-failure\n");
  process.exitCode = 1;
}
