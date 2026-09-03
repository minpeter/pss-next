import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validateProductionOverlapArtifact } from "./production-overlap-validation";
import { isRuntimeUserBlockZero } from "./runtime-block-time-metrics";

const execFileAsync = promisify(execFile);
const CLI_TEST_TIMEOUT_MS = 120_000;

describe("production-overlap CLI artifact", () => {
  it(
    "separates dispatch delay from actual visible-turn blocking",
    async () => {
      const outputDirectory = await mkdtemp(
        join(tmpdir(), "pss-production-overlap-test-")
      );

      try {
        await runProductionOverlap(outputDirectory, 1);
        const first = await readReport(outputDirectory);
        const resumed = await runProductionOverlap(outputDirectory, 2);

        const report = await readReport(outputDirectory);
        const markdown = await readFile(
          join(outputDirectory, "production-overlap.md"),
          "utf8"
        );
        const receipt = parseReceipt(
          JSON.parse(
            await readFile(
              join(outputDirectory, "production-overlap-command.json"),
              "utf8"
            )
          )
        );
        const validation = await execFileAsync(
          "pnpm",
          [
            "run",
            "production-overlap-validate",
            "--",
            "--input",
            join(outputDirectory, "production-overlap.json"),
          ],
          { cwd: import.meta.dirname }
        );

        expect(report).toMatchObject({
          mode: "deterministic",
          repetitions: 2,
        });
        expect(report.pairs).toHaveLength(12);
        expect(report.pairs.slice(0, 6)).toEqual(first.pairs);
        expect(resumed).toContain("resume=preserved");
        expect(
          report.pairs.every(
            ({ actualUserBlockMs, control, dispatchBlockMs, treatment }) =>
              timestampsAreMonotonic(control) &&
              timestampsAreMonotonic(treatment) &&
              actualUserBlockMs >= 0 &&
              dispatchBlockMs >= 0
          )
        ).toBe(true);
        expect(markdown).toContain(
          "| Scenario | Dispatch block | Actual user block |"
        );
        expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
        expect(isRuntimeUserBlockZero(5)).toBe(true);
        expect(isRuntimeUserBlockZero(11)).toBe(false);
        const firstAggregate = report.aggregates[0];
        if (firstAggregate === undefined) {
          throw new TypeError("Expected production overlap aggregate.");
        }
        const corrupted = {
          ...report,
          aggregates: report.aggregates.map((aggregate, index) =>
            index === 0
              ? {
                  ...aggregate,
                  actualUserBlockMs: {
                    ...aggregate.actualUserBlockMs,
                    mean: firstAggregate.actualUserBlockMs.mean + 1,
                  },
                }
              : aggregate
          ),
        };
        expect(() => validateProductionOverlapArtifact(corrupted)).toThrow(
          "aggregate is inconsistent"
        );
        const repetitionIndex = receipt.argv.indexOf("--repetitions") + 1;
        const corruptedReceipt = {
          ...receipt,
          argv: receipt.argv.map((argument, index) =>
            index === repetitionIndex ? "9" : argument
          ),
        };
        await writeFile(
          join(outputDirectory, "production-overlap-command.json"),
          JSON.stringify(corruptedReceipt)
        );
        await expect(
          execFileAsync(
            "pnpm",
            [
              "run",
              "production-overlap-validate",
              "--",
              "--input",
              join(outputDirectory, "production-overlap.json"),
            ],
            { cwd: import.meta.dirname }
          )
        ).rejects.toThrow();
      } finally {
        await rm(outputDirectory, { force: true, recursive: true });
      }
    },
    CLI_TEST_TIMEOUT_MS
  );
});

async function runProductionOverlap(
  outputDirectory: string,
  repetitions: number
): Promise<string> {
  const result = await execFileAsync(
    "pnpm",
    [
      "run",
      "production-overlap",
      "--",
      "--mode",
      "deterministic",
      "--repetitions",
      String(repetitions),
      "--output",
      outputDirectory,
    ],
    { cwd: import.meta.dirname }
  );
  return result.stdout;
}

type TestAggregate = Record<string, unknown> & {
  readonly actualUserBlockMs: Record<string, unknown> & {
    readonly mean: number;
  };
};

type TestReport = Record<string, unknown> & {
  readonly aggregates: readonly TestAggregate[];
  readonly mode: string;
  readonly pairs: readonly TestPair[];
  readonly repetitions: number;
};

interface TestPair {
  readonly actualUserBlockMs: number;
  readonly control: TurnTimestamps;
  readonly dispatchBlockMs: number;
  readonly treatment: TurnTimestamps;
}

async function readReport(outputDirectory: string): Promise<TestReport> {
  const raw: unknown = JSON.parse(
    await readFile(join(outputDirectory, "production-overlap.json"), "utf8")
  );
  validateProductionOverlapArtifact(raw);
  if (!isTestReport(raw)) {
    throw new TypeError("Production overlap report lacks test evidence.");
  }
  return raw;
}

function parseReceipt(raw: unknown): Record<string, unknown> & {
  readonly argv: readonly string[];
} {
  if (!isRecord(raw)) {
    throw new TypeError("Production overlap receipt is invalid.");
  }
  const argv = raw.argv;
  if (!isStringArray(argv)) {
    throw new TypeError("Production overlap receipt is invalid.");
  }
  return { ...raw, argv };
}

function isTestReport(value: unknown): value is TestReport {
  return (
    isRecord(value) &&
    typeof value.mode === "string" &&
    typeof value.repetitions === "number" &&
    Array.isArray(value.pairs) &&
    value.pairs.every(isTestPair) &&
    Array.isArray(value.aggregates) &&
    value.aggregates.every(isTestAggregate)
  );
}

function isTestPair(value: unknown): value is TestPair {
  return (
    isRecord(value) &&
    typeof value.actualUserBlockMs === "number" &&
    typeof value.dispatchBlockMs === "number" &&
    isTurnTimestamps(value.control) &&
    isTurnTimestamps(value.treatment)
  );
}

function isTestAggregate(value: unknown): value is TestAggregate {
  return (
    isRecord(value) &&
    isRecord(value.actualUserBlockMs) &&
    typeof value.actualUserBlockMs.mean === "number"
  );
}

interface TurnTimestamps {
  readonly firstVisibleAtMs: number;
  readonly providerStartedAtMs: number;
  readonly sentAtMs: number;
  readonly stepStartedAtMs: number;
  readonly turnEndedAtMs: number;
  readonly turnStartedAtMs: number;
}

function isTurnTimestamps(value: unknown): value is TurnTimestamps {
  return (
    isRecord(value) &&
    typeof value.firstVisibleAtMs === "number" &&
    typeof value.providerStartedAtMs === "number" &&
    typeof value.sentAtMs === "number" &&
    typeof value.stepStartedAtMs === "number" &&
    typeof value.turnEndedAtMs === "number" &&
    typeof value.turnStartedAtMs === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function timestampsAreMonotonic(timestamps: TurnTimestamps): boolean {
  return (
    timestamps.sentAtMs <= timestamps.turnStartedAtMs &&
    timestamps.turnStartedAtMs <= timestamps.stepStartedAtMs &&
    timestamps.stepStartedAtMs <= timestamps.providerStartedAtMs &&
    timestamps.providerStartedAtMs <= timestamps.firstVisibleAtMs &&
    timestamps.firstVisibleAtMs <= timestamps.turnEndedAtMs
  );
}
