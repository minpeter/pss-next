import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTuiExtensionReloader } from "./cli";

const STAGED_FAILURE = /Staged extension import failed/;
const INVALID_EXPORT = /default export must be a function/;

let root: string;
let cwd: string;
let home: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-cli-reload-staging-"));
  cwd = join(root, "project");
  home = join(root, "home");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true }),
  ]);
});

afterEach(async () => {
  await rm(root, { force: true, recursive: true });
});

describe("createTuiExtensionReloader", () => {
  it("reloads healthy -e extensions through staging and commit", async () => {
    const extensionPath = join(cwd, "sample.mjs");
    await writeFile(
      extensionPath,
      "export default (pss) => { pss.provide({ kind: 'instructions', fragments: ['hi'] }); };"
    );
    const reload = createTuiExtensionReloader({
      cwd,
      extensionPaths: [extensionPath],
      home,
    });
    const result = await reload();
    expect(result.extensions.map((extension) => extension.id)).toEqual([
      "sample",
    ]);
    result.rollbackModuleCache();
  });

  it("fails a broken candidate at staging time, before the main context imports it", async () => {
    const marker = `pss-reload-staging-main-${Date.now()}`;
    const extensionPath = join(cwd, "broken.mjs");
    await writeFile(
      extensionPath,
      `globalThis[${JSON.stringify(marker)}] = true;\nthrow new Error("broken at import");`
    );
    const reload = createTuiExtensionReloader({
      cwd,
      extensionPaths: [extensionPath],
      home,
    });
    await expect(reload()).rejects.toThrow(STAGED_FAILURE);
    // The staged failure ran only in the worker context: the live module
    // graph never executed the candidate.
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
  });

  it("fails invalid export shapes at staging time", async () => {
    const extensionPath = join(cwd, "invalid.mjs");
    await writeFile(extensionPath, "export default 42;");
    const reload = createTuiExtensionReloader({
      cwd,
      extensionPaths: [extensionPath],
      home,
    });
    await expect(reload()).rejects.toThrow(INVALID_EXPORT);
  });
});
