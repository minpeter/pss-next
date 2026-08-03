import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setExtensionEnabled } from "./activation";
import { installExtension } from "./install";
import { extensionScopePaths, extensionTrustPath } from "./paths";
import { readExtensionSettings, writeExtensionSettings } from "./settings";
import type { RunExtensionCommand } from "./types";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("project extension trust transaction", () => {
  it("does not trust a project when settings commit fails", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-trust-"));
    cleanupRoots.push(root);
    const cwd = join(root, "project");
    const home = join(root, "home");
    const modulePath = join(root, "extension.mjs");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      modulePath,
      "export default function extension() {}\n",
      "utf8"
    );
    const context = {
      cwd,
      enabled: true,
      home,
      id: "trust-failure",
      scope: "project" as const,
      settingsWriter() {
        return Promise.reject(new Error("settings unavailable"));
      },
      source: modulePath,
    };

    // When
    const installing = installExtension(context);

    // Then
    await expect(installing).rejects.toThrow("settings unavailable");
    await expect(
      access(join(home, ".pss", "trusted-projects.json"))
    ).rejects.toThrow();
  });

  it("restores disabled state when project trust cannot be persisted", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-extension-enable-trust-"));
    cleanupRoots.push(root);
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    const context = { cwd, home, scope: "project" as const };
    const paths = await extensionScopePaths(context);
    await writeExtensionSettings(paths.settingsPath, {
      extensions: [
        {
          enabled: false,
          id: "demo",
          installedAt: "2026-08-03T00:00:00.000Z",
          source: "./demo.mjs",
          sourceKind: "local",
          target: { kind: "module", path: "./demo.mjs" },
        },
      ],
      values: {},
    });
    await mkdir(extensionTrustPath(home), { recursive: true });

    await expect(
      setExtensionEnabled({
        ...context,
        all: false,
        enabled: true,
        ids: ["demo"],
      })
    ).rejects.toThrow();

    await expect(
      readExtensionSettings(paths.settingsPath)
    ).resolves.toMatchObject({ extensions: [{ enabled: false, id: "demo" }] });
  });
});

describe("extension installation transaction", () => {
  it("serializes duplicate installs before mutating the shared package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-extension-install-race-"));
    cleanupRoots.push(root);
    const cwd = join(root, "project");
    const home = join(root, "home");
    await mkdir(cwd, { recursive: true });
    let commandCount = 0;
    const runCommand: RunExtensionCommand = async (_command, args) => {
      commandCount += 1;
      const prefixIndex = args.indexOf("--prefix");
      const installRoot = args[prefixIndex + 1];
      if (!installRoot) {
        throw new Error("expected npm --prefix");
      }
      const packageJsonPath = join(installRoot, "package.json");
      const packageJson = JSON.parse(
        await readFile(packageJsonPath, "utf8")
      ) as Record<string, unknown>;
      await writeFile(
        packageJsonPath,
        JSON.stringify({
          ...packageJson,
          dependencies: { demo: "1.0.0" },
        })
      );
      const packageRoot = join(installRoot, "node_modules", "demo");
      await mkdir(packageRoot, { recursive: true });
      await writeFile(
        join(packageRoot, "package.json"),
        JSON.stringify({ main: "index.js" })
      );
      return { code: 0, stderr: "", stdout: "" };
    };
    const context = {
      cwd,
      enabled: true,
      home,
      importer: async () => ({ default: () => undefined }),
      runCommand,
      scope: "global" as const,
      source: "demo@1.0.0",
    };

    const results = await Promise.allSettled([
      installExtension(context),
      installExtension(context),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected")
    ).toHaveLength(1);
    expect(commandCount).toBe(1);
    const paths = await extensionScopePaths(context);
    await expect(
      readExtensionSettings(paths.settingsPath)
    ).resolves.toMatchObject({
      extensions: [{ id: "demo" }],
    });
  });
});
