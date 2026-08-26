import { describe, expect, it } from "vitest";
import { comparisonArtifact, invoke } from "./comparison-report-test-support";

describe("comparison report", () => {
  it("rejects a zero prefix token count", async () => {
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
            hops: [{ prefixTokens: 0, summaryTokens: 0 }],
            status: "valid",
          },
          pss: { status: "valid" },
        },
      ],
    });

    // When
    const result = await invoke(["--table", artifact]);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "COMPARISON_ARTIFACT_INVALID\n",
      stdout: "",
    });
  });

  it("rejects a model containing a newline", async () => {
    // Given
    const artifact = await comparisonArtifact({
      aggregate: {
        overall: {
          pi: {
            compressionMean: null,
            invalid: 0,
            retained: 0,
            semanticRetained: 0,
            total: 0,
            valid: 0,
          },
          pss: {
            compressionMean: null,
            invalid: 0,
            retained: 0,
            semanticRetained: 0,
            total: 0,
            valid: 0,
          },
        },
      },
      model: "benchmark`model\ncontinuation",
      rows: [],
    });

    // When
    const result = await invoke(["--table", artifact]);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "COMPARISON_ARTIFACT_INVALID\n",
      stdout: "",
    });
  });
});
