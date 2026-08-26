import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateTaskUtilityArtifact } from "./task-utility-artifact-validation";
import { createTaskUtilityReport } from "./task-utility-report";
import { runTaskUtilityCampaign } from "./task-utility-runner";

describe("task utility artifact validation", () => {
  it("accepts empty final prose when a failed live arm has audit evidence", async () => {
    const outputDirectory = await mkdtemp(
      join(tmpdir(), "pss-task-utility-artifact-validation-")
    );

    try {
      const pairs = await runTaskUtilityCampaign({
        attemptTimeoutMs: 10_000,
        mode: "deterministic",
        outputDirectory,
        repetitions: 1,
      });
      const firstPair = pairs[0];
      if (firstPair === undefined) {
        throw new TypeError("Expected a task utility pair.");
      }
      const failedPair = {
        ...firstPair,
        arms: firstPair.arms.map((arm) =>
          arm.arm === "compact"
            ? {
                ...arm,
                assistantOutput: "",
                passed: false,
                validation: {
                  checks: arm.validation.checks.map((check, index) => ({
                    ...check,
                    passed: index === 0 ? false : check.passed,
                  })),
                  passed: false,
                },
              }
            : arm
        ),
        classification: "downstream-execution-variance" as const,
        compactPassed: false,
      };
      const report = createTaskUtilityReport({
        mode: "live",
        model: "test-model",
        pairs: [failedPair, ...pairs.slice(1)],
        repetitions: 1,
      });

      expect(() => validateTaskUtilityArtifact(report)).not.toThrow();
    } finally {
      await rm(outputDirectory, { force: true, recursive: true });
    }
  });
});
