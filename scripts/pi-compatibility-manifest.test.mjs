import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverCompatibilityManifestPaths,
  readCompatibilityFiles,
  validateCompatibilityManifest,
  validateCompatibilityManifests,
} from "./validate-pi-compatibility-manifest.mjs";

const UPSTREAM_COMMIT = "845d6ff1f6643aba440341cce877ce1c43ebbc39";
const INTENTIONAL_DIFFERENCES = [
  "intentional-difference:ai-sdk",
  "intentional-difference:durable-execution",
];

function clone(value) {
  return structuredClone(value);
}

describe("Pi compatibility manifest", () => {
  it("validates every checked-in versioned manifest and pins v0.83.0", () => {
    const files = readCompatibilityFiles();

    expect(validateCompatibilityManifests()).toHaveLength(1);
    expect(files.manifest.baseline).toMatchObject({
      release: "v0.83.0",
      commit: UPSTREAM_COMMIT,
    });
    expect(files.manifest.classifications).toBeUndefined();
    expect(files.schema.properties.classifications).toBeUndefined();
    expect(files.schema.$defs.surface.properties.classification.enum).toEqual([
      "native",
      "adapter",
      "planned",
      ...INTENTIONAL_DIFFERENCES,
    ]);
  });

  it("reports invalid schema without a manifest path", () => {
    const files = readCompatibilityFiles();
    files.manifestPath = undefined;
    files.manifest.unexpected = true;

    expect(() => validateCompatibilityManifest(files)).toThrow(
      "Pi compatibility manifest violates its schema"
    );
  });

  it("permits only the two named intentional differences, exactly once", () => {
    const files = readCompatibilityFiles();
    const differences = files.manifest.surfaces
      .map(({ classification }) => classification)
      .filter((classification) => classification.startsWith("intentional-"));

    expect(differences.sort()).toEqual([...INTENTIONAL_DIFFERENCES].sort());

    const extraDifference = clone(files);
    extraDifference.manifest.surfaces[2].classification =
      "intentional-difference:provider-auth";
    expect(() => validateCompatibilityManifest(extraDifference)).toThrow(
      "violates its schema"
    );

    const duplicateDifference = clone(files);
    duplicateDifference.manifest.surfaces[2].classification =
      "intentional-difference:ai-sdk";
    expect(() => validateCompatibilityManifest(duplicateDifference)).toThrow(
      "violates its schema"
    );

    for (const difference of INTENTIONAL_DIFFERENCES) {
      const missingDifference = clone(files);
      missingDifference.manifest.surfaces =
        missingDifference.manifest.surfaces.filter(
          ({ classification }) => classification !== difference
        );
      expect(() => validateCompatibilityManifest(missingDifference)).toThrow(
        "violates its schema"
      );
    }
  });

  it("rejects duplicate surface ids and missing local evidence", () => {
    const duplicate = readCompatibilityFiles();
    duplicate.manifest.surfaces[1].id = duplicate.manifest.surfaces[0].id;
    expect(() => validateCompatibilityManifest(duplicate)).toThrow(
      "duplicate surface ids"
    );

    const missingEvidence = readCompatibilityFiles();
    missingEvidence.manifest.surfaces[0].evidence.local = [
      "does-not-exist/compatibility-evidence.ts",
    ];
    expect(() => validateCompatibilityManifest(missingEvidence)).toThrow(
      "references missing local evidence"
    );
  });

  it("rejects absolute, traversal, and symlink-escaping local evidence", () => {
    for (const path of [
      join(tmpdir(), "absolute-evidence"),
      "../outside-repository",
    ]) {
      const files = readCompatibilityFiles();
      files.manifest.surfaces[0].evidence.local = [path];
      expect(() => validateCompatibilityManifest(files)).toThrow(
        "local evidence escapes repository root"
      );
    }

    const evidenceRoot = mkdtempSync(join(tmpdir(), "pss-evidence-root-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "pss-evidence-outside-"));
    try {
      writeFileSync(join(outsideRoot, "evidence.ts"), "outside");
      symlinkSync(outsideRoot, join(evidenceRoot, "escape"), "dir");
      const files = readCompatibilityFiles();
      files.evidenceRoot = evidenceRoot;
      files.manifest.surfaces[0].evidence.local = ["escape/evidence.ts"];

      expect(() => validateCompatibilityManifest(files)).toThrow(
        "escapes repository root through a symlink"
      );
    } finally {
      rmSync(evidenceRoot, { force: true, recursive: true });
      rmSync(outsideRoot, { force: true, recursive: true });
    }
  });

  it("uses the custom directory default and sorts manifests numerically", () => {
    const directory = mkdtempSync(join(tmpdir(), "pss-pi-discovery-"));
    const files = readCompatibilityFiles();

    try {
      writeFileSync(
        join(directory, "pi-manifest.schema.json"),
        JSON.stringify(files.schema)
      );
      for (const release of ["v10.0.0", "v9.9.9"]) {
        const manifest = clone(files.manifest);
        manifest.baseline.release = release;
        writeFileSync(
          join(directory, `pi-${release}.json`),
          JSON.stringify(manifest)
        );
      }

      expect(
        discoverCompatibilityManifestPaths(directory).map((path) =>
          basename(path)
        )
      ).toEqual(["pi-v9.9.9.json", "pi-v10.0.0.json"]);
      expect(readCompatibilityFiles(undefined, directory).manifestPath).toBe(
        join(directory, "pi-v10.0.0.json")
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("discovers and rejects an invalid additional versioned manifest", () => {
    const directory = mkdtempSync(join(tmpdir(), "pss-pi-compatibility-"));
    const files = readCompatibilityFiles();

    try {
      writeFileSync(
        join(directory, "pi-manifest.schema.json"),
        JSON.stringify(files.schema)
      );
      writeFileSync(
        join(directory, "pi-v0.83.0.json"),
        JSON.stringify(files.manifest)
      );

      const invalid = clone(files.manifest);
      invalid.surfaces[2].classification = "unknown";
      writeFileSync(join(directory, "pi-v9.9.9.json"), JSON.stringify(invalid));

      expect(() => validateCompatibilityManifests(directory)).toThrow(
        "pi-v9.9.9.json violates its schema"
      );

      writeFileSync(
        join(directory, "pi-v9.9.9.json"),
        JSON.stringify(files.manifest)
      );
      expect(() => validateCompatibilityManifests(directory)).toThrow(
        "pi-v9.9.9.json does not match baseline release v0.83.0"
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
