import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sourceFilesWithCurrentEdits = [
  "scripts/cloudflare-example.test.mjs",
  "scripts/examples.fixture.mjs",
  "scripts/examples.test.mjs",
  "scripts/file-size.test.mjs",
  "scripts/release-workflow.test.mjs",
  "scripts/verify-release-artifacts.mjs",
  "scripts/verify-release-artifacts.fixture.mjs",
  "scripts/verify-release-artifacts/core.mjs",
  "scripts/verify-release-artifacts/package-checks.mjs",
  "scripts/verify-release-artifacts/runtime-checks.mjs",
  "scripts/verify-release-artifacts/runtime-public-surface.mjs",
  "scripts/verify-release-artifacts/shared.mjs",
  "scripts/verify-release-artifacts-package.test.mjs",
  "scripts/verify-release-artifacts-runtime.test.mjs",
  "scripts/verify-release-artifacts-runtime-subpaths.test.mjs",
];

function pureLineCount(path) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("#")
      );
    }).length;
}

describe("source file size", () => {
  it("keeps changed script files below the reviewable pure LOC ceiling", () => {
    for (const path of sourceFilesWithCurrentEdits) {
      expect(pureLineCount(path), path).toBeLessThanOrEqual(250);
    }
  });
});
