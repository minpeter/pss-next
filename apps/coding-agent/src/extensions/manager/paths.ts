import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionScope } from "./types";

export interface ExtensionScopePaths {
  readonly installRoot: string;
  readonly settingsPath: string;
}

export async function extensionScopePaths({
  cwd,
  home,
  scope,
}: {
  readonly cwd: string;
  readonly home: string;
  readonly scope: ExtensionScope;
}): Promise<ExtensionScopePaths> {
  const root =
    scope === "global"
      ? join(home, ".pss")
      : await safeProjectSettingsRoot(cwd);
  return {
    installRoot: join(root, "extensions"),
    settingsPath: join(root, "settings.json"),
  };
}

async function safeProjectSettingsRoot(cwd: string): Promise<string> {
  const projectRoot = await realpath(cwd);
  const root = join(projectRoot, ".pss");
  const installRoot = join(root, "extensions");
  await assertNotSymbolicLink(root, "Project .pss directory");
  await assertNotSymbolicLink(installRoot, "Project extension package root");
  await assertNotSymbolicLink(
    join(installRoot, "package.json"),
    "Project extension package.json"
  );
  await assertNotSymbolicLink(
    join(installRoot, "package-lock.json"),
    "Project extension package-lock.json"
  );
  await assertNotSymbolicLink(
    join(root, "settings.json"),
    "Project extension settings"
  );
  return root;
}

async function assertNotSymbolicLink(
  path: string,
  label: string
): Promise<void> {
  try {
    const details = await lstat(path);
    if (details.isSymbolicLink()) {
      throw new TypeError(`${label} must not be a symbolic link`);
    }
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function extensionTrustPath(home: string): string {
  return join(home, ".pss", "trusted-projects.json");
}
