import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasCompleteQualityBudget,
  loadQualitySweepResume,
} from "./quality-sweep-storage";
import type { QualitySweepObservation } from "./quality-sweep-types";

const SCENARIOS = [
  "baseline",
  "lifecycle",
  "boundary-noise",
  "holdout-json",
  "holdout-cjk",
  "holdout-log",
] as const;

describe("quality sweep budget checkpoints", () => {
  it("requires every exact arm-scenario-repetition cell", () => {
    const grid: readonly QualitySweepObservation[] = SCENARIOS.flatMap(
      (scenario) =>
        Array.from({ length: 3 }, (_, repetition) =>
          (["pss", "pi"] as const).map((arm) => ({
            arm,
            budget: 256,
            compressionRatio: null,
            controlCorrect: 0,
            controlPassed: true,
            controlTotal: 0,
            correct: 0,
            costUsd: null,
            fixtureSeed: "fixture-seed",
            latencyMs: null,
            repetition: repetition + 1,
            scenario,
            sentOutputTokens: [],
            summarizerInputTokens: 0,
            summaryTokens: 0,
            total: 0,
            valid: true,
          }))
        ).flat()
    );
    const duplicate = grid[0];
    if (duplicate === undefined) {
      throw new TypeError("Expected a quality sweep observation.");
    }
    const corrupted: readonly QualitySweepObservation[] = [
      ...grid.slice(0, -1),
      duplicate,
    ];

    expect(hasCompleteQualityBudget(grid, 256, 3)).toBe(true);
    expect(hasCompleteQualityBudget(corrupted, 256, 3)).toBe(false);
  });

  it("rejects legacy reports with fabricated output budgets", async () => {
    const output = await mkdtemp(join(tmpdir(), "quality-sweep-storage-"));
    try {
      await writeFile(
        join(output, "quality-sweep.json"),
        JSON.stringify({
          budgets: [256, 512, 1024, 2048, 4096, 8192, 13_107],
          mode: "live",
          model: "test-model",
          observations: [],
          repetitions: 3,
          schemaVersion: "quality-sweep-v1",
        })
      );

      await expect(loadQualitySweepResume(output, 3)).rejects.toThrow(
        "identity mismatch"
      );
    } finally {
      await rm(output, { force: true, recursive: true });
    }
  });
});
