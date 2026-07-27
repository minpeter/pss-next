import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { removeExtension } from "./manager";
import { extensionScopePaths } from "./paths";
import { writeExtensionSettings } from "./settings";
import type { RunExtensionCommand } from "./types";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("managed extension removal", () => {
  it("keeps the package installed when settings cannot be persisted", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-remove-"));
    cleanupRoots.push(root);
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    const paths = await extensionScopePaths({
      cwd,
      home,
      scope: "global",
    });
    await writeExtensionSettings(paths.settingsPath, {
      extensions: [
        {
          enabled: true,
          id: "demo",
          installedAt: "2026-07-23T00:00:00.000Z",
          source: "demo@1.0.0",
          sourceKind: "npm",
          target: { kind: "package", packageName: "demo" },
        },
      ],
      values: {},
    });
    const invocations: string[][] = [];
    const runCommand: RunExtensionCommand = (_command, args) => {
      invocations.push([...args]);
      return Promise.resolve({ code: 0, stderr: "", stdout: "" });
    };
    const settingsDirectory = dirname(paths.settingsPath);
    await chmod(settingsDirectory, 0o500);

    // When
    try {
      await expect(
        removeExtension({
          cwd,
          home,
          id: "demo",
          runCommand,
          scope: "global",
        })
      ).rejects.toThrow();
    } finally {
      await chmod(settingsDirectory, 0o700);
    }

    // Then
    expect(invocations).toEqual([]);
    const persisted = JSON.parse(await readFile(paths.settingsPath, "utf8"));
    expect(persisted.extensions).toEqual([
      expect.objectContaining({ id: "demo" }),
    ]);
  });
});
