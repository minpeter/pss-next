import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const codingAgentRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(codingAgentRoot, "../..");

describe("exec CLI extension validation", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pss-exec-extension-security-"));
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("prints a safe error for a hostile configured extension id", async () => {
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
    const closed = once(child, "close");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // When
    const [exitCode] = await closed;

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
  });

  it("prints a path-free error for duplicate enabled extension ids", async () => {
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
    const closed = once(child, "close");
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    // When
    const [exitCode] = await closed;

    // Then
    const output = `${stdout}${stderr}`;
    expect(exitCode).toBe(1);
    expect(output).toContain("Duplicate coding agent extension id.");
    expect(output).not.toContain(privateId);
    expect(output).not.toContain(firstPath);
    expect(output).not.toContain(secondPath);
  });
});
