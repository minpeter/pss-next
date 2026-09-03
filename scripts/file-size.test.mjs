import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const scriptSourceFilePattern = /\.(?:mjs|mts)$/;

const scriptSourceFiles = readdirSync("scripts", { recursive: true })
  .filter((path) => scriptSourceFilePattern.test(path))
  .map((path) => `scripts/${path}`);

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
  it("keeps every script source file below the reviewable pure LOC ceiling", () => {
    for (const path of scriptSourceFiles) {
      expect(pureLineCount(path), path).toBeLessThanOrEqual(250);
    }
  });
});
