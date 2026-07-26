import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseExtensionSource } from "./source";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("extension source parsing", () => {
  it("parses npm and Git package sources", async () => {
    // Given
    const cwd = "/workspace";

    // When
    const npm = await parseExtensionSource("npm:@scope/demo@1.2.3", cwd);
    const git = await parseExtensionSource(
      "git+https://github.com/acme/demo.git#v1",
      cwd
    );

    // Then
    expect(npm).toEqual({
      installSpec: "@scope/demo@1.2.3",
      kind: "package",
      packageName: "@scope/demo",
      requested: "npm:@scope/demo@1.2.3",
      sourceKind: "npm",
    });
    expect(git).toEqual({
      installSpec: "git+https://github.com/acme/demo.git#v1",
      kind: "package",
      requested: "git+https://github.com/acme/demo.git#v1",
      sourceKind: "git",
    });
  });

  it("distinguishes local modules from local packages", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-source-"));
    cleanupRoots.push(root);
    const modulePath = join(root, "extension.mjs");
    const packagePath = join(root, "package");
    await writeFile(modulePath, "export default function () {}\n", "utf8");
    await mkdir(packagePath);
    await writeFile(
      join(packagePath, "package.json"),
      '{"name":"local-extension"}\n',
      "utf8"
    );

    // When
    const moduleSource = await parseExtensionSource("./extension.mjs", root);
    const packageSource = await parseExtensionSource("./package", root);

    // Then
    expect(moduleSource).toEqual({
      kind: "module",
      path: modulePath,
      requested: "./extension.mjs",
    });
    expect(packageSource).toEqual({
      installSpec: packagePath,
      kind: "package",
      packageName: "local-extension",
      requested: "./package",
      sourceKind: "local",
    });
  });

  it("rejects TypeScript modules that Node cannot import directly", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-source-"));
    cleanupRoots.push(root);
    await writeFile(
      join(root, "extension.ts"),
      "export default function () {}\n",
      "utf8"
    );

    // When
    const parsing = parseExtensionSource("./extension.ts", root);

    // Then
    await expect(parsing).rejects.toThrow(
      "Local extension modules must end in .js or .mjs"
    );
  });
});
