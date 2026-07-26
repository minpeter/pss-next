import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodingAgentExtensionInput } from "../types";
import { loadCliExtensions, mergeCliExtensions } from "./cli-extensions";

const pathNotFoundPattern = /--extension path not found/u;
const moduleKindPattern = /must be a \.ts, \.mts, \.js, or \.mjs module/u;
const noIndexPattern = /has no index module/u;
const invalidIdPattern = /not a valid extension id/u;
const duplicateIdPattern = /Duplicate --extension id "dup"/u;

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pss-cli-extensions-"));
  cleanupRoots.push(root);
  return root;
}

describe("loadCliExtensions", () => {
  it("loads a TypeScript module file with an id from its file name", async () => {
    // Given
    const root = await temporaryDirectory();
    const modulePath = join(root, "review-guard.ts");
    await writeFile(
      modulePath,
      [
        "interface Marker { readonly loaded: boolean }",
        "const marker: Marker = { loaded: true };",
        "export default function reviewGuard(): void {",
        "  void marker;",
        "}",
        "",
      ].join("\n")
    );

    // When
    const extensions = await loadCliExtensions({
      cwd: root,
      paths: ["./review-guard.ts"],
    });

    // Then
    expect(extensions).toHaveLength(1);
    expect(extensions[0]?.id).toBe("review-guard");
  });

  it("loads a directory extension through its index module", async () => {
    // Given
    const root = await temporaryDirectory();
    await mkdir(join(root, "checkpoint"));
    await writeFile(
      join(root, "checkpoint", "index.mjs"),
      "export default function checkpoint() {}\n"
    );

    // When
    const extensions = await loadCliExtensions({
      cwd: root,
      paths: ["checkpoint"],
    });

    // Then
    expect(extensions.map((extension) => extension.id)).toEqual(["checkpoint"]);
  });

  it("rejects missing paths, non-module files, and empty directories", async () => {
    // Given
    const root = await temporaryDirectory();
    await writeFile(join(root, "notes.txt"), "hello");
    await mkdir(join(root, "empty"));

    // When / Then
    await expect(
      loadCliExtensions({ cwd: root, paths: ["missing.ts"] })
    ).rejects.toThrow(pathNotFoundPattern);
    await expect(
      loadCliExtensions({ cwd: root, paths: ["notes.txt"] })
    ).rejects.toThrow(moduleKindPattern);
    await expect(
      loadCliExtensions({ cwd: root, paths: ["empty"] })
    ).rejects.toThrow(noIndexPattern);
  });

  it("rejects invalid ids and duplicate ids", async () => {
    // Given
    const root = await temporaryDirectory();
    await writeFile(join(root, "Bad Name.mjs"), "export default () => {};");
    await writeFile(join(root, "dup.mjs"), "export default () => {};");
    await mkdir(join(root, "nested"));
    await writeFile(
      join(root, "nested", "dup.mjs"),
      "export default () => {};"
    );

    // When / Then
    await expect(
      loadCliExtensions({ cwd: root, paths: ["Bad Name.mjs"] })
    ).rejects.toThrow(invalidIdPattern);
    await expect(
      loadCliExtensions({ cwd: root, paths: ["dup.mjs", "nested/dup.mjs"] })
    ).rejects.toThrow(duplicateIdPattern);
  });
});

describe("mergeCliExtensions", () => {
  it("replaces configured extensions that share a CLI extension id", () => {
    // Given
    const configured: CodingAgentExtensionInput[] = [
      { default: () => undefined, id: "keep" },
      { default: () => undefined, id: "replaced" },
    ];
    const cli: CodingAgentExtensionInput[] = [
      { default: () => undefined, id: "replaced" },
    ];

    // When
    const merged = mergeCliExtensions(configured, cli);

    // Then
    expect(merged.map((extension) => extension.id)).toEqual([
      "keep",
      "replaced",
    ]);
    expect(merged[1]).toBe(cli[0]);
  });
});
