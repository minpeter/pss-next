import { describe, expect, it } from "vitest";
import { comparisonArtifact, invoke } from "./comparison-report-test-support";

describe("comparison report", () => {
  it("comparison report computes paired quality, compression, and latency metrics", async () => {
    const artifact = await comparisonArtifact();
    const result = await invoke(["--table", artifact]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "| PSS | 2 | 0 | 90/100 (90.00%) | 95/100 (95.00%) | 25.00% | 75.00% | unavailable |"
    );
    expect(result.stdout).toContain(
      "| pi-coding-agent | 2 | 0 | 80/100 (80.00%) | 85/100 (85.00%) | 40.00% | 60.00% | unavailable |"
    );
  });

  it("comparison report separates invalid trials from valid quality means", async () => {
    const artifact = await comparisonArtifact({
      aggregate: {
        overall: {
          pi: {
            compressionMean: 0.5,
            invalid: 1,
            retained: 10,
            semanticRetained: 11,
            total: 12,
            valid: 1,
          },
          pss: {
            compressionMean: 0.2,
            invalid: 1,
            retained: 12,
            semanticRetained: 12,
            total: 12,
            valid: 1,
          },
        },
      },
      model: "benchmark-model",
      rows: [
        {
          pi: {
            error: "provider unavailable",
            status: "summary-provider-failure",
          },
          pss: { status: "valid" },
          repetition: 1,
          scenario: "baseline",
        },
        {
          pi: { status: "valid" },
          pss: {
            error: "evaluator unavailable",
            status: "evaluation-provider-failure",
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
      "| PSS | 1 | 1 | 12/12 (100.00%) | 12/12 (100.00%) | 20.00% | 80.00% | unavailable |"
    );
    expect(result.stdout).toContain(
      "| pi-coding-agent | 1 | 1 | 10/12 (83.33%) | 11/12 (91.67%) | 50.00% | 50.00% | unavailable |"
    );
    expect(result.stdout).toContain(
      "| PSS | evaluation-provider-failure | 1 |"
    );
    expect(result.stdout).toContain(
      "| pi-coding-agent | summary-provider-failure | 1 |"
    );
  });

  it("renders every token metric cell when one method is unavailable", async () => {
    // Given
    const artifact = await comparisonArtifact({
      aggregate: {
        overall: {
          pi: {
            compressionMean: null,
            invalid: 1,
            retained: 0,
            semanticRetained: 0,
            total: 0,
            valid: 0,
          },
          pss: {
            compressionMean: 0.5,
            invalid: 0,
            retained: 1,
            semanticRetained: 1,
            total: 1,
            valid: 1,
          },
        },
      },
      model: "benchmark-model",
      rows: [
        {
          pi: { status: "summary-provider-failure" },
          pss: {
            hops: [{ prefixTokens: 2, summaryTokens: 1 }],
            status: "valid",
          },
        },
      ],
    });

    // When
    const result = await invoke(["--table", artifact]);

    // Then
    expect(result.stdout).toContain(
      "| pi-coding-agent | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |"
    );
  });
});
