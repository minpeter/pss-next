import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverLocalExtensions,
  hasLocalExtensionCandidates,
} from "./local-discovery";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pss-local-discovery-"));
  cleanupRoots.push(root);
  return root;
}

describe("local extension discovery", () => {
  it("returns nothing for a missing directory", async () => {
    // Given
    const root = await temporaryDirectory();

    // When
    const discovered = await discoverLocalExtensions(join(root, "missing"));

    // Then
    expect(discovered.candidates).toEqual([]);
    expect(discovered.notices).toEqual([]);
  });

  it("discovers module files and index directories in name order", async () => {
    // Given
    const root = await temporaryDirectory();
    await writeFile(join(root, "beta.mjs"), "export default () => {};");
    await writeFile(join(root, "alpha.ts"), "export default () => {};");
    await mkdir(join(root, "gamma"));
    await writeFile(
      join(root, "gamma", "index.ts"),
      "export default () => {};"
    );
    await writeFile(join(root, "notes.txt"), "not a module");

    // When
    const discovered = await discoverLocalExtensions(root);

    // Then
    expect(discovered.candidates).toEqual([
      { id: "alpha", path: join(root, "alpha.ts") },
      { id: "beta", path: join(root, "beta.mjs") },
      { id: "gamma", path: join(root, "gamma", "index.ts") },
    ]);
    expect(discovered.notices).toEqual([]);
  });

  it("ignores managed install metadata and dotfiles", async () => {
    // Given
    const root = await temporaryDirectory();
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "pkg", "index.js"),
      "export default () => {};"
    );
    await writeFile(join(root, "package.json"), "{}");
    await writeFile(join(root, "package-lock.json"), "{}");
    await writeFile(join(root, ".hidden.ts"), "export default () => {};");

    // When
    const discovered = await discoverLocalExtensions(root);

    // Then
    expect(discovered.candidates).toEqual([]);
    expect(discovered.notices).toEqual([]);
  });

  it("skips symbolic links and invalid names with notices", async () => {
    // Given
    const root = await temporaryDirectory();
    const outside = join(root, "outside.mjs");
    await writeFile(outside, "export default () => {};");
    const extensionsDirectory = join(root, "extensions");
    await mkdir(extensionsDirectory);
    await symlink(outside, join(extensionsDirectory, "linked.mjs"));
    await writeFile(
      join(extensionsDirectory, "Bad Name.ts"),
      "export default () => {};"
    );

    // When
    const discovered = await discoverLocalExtensions(extensionsDirectory);

    // Then
    expect(discovered.candidates).toEqual([]);
    expect(discovered.notices).toHaveLength(2);
    const combined = discovered.notices.join("\n");
    expect(combined).toContain("symbolic links");
    expect(combined).toContain("Bad Name.ts");
  });

  it("skips directories without an index module", async () => {
    // Given
    const root = await temporaryDirectory();
    await mkdir(join(root, "helpers"));
    await writeFile(join(root, "helpers", "util.ts"), "export const x = 1;");

    // When
    const discovered = await discoverLocalExtensions(root);

    // Then
    expect(discovered.candidates).toEqual([]);
  });
});

describe("hasLocalExtensionCandidates", () => {
  it("reports false for empty or missing directories", async () => {
    // Given
    const root = await temporaryDirectory();

    // When / Then
    expect(await hasLocalExtensionCandidates(join(root, "missing"))).toBe(
      false
    );
    expect(await hasLocalExtensionCandidates(root)).toBe(false);
  });

  it("reports true when a loose module exists", async () => {
    // Given
    const root = await temporaryDirectory();
    await writeFile(join(root, "guard.ts"), "export default () => {};");

    // When / Then
    expect(await hasLocalExtensionCandidates(root)).toBe(true);
  });

  it("reports true when only skipped entries exist", async () => {
    // Given
    const root = await temporaryDirectory();
    await writeFile(join(root, "Bad Name.ts"), "export default () => {};");

    // When / Then
    expect(await hasLocalExtensionCandidates(root)).toBe(true);
  });
});
