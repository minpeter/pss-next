import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { typescriptSubprocessArguments } from "./typescript-subprocess.test-support";

const benchmarkDirectory = dirname(fileURLToPath(import.meta.url));
const temporaryDirectories: string[] = [];
const CLEANUP_TIMEOUT_MS = 5000;
const SUBPROCESS_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;
const injectedModel = "CLI_MODEL_SECRET\u001b[31m\n\u2028";
const injectedPathSegment = "CLI_PATH_SECRET\u001b[2J\n\u2028";
const STARTED_OUTPUT = /^compare-pi-started\n/;

const cliEnvironment = {
  ...process.env,
  AI_API_KEY: "test-key",
  AI_BASE_URL: "http://127.0.0.1:1/v1",
  AI_MODEL: injectedModel,
};

const cliArguments = (outputPath: string): string[] =>
  typescriptSubprocessArguments("compare-pi.ts", [outputPath]);

const campaignCliArguments = (outputPath: string): string[] =>
  typescriptSubprocessArguments("compare-pi.ts", [
    "--output",
    outputPath,
    "--summary-max-output-tokens",
    "256",
    "--repetitions",
    "1",
  ]);

async function forceCloseChild(child: ChildProcess): Promise<void> {
  let closeListener: (() => void) | undefined;
  const closed = new Promise<void>((resolveClosed) => {
    closeListener = () => resolveClosed();
    child.once("close", closeListener);
  });
  try {
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      once(AbortSignal.timeout(CLEANUP_TIMEOUT_MS), "abort").then(() => {
        throw new Error("Timed out while closing the child process.");
      }),
    ]);
  } finally {
    if (closeListener !== undefined) {
      child.off("close", closeListener);
    }
  }
}

async function runWithCleanup<T>(
  operation: Promise<T>,
  cleanup: () => Promise<void>
): Promise<T> {
  const [operationResult] = await Promise.allSettled([operation]);
  const [cleanupResult] = await Promise.allSettled([
    Promise.resolve().then(cleanup),
  ]);
  if (operationResult.status === "rejected") {
    throw operationResult.reason;
  }
  if (cleanupResult.status === "rejected") {
    throw cleanupResult.reason;
  }
  return operationResult.value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("compare-pi CLI output boundary", () => {
  it("subscribes to close before checking exited state", async () => {
    const child = new ChildProcess();
    let closeListenerWasAttached = false;
    Object.defineProperty(child, "exitCode", {
      get: () => {
        closeListenerWasAttached = child.listenerCount("close") > 0;
        return 0;
      },
    });

    await forceCloseChild(child);

    expect(closeListenerWasAttached).toBe(true);
    expect(child.listenerCount("close")).toBe(0);
  });

  it("preserves subprocess failure when cleanup also fails", async () => {
    const subprocessError = new Error("subprocess failed");
    const cleanupError = new Error("cleanup failed");

    await expect(
      runWithCleanup(Promise.reject(subprocessError), () =>
        Promise.reject(cleanupError)
      )
    ).rejects.toBe(subprocessError);
  });

  const rejectTerminalActiveStartupOutput = async (): Promise<void> => {
    // Given
    const directory = await mkdtemp(join(tmpdir(), "compare-pi-cli-"));
    temporaryDirectories.push(directory);
    const outputPath = join(directory, injectedPathSegment);
    const child = spawn(process.execPath, cliArguments(outputPath), {
      cwd: benchmarkDirectory,
      env: cliEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    // When
    const subprocessTimeout = AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS);
    const closed = once(child, "close", { signal: subprocessTimeout });
    const firstOutput = await runWithCleanup(
      once(child.stdout, "data", {
        signal: subprocessTimeout,
      }),
      async () => {
        const [closedResult, cleanupResult] = await Promise.allSettled([
          closed,
          forceCloseChild(child),
        ]);
        if (closedResult.status === "rejected") {
          throw closedResult.reason;
        }
        if (cleanupResult.status === "rejected") {
          throw cleanupResult.reason;
        }
      }
    );
    const output = String(firstOutput);

    // Then
    expect(output).not.toContain("CLI_MODEL_SECRET");
    expect(output).not.toContain("CLI_PATH_SECRET");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u2028");
    expect(stderr).not.toContain("CLI_MODEL_SECRET");
    expect(stderr).not.toContain("CLI_PATH_SECRET");
    expect(stderr).not.toContain("\u001b");
    expect(stderr).not.toContain("\u2028");
  };
  it(
    "does not reflect model or output path controls during startup",
    rejectTerminalActiveStartupOutput,
    TEST_TIMEOUT_MS
  );

  const emitStableStartupFailure = async (): Promise<void> => {
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
      timeout: SUBPROCESS_TIMEOUT_MS,
    });

    // Then
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("compare-pi-failure\n");
  };
  it(
    "emits only a stable sentinel when startup fails",
    emitStableStartupFailure,
    TEST_TIMEOUT_MS
  );
  it(
    "accepts quality-campaign flags before provider dispatch",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "compare-pi-flags-"));
      temporaryDirectories.push(directory);
      const child = spawn(
        process.execPath,
        campaignCliArguments(join(directory, "output")),
        {
          cwd: benchmarkDirectory,
          env: cliEnvironment,
          stdio: ["ignore", "pipe", "pipe"],
        }
      );
      const subprocessTimeout = AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS);
      const closed = once(child, "close", { signal: subprocessTimeout });
      const firstOutput = await runWithCleanup(
        once(child.stdout, "data", { signal: subprocessTimeout }),
        async () => {
          const [closedResult, cleanupResult] = await Promise.allSettled([
            closed,
            forceCloseChild(child),
          ]);
          if (closedResult.status === "rejected") {
            throw closedResult.reason;
          }
          if (cleanupResult.status === "rejected") {
            throw cleanupResult.reason;
          }
        }
      );

      expect(String(firstOutput)).toMatch(STARTED_OUTPUT);
    },
    TEST_TIMEOUT_MS
  );
});
