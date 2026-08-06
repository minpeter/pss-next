import { describe, expect, it } from "vitest";
import {
  readCompatibilityFiles,
  validateCompatibilityManifest,
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
  it("validates the checked-in manifest and pins the v0.83.0 commit", () => {
    const files = readCompatibilityFiles();

    expect(() => validateCompatibilityManifest(files)).not.toThrow();
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
  });

  it("rejects duplicate surface ids", () => {
    const files = readCompatibilityFiles();
    files.manifest.surfaces[1].id = files.manifest.surfaces[0].id;

    expect(() => validateCompatibilityManifest(files)).toThrow(
      "duplicate surface ids"
    );
  });
});
