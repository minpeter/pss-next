import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { parseComparePiReport } from "./compare-pi-parse";
import type { ArmResult, ComparePiHop } from "./compare-pi-types";
import type {
  QualitySweepArm,
  QualitySweepObservation,
} from "./quality-sweep-types";

const execFileAsync = promisify(execFile);

type ComparePiDispatch = (
  arguments_: readonly string[],
  budgetDirectory: string
) => Promise<void>;

export async function runLiveQualityBudget({
  budget,
  dispatch = dispatchComparePi,
  outputDirectory,
  repetitions,
}: {
  readonly budget: number;
  readonly dispatch?: ComparePiDispatch;
  readonly outputDirectory: string;
  readonly repetitions: number;
}): Promise<{
  readonly model: string;
  readonly observations: readonly QualitySweepObservation[];
}> {
  const budgetDirectory = join(outputDirectory, "raw", String(budget));
  const arguments_ = [
    "exec",
    "tsx",
    "--conditions=@minpeter/pss-source",
    "compare-pi.ts",
    "--output",
    budgetDirectory,
    "--summary-max-output-tokens",
    String(budget),
    "--repetitions",
    String(repetitions),
  ];
  await dispatch(arguments_, budgetDirectory);
  return loadQualityBudgetObservations({ budget, outputDirectory });
}

async function dispatchComparePi(arguments_: readonly string[]): Promise<void> {
  await execFileAsync("pnpm", arguments_, {
    cwd: import.meta.dirname,
    maxBuffer: 100 * 1024 * 1024,
    timeout: 3 * 60 * 60 * 1000,
  });
}

export async function loadQualityBudgetObservations({
  budget,
  outputDirectory,
}: {
  readonly budget: number;
  readonly outputDirectory: string;
}): Promise<{
  readonly model: string;
  readonly observations: readonly QualitySweepObservation[];
}> {
  const report = parseComparePiReport(
    JSON.parse(
      await readFile(
        join(outputDirectory, "raw", String(budget), "comparison.json"),
        "utf8"
      )
    )
  );
  if (report.summaryMaxOutputTokens !== budget) {
    throw new TypeError(
      "Compare-pi report budget does not match quality cell."
    );
  }
  return {
    model: report.model,
    observations: report.rows.flatMap((row) => [
      observation("pss", budget, row.pss, row.scenario, row.repetition),
      observation("pi", budget, row.pi, row.scenario, row.repetition),
    ]),
  };
}

function observation(
  arm: QualitySweepArm,
  budget: number,
  result: ArmResult,
  scenario: string,
  repetition: number
): QualitySweepObservation {
  const hops = result.hops ?? [];
  const valid = result.status === "valid" && result.score !== undefined;
  const controlCorrect = result.score?.arms.full.overall.correct ?? 0;
  const controlTotal = result.score?.arms.full.overall.total ?? 0;
  const controlPassed =
    valid && controlTotal > 0 && controlCorrect === controlTotal;
  const summaryTokens = sum(hops.map((hop) => hop.summaryTokens));
  const prefixTokens = sum(hops.map((hop) => hop.prefixTokens));
  return {
    arm,
    budget,
    compressionRatio: prefixTokens === 0 ? null : summaryTokens / prefixTokens,
    controlCorrect,
    controlPassed,
    controlTotal,
    correct: valid ? (result.score?.headline.correct ?? 0) : 0,
    costUsd: null,
    ...(result.answers === undefined
      ? {}
      : { evaluationAnswers: result.answers }),
    fixtureSeed: `compare-pi-${scenario}-1`,
    ...(valid && controlPassed
      ? {}
      : {
          invalidReason:
            result.error ?? (valid ? "invalid-full-control" : result.status),
        }),
    latencyMs: valid ? sum(hops.map((hop) => hop.compactionMs ?? 0)) : null,
    repetition,
    scenario,
    sentOutputTokens: observedSummaryOutputTokens(hops),
    summarizerInputTokens: sum(
      hops.map((hop) => hop.summarizerInputTokens ?? 0)
    ),
    summaryTokens,
    total: valid && controlPassed ? (result.score?.headline.total ?? 0) : 0,
    valid: valid && controlPassed,
  };
}

export function observedSummaryOutputTokens(
  hops: readonly Pick<ComparePiHop, "sentOutputTokens">[]
): readonly number[] {
  return hops.map(({ sentOutputTokens }) => sentOutputTokens);
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
