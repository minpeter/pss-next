import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const codingAgentRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(codingAgentRoot, "../..");
const CLEANUP_TIMEOUT_MS = 5000;
const SUBPROCESS_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 30_000;

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

describe("exec CLI extension validation", () => {
  let root: string;

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

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pss-exec-extension-security-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  const rejectHostileExtensionId = async (): Promise<void> => {
    // Given
    const hostileId = "extension-secret\u001b[2J\u0007\nSECOND_LINE\u2028";
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const extensionRoot = join(home, ".pss", "extensions");
    const extensionPath = join(extensionRoot, "hostile.mjs");
    await mkdir(extensionRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(extensionPath, "export default () => undefined;\n");
    await writeFile(
      join(home, ".pss", "settings.json"),
      `${JSON.stringify({
        extensions: [
          {
            enabled: true,
            id: hostileId,
            installedAt: "2026-08-23T00:00:00.000Z",
            source: extensionPath,
            sourceKind: "local",
            target: { kind: "module", path: extensionPath },
          },
        ],
      })}\n`
    );
    const child = spawn(
      process.execPath,
      [
        join(codingAgentRoot, "bin/pss.js"),
        "exec",
        "--prompt",
        "do not run",
        "--workspace",
        workspace,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          AI_API_KEY: "test",
          AI_BASE_URL: "https://example.invalid/v1",
          AI_MODEL: "test-model",
          HOME: home,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const closed = once(child, "close", {
      signal: AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // When
    const [exitCode] = await runWithCleanup(closed, () =>
      forceCloseChild(child)
    );

    // Then
    const output = `${stdout}${stderr}`;
    expect(exitCode).toBe(1);
    expect(output).toContain("Invalid extension id.");
    expect(output).not.toContain(hostileId);
    expect(output).not.toContain("extension-secret");
    expect(output).not.toContain("SECOND_LINE");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).not.toContain("\u2028");
  };
  it(
    "prints a safe error for a hostile configured extension id",
    rejectHostileExtensionId,
    TEST_TIMEOUT_MS
  );

  const rejectDuplicateExtensionIds = async (): Promise<void> => {
    // Given
    const privateId = "private-api-token";
    const home = join(root, "home");
    const workspace = join(root, "workspace");
    const extensionRoot = join(home, ".pss", "extensions");
    const firstPath = join(extensionRoot, "first-private-module.mjs");
    const secondPath = join(extensionRoot, "second-private-module.mjs");
    await mkdir(extensionRoot, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(firstPath, "export default () => undefined;\n");
    await writeFile(secondPath, "export default () => undefined;\n");
    await writeFile(
      join(home, ".pss", "settings.json"),
      `${JSON.stringify({
        extensions: [firstPath, secondPath].map((path) => ({
          enabled: true,
          id: privateId,
          installedAt: "2026-08-23T00:00:00.000Z",
          source: path,
          sourceKind: "local",
          target: { kind: "module", path },
        })),
      })}\n`
    );
    const child = spawn(
      process.execPath,
      [
        join(codingAgentRoot, "bin/pss.js"),
        "exec",
        "--prompt",
        "do not run",
        "--workspace",
        workspace,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          AI_API_KEY: "test",
          AI_BASE_URL: "https://example.invalid/v1",
          AI_MODEL: "test-model",
          HOME: home,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    const closed = once(child, "close", {
      signal: AbortSignal.timeout(SUBPROCESS_TIMEOUT_MS),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // When
    const [exitCode] = await runWithCleanup(closed, () =>
      forceCloseChild(child)
    );

    // Then
    const output = `${stdout}${stderr}`;
    expect(exitCode).toBe(1);
    expect(output).toContain("Duplicate coding agent extension id.");
    expect(output).not.toContain(privateId);
    expect(output).not.toContain(firstPath);
    expect(output).not.toContain(secondPath);
  };
  it(
    "prints a path-free error for duplicate enabled extension ids",
    rejectDuplicateExtensionIds,
    TEST_TIMEOUT_MS
  );
});
