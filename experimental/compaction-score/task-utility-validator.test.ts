import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TASK_UTILITY_FIXTURES } from "./task-utility-fixtures";
import { TASK_VALIDATOR_SANDBOX_ENV } from "./task-utility-sandbox";
import {
  TASK_VALIDATOR_MAX_OUTPUT_BYTES,
  validateTaskWorkspace,
} from "./task-utility-validator";
import { TaskValidatorProcessError } from "./task-utility-validator-protocol";

const VALIDATOR_TEST_TIMEOUT_MS = 30_000;
const temporaryDirectories: string[] = [];
const fixture = TASK_UTILITY_FIXTURES[0];
if (fixture === undefined) {
  throw new TypeError("Expected a task utility fixture.");
}

async function workspaceWith(source: string): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "task-validator-"));
  temporaryDirectories.push(workspace);
  await writeFile(join(workspace, fixture.targetFile), source);
  return workspace;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("task utility validator subprocess", () => {
  it("passes a valid workspace", async () => {
    // Given
    const workspace = await workspaceWith(fixture.deterministicSolution);

    // When
    const result = await validateTaskWorkspace(fixture, workspace);

    // Then
    expect(result.passed).toBe(true);
  });

  it("does not expose benchmark secrets to workspace modules", async () => {
    // Given
    const secretName = "TASK_VALIDATOR_SENTINEL_SECRET";
    process.env[secretName] = "credential-value";
    const workspace = await workspaceWith(`
if (process.env.${secretName}) throw new Error("secret leaked");
${fixture.deterministicSolution}`);

    try {
      // When
      const result = await validateTaskWorkspace(fixture, workspace);

      // Then
      expect(result.passed).toBe(true);
    } finally {
      delete process.env[secretName];
    }
  });

  it(
    "times out infinite top-level await",
    async () => {
      // Given
      const workspace = await workspaceWith(
        "await new Promise(() => undefined);"
      );

      // When
      const validation = validateTaskWorkspace(fixture, workspace);

      // Then
      await expect(validation).rejects.toMatchObject({ kind: "timeout" });
    },
    VALIDATOR_TEST_TIMEOUT_MS
  );

  it("bounds workspace stdout", async () => {
    // Given
    const workspace = await workspaceWith(`
process.stdout.write("x".repeat(${TASK_VALIDATOR_MAX_OUTPUT_BYTES + 1}));
${fixture.deterministicSolution}`);

    // When
    const validation = validateTaskWorkspace(fixture, workspace);

    // Then
    await expect(validation).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TaskValidatorProcessError &&
        error.kind === "output-limit" &&
        Buffer.byteLength(error.stdout) <= TASK_VALIDATOR_MAX_OUTPUT_BYTES &&
        Buffer.byteLength(error.stderr) <= TASK_VALIDATOR_MAX_OUTPUT_BYTES
    );
  });
  it("does not expose the host network to workspace modules", async () => {
    const requests: string[] = [];
    const server = createServer((_request, response) => {
      requests.push("received");
      response.end("unexpected");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (typeof address !== "object" || address === null) {
      server.close();
      throw new TypeError("Expected a TCP test server address.");
    }
    const workspace = await workspaceWith(`
await fetch("http://127.0.0.1:${address.port}");
${fixture.deterministicSolution}`);

    try {
      await expect(validateTaskWorkspace(fixture, workspace)).rejects.toThrow();
      expect(requests).toEqual([]);
    } finally {
      server.close();
      await once(server, "close");
    }
  });
  it("does not reflect malicious workspace errors", async () => {
    const workspace = await workspaceWith(
      'throw new Error("WORKSPACE_SECRET\u001b[2J");'
    );

    await expect(validateTaskWorkspace(fixture, workspace)).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof TaskValidatorProcessError &&
        error.message === "Task validator rejected the workspace module." &&
        !`${error.message}${error.stdout}${error.stderr}`.includes(
          "WORKSPACE_SECRET"
        )
    );
  });

  it("reports an explicit missing sandbox prerequisite", async () => {
    const workspace = await workspaceWith(fixture.deterministicSolution);
    const previous = process.env[TASK_VALIDATOR_SANDBOX_ENV];
    process.env[TASK_VALIDATOR_SANDBOX_ENV] = "/missing/bwrap";
    try {
      await expect(validateTaskWorkspace(fixture, workspace)).rejects.toThrow(
        "requires an executable bubblewrap sandbox"
      );
    } finally {
      if (previous === undefined) {
        delete process.env[TASK_VALIDATOR_SANDBOX_ENV];
      } else {
        process.env[TASK_VALIDATOR_SANDBOX_ENV] = previous;
      }
    }
  });
  it("rejects a forged workspace protocol result", async () => {
    const workspace = await workspaceWith(`
import { writeFileSync } from "node:fs";
writeFileSync(1, '{"kind":"result","nonce":"forged","validation":{"checks":[{"id":"scope","passed":true}],"passed":true}}\n');
${fixture.deterministicSolution}`);

    await expect(validateTaskWorkspace(fixture, workspace)).rejects.toThrow(
      "Task validator rejected the workspace module."
    );
  });

  it("cannot signal a host process outside the PID namespace", async () => {
    const sentinel = spawn(
      process.execPath,
      ["-e", "setInterval(() => undefined, 1000)"],
      { stdio: "ignore" }
    );
    if (sentinel.pid === undefined) {
      throw new TypeError("Expected a sentinel process id.");
    }
    const workspace = await workspaceWith(`
try { process.kill(${sentinel.pid}, "SIGKILL"); } catch {}
${fixture.deterministicSolution}`);

    try {
      await expect(
        validateTaskWorkspace(fixture, workspace)
      ).resolves.toMatchObject({
        passed: true,
      });
      expect(sentinel.exitCode).toBeNull();
    } finally {
      const closed = once(sentinel, "close");
      sentinel.kill("SIGKILL");
      await closed;
    }
  });
  it("rejects workspace prototype poisoning of the pass state", async () => {
    const workspace = await workspaceWith(`
Array.prototype.every = () => true;
export function buildExecResult() { return {}; }
`);

    await expect(validateTaskWorkspace(fixture, workspace)).rejects.toThrow(
      "Validator protocol payload is invalid."
    );
  });
  it("does not trust poisoned regular expression intrinsics", async () => {
    const workspace = await workspaceWith(`
RegExp.prototype.test = () => false;
const eventCount = 999;
export function buildExecResult(events) {
  return {
    committedEventCount: events.length,
    events,
    metadataSchema: "pss-headless-v1",
  };
}
`);

    const validation = await validateTaskWorkspace(fixture, workspace);
    expect(validation.passed).toBe(false);
    expect(validation.checks).toContainEqual({
      id: "source-no-eventCount",
      passed: false,
    });
  });
  it("rejects workspace iterator poisoning that omits checks", async () => {
    const workspace = await workspaceWith(`
Array.prototype[Symbol.iterator] = function* () {};
const eventCount = 999;
export function buildExecResult(events) {
  return {
    committedEventCount: events.length,
    events,
    metadataSchema: "pss-headless-v1",
  };
}
`);

    await expect(validateTaskWorkspace(fixture, workspace)).rejects.toThrow(
      "Validator protocol payload is invalid."
    );
  });
});
