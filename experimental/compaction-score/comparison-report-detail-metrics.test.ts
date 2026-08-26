import { describe, expect, it } from "vitest";
import { comparisonArtifact, invoke } from "./comparison-report-test-support";

describe("comparison report", () => {
  it("comparison report renders detailed token and direct compaction metrics", async () => {
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
      model: "benchmark-model",
      rows: [
        {
          pi: {
            hops: [
              {
                compactionMs: 200,
                prefixTokens: 1000,
                summarizerInputTokens: 950,
                summaryTokens: 400,
              },
            ],
            status: "valid",
          },
          pss: {
            hops: [
              {
                compactionMs: 100,
                prefixTokens: 1000,
                summarizerInputTokens: 900,
                summaryTokens: 250,
              },
            ],
            status: "valid",
          },
          repetition: 1,
          scenario: "baseline",
        },
        {
          pi: {
            hops: [
              {
                compactionMs: 600,
                prefixTokens: 2000,
                summarizerInputTokens: 1300,
                summaryTokens: 800,
              },
            ],
            status: "valid",
          },
          pss: {
            hops: [
              {
                compactionMs: 300,
                prefixTokens: 2000,
                summarizerInputTokens: 1200,
                summaryTokens: 500,
              },
            ],
            status: "valid",
          },
          repetition: 2,
          scenario: "baseline",
        },
      ],
    });
    const result = await invoke(["--table", artifact]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "| PSS | 2 | 3,000 | 2,100 | 750 | 2,250 | 375.00 | 120.00 | 126.67 |"
    );
    expect(result.stdout).toContain(
      "| pi-coding-agent | 2 | 3,000 | 2,250 | 1,200 | 1,800 | 600.00 | 66.67 | 70.83 |"
    );
    expect(result.stdout).toContain(
      "| PSS | 2/2 | 400.00 ms | 200.00 ms | 200.00 ms | 290.00 ms | 300.00 ms | 5,250.00 tok/s |"
    );
    expect(result.stdout).toContain(
      "| pi-coding-agent | 2/2 | 800.00 ms | 400.00 ms | 400.00 ms | 580.00 ms | 600.00 ms | 2,812.50 tok/s |"
    );
    expect(result.stdout).toContain(
      "| PSS | 82.56%-94.48% | 88.82%-97.85% | 0.00% | 100.00 ms | 0/2 (0.00%) |"
    );
    expect(result.stdout).toContain(
      "| pi-coding-agent | 71.12%-86.66% | 76.72%-90.69% | 0.00% | 200.00 ms | 0/2 (0.00%) |"
    );
  });

  it("accepts zero for nonnegative hop metrics", async () => {
    // Given
    const artifact = await comparisonArtifact({
      aggregate: {
        overall: {
          pi: {
            compressionMean: 0,
            invalid: 0,
            retained: 0,
            semanticRetained: 0,
            total: 0,
            valid: 1,
          },
          pss: {
            compressionMean: null,
            invalid: 0,
            retained: 0,
            semanticRetained: 0,
            total: 0,
            valid: 1,
          },
        },
      },
      model: "benchmark-model",
      rows: [
        {
          pi: {
            hops: [
              {
                compactionMs: 0,
                prefixTokens: 1,
                summarizerInputTokens: 0,
                summaryTokens: 0,
              },
            ],
            status: "valid",
          },
          pss: { status: "valid" },
        },
      ],
    });

    // When
    const result = await invoke(["--table", artifact]);

    // Then
    expect(result.exitCode).toBe(0);
  });
});
