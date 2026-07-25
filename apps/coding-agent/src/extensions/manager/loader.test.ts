import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfiguredCodingAgentExtensions } from "./loader";
import { extensionScopePaths, extensionTrustPath } from "./paths";
import { writeExtensionSettings, writeTrustedProjects } from "./settings";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("configured extension loading", () => {
  it("loads global then trusted project factories and skips disabled entries", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-loader-"));
    cleanupRoots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const globalModule = join(root, "global.mjs");
    const projectModule = join(root, "project.mjs");
    await writeFile(
      globalModule,
      "export default function globalExtension() {}\n",
      "utf8"
    );
    await writeFile(
      projectModule,
      "export default function projectExtension() {}\n",
      "utf8"
    );
    const globalPaths = await extensionScopePaths({
      cwd,
      home,
      scope: "global",
    });
    const projectPaths = await extensionScopePaths({
      cwd,
      home,
      scope: "project",
    });
    await writeExtensionSettings(globalPaths.settingsPath, {
      extensions: [
        entry("global", globalModule, true),
        entry("disabled", globalModule, false),
      ],
      values: {},
    });
    await writeExtensionSettings(projectPaths.settingsPath, {
      extensions: [entry("project", projectModule, true)],
      values: {},
    });

    // When
    const blocked = await loadConfiguredCodingAgentExtensions({ cwd, home });
    await writeTrustedProjects(extensionTrustPath(home), [cwd]);
    const trusted = await loadConfiguredCodingAgentExtensions({ cwd, home });

    // Then
    expect(blocked.extensions.map((extension) => extension.id)).toEqual([
      "global",
    ]);
    expect(blocked.notices).toHaveLength(1);
    expect(trusted.extensions.map((extension) => extension.id)).toEqual([
      "global",
      "project",
    ]);
    expect(trusted.notices).toEqual([]);
  });

  it("uses a trusted project extension instead of a global extension with the same id", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-loader-"));
    cleanupRoots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    await mkdir(cwd, { recursive: true });
    const globalModule = join(root, "global.mjs");
    const projectModule = join(root, "project.mjs");
    await writeFile(
      globalModule,
      "export default function globalExtension() {}\n",
      "utf8"
    );
    await writeFile(
      projectModule,
      "export default function projectExtension() {}\n",
      "utf8"
    );
    const globalPaths = await extensionScopePaths({
      cwd,
      home,
      scope: "global",
    });
    const projectPaths = await extensionScopePaths({
      cwd,
      home,
      scope: "project",
    });
    await writeExtensionSettings(globalPaths.settingsPath, {
      extensions: [entry("shared", globalModule, true)],
      values: {},
    });
    await writeExtensionSettings(projectPaths.settingsPath, {
      extensions: [entry("shared", projectModule, true)],
      values: {},
    });
    await writeTrustedProjects(extensionTrustPath(home), [cwd]);

    // When
    const loaded = await loadConfiguredCodingAgentExtensions({ cwd, home });

    // Then
    expect(loaded.extensions).toHaveLength(1);
    const extension = loaded.extensions[0];
    if (extension === undefined || !("default" in extension)) {
      throw new Error("Expected a loaded extension module");
    }
    expect(extension.default.name).toBe("projectExtension");
  });

  it("blocks malformed project settings until the project is trusted", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-loader-"));
    cleanupRoots.push(root);
    const home = join(root, "home");
    const cwd = join(root, "project");
    const projectSettings = join(cwd, ".pss", "settings.json");
    await mkdir(join(cwd, ".pss"), { recursive: true });
    await writeFile(projectSettings, "{", "utf8");

    // When
    const loaded = await loadConfiguredCodingAgentExtensions({ cwd, home });

    // Then
    expect(loaded.extensions).toEqual([]);
    expect(loaded.notices).toEqual([
      "Project extensions are blocked until explicitly enabled or installed for this project.",
    ]);
  });
});

function entry(id: string, path: string, enabled: boolean) {
  return {
    enabled,
    id,
    installedAt: "2026-07-23T00:00:00.000Z",
    source: path,
    sourceKind: "local" as const,
    target: { kind: "module" as const, path },
  };
}
