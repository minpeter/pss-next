import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runComparisonCli } from "./compare-reports";
import { parseComparisonCliOutput } from "./compare-reports-cli-output.test-support";
import type { FixtureQuestion } from "./fixture";
import { summarizeTrials, type TrialRecord } from "./report";
import { scoreAnswers } from "./scorer";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

const report = () => {
  const question: FixtureQuestion = {
    answer: "alpha",
    category: "exact-recall",
    question: "Value?",
  };
  const answers = new Map([[question, "alpha"]]);
  const record: TrialRecord = {
    fixtureSeed: "compare-cli-test",
    hops: [{ endSeqExclusive: 10, prefixTokens: 100, summaryTokens: 30 }],
    id: "valid-1",
    prefixTokens: 100,
    repetition: 1,
    scenario: "baseline",
    score: scoreAnswers([question], answers, answers),
    status: "valid",
    summaryTokens: 30,
  };
  return summarizeTrials([record]);
};

async function fixtureFiles(candidate: unknown = report()) {
  const directory = await mkdtemp(join(tmpdir(), "compare-reports-test-"));
  temporaryDirectories.push(directory);
  const baselinePath = join(directory, "baseline.json");
  const candidatePath = join(directory, "candidate.json");
  await Promise.all([
    writeFile(baselinePath, JSON.stringify(report())),
    writeFile(
      candidatePath,
      typeof candidate === "string" ? candidate : JSON.stringify(candidate)
    ),
  ]);
  return { baselinePath, candidatePath };
}

async function invoke(paths: readonly string[]) {
  let stderr = "";
  let stdout = "";
  const exitCode = await runComparisonCli(paths, {
    stderr: (text) => {
      stderr += text;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { exitCode, stderr, stdout };
}

describe("compare reports CLI", () => {
  it("exits zero with a JSON pass decision for real TrialSummary files", async () => {
    const paths = await fixtureFiles();

    const result = await invoke([
      "--",
      paths.baselinePath,
      paths.candidatePath,
    ]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `${JSON.stringify({ failures: [], passed: true }, null, 2)}\n`,
    });
  });

  it("exits nonzero with gate codes for a report mutation", async () => {
    const original = report();
    const candidate = {
      ...original,
      compression: original.compression
        ? {
            ...original.compression,
            byHop: original.compression.byHop.map((row, index) =>
              index === 0 ? { ...row, ratio: { ...row.ratio, max: 1 } } : row
            ),
          }
        : null,
    };
    const paths = await fixtureFiles(candidate);

    const result = await invoke([paths.baselinePath, paths.candidatePath]);
    const output = parseComparisonCliOutput(result.stdout);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(output.passed).toBe(false);
    expect(output.failureCodes).toContain("HOP_RATIO_NOT_BELOW_ONE");
  });

  it("classifies an untrusted invalid status without reflecting its bytes", async () => {
    // Given
    const candidate = report();
    const unsafeStatus =
      'provider token sk-secret <img src=x onerror="alert(1)">\u001b[31m\n\u202e\u2029\udc00';
    const paths = await fixtureFiles({
      ...candidate,
      trials: {
        ...candidate.trials,
        invalidByStatus: { [unsafeStatus]: 0 },
      },
    });

    // When
    const result = await invoke([paths.baselinePath, paths.candidatePath]);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "",
      stdout: `${JSON.stringify(
        {
          failures: [
            {
              code: "REPORT_METRIC_INVALID",
              payload: {
                actual: "unknown invalid status key",
                expected: "known invalid status keys",
                path: "$.trials.invalidByStatus",
                report: "candidate",
              },
            },
          ],
          passed: false,
        },
        null,
        2
      )}\n`,
    });
  });

  it("classifies an untrusted retention category without reflecting its bytes", async () => {
    // Given
    const candidate = report();
    const unsafeCategory =
      'provider token sk-category-secret <img src=x onerror="alert(1)">\u001b[31m\n\u2028\u2029\u202e\ud800';
    const paths = await fixtureFiles({
      ...candidate,
      retention: candidate.retention
        ? {
            ...candidate.retention,
            byCategory: candidate.retention.byCategory.map((row, index) =>
              index === 0 ? { ...row, category: unsafeCategory } : row
            ),
          }
        : null,
    });

    // When
    const result = await invoke([paths.baselinePath, paths.candidatePath]);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "",
      stdout: `${JSON.stringify(
        {
          failures: [
            {
              code: "REPORT_METRIC_INVALID",
              payload: {
                actual: "unknown question category",
                expected: "known question category",
                path: "$.retention.byCategory[0].category",
                report: "candidate",
              },
            },
          ],
          passed: false,
        },
        null,
        2
      )}\n`,
    });
  });

  it("rejects malformed JSON with a stable sentinel", async () => {
    // Given
    const paths = await fixtureFiles('{"compression":');

    // When
    const result = await invoke([paths.baselinePath, paths.candidatePath]);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "CANDIDATE_REPORT_JSON_INVALID\n",
      stdout: "",
    });
  });

  it("rejects an unsafe missing input path without reflecting it", async () => {
    // Given
    const paths = await fixtureFiles();
    const unsafePath = `${paths.baselinePath}-secret-<img>-\u202e`;

    // When
    const result = await invoke([unsafePath, paths.candidatePath]);

    // Then
    expect(result).toEqual({
      exitCode: 1,
      stderr: "BASELINE_REPORT_READ_FAILED\n",
      stdout: "",
    });
  });
});
