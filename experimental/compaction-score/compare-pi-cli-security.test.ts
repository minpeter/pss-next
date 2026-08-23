import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { typescriptSubprocessArguments } from "./typescript-subprocess.test-support";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories: string[] = [];
const injectedModel = "CLI_MODEL_SECRET\u001b[31m\n\u2028";
const injectedPathSegment = "CLI_PATH_SECRET\u001b[2J\n\u2028";

const cliEnvironment = {
  ...process.env,
  AI_API_KEY: "test-key",
  AI_BASE_URL: "http://127.0.0.1:1/v1",
  AI_MODEL: injectedModel,
};

const cliArguments = (outputPath: string): string[] =>
  typescriptSubprocessArguments("compare-pi.ts", [outputPath]);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("compare-pi CLI output boundary", () => {
  it("does not reflect model or output path controls during startup", async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "compare-pi-cli-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, injectedPathSegment);
    const child = spawn(process.execPath, cliArguments(outputPath), {
      cwd: benchmarkDirectory,
      env: cliEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });

    // When
    const closed = once(child, "close");
    const [firstOutput] = await once(child.stdout, "data", {
      signal: AbortSignal.timeout(10_000),
    });
    child.kill();
    await closed;
    const output = String(firstOutput);

    // Then
    expect(output).not.toContain("CLI_MODEL_SECRET");
    expect(output).not.toContain("CLI_PATH_SECRET");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u2028");
  });

  it("emits only a stable sentinel when startup fails", async () => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "compare-pi-cli-"));
    temporaryDirectories.push(directory);
    const blockingFile = join(directory, "blocking-file");
    await writeFile(blockingFile, "not a directory");
    const outputPath = join(blockingFile, injectedPathSegment);

    // When
    const result = spawnSync(process.execPath, cliArguments(outputPath), {
      cwd: benchmarkDirectory,
      encoding: "utf8",
      env: cliEnvironment,
      timeout: 10_000,
    });

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("compare-pi-failure\n");
  });
});
