import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runComparisonCli } from "./compare-reports";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function comparisonArtifact(
  artifact: Readonly<Record<string, unknown>> = {
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
    rows: [],
  }
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "comparison-report-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "comparison.json");
  await writeFile(
    path,
    JSON.stringify(artifact)
  );
  return path;
}

async function invoke(args: readonly string[]) {
  let stderr = "";
  let stdout = "";
  const exitCode = await runComparisonCli(args, {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stderr, stdout };
}

describe("comparison report", () => {
  it("comparison report computes paired quality, compression, and latency metrics", async () => {
    const artifact = await comparisonArtifact();

    const result = await invoke(["--table", artifact]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: [
        "# Compaction comparison",
        "",
        "Model: `benchmark-model`",
        "",
        "| Method | Valid | Invalid | Exact retention | Semantic retention | Summary ratio | Savings | Compaction latency |",
        "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
        "| PSS | 2 | 0 | 90/100 (90.00%) | 95/100 (95.00%) | 25.00% | 75.00% | unavailable |",
        "| pi-coding-agent | 2 | 0 | 80/100 (80.00%) | 85/100 (85.00%) | 40.00% | 60.00% | unavailable |",
        "",
        "_Comparator-specific compaction latency is not present in comparison.json._",
        "",
      ].join("\n"),
    });
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
});
