import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DECLARATION_EXPORT_PATTERN = /^\.\/dist\/.+\.d\.ts$/;
const JAVASCRIPT_EXPORT_PATTERN = /^\.\/dist\/.+\.js$/;
const SOURCE_CONDITION = "@minpeter/pss-source";
const packageDirectories = [
  "apps/coding-agent",
  "extensions/latex",
  "extensions/mermaid",
  "extensions/web",
  "packages/runtime",
];

function readPackage(directory) {
  return JSON.parse(readFileSync(`${directory}/package.json`, "utf8"));
}

describe("workspace source export condition", () => {
  it("precedes the TypeScript types condition in every source-enabled export", () => {
    for (const directory of packageDirectories) {
      const packageJson = readPackage(directory);
      for (const [subpath, conditions] of Object.entries(packageJson.exports)) {
        expect(
          Object.keys(conditions)[0],
          `${packageJson.name}${subpath}`
        ).toBe(SOURCE_CONDITION);
      }
    }
  });

  it("preserves declaration and JavaScript fallbacks for published consumers", () => {
    for (const directory of packageDirectories) {
      const packageJson = readPackage(directory);
      for (const [subpath, conditions] of Object.entries(packageJson.exports)) {
        expect(
          Object.keys(conditions).indexOf("types"),
          `${packageJson.name}${subpath}`
        ).toBeLessThan(Object.keys(conditions).indexOf("import"));
        expect(conditions.types).toMatch(DECLARATION_EXPORT_PATTERN);
        expect(conditions.import).toMatch(JAVASCRIPT_EXPORT_PATTERN);
      }
    }
  });
});
