import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installExtensionPackage,
  rollbackExtensionPackage,
} from "./package-installer";
import type { RunExtensionCommand } from "./types";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("managed extension package installation", () => {
  it("installs npm, Git, and local package specs with lifecycle scripts disabled", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-packages-"));
    cleanupRoots.push(root);
    const installRoot = join(root, "managed");
    const invocations: { args: readonly string[]; command: string }[] = [];
    const runCommand: RunExtensionCommand = async (command, args) => {
      invocations.push({ args, command });
      const spec = args.at(-1) ?? "";
      const packageName = spec.includes("git") ? "git-extension" : "demo";
      const packageJsonPath = join(installRoot, "package.json");
      const current = JSON.parse(await readFile(packageJsonPath, "utf8"));
      await mkdir(join(installRoot, "node_modules", packageName), {
        recursive: true,
      });
      await writeFile(
        packageJsonPath,
        `${JSON.stringify({
          ...current,
          dependencies: {
            ...current.dependencies,
            [packageName]: spec,
          },
        })}\n`,
        "utf8"
      );
      return { code: 0, stderr: "", stdout: "" };
    };

    // When
    await installExtensionPackage({
      installRoot,
      installSpec: "demo@1.0.0",
      packageName: "demo",
      runCommand,
    });
    const git = await installExtensionPackage({
      installRoot,
      installSpec: "git+https://example.com/git-extension.git",
      runCommand,
    });
    await installExtensionPackage({
      installRoot,
      installSpec: "/tmp/local-extension",
      packageName: "demo",
      runCommand,
    });

    // Then
    expect(git.packageName).toBe("git-extension");
    expect(invocations).toHaveLength(3);
    for (const invocation of invocations) {
      expect(invocation.command).toBe("npm");
      expect(invocation.args).toContain("--ignore-scripts");
      expect(invocation.args).toContain("--save-exact");
      expect(invocation.args).toContain(installRoot);
    }
  });

  it("qualifies registry versions when restoring an existing package", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-rollback-"));
    cleanupRoots.push(root);
    const installRoot = join(root, "managed");
    const specs: string[] = [];
    const runCommand: RunExtensionCommand = async (_command, args) => {
      const spec = args.at(-1) ?? "";
      specs.push(spec);
      const packageJsonPath = join(installRoot, "package.json");
      const current = JSON.parse(await readFile(packageJsonPath, "utf8"));
      await writeFile(
        packageJsonPath,
        JSON.stringify({
          ...current,
          dependencies: { demo: "1.0.0" },
        }),
        "utf8"
      );
      return { code: 0, stderr: "", stdout: "" };
    };
    await mkdir(installRoot, { recursive: true });
    await writeFile(
      join(installRoot, "package.json"),
      JSON.stringify({
        dependencies: { demo: "2.0.0" },
        private: true,
        type: "module",
      }),
      "utf8"
    );

    // When
    await rollbackExtensionPackage({
      installRoot,
      installed: { packageName: "demo", previousSpec: "1.0.0" },
      runCommand,
    });

    // Then
    expect(specs).toEqual(["demo@1.0.0"]);
  });
});
