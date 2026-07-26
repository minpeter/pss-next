import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readExtensionSettings, updateExtensionSettings } from "./settings";
import type { ExtensionSettingsEntry } from "./types";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

function entry(id: string): ExtensionSettingsEntry {
  return {
    enabled: true,
    id,
    installedAt: "2026-07-25T00:00:00.000Z",
    source: `./${id}.mjs`,
    sourceKind: "local",
    target: { kind: "module", path: `./${id}.mjs` },
  };
}

describe("updateExtensionSettings concurrency", () => {
  it("does not drop entries under concurrent writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "pss-settings-cas-"));
    cleanupRoots.push(root);
    const path = join(root, "settings.json");

    await updateExtensionSettings(path, () => ({
      extensions: [],
      values: {},
    }));

    await Promise.all([
      updateExtensionSettings(path, (document) => ({
        ...document,
        extensions: [...document.extensions, entry("alpha")],
      })),
      updateExtensionSettings(path, (document) => ({
        ...document,
        extensions: [...document.extensions, entry("beta")],
      })),
      updateExtensionSettings(path, (document) => ({
        ...document,
        extensions: [...document.extensions, entry("gamma")],
      })),
    ]);

    const final = await readExtensionSettings(path);
    expect(final.extensions.map((item) => item.id).sort()).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });
});
