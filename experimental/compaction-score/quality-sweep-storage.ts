import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nonemptyString, object } from "./quality-sweep-parse";
import { renderQualitySweepReport } from "./quality-sweep-report";
import type {
  QualitySweepObservation,
  QualitySweepReport,
} from "./quality-sweep-types";
import { parseQualitySweepObservation } from "./quality-sweep-validation";

const BUDGETS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 13_107] as const;
const SCENARIO_COUNT = 6;
const LIVE_SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "holdout-json",
  "holdout-cjk",
  "holdout-log",
] as const;

export async function loadQualitySweepResume(
  outputDirectory: string,
  repetitions: number
): Promise<{
  readonly createdAt: string;
  readonly model: string;
  readonly observations: readonly QualitySweepObservation[];
} | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await readFile(join(outputDirectory, "quality-sweep.json"), "utf8")
    );
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
  const report = object(raw, "existing quality sweep");
  if (
    report.schemaVersion !== "quality-sweep-v2" ||
    report.mode !== "live" ||
    report.repetitions !== repetitions ||
    JSON.stringify(report.budgets) !== JSON.stringify(BUDGETS) ||
    !Array.isArray(report.observations)
  ) {
    throw new TypeError("Existing quality sweep report identity mismatch.");
  }
  const observations = report.observations.map(parseQualitySweepObservation);
  assertUniqueObservations(observations);
  return {
    createdAt: nonemptyString(report.createdAt, "createdAt"),
    model: nonemptyString(report.model, "model"),
    observations,
  };
}

export function hasCompleteQualityBudget(
  observations: readonly QualitySweepObservation[],
  budget: number,
  repetitions: number
): boolean {
  const matching = observations.filter(
    (observation) => observation.budget === budget
  );
  const actual = new Set(
    matching.map(
      (observation) =>
        `${observation.arm}:${observation.scenario}:${observation.repetition}`
    )
  );
  const expected = LIVE_SCENARIOS.flatMap((scenario) =>
    Array.from({ length: repetitions }, (_, repetition) =>
      (["pss", "pi"] as const).map(
        (arm) => `${arm}:${scenario}:${repetition + 1}`
      )
    ).flat()
  );
  return (
    matching.length === SCENARIO_COUNT * repetitions * 2 &&
    actual.size === matching.length &&
    expected.every((key) => actual.has(key))
  );
}

export async function writeQualitySweepReport(
  report: QualitySweepReport,
  outputDirectory: string
): Promise<void> {
  await Promise.all([
    atomicWrite(
      join(outputDirectory, "quality-sweep.json"),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    atomicWrite(
      join(outputDirectory, "quality-sweep.md"),
      renderQualitySweepReport(report)
    ),
  ]);
}

export async function writeQualitySweepReceipt(
  outputDirectory: string,
  receipt: {
    readonly argv: readonly string[];
    readonly completedAt: string | null;
    readonly error: string | null;
    readonly startedAt: string;
    readonly status: "completed" | "failed" | "running";
  }
): Promise<void> {
  await atomicWrite(
    join(outputDirectory, "quality-sweep-command.json"),
    `${JSON.stringify(receipt, null, 2)}\n`
  );
}

function assertUniqueObservations(
  observations: readonly QualitySweepObservation[]
): void {
  const keys = observations.map(
    (item) => `${item.arm}:${item.budget}:${item.scenario}:${item.repetition}`
  );
  if (new Set(keys).size !== keys.length) {
    throw new TypeError("Existing quality sweep has duplicate observations.");
  }
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

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
