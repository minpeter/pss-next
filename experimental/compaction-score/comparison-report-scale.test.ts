import { describe, expect, it } from "vitest";
import { comparisonArtifact, invoke } from "./comparison-report-test-support";

describe("comparison report", () => {
  it("renders a bounded model name with many backtick runs", async () => {
    const artifact = await comparisonArtifact({
      aggregate: {
        overall: {
          pi: {
            compressionMean: 0.4,
            invalid: 0,
            retained: 80,
            semanticRetained: 85,
            total: 100,
            valid: 2,
          },
          pss: {
            compressionMean: 0.25,
            invalid: 0,
            retained: 90,
            semanticRetained: 95,
            total: 100,
            valid: 2,
          },
        },
      },
      model: "`x".repeat(128),
      rows: [],
    });

    const result = await invoke(["--table", artifact]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("renders one valid row with many hops without argument overflow", async () => {
    const hops = Array.from({ length: 150_000 }, () => ({
      compactionMs: 1,
      prefixTokens: 2,
      summaryTokens: 1,
    }));
    const arm = {
      compressionMean: 0.5,
      invalid: 0,
      retained: 1,
      semanticRetained: 1,
      total: 1,
      valid: 1,
    };
    const artifact = await comparisonArtifact({
      aggregate: { overall: { pi: arm, pss: arm } },
      model: "benchmark-model",
      rows: [{ pi: { status: "valid" }, pss: { hops, status: "valid" } }],
    });

    const result = await invoke(["--table", artifact]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  it("renders many valid timed rows without argument overflow", async () => {
    const hops = [{ compactionMs: 1, prefixTokens: 2, summaryTokens: 1 }];
    const rows = Array.from({ length: 150_000 }, () => ({
      pi: { status: "valid" },
      pss: { hops, status: "valid" },
    }));
    const arm = {
      compressionMean: 0.5,
      invalid: 0,
      retained: 1,
      semanticRetained: 1,
      total: 1,
      valid: 1,
    };
    const artifact = await comparisonArtifact({
      aggregate: { overall: { pi: arm, pss: arm } },
      model: "benchmark-model",
      rows,
    });

    const result = await invoke(["--table", artifact]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
