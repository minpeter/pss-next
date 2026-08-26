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

describe("compare reports failure identity", () => {
  it.each([
    ["missing baseline", "missing", "valid", "BASELINE_REPORT_READ_FAILED"],
    ["missing candidate", "valid", "missing", "CANDIDATE_REPORT_READ_FAILED"],
    [
      "malformed baseline",
      "malformed",
      "valid",
      "BASELINE_REPORT_JSON_INVALID",
    ],
    [
      "malformed candidate",
      "valid",
      "malformed",
      "CANDIDATE_REPORT_JSON_INVALID",
    ],
  ] as const)(
    "emits a fixed role-bearing sentinel for a %s",
    async (_name, baselineState, candidateState, sentinel) => {
      // Given
      const directory = await mkdtemp(join(tmpdir(), "compare-identity-"));
      temporaryDirectories.push(directory);
      const unsafePathSuffix = "-secret-<img>-\u001b-\u202e";
      const baselinePath = join(directory, `baseline${unsafePathSuffix}.json`);
      const candidatePath = join(
        directory,
        `candidate${unsafePathSuffix}.json`
      );
      if (baselineState !== "missing") {
        await writeFile(
          baselinePath,
          baselineState === "valid" ? "{}" : '{"compression":'
        );
      }
      if (candidateState !== "missing") {
        await writeFile(
          candidatePath,
          candidateState === "valid" ? "{}" : '{"compression":'
        );
      }

      // When
      const result = await invoke([baselinePath, candidatePath]);

      // Then
      expect(result).toEqual({
        exitCode: 1,
        stderr: `${sentinel}\n`,
        stdout: "",
      });
    }
  );
});
