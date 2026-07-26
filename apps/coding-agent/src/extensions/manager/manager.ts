import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionTarget } from "./module-loader";
import {
  installExtensionPackage,
  removeExtensionPackage,
} from "./package-installer";
import { extensionScopePaths } from "./paths";
import { readExtensionSettings, updateExtensionSettings } from "./settings";
import { parseExtensionSource } from "./source";
import type {
  ExtensionManagerContext,
  ExtensionScope,
  ExtensionSettingsEntry,
} from "./types";

export async function removeExtension(
  context: ExtensionManagerContext & {
    readonly id: string;
    readonly scope: ExtensionScope;
  }
): Promise<ExtensionSettingsEntry> {
  const paths = await extensionScopePaths(context);
  let removed: ExtensionSettingsEntry | undefined;
  let remainingPackages: readonly ExtensionSettingsEntry[] = [];
  await updateExtensionSettings(paths.settingsPath, (document) => {
    const entry = document.extensions.find((item) => item.id === context.id);
    if (entry === undefined) {
      throw new Error(`Extension "${context.id}" is not installed`);
    }
    removed = entry;
    remainingPackages = document.extensions.filter(
      (item) => item.id !== entry.id
    );
    return {
      ...document,
      extensions: remainingPackages,
    };
  });
  const entry = removed as ExtensionSettingsEntry;
  if (entry.target.kind === "package") {
    const packageName = entry.target.packageName;
    if (
      !remainingPackages.some(
        (item) =>
          item.target.kind === "package" &&
          item.target.packageName === packageName
      )
    ) {
      await removeExtensionPackage({
        installRoot: paths.installRoot,
        packageName,
        ...(context.runCommand === undefined
          ? {}
          : { runCommand: context.runCommand }),
      });
    }
  }
  return entry;
}

export async function updateExtensions(
  context: ExtensionManagerContext & {
    readonly all: boolean;
    readonly ids: readonly string[];
    readonly scope: ExtensionScope;
  }
): Promise<readonly ExtensionSettingsEntry[]> {
  const paths = await extensionScopePaths(context);
  const document = await readExtensionSettings(paths.settingsPath);
  const selected =
    context.all || context.ids.length === 0
      ? new Set(document.extensions.map((entry) => entry.id))
      : new Set(context.ids);
  assertIdsExist(document.extensions, selected);
  const updated: ExtensionSettingsEntry[] = [];
  for (const entry of document.extensions) {
    if (!selected.has(entry.id)) {
      continue;
    }
    if (entry.target.kind === "package") {
      const parsedSource = await parseExtensionSource(
        entry.source,
        context.cwd
      );
      if (parsedSource.kind !== "package") {
        throw new TypeError(
          `Extension "${entry.id}" no longer resolves to a package`
        );
      }
      await updateManagedPackage(
        context,
        entry.id,
        entry.target,
        parsedSource.installSpec,
        paths.installRoot
      );
    } else {
      await loadExtensionTarget({
        cacheBust: (context.now?.() ?? new Date()).toISOString(),
        id: entry.id,
        ...(context.importer === undefined
          ? {}
          : { importer: context.importer }),
        installRoot: paths.installRoot,
        target: entry.target,
      });
    }
    updated.push({
      ...entry,
      updatedAt: (context.now?.() ?? new Date()).toISOString(),
    });
  }
  const byId = new Map(updated.map((entry) => [entry.id, entry]));
  await updateExtensionSettings(paths.settingsPath, (latest) => ({
    ...latest,
    extensions: latest.extensions.map((entry) => byId.get(entry.id) ?? entry),
  }));
  return updated;
}

async function updateManagedPackage(
  context: ExtensionManagerContext,
  id: string,
  target: { readonly kind: "package"; readonly packageName: string },
  installSpec: string,
  installRoot: string
): Promise<void> {
  await validatePackageUpdate(context, id, target, installSpec);
  const backupParent = await mkdtemp(
    join(tmpdir(), "pss-extension-update-backup-")
  );
  const backupRoot = join(backupParent, "managed");
  await cp(installRoot, backupRoot, { recursive: true });
  try {
    await installExtensionPackage({
      installRoot,
      installSpec,
      packageName: target.packageName,
      ...(context.runCommand === undefined
        ? {}
        : { runCommand: context.runCommand }),
    });
    await loadExtensionTarget({
      cacheBust: randomUUID(),
      id,
      ...(context.importer === undefined ? {} : { importer: context.importer }),
      installRoot,
      target,
    });
  } catch (error) {
    try {
      await rm(installRoot, { force: true, recursive: true });
      await cp(backupRoot, installRoot, { recursive: true });
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        `Extension "${id}" update and restore both failed`
      );
    }
    throw error;
  } finally {
    await rm(backupParent, { force: true, recursive: true });
  }
}

async function validatePackageUpdate(
  context: ExtensionManagerContext,
  id: string,
  target: { readonly kind: "package"; readonly packageName: string },
  installSpec: string
): Promise<void> {
  const stagingRoot = await mkdtemp(
    join(tmpdir(), "pss-extension-update-validation-")
  );
  try {
    await installExtensionPackage({
      installRoot: stagingRoot,
      installSpec,
      packageName: target.packageName,
      ...(context.runCommand === undefined
        ? {}
        : { runCommand: context.runCommand }),
    });
    await loadExtensionTarget({
      id,
      ...(context.importer === undefined ? {} : { importer: context.importer }),
      installRoot: stagingRoot,
      target,
    });
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}

function assertIdsExist(
  entries: readonly ExtensionSettingsEntry[],
  selected: ReadonlySet<string>
): void {
  const installed = new Set(entries.map((entry) => entry.id));
  for (const id of selected) {
    if (!installed.has(id)) {
      throw new Error(`Extension "${id}" is not installed`);
    }
  }
}
