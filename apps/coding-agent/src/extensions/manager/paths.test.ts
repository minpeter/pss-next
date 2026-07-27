import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extensionScopePaths } from "./paths";

const cleanupRoots: string[] = [];

afterEach(async () => {
  for (const root of cleanupRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

describe("project extension paths", () => {
  it.each(["package.json", "package-lock.json"] as const)(
    "rejects a symlinked managed %s",
    async (metadataName) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "pss-extension-paths-"));
      cleanupRoots.push(root);
      const cwd = join(root, "project");
      const installRoot = join(cwd, ".pss", "extensions");
      const outsideMetadata = join(root, metadataName);
      await mkdir(installRoot, { recursive: true });
      await writeFile(outsideMetadata, "{}\n", "utf8");
      await symlink(outsideMetadata, join(installRoot, metadataName));

      // When
      const resolving = extensionScopePaths({
        cwd,
        home: join(root, "home"),
        scope: "project",
      });

      // Then
      await expect(resolving).rejects.toThrow(
        `Project extension ${metadataName} must not be a symbolic link`
      );
    }
  );
});
