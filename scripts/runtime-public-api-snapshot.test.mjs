import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  declarationExportsFromText,
  diffPublicApi,
} from "./runtime-public-api-snapshot.mjs";

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
  it("parses aliases and type-only exports without matching comments", () => {
    const declaration = `
      /** export { Phantom } */
      export type { SourceType as TypeAlias } from "./types.js";
      export { type OtherType as InlineType, runtime as renamedRuntime } from "./values.js";
      export interface DirectType { readonly value: string }
      export declare const directValue: string;
    `;

    expect(declarationExportsFromText(declaration, "fixture.d.ts")).toEqual([
      "type DirectType",
      "type InlineType",
      "type TypeAlias",
      "value directValue",
      "value renamedRuntime",
    ]);
  });

  it("rejects default and export-star surfaces explicitly", () => {
    expect(() =>
      declarationExportsFromText("export default class PublicApi {}")
    ).toThrow("default exports are not supported");
    expect(() =>
      declarationExportsFromText('export * from "./internal.js";')
    ).toThrow("export star declarations are not supported");
    expect(() =>
      declarationExportsFromText('export * as internal from "./internal.js";')
    ).toThrow("ExportNamespaceSpecifier declarations are not supported");
  });
});
