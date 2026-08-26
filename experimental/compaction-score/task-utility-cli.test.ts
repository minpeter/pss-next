import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { validateTaskUtilityArtifact } from "./task-utility-artifact-validation";
import {
  parseTaskUtilityPairs,
  parseTaskUtilityReport,
} from "./task-utility-evidence-validation";
import { parseTaskUtilityReceipt } from "./task-utility-storage";

const execFileAsync = promisify(execFile);
const CLI_TEST_TIMEOUT_MS = 60_000;
const FIXTURES = [
  "exec-committed-event-telemetry",
  "prompt-template-dollar-escape",
  "workspace-cache-ignore-correction",
] as const;

describe("task-utility CLI artifact", () => {
  it(
    "emits paired downstream coding-task results",
    async () => {
      const outputDirectory = await mkdtemp(
        join(tmpdir(), "pss-task-utility-test-")
      );

      try {
        await runTaskUtility(outputDirectory, 2);
        const sentinel = join(
          outputDirectory,
          "workspaces",
          FIXTURES[0],
          "r1",
          "full",
          "exec-result.mjs"
        );
        await writeFile(
          sentinel,
          `${await readFile(sentinel, "utf8")}// resume sentinel\n`
        );
        await runTaskUtility(outputDirectory, 2);

        const rawReport: unknown = JSON.parse(
          await readFile(join(outputDirectory, "task-utility.json"), "utf8")
        );
        const report = parseTaskUtilityReport(rawReport);
        const rawReceipt: unknown = JSON.parse(
          await readFile(
            join(outputDirectory, "task-utility-command.json"),
            "utf8"
          )
        );
        const receipt = parseTaskUtilityReceipt(rawReceipt);
        const markdown = await readFile(
          join(outputDirectory, "task-utility.md"),
          "utf8"
        );
        const validation = await execFileAsync(
          "pnpm",
          [
            "run",
            "task-utility-validate",
            "--",
            "--input",
            join(outputDirectory, "task-utility.json"),
          ],
          { cwd: import.meta.dirname }
        );

        expect(report).toMatchObject({
          fixtures: FIXTURES,
          mode: "deterministic",
          model: "deterministic-mock",
          repetitions: 2,
        });
        expect(report.pairs).toHaveLength(FIXTURES.length * 2);
        expect(
          report.pairs.every(
            ({ compactPassed, fixture, fullPassed }) =>
              FIXTURES.some((candidate) => candidate === fixture) &&
              typeof compactPassed === "boolean" &&
              typeof fullPassed === "boolean"
          )
        ).toBe(true);
        expect(markdown).toContain(
          "| Fixture | Full success | Compact success |"
        );
        expect(await readFile(sentinel, "utf8")).toContain(
          "// resume sentinel"
        );
        expect(receipt.status).toBe("completed");
        expect(report.summary.fullLatencyMs.meanCi95).toHaveLength(2);
        expect(report.summary.compactLatencyMs.meanCi95).toHaveLength(2);
        expect(report.summary.fullQuality.wilson95).toHaveLength(2);
        expect(report.summary.compactQuality.wilson95).toHaveLength(2);
        expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });
        const corrupted = {
          ...report,
          pairs: report.pairs.map((pair, index) =>
            index === 0 ? { ...pair, order: "compact-full" as const } : pair
          ),
        };
        expect(() => validateTaskUtilityArtifact(corrupted)).toThrow(
          "pair order is invalid"
        );
        const repetitionIndex = receipt.argv.indexOf("--repetitions") + 1;
        if (repetitionIndex === 0 || repetitionIndex >= receipt.argv.length) {
          throw new TypeError("Expected repetitions receipt argument.");
        }
        receipt.argv[repetitionIndex] = "9";
        await writeFile(
          join(outputDirectory, "task-utility-command.json"),
          JSON.stringify(receipt)
        );
        await expect(
          execFileAsync(
            "pnpm",
            [
              "run",
              "task-utility-validate",
              "--",
              "--input",
              join(outputDirectory, "task-utility.json"),
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

  it(
    "retries partial pairs whose full control failed",
    async () => {
      const outputDirectory = await mkdtemp(
        join(tmpdir(), "pss-task-utility-invalid-control-test-")
      );

      try {
        await runTaskUtility(outputDirectory, 1);
        const partialPath = join(outputDirectory, "task-utility.partial.json");
        const rawPartial: unknown = JSON.parse(
          await readFile(partialPath, "utf8")
        );
        if (
          typeof rawPartial !== "object" ||
          rawPartial === null ||
          Array.isArray(rawPartial)
        ) {
          throw new TypeError("Expected task utility partial.");
        }
        const pairs = parseTaskUtilityPairs(Reflect.get(rawPartial, "pairs"));
        const pair = pairs[0];
        if (pair === undefined) {
          throw new TypeError("Expected a full-control task pair.");
        }
        const partial = {
          ...rawPartial,
          pairs: [
            {
              ...pair,
              arms: pair.arms.map((arm) =>
                arm.arm === "full" ? { ...arm, passed: false } : arm
              ),
              fullPassed: false,
            },
            ...pairs.slice(1),
          ],
        };
        await writeFile(partialPath, JSON.stringify(partial));

        await runTaskUtility(outputDirectory, 1);

        const rawReport: unknown = JSON.parse(
          await readFile(join(outputDirectory, "task-utility.json"), "utf8")
        );
        const report = parseTaskUtilityReport(rawReport);
        expect(report.pairs[0]?.fullPassed).toBe(true);
      } finally {
        await rm(outputDirectory, { force: true, recursive: true });
      }
    },
    CLI_TEST_TIMEOUT_MS
  );
});

async function runTaskUtility(
  outputDirectory: string,
  repetitions: number
): Promise<void> {
  await execFileAsync(
    "pnpm",
    [
      "run",
      "task-utility",
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
}
