import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  array,
  boolean,
  finite,
  nonnegativeInteger,
  object,
  positiveInteger,
} from "./quality-sweep-parse";
import { validateQualitySweepArtifact } from "./quality-sweep-validation";

const execFileAsync = promisify(execFile);
const CLI_TEST_TIMEOUT_MS = 30_000;
const BUDGETS = [64, 128, 256, 512, 1024, 2048, 4096, 8192, 13_107];

describe("quality-sweep CLI artifact", () => {
  it(
    "emits a validated matched-quality report",
    async () => {
      const outputDirectory = await mkdtemp(
        join(tmpdir(), "pss-quality-sweep-test-")
      );

      try {
        await execFileAsync(
          "pnpm",
          [
            "run",
            "quality-sweep",
            "--",
            "--mode",
            "deterministic",
            "--repetitions",
            "1",
            "--output",
            outputDirectory,
          ],
          { cwd: import.meta.dirname }
        );

        const report: unknown = JSON.parse(
          await readFile(join(outputDirectory, "quality-sweep.json"), "utf8")
        );
        validateQualitySweepArtifact(report);
        const reportObject = object(report, "quality sweep report");
        const observations = array(
          reportObject.observations,
          "quality sweep observations"
        );
        const matchedQuality = array(
          reportObject.matchedQuality,
          "matched quality"
        );
        const receipt: unknown = JSON.parse(
          await readFile(
            join(outputDirectory, "quality-sweep-command.json"),
            "utf8"
          )
        );
        const receiptObject = object(receipt, "quality sweep receipt");
        const receiptArgv = receiptObject.argv;
        if (
          !(
            Array.isArray(receiptArgv) &&
            receiptArgv.every((argument) => typeof argument === "string")
          )
        ) {
          throw new TypeError("Expected quality sweep receipt arguments.");
        }
        const validation = await execFileAsync(
          "pnpm",
          [
            "run",
            "quality-sweep-validate",
            "--",
            "--input",
            join(outputDirectory, "quality-sweep.json"),
          ],
          { cwd: import.meta.dirname }
        );
        const markdown = await readFile(
          join(outputDirectory, "quality-sweep.md"),
          "utf8"
        );

        expect({
          budgets: array(reportObject.budgets, "budgets").map((budget) =>
            positiveInteger(budget, "budget")
          ),
          mode: reportObject.mode,
          repetitions: positiveInteger(reportObject.repetitions, "repetitions"),
        }).toMatchObject({
          budgets: BUDGETS,
          mode: "deterministic",
          repetitions: 1,
        });
        expect(matchedQuality.length).toBeGreaterThan(0);
        expect(
          observations.every((rawObservation) => {
            const observation = object(rawObservation, "observation");
            return (
              boolean(observation.controlPassed, "controlPassed") &&
              nonnegativeInteger(
                observation.controlCorrect,
                "controlCorrect"
              ) === nonnegativeInteger(observation.controlTotal, "controlTotal")
            );
          })
        ).toBe(true);
        expect(
          matchedQuality.every((rawMatch) => {
            const match = object(rawMatch, "matched quality");
            const quality = finite(match.quality, "quality");
            return (
              Number.isFinite(finite(match.piBudget, "piBudget")) &&
              Number.isFinite(finite(match.pssBudget, "pssBudget")) &&
              quality >= 0.5 &&
              quality <= 0.7
            );
          })
        ).toBe(true);
        expect(receiptObject.status).toBe("completed");
        expect(JSON.parse(validation.stdout)).toMatchObject({ valid: true });

        const corrupted: unknown = structuredClone(report);
        const corruptedObject = object(corrupted, "corrupted report");
        const firstCell = array(corruptedObject.cells, "corrupted cells")[0];
        const firstCellObject = object(firstCell, "corrupted cell");
        firstCellObject.correct =
          nonnegativeInteger(firstCellObject.correct, "cell.correct") + 1;
        expect(() => validateQualitySweepArtifact(corrupted)).toThrow(
          "cell accounting is inconsistent"
        );

        const overBudget: unknown = structuredClone(report);
        const overBudgetObject = object(overBudget, "over-budget report");
        const firstObservation = array(
          overBudgetObject.observations,
          "over-budget observations"
        )[0];
        const firstObservationObject = object(
          firstObservation,
          "over-budget observation"
        );
        firstObservationObject.summaryTokens =
          array(firstObservationObject.sentOutputTokens, "sentOutputTokens")
            .map((tokens) => positiveInteger(tokens, "sentOutputToken"))
            .reduce((total, tokens) => total + tokens, 0) + 1;
        expect(() => validateQualitySweepArtifact(overBudget)).toThrow(
          "exceeds its enforced output budget"
        );
        expect(markdown).toContain("| Quality | PSS budget | pi budget |");
        const repetitionIndex = receiptArgv.indexOf("--repetitions") + 1;
        if (repetitionIndex === 0 || repetitionIndex >= receiptArgv.length) {
          throw new TypeError("Expected quality sweep repetition argument.");
        }
        receiptArgv[repetitionIndex] = "9";
        await writeFile(
          join(outputDirectory, "quality-sweep-command.json"),
          JSON.stringify(receipt)
        );
        await expect(
          execFileAsync(
            "pnpm",
            [
              "run",
              "quality-sweep-validate",
              "--",
              "--input",
              join(outputDirectory, "quality-sweep.json"),
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
