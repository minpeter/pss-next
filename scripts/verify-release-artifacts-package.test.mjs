import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isMainModule,
  verifyReleaseArtifacts,
} from "./verify-release-artifacts/core.mjs";
import {
  cleanupFixtures,
  cliBinReadFailurePattern,
  createFixture,
  createTrackedTempRoot,
} from "./verify-release-artifacts.fixture.mjs";

afterEach(cleanupFixtures);

describe("verifyReleaseArtifacts package checks", () => {
  it("passes when package dist outputs contain publish-safe ESM artifacts", () => {
    const cwd = createFixture();

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([]);
  });

  it("passes for independently published extension packages", () => {
    const cwd = createFixture();

    expect(
      verifyReleaseArtifacts({
        cwd,
        packages: ["extension-latex"],
      })
    ).toEqual([]);
  });

  it("resolves the LaTeX extension from the extensions workspace", () => {
    const cwd = createFixture();
    rmSync(resolve(cwd, "extensions/latex/dist"), {
      force: true,
      recursive: true,
    });

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["extension-latex"] })
    ).toEqual([
      "extensions/latex/dist is missing; run the package build first",
    ]);
  });

  it("requires runtime-spawned extension workers in the coding-agent bundle", () => {
    const cwd = createFixture();
    rmSync(
      resolve(
        cwd,
        "apps/coding-agent/dist/extensions/mermaid/dist/mermaid-art-worker.js"
      )
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      [
        "apps/coding-agent/dist/extensions/mermaid/dist/mermaid-art-worker.js is missing; runtime-spawned extension workers must be copied into the bundle",
      ]
    );
  });

  it("rejects private extension imports leaking into the coding-agent bundle", () => {
    const cwd = createFixture();
    writeFileSync(
      resolve(cwd, "apps/coding-agent/dist/leaky.js"),
      'import createLatex from "@minpeter/pss-extension-latex";\nexport default createLatex;\n'
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      [
        "apps/coding-agent/dist/leaky.js imports a private extension package; built-in extensions must be inlined via tsdown deps.alwaysBundle",
      ]
    );
  });

  it("rejects extensionless relative imports that would break Node ESM", () => {
    const cwd = createFixture();
    writeFileSync(
      resolve(cwd, "packages/runtime/dist/helper.js"),
      "export const helper = true;\n"
    );
    writeFileSync(
      resolve(cwd, "packages/runtime/dist/index.js"),
      'import "./helper";\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/index.js: extensionless relative import ./helper",
    ]);
  });

  it("rejects extensionless dynamic imports that would break Node ESM", () => {
    const cwd = createFixture();
    writeFileSync(
      resolve(cwd, "apps/coding-agent/dist/chunk.js"),
      "export const chunk = true;\n"
    );
    writeFileSync(
      resolve(cwd, "apps/coding-agent/dist/index.js"),
      'export async function loadChunk() { return import("./chunk"); }\n'
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "apps/coding-agent/dist/index.js: extensionless relative import ./chunk",
    ]);
  });

  it("rejects test and fixture files from package dist outputs", () => {
    const cwd = createFixture();
    writeFileSync(
      resolve(cwd, "apps/coding-agent/dist/web-fetch.test.js"),
      "export {};\n"
    );
    writeFileSync(
      resolve(cwd, "packages/runtime/dist/test-fixtures.d.ts"),
      "export {};\n"
    );

    expect(
      verifyReleaseArtifacts({ cwd, packages: ["runtime", "coding-agent"] })
    ).toEqual([
      "packages/runtime/dist/test-fixtures.d.ts: test or fixture artifact must not be published",
      "apps/coding-agent/dist/web-fetch.test.js: test or fixture artifact must not be published",
    ]);
  });

  it("rejects missing CLI bin metadata for the coding-agent package", () => {
    const cwd = createFixture();
    writeFileSync(
      resolve(cwd, "apps/coding-agent/package.json"),
      JSON.stringify({ bin: { pss: "./bin/pss.js" } })
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      [
        "apps/coding-agent/package.json: bin.pss-coding-agent must target ./bin/pss.js",
      ]
    );
  });

  it("rejects CLI bin targets without a shebang", () => {
    const cwd = createFixture();
    writeFileSync(
      resolve(cwd, "apps/coding-agent/bin/pss.js"),
      "import '../dist/tui.js';\n"
    );

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      ["apps/coding-agent/bin/pss.js: CLI bin target must start with a shebang"]
    );
  });

  it("rejects CLI bin targets without executable mode", () => {
    const cwd = createFixture();
    const binPath = resolve(cwd, "apps/coding-agent/bin/pss.js");
    writeFileSync(binPath, "#!/usr/bin/env node\nimport '../dist/tui.js';\n");
    chmodSync(binPath, 0o644);

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      ["apps/coding-agent/bin/pss.js: CLI bin target must be executable"]
    );
  });

  it("skips CLI bin executable mode checks on Windows", () => {
    const cwd = createFixture();
    const binPath = resolve(cwd, "apps/coding-agent/bin/pss.js");
    writeFileSync(binPath, "#!/usr/bin/env node\nimport '../dist/tui.js';\n");
    chmodSync(binPath, 0o644);

    expect(
      verifyReleaseArtifacts({
        cwd,
        packages: ["coding-agent"],
        platform: "win32",
      })
    ).toEqual([]);
  });

  it("reports CLI bin target read failures instead of throwing", () => {
    const cwd = createFixture();
    const binPath = resolve(cwd, "apps/coding-agent/bin/pss.js");
    rmSync(binPath);
    mkdirSync(binPath);

    expect(verifyReleaseArtifacts({ cwd, packages: ["coding-agent"] })).toEqual(
      [expect.stringMatching(cliBinReadFailurePattern)]
    );
  });

  it("detects script entrypoints with encoded file URLs", () => {
    const cwd = createTrackedTempRoot("pss-script path-");
    const scriptPath = resolve(cwd, "verify script.mjs");

    expect(isMainModule(pathToFileURL(scriptPath).href, scriptPath)).toBe(true);
    expect(
      isMainModule(pathToFileURL(scriptPath).href, `${scriptPath}.bak`)
    ).toBe(false);
  });
});
