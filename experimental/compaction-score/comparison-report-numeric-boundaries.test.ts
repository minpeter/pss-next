import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runComparisonCli } from "./compare-reports";

const temporaryDirectories: string[] = [];

const aggregateArm = {
  compressionMean: 0.5,
  invalid: 0,
  retained: 1,
  semanticRetained: 1,
  total: 1,
  valid: 1,
};

function artifact(
  pss: Readonly<Record<string, unknown>>,
  pssAggregate: Readonly<Record<string, unknown>> = aggregateArm
) {
  return {
    aggregate: { overall: { pi: aggregateArm, pss: pssAggregate } },
    model: "numeric-boundary-model",
    rows: [{ pi: { status: "valid" }, pss: { status: "valid", ...pss } }],
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

async function invoke(value: Readonly<Record<string, unknown>>) {
  const directory = await mkdtemp(join(tmpdir(), "comparison-numeric-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "comparison.json");
  await writeFile(path, JSON.stringify(value));
  let stderr = "";
  let stdout = "";
  const exitCode = await runComparisonCli(["--table", path], {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stderr, stdout };
}

const invalidResult = {
  exitCode: 1,
  stderr: "COMPARISON_ARTIFACT_INVALID\n",
  stdout: "",
};

describe("comparison report numeric boundary", () => {
  it("rejects two individually finite 1e308 token hops when their total overflows", async () => {
    // Given
    const value = artifact({
      hops: [
        { prefixTokens: 1e308, summaryTokens: 1 },
        { prefixTokens: 1e308, summaryTokens: 1 },
      ],
    });

    // When
    const result = await invoke(value);

    // Then
    expect(result).toEqual(invalidResult);
  });

  it("rejects two individually finite 1e308 duration hops when their total overflows", async () => {
    // Given
    const value = artifact({
      hops: [
        {
          compactionMs: 1e308,
          prefixTokens: 2,
          summarizerInputTokens: 1,
          summaryTokens: 1,
        },
        {
          compactionMs: 1e308,
          prefixTokens: 2,
          summarizerInputTokens: 1,
          summaryTokens: 1,
        },
      ],
    });

    // When
    const result = await invoke(value);

    // Then
    expect(result).toEqual(invalidResult);
  });

  it.each([
    [
      "unsafe aggregate count",
      artifact({}, { ...aggregateArm, total: Number.MAX_SAFE_INTEGER + 1 }),
    ],
    [
      "aggregate ratio below zero",
      artifact({}, { ...aggregateArm, compressionMean: -0.01 }),
    ],
    [
      "aggregate ratio above one",
      artifact({}, { ...aggregateArm, compressionMean: 1.01 }),
    ],
    [
      "exact retained facts above total facts",
      artifact({}, { ...aggregateArm, retained: 2 }),
    ],
    [
      "semantic retained facts above total facts",
      artifact({}, { ...aggregateArm, semanticRetained: 2 }),
    ],
    [
      "semantic retained facts below exact retained facts",
      artifact({}, { ...aggregateArm, retained: 1, semanticRetained: 0 }),
    ],
    [
      "summary larger than its source prefix",
      artifact({ hops: [{ prefixTokens: 1, summaryTokens: 2 }] }),
    ],
    [
      "unsafe summarizer input token count",
      artifact({
        hops: [
          {
            prefixTokens: 1,
            summarizerInputTokens: Number.MAX_SAFE_INTEGER + 1,
            summaryTokens: 1,
          },
        ],
      }),
    ],
    [
      "duration above the supported bound",
      artifact({
        hops: [
          {
            compactionMs: Number.MAX_SAFE_INTEGER + 1,
            prefixTokens: 1,
            summaryTokens: 1,
          },
        ],
      }),
    ],
    [
      "aggregate attempt count overflow",
      artifact(
        {},
        {
          ...aggregateArm,
          invalid: 1,
          valid: Number.MAX_SAFE_INTEGER,
        }
      ),
    ],
  ])("rejects %s without report output", async (_name, value) => {
    // Given / When
    const result = await invoke(value);

    // Then
    expect(result).toEqual(invalidResult);
  });

  it("accepts zero and the largest exactly accumulated safe values", async () => {
    // Given
    const largest = Number.MAX_SAFE_INTEGER;
    const value = artifact(
      {
        hops: [
          {
            compactionMs: largest - 1,
            prefixTokens: largest - 1,
            summarizerInputTokens: largest - 1,
            summaryTokens: largest - 1,
          },
          {
            compactionMs: 1,
            prefixTokens: 1,
            summarizerInputTokens: 1,
            summaryTokens: 1,
          },
        ],
      },
      {
        compressionMean: 1,
        invalid: 0,
        retained: largest,
        semanticRetained: largest,
        total: largest,
        valid: largest,
      }
    );

    // When
    const result = await invoke(value);

    // Then
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.length).toBeGreaterThan(0);
  });
});
