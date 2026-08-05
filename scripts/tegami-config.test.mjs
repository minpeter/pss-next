import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const releaseIgnoreBlockPattern = /const releaseIgnore = \[([\s\S]*?)\];/;
const quotedListItemPattern = /^\s+"([^"]+)",$/gm;
const workspaceRoots = [
  "apps",
  "packages",
  "examples",
  "experimental",
  "extensions",
];

function readWorkspaceManifests() {
  const paths = [
    "package.json",
    ...workspaceRoots.flatMap((root) =>
      readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${root}/${entry.name}/package.json`)
        .filter(existsSync)
    ),
  ];

  return paths.map((path) => ({
    manifest: JSON.parse(readFileSync(path, "utf8")),
    path,
  }));
}

function readReleaseIgnore(script) {
  const block = script.match(releaseIgnoreBlockPattern)?.[1];
  expect(block).toBeDefined();

  return new Set(
    [...block.matchAll(quotedListItemPattern)].map((match) => match[1])
  );
}

describe("Tegami release configuration", () => {
  it("targets the repository's next prerelease lane", () => {
    const script = readFileSync("scripts/tegami.mts", "utf8");

    expect(script).toContain('from "tegami"');
    expect(script).toContain('from "tegami/cli"');
    expect(script).toContain('from "tegami/plugins/github"');
    expect(script).toContain('client: "pnpm"');
    expect(script).toContain('repo: "minpeter/pss-runtime"');
    expect(script).toContain('base: "main"');
    expect(script).toContain('workflow: "release.yml"');
    expect(script.match(/prerelease: "next"/g)).toHaveLength(2);
    expect(script.match(/distTag: "next"/g)).toHaveLength(2);
    expect(script).toContain('"@minpeter/pss-runtime"');
    expect(script).toContain('"@minpeter/pss-coding-agent"');
  });

  it("excludes every private and experimental workspace from the graph", () => {
    const script = readFileSync("scripts/tegami.mts", "utf8");
    const ignored = readReleaseIgnore(script);
    const expected = readWorkspaceManifests()
      .filter(
        ({ manifest, path }) =>
          manifest.private === true || path.startsWith("experimental/")
      )
      .map(({ manifest }) => manifest.name);

    expect(ignored).toEqual(new Set(expected));
  });

  it("keeps every public app and package in release planning", () => {
    const script = readFileSync("scripts/tegami.mts", "utf8");
    const ignored = readReleaseIgnore(script);
    const publicAppsAndPackages = readWorkspaceManifests().filter(
      ({ manifest, path }) =>
        (path.startsWith("apps/") || path.startsWith("packages/")) &&
        manifest.private !== true
    );

    expect(publicAppsAndPackages.map(({ manifest }) => manifest.name)).toEqual(
      expect.arrayContaining([
        "@minpeter/pss-coding-agent",
        "@minpeter/pss-runtime",
      ])
    );
    for (const { manifest } of publicAppsAndPackages) {
      expect(ignored.has(manifest.name)).toBe(false);
    }
  });

  it("does not propagate dependency bumps into excluded workspaces", () => {
    const script = readFileSync("scripts/tegami.mts", "utf8");

    expect(script).toContain("releaseIgnore.includes(dependent.name)");
    expect(script).toContain('case "dependencies":');
    expect(script).toContain('case "optionalDependencies":');
    expect(script).toContain('case "devDependencies":');
    expect(script).toContain('case "peerDependencies":');
  });

  it("removes Changesets release state", () => {
    expect(existsSync(".changeset/config.json")).toBe(false);
  });

  it("publishes package metadata from the current repository", () => {
    for (const path of [
      "packages/runtime/package.json",
      "apps/coding-agent/package.json",
      "extensions/latex/package.json",
      "extensions/mermaid/package.json",
      "extensions/web/package.json",
    ]) {
      const manifest = JSON.parse(readFileSync(path, "utf8"));

      expect(manifest.repository.url).toBe(
        "git+https://github.com/minpeter/pss-runtime.git"
      );
    }
  });
});
