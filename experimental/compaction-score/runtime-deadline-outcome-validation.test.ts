import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseRuntimeDeadlineReport } from "./runtime-deadline-outcome-cli-support";
import { validateRuntimeDeadlineOutcomeReport } from "./runtime-deadline-outcome-validation";

const execFileAsync = promisify(execFile);

describe("runtime deadline outcome validation", () => {
  it("requires an auditable summary for every 60-cell arm", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "pss-deadline-validation-test-")
    );
    try {
      await execFileAsync(
        "pnpm",
        [
          "run",
          "deadline-outcome",
          "--",
          "--mode",
          "deterministic",
          "--deadline-ms",
          "10000",
          "--repetitions",
          "10",
          "--output",
          outputDirectory,
        ],
        { cwd: import.meta.dirname }
      );
      const raw: unknown = JSON.parse(
        await readFile(
          join(outputDirectory, "runtime-deadline-outcome.json"),
          "utf8"
        )
      );
      const report = parseRuntimeDeadlineReport(raw);
      expect(() => validateRuntimeDeadlineOutcomeReport(report)).not.toThrow();
      const withoutSummary = { ...report, summary: undefined };
      expect(() =>
        validateRuntimeDeadlineOutcomeReport(withoutSummary)
      ).toThrow("missing its auditable summary");
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  }, 30_000);
});
