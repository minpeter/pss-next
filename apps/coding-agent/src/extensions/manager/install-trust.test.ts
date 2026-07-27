import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installExtension } from "./install";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("project extension trust transaction", () => {
  it("does not trust a project when settings commit fails", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "pss-extension-trust-"));
    cleanupRoots.push(root);
    const cwd = join(root, "project");
    const home = join(root, "home");
    const modulePath = join(root, "extension.mjs");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      modulePath,
      "export default function extension() {}\n",
      "utf8"
    );
    const context = {
      cwd,
      enabled: true,
      home,
      id: "trust-failure",
      scope: "project" as const,
      settingsWriter() {
        return Promise.reject(new Error("settings unavailable"));
      },
      source: modulePath,
    };

    // When
    const installing = installExtension(context);

    // Then
    await expect(installing).rejects.toThrow("settings unavailable");
    await expect(
      access(join(home, ".pss", "trusted-projects.json"))
    ).rejects.toThrow();
  });
});
