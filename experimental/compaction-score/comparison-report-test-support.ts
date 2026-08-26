import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { runComparisonCli } from "./compare-reports";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

export async function comparisonArtifact(
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
  await writeFile(path, JSON.stringify(artifact));
  return path;
}

export async function invoke(args: readonly string[]) {
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
