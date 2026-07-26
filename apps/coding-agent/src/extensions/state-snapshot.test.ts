import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { snapshotExtensionState } from "./state-snapshot";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pss-state-snapshot-"));
  cleanupRoots.push(root);
  return root;
}

describe("snapshotExtensionState", () => {
  it("restores files changed after the snapshot", async () => {
    // Given
    const root = await temporaryDirectory();
    const stateRoot = join(root, "extension-state");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "ext.json"), '{"revision":1}');

    // When — the replacement mutates and adds state, then fails.
    const snapshot = await snapshotExtensionState(stateRoot);
    await writeFile(join(stateRoot, "ext.json"), '{"revision":2}');
    await writeFile(join(stateRoot, "new.json"), "{}");
    await snapshot.restore();

    // Then
    await expect(readFile(join(stateRoot, "ext.json"), "utf8")).resolves.toBe(
      '{"revision":1}'
    );
    await expect(
      readFile(join(stateRoot, "new.json"), "utf8")
    ).rejects.toThrow();
  });

  it("removes a state directory that did not exist before", async () => {
    // Given
    const root = await temporaryDirectory();
    const stateRoot = join(root, "extension-state");

    // When
    const snapshot = await snapshotExtensionState(stateRoot);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "ext.json"), "{}");
    await snapshot.restore();

    // Then
    await expect(
      readFile(join(stateRoot, "ext.json"), "utf8")
    ).rejects.toThrow();
  });

  it("discard keeps the current state untouched", async () => {
    // Given
    const root = await temporaryDirectory();
    const stateRoot = join(root, "extension-state");
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "ext.json"), '{"revision":1}');

    // When
    const snapshot = await snapshotExtensionState(stateRoot);
    await writeFile(join(stateRoot, "ext.json"), '{"revision":2}');
    await snapshot.discard();

    // Then
    await expect(readFile(join(stateRoot, "ext.json"), "utf8")).resolves.toBe(
      '{"revision":2}'
    );
  });
});
