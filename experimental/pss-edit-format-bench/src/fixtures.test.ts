import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  assertDeterministicFixtureManifest,
  generateFixtureManifest,
  listFixtureTasks,
  loadFixtureCorpus,
  writeFixtureCorpus,
} from "./fixtures";

const temporaryDirectory = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "pss-fixtures-test-"));
  onTestFinished(() => rm(root, { force: true, recursive: true }));
  return root;
};

describe("seeded fixture corpus", () => {
  it("produces identical manifests for the same seed", () => {
    const first = generateFixtureManifest(42, 6);
    const second = generateFixtureManifest(42, 6);

    expect(second).toEqual(first);
    expect(first.tasks.map((task) => task.metadata.difficulty)).toEqual([
      "easy",
      "medium",
      "hard",
      "easy",
      "medium",
      "hard",
    ]);
  });

  it("changes generated fixtures when the seed changes", () => {
    const first = generateFixtureManifest(42, 3);
    const second = generateFixtureManifest(43, 3);

    expect(second).not.toEqual(first);
  });

  it("generates a hard fixture with an unchanged support file", () => {
    const manifest = generateFixtureManifest(42, 3);
    const hard = manifest.tasks[2];
    if (hard === undefined) {
      throw new Error("hard fixture missing");
    }

    expect(Object.keys(hard.initialFiles).sort()).toEqual([
      "src/fixture.rs",
      "src/support.rs",
    ]);
    expect(Object.keys(hard.expectedFiles).sort()).toEqual([
      "src/fixture.rs",
      "src/support.rs",
    ]);
    expect(hard.expectedFiles["src/support.rs"]).toBe(
      hard.initialFiles["src/support.rs"]
    );
  });

  it("rejects a corpus that differs from deterministic seed regeneration", () => {
    const manifest = generateFixtureManifest(42, 3);
    const first = manifest.tasks[0];
    if (first === undefined) {
      throw new Error("generated fixture missing");
    }
    const tampered = {
      ...manifest,
      tasks: [
        { ...first, instruction: `${first.instruction} tampered` },
        ...manifest.tasks.slice(1),
      ],
    };

    expect(() => assertDeterministicFixtureManifest(manifest)).not.toThrow();
    expect(() => assertDeterministicFixtureManifest(tampered)).toThrow(
      "fixture corpus does not match deterministic seed=42 count=3"
    );
  });

  it("round-trips input expected prompt and metadata files", async () => {
    const root = await temporaryDirectory();
    const manifest = generateFixtureManifest(42, 3);

    await writeFixtureCorpus(root, manifest);
    const loaded = await loadFixtureCorpus(root);

    expect(loaded).toEqual(manifest);
    await expect(
      readFile(join(root, "tasks", "seed-42-000", "prompt.txt"), "utf8")
    ).resolves.toBe(manifest.tasks[0]?.instruction);
  });

  it("rejects a malformed persisted fixture and lists valid metadata", async () => {
    const root = await temporaryDirectory();
    const manifest = generateFixtureManifest(42, 3);
    await writeFixtureCorpus(root, manifest);
    await writeFile(
      join(root, "tasks", "seed-42-000", "task.json"),
      '{"id":"seed-42-000"}\n',
      "utf8"
    );

    await expect(loadFixtureCorpus(root)).rejects.toThrow(
      "invalid fixture task seed-42-000"
    );
    expect(listFixtureTasks(manifest)).toEqual([
      "seed-42-000 typescript/easy replace-line score=1",
      "seed-42-001 python/medium replace-line score=2",
      "seed-42-002 rust/hard replace-line score=3",
    ]);
  });
});
