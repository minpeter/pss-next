import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { beginCommonJsReloadTransaction } from "./reload-module-graph";

const require = createRequire(import.meta.url);
const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pss-reload-graph-"));
  cleanupRoots.push(root);
  return root;
}

describe("beginCommonJsReloadTransaction", () => {
  it("evicts extension-owned entries and restores them on rollback", async () => {
    // Given
    const root = await temporaryDirectory();
    const helperPath = join(root, "helper.cjs");
    await writeFile(helperPath, 'module.exports = { marker: "one" };\n');
    const original: unknown = require(helperPath);
    expect(require.cache[helperPath]).toBeDefined();

    // When
    const transaction = beginCommonJsReloadTransaction([root]);
    const evicted = require.cache[helperPath];
    await writeFile(helperPath, 'module.exports = { marker: "two" };\n');
    const reloaded: unknown = require(helperPath);
    transaction.rollback();
    const restored: unknown = require(helperPath);

    // Then
    expect(evicted).toBeUndefined();
    expect(reloaded).toMatchObject({ marker: "two" });
    expect(restored).toBe(original);
  });

  it("leaves node_modules entries untouched", async () => {
    // Given
    const root = await temporaryDirectory();
    const dependencyDirectory = join(root, "node_modules", "dep");
    await mkdir(dependencyDirectory, { recursive: true });
    const dependencyPath = join(dependencyDirectory, "index.cjs");
    await writeFile(dependencyPath, 'module.exports = { marker: "dep" };\n');
    const dependency: unknown = require(dependencyPath);

    // When
    beginCommonJsReloadTransaction([root]);

    // Then
    expect(require.cache[dependencyPath]).toBeDefined();
    expect(require(dependencyPath)).toBe(dependency);
  });
});
