import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { loadExtensionTarget } from "./module-loader";

const execFileAsync = promisify(execFile);

const cleanupRoots: string[] = [];
const restartRequiredPattern = /requires a restart.*CommonJS/u;

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

  // Runs in a child Node process because module customization hooks do not
  // intercept imports issued through vitest's own module runner.
  it("requires a restart instead of mutating cached commonjs helpers", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-module-loader-"));
    cleanupRoots.push(root);
    const helperPath = join(root, "helper.cjs");
    const entryPath = join(root, "entry.mjs");
    await writeFile(helperPath, 'module.exports = { marker: "one" };\n');
    await writeFile(
      entryPath,
      [
        'import helper from "./helper.cjs";',
        "export default function extension() {}",
        "extension.marker = helper.marker;",
        "",
      ].join("\n")
    );
    const script = [
      `import { ensureReloadModuleGraphHooks, beginCommonJsReloadTransaction } from ${JSON.stringify(
        new URL("./reload-module-graph.ts", import.meta.url).href
      )};`,
      'import { writeFile } from "node:fs/promises";',
      'import { pathToFileURL } from "node:url";',
      "ensureReloadModuleGraphHooks();",
      `const root = ${JSON.stringify(root)};`,
      `const entryPath = ${JSON.stringify(entryPath)};`,
      `const helperPath = ${JSON.stringify(helperPath)};`,
      "const importBusted = async (cacheBust) => {",
      "  beginCommonJsReloadTransaction([root]);",
      "  const url = pathToFileURL(entryPath);",
      "  url.searchParams.set('pss-extension-update', cacheBust);",
      "  return await import(url.href);",
      "};",
      "const first = await importBusted('1');",
      "await writeFile(helperPath, 'module.exports = { marker: \"two\" };\\n');",
      "const second = await importBusted('2');",
      "console.log(JSON.stringify({ first: first.default.marker, second: second.default.marker }));",
    ].join("\n");

    // When
    const reload = execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 30_000 }
    );

    // Then
    await expect(reload).rejects.toThrow(restartRequiredPattern);
  });

  it("reloads transitive helper modules when cache busting", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-module-loader-"));
    cleanupRoots.push(root);
    const helperPath = join(root, "helper.mjs");
    const entryPath = join(root, "entry.mjs");
    await writeFile(helperPath, 'export const marker = "one";\n', "utf8");
    await writeFile(
      entryPath,
      [
        'import { marker } from "./helper.mjs";',
        "export default function extension() {}",
        "extension.marker = marker;",
        "",
      ].join("\n"),
      "utf8"
    );
    const script = [
      `import { ensureReloadModuleGraphHooks } from ${JSON.stringify(
        new URL("./reload-module-graph.ts", import.meta.url).href
      )};`,
      'import { writeFile } from "node:fs/promises";',
      'import { pathToFileURL } from "node:url";',
      "ensureReloadModuleGraphHooks();",
      `const entryPath = ${JSON.stringify(entryPath)};`,
      `const helperPath = ${JSON.stringify(helperPath)};`,
      "const importBusted = async (cacheBust) => {",
      "  const url = pathToFileURL(entryPath);",
      "  url.searchParams.set('pss-extension-update', cacheBust);",
      "  return await import(url.href);",
      "};",
      "const first = await importBusted('1');",
      "await writeFile(helperPath, 'export const marker = \"two\";\\n');",
      "const second = await importBusted('2');",
      "console.log(JSON.stringify({ first: first.default.marker, second: second.default.marker }));",
    ].join("\n");

    // When
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 30_000 }
    );

    // Then
    expect(JSON.parse(stdout.trim())).toEqual({
      first: "one",
      second: "two",
    });
  });
});
