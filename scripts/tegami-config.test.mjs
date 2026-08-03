import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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
    expect(script.match(/prerelease: "next"/g)).toHaveLength(4);
    expect(script.match(/distTag: "next"/g)).toHaveLength(4);
    expect(script).toContain('"@minpeter/pss-runtime"');
    expect(script).toContain('"@minpeter/pss-coding-agent"');
    expect(script).toContain('"@minpeter/pss-extension-latex"');
    expect(script).toContain('"@minpeter/pss-extension-web"');
  });

  it("excludes every private workspace from release planning", () => {
    const script = readFileSync("scripts/tegami.mts", "utf8");

    expect(script).toContain('"pss-next"');
    expect(script).toContain('"@minpeter/pss-worker-agent"');
    expect(script).toContain('"@minpeter/pss-runtime-edge-image-qa"');
    expect(script).toContain("/^@minpeter\\/pss-example-/");
  });

  it("removes Changesets release state", () => {
    expect(existsSync(".changeset/config.json")).toBe(false);
  });

  it("publishes package metadata from the current repository", () => {
    for (const path of [
      "packages/runtime/package.json",
      "apps/coding-agent/package.json",
      "extensions/latex/package.json",
      "extensions/web/package.json",
    ]) {
      const manifest = JSON.parse(readFileSync(path, "utf8"));

      expect(manifest.repository.url).toBe(
        "git+https://github.com/minpeter/pss-runtime.git"
      );
    }
  });
});
