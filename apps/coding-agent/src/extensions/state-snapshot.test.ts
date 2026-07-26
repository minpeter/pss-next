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

async function temporaryStateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pss-state-snapshot-"));
  cleanupRoots.push(root);
  const stateRoot = join(root, "extension-state");
  await mkdir(stateRoot, { recursive: true });
  return stateRoot;
}

describe("snapshotExtensionState", () => {
  it("restores only the listed extensions' files", async () => {
    // Given
    const stateRoot = await temporaryStateRoot();
    await writeFile(join(stateRoot, "guard.json"), '{"revision":1}');
    await writeFile(join(stateRoot, "other.json"), '{"foreign":1}');

    // When — the replacement mutates listed and unrelated state, then fails.
    const snapshot = await snapshotExtensionState(
      ["guard", "fresh"],
      stateRoot
    );
    await writeFile(join(stateRoot, "guard.json"), '{"revision":2}');
    await writeFile(join(stateRoot, "fresh.json"), "{}");
    await writeFile(join(stateRoot, "other.json"), '{"foreign":2}');
    await snapshot.restore();

    // Then — listed files roll back, unrelated files keep their new value.
    await expect(readFile(join(stateRoot, "guard.json"), "utf8")).resolves.toBe(
      '{"revision":1}'
    );
    await expect(
      readFile(join(stateRoot, "fresh.json"), "utf8")
    ).rejects.toThrow();
    await expect(readFile(join(stateRoot, "other.json"), "utf8")).resolves.toBe(
      '{"foreign":2}'
    );
  });

  it("handles missing state files and directories", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-state-snapshot-"));
    cleanupRoots.push(root);
    const stateRoot = join(root, "missing-state");

    // When — the state root does not exist yet.
    const snapshot = await snapshotExtensionState(["guard"], stateRoot);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "guard.json"), "{}");
    await snapshot.restore();

    // Then
    await expect(
      readFile(join(stateRoot, "guard.json"), "utf8")
    ).rejects.toThrow();
  });

  it("discard keeps the current state untouched", async () => {
    // Given
    const stateRoot = await temporaryStateRoot();
    await writeFile(join(stateRoot, "guard.json"), '{"revision":1}');

    // When
    const snapshot = await snapshotExtensionState(["guard"], stateRoot);
    await writeFile(join(stateRoot, "guard.json"), '{"revision":2}');
    await snapshot.discard();

    // Then
    await expect(readFile(join(stateRoot, "guard.json"), "utf8")).resolves.toBe(
      '{"revision":2}'
    );
  });
});
