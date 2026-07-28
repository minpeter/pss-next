import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PACKAGES_SECTION_PATTERN =
  /^packages:\n(?<items>(?: {2}-[^\n]*(?:\n|$))*)/;
const QUOTED_VALUE_PATTERN = /^(["'])(.*)\1$/;
const WORKSPACE_LIST_PREFIX_PATTERN = /^\s*-\s*/;

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readPnpmWorkspacePatterns(source) {
  const items = source.match(PACKAGES_SECTION_PATTERN)?.groups?.items;
  if (items === undefined) {
    throw new Error(
      "pnpm-workspace.yaml must declare a top-level packages list"
    );
  }

  return items
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.replace(WORKSPACE_LIST_PREFIX_PATTERN, "").trim())
    .map((value) => value.match(QUOTED_VALUE_PATTERN)?.[2] ?? value);
}

describe("workspace metadata", () => {
  it("keeps package.json and pnpm workspace globs aligned", () => {
    const rootPackageJson = readJson("package.json");
    const pnpmWorkspace = readFileSync("pnpm-workspace.yaml", "utf8");

    expect(rootPackageJson.workspaces).toEqual(
      readPnpmWorkspacePatterns(pnpmWorkspace)
    );
  });

  it("keeps host-provided peers out of package dependency snapshots", () => {
    const pnpmWorkspace = readFileSync("pnpm-workspace.yaml", "utf8");

    expect(pnpmWorkspace).toContain("autoInstallPeers: false");
  });
});
