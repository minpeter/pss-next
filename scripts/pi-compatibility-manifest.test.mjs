import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
