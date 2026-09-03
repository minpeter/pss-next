import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("release workflow", () => {
  it("versions or publishes main through Tegami", () => {
    const ciWorkflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const workflow = readFileSync(".github/workflows/release.yml", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8"));

    expect(packageJson.scripts.tegami).toBe("node scripts/tegami.mts");
    expect(packageJson.scripts.changeset).toBeUndefined();
    expect(packageJson.scripts["version-packages"]).toBeUndefined();
    expect(packageJson.scripts["release:v0.1"]).toBeUndefined();
    expect(packageJson.devDependencies.tegami).toBe("1.4.0");
    expect(packageJson.devDependencies["@changesets/cli"]).toBeUndefined();
    expect(packageJson.engines.node).toBe(">=24");
    expect(readFileSync(".node-version", "utf8").trim()).toBe("24");
    expect(workflow).toContain("      - main\n");
    expect(workflow).not.toContain("      - v0.1\n");
    expect(workflow).not.toContain("workflow_dispatch:");
    expect(workflow).toContain("fetch-depth: 0");
    expect(ciWorkflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("node-version-file: .node-version");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: pins the literal GitHub Actions matrix expression in ci.yml
    expect(ciWorkflow).toContain("node-version: ${{ matrix.node }}");
    expect(ciWorkflow).toContain('node: ["24", "26"]');
    expect(ciWorkflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("- name: Install sandbox prerequisite");
    expect(workflow).toContain(
      "sudo apt-get install --yes --no-install-recommends bubblewrap procps util-linux"
    );
    expect(workflow).toContain('PSS_TASK_VALIDATOR_NETWORK_ISOLATED: "1"');
    expect(workflow).toContain("pnpm tegami ci");
    expect(workflow).toContain("pnpm verify:release");
    expect(packageJson.scripts["verify:release"]).toContain(
      "pnpm verify:package-apis"
    );
    expect(packageJson.scripts["verify:package-apis"]).toBe(
      "publint packages/runtime && publint apps/coding-agent && publint extensions/latex && publint extensions/mermaid && publint extensions/web && node scripts/packed-consumer-smoke.mjs"
    );
    expect(workflow).not.toContain("Verify coding-agent dependency resolution");
    expect(workflow).not.toContain("NPM_CONFIG_PROVENANCE");
    expect(workflow).not.toContain("changesets/action");
  });
});
