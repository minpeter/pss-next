import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCodingAgentCli } from "./cli";

interface CliFixture {
  readonly home: string;
  readonly modulePath: string;
  readonly project: string;
  readonly root: string;
}

async function createCliFixture(): Promise<CliFixture> {
  const root = await mkdtemp(join(tmpdir(), "pss-extension-cli-"));
  const home = join(root, "home");
  const project = join(root, "project");
  const modulePath = join(root, "demo-extension.mjs");
  await mkdir(project, { recursive: true });
  await writeFile(
    modulePath,
    [
      "export default function demo(pss) {",
      '  pss.provide({ kind: "instructions", fragments: ["installed extension"] });',
      "}",
      "",
    ].join("\n"),
    "utf8"
  );
  return { home, modulePath, project, root };
}

async function runCli(
  fixture: CliFixture,
  argv: readonly string[]
): Promise<{ readonly code: number; readonly output: string }> {
  let output = "";
  const code = await runCodingAgentCli({
    argv,
    cwd: fixture.project,
    home: fixture.home,
    stdout: {
      write(text: string): void {
        output += text;
      },
    },
  });
  return { code, output };
}

describe("extension management CLI", () => {
  it("installs and lists a project-local default-export module", async () => {
    // Given
    const fixture = await createCliFixture();

    try {
      // When
      const installed = await runCli(fixture, [
        "extension",
        "install",
        fixture.modulePath,
        "--scope",
        "project",
        "--id",
        "demo",
      ]);
      const listed = await runCli(fixture, ["extension", "list"]);

      // Then
      expect(installed.code).toBe(0);
      expect(installed.output).toContain("installed project demo");
      expect(listed.code).toBe(0);
      expect(listed.output).toContain("project  enabled  demo");
      const settings = JSON.parse(
        await readFile(join(fixture.project, ".pss", "settings.json"), "utf8")
      );
      expect(settings.extensions).toEqual([
        expect.objectContaining({
          enabled: true,
          id: "demo",
          source: fixture.modulePath,
        }),
      ]);
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("disables, enables, and removes an installed extension", async () => {
    // Given
    const fixture = await createCliFixture();

    try {
      await runCli(fixture, [
        "extension",
        "install",
        fixture.modulePath,
        "--id",
        "demo",
      ]);

      // When
      const disabled = await runCli(fixture, ["extension", "disable", "demo"]);
      const enabled = await runCli(fixture, ["extension", "enable", "demo"]);
      const removed = await runCli(fixture, ["extension", "remove", "demo"]);

      // Then
      expect(disabled).toEqual({
        code: 0,
        output: "disabled global demo\n",
      });
      expect(enabled).toEqual({
        code: 0,
        output: "enabled global demo\n",
      });
      expect(removed).toEqual({
        code: 0,
        output: "removed global demo\n",
      });
      const listed = await runCli(fixture, ["extension", "list"]);
      expect(listed.output).toBe("No extensions installed.\n");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("leaves settings absent when module validation fails", async () => {
    // Given
    const fixture = await createCliFixture();
    const invalidModule = join(fixture.root, "invalid.mjs");
    await writeFile(invalidModule, 'export default "invalid";\n', "utf8");

    try {
      // When
      const result = await runCli(fixture, [
        "extension",
        "install",
        invalidModule,
        "--id",
        "invalid",
      ]);

      // Then
      expect(result.code).toBe(1);
      expect(result.output).toContain("default export must be a function");
      await expect(
        access(join(fixture.home, ".pss", "settings.json"))
      ).rejects.toThrow();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("rolls back a package whose default export is invalid", async () => {
    // Given
    const fixture = await createCliFixture();
    const packageRoot = join(fixture.root, "invalid-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        exports: "./index.mjs",
        name: "invalid-package",
        type: "module",
        version: "1.0.0",
      }),
      "utf8"
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      'export default "invalid";\n',
      "utf8"
    );

    try {
      // When
      const result = await runCli(fixture, [
        "extension",
        "install",
        packageRoot,
      ]);

      // Then
      expect(result.code).toBe(1);
      expect(result.output).toContain("default export must be a function");
      await expect(
        access(join(fixture.home, ".pss", "extensions"))
      ).rejects.toThrow();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  }, 30_000);

  it("rejects a project settings symlink without writing global settings", async () => {
    // Given
    const fixture = await createCliFixture();
    await mkdir(join(fixture.home, ".pss"), { recursive: true });
    await symlink(
      join(fixture.home, ".pss"),
      join(fixture.project, ".pss"),
      "dir"
    );

    try {
      // When
      const result = await runCli(fixture, [
        "extension",
        "install",
        fixture.modulePath,
        "--scope",
        "project",
        "--id",
        "symlinked",
      ]);

      // Then
      expect(result.code).toBe(1);
      expect(result.output).toContain("must not be a symbolic link");
      await expect(
        access(join(fixture.home, ".pss", "settings.json"))
      ).rejects.toThrow();
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });

  it("keeps the last valid package bytes when an update is invalid", async () => {
    // Given
    const fixture = await createCliFixture();
    const packageRoot = join(fixture.root, "update-package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        exports: "./index.mjs",
        name: "update-package",
        type: "module",
        version: "1.0.0",
      }),
      "utf8"
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      "export default function validExtension() {}\n",
      "utf8"
    );

    try {
      const installed = await runCli(fixture, [
        "extension",
        "install",
        packageRoot,
      ]);
      expect(installed.code).toBe(0);
      await writeFile(
        join(packageRoot, "index.mjs"),
        'export default "invalid";\n',
        "utf8"
      );

      // When
      const updated = await runCli(fixture, [
        "extension",
        "update",
        "update-package",
      ]);

      // Then
      expect(updated.code).toBe(1);
      expect(updated.output).toContain("default export must be a function");
      await expect(
        readFile(
          join(
            fixture.home,
            ".pss",
            "extensions",
            "node_modules",
            "update-package",
            "index.mjs"
          ),
          "utf8"
        )
      ).resolves.toContain("function validExtension");
    } finally {
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
});
