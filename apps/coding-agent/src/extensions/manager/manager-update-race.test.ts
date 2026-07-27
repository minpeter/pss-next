import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateExtensions } from "./manager";
import { extensionScopePaths } from "./paths";
import { writeExtensionSettings } from "./settings";
import type { RunExtensionCommand } from "./types";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("managed extension update isolation", () => {
  it("restores managed bytes when the final install differs from staging", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-update-race-"));
    cleanupRoots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const paths = await extensionScopePaths({
      cwd,
      home,
      scope: "global",
    });
    await writePackage(paths.installRoot, "valid");
    await writeExtensionSettings(paths.settingsPath, {
      extensions: [
        {
          enabled: true,
          id: "race",
          installedAt: "2026-07-23T00:00:00.000Z",
          source: "npm:race-package@latest",
          sourceKind: "npm",
          target: { kind: "package", packageName: "race-package" },
        },
      ],
      values: {},
    });
    let installs = 0;
    const runCommand: RunExtensionCommand = async (_command, args) => {
      const prefixIndex = args.indexOf("--prefix");
      const installRoot = args[prefixIndex + 1];
      if (installRoot === undefined) {
        return { code: 1, stderr: "missing prefix", stdout: "" };
      }
      installs += 1;
      await writePackage(installRoot, installs === 1 ? "valid" : "invalid");
      return { code: 0, stderr: "", stdout: "" };
    };

    // When
    const updating = updateExtensions({
      all: false,
      cwd,
      home,
      ids: ["race"],
      runCommand,
      scope: "global",
    });

    // Then
    await expect(updating).rejects.toThrow(
      'Coding agent extension "race" default export must be a function'
    );
    await expect(
      readFile(
        join(paths.installRoot, "node_modules", "race-package", "index.mjs"),
        "utf8"
      )
    ).resolves.toContain("function extension");
  });
});

async function writePackage(
  installRoot: string,
  state: "invalid" | "valid"
): Promise<void> {
  const packageRoot = join(installRoot, "node_modules", "race-package");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(installRoot, "package.json"),
    JSON.stringify({
      dependencies: { "race-package": "1.0.0" },
      private: true,
      type: "module",
    }),
    "utf8"
  );
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      exports: "./index.mjs",
      name: "race-package",
      type: "module",
      version: "1.0.0",
    }),
    "utf8"
  );
  await writeFile(
    join(packageRoot, "index.mjs"),
    state === "valid"
      ? "export default function extension() {}\n"
      : 'export default "invalid";\n',
    "utf8"
  );
}
