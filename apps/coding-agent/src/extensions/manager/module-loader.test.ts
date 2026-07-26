import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensionTarget } from "./module-loader";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("managed package module loading", () => {
  it("loads an ESM package that exposes only the import condition", async () => {
    // Given
    const installRoot = await mkdtemp(
      join(tmpdir(), "pss-extension-import-only-")
    );
    cleanupRoots.push(installRoot);
    const packageRoot = join(installRoot, "node_modules", "import-only");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(installRoot, "package.json"),
      '{"private":true,"type":"module"}\n',
      "utf8"
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        exports: { ".": { import: "./index.mjs" } },
        name: "import-only",
        type: "module",
        version: "1.0.0",
      }),
      "utf8"
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      "export default function extension() {}\n",
      "utf8"
    );

    // When
    const extension = await loadExtensionTarget({
      id: "import-only",
      installRoot,
      target: { kind: "package", packageName: "import-only" },
    });

    // Then
    expect(extension.id).toBe("import-only");
    expect(extension).toHaveProperty("default");
  });

  it("loads an ESM package with a bare main entry path", async () => {
    // Given
    const installRoot = await mkdtemp(
      join(tmpdir(), "pss-extension-main-entry-")
    );
    cleanupRoots.push(installRoot);
    const packageRoot = join(installRoot, "node_modules", "main-entry");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(installRoot, "package.json"),
      '{"private":true,"type":"module"}\n',
      "utf8"
    );
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        main: "index.mjs",
        name: "main-entry",
        type: "module",
        version: "1.0.0",
      }),
      "utf8"
    );
    await writeFile(
      join(packageRoot, "index.mjs"),
      "export default function extension() {}\n",
      "utf8"
    );

    // When
    const extension = await loadExtensionTarget({
      id: "main-entry",
      installRoot,
      target: { kind: "package", packageName: "main-entry" },
    });

    // Then
    expect(extension.id).toBe("main-entry");
    expect(extension).toHaveProperty("default");
  });

  it("applies installed configuration to static object extensions", async () => {
    const staticExtension = {
      configure: () => undefined,
      config: { moduleDefault: true },
      id: "static-extension",
    };

    const extension = await loadExtensionTarget({
      config: { installed: true },
      id: "static-extension",
      importer: async () => ({ default: staticExtension }),
      installRoot: process.cwd(),
      target: { kind: "module", path: "fixture.mjs" },
    });

    expect(extension).toMatchObject({
      config: { installed: true, moduleDefault: true },
      id: "static-extension",
    });
  });
});
