import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { diffPublicApi } from "./runtime-public-api-snapshot.mjs";

describe("runtime public API snapshot", () => {
  it("reports additions, removals, and entrypoint changes", () => {
    const expected = {
      surfaces: {
        ".": ["type Agent", "value createAgent"],
        "./old": ["value oldApi"],
      },
    };
    const actual = {
      surfaces: {
        ".": ["type Agent", "value openAgent"],
        "./new": ["type NewApi"],
      },
    };

    expect(diffPublicApi(expected, actual)).toEqual([
      "- .: value createAgent",
      "+ .: value openAgent",
      "+ ./new: type NewApi",
      "- ./old: value oldApi",
    ]);
  });

  it("tracks every package export entrypoint", () => {
    const manifest = JSON.parse(
      readFileSync("packages/runtime/package.json", "utf8")
    );
    const snapshot = JSON.parse(
      readFileSync("packages/runtime/public-api.snapshot.json", "utf8")
    );

    expect(Object.keys(snapshot.surfaces).sort()).toEqual(
      Object.keys(manifest.exports).sort()
    );
  });
});
