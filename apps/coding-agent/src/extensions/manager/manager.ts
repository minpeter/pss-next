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
import {
  readExtensionSettings,
  updateExtensionSettings,
  withExtensionOperationLock,
} from "./settings";
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
  return await withExtensionOperationLock(paths.installRoot, async () =>
    removeExtensionOwned(context, paths)
  );
}

async function removeExtensionOwned(
  context: ExtensionManagerContext & { readonly id: string },
  paths: Awaited<ReturnType<typeof extensionScopePaths>>
): Promise<ExtensionSettingsEntry> {
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
      const backup = await snapshotInstallRoot(paths.installRoot);
      try {
        await removeExtensionPackage({
          installRoot: paths.installRoot,
          packageName,
          ...(context.runCommand === undefined
            ? {}
            : { runCommand: context.runCommand }),
        });
      } catch (error) {
        try {
          await restoreInstallRoot(paths.installRoot, backup.root);
          await updateExtensionSettings(paths.settingsPath, (latest) => ({
            ...latest,
            extensions: latest.extensions.some(
              (candidate) => candidate.id === entry.id
            )
              ? latest.extensions
              : [...latest.extensions, entry],
          }));
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            `Extension "${entry.id}" removal and settings restore both failed`
          );
        }
        throw error;
      } finally {
        await rm(backup.parent, { force: true, recursive: true });
      }
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
  return await withExtensionOperationLock(paths.installRoot, async () =>
    updateExtensionsOwned(context, paths)
  );
}

async function updateExtensionsOwned(
  context: ExtensionManagerContext & {
    readonly all: boolean;
    readonly ids: readonly string[];
  },
  paths: Awaited<ReturnType<typeof extensionScopePaths>>
): Promise<readonly ExtensionSettingsEntry[]> {
  const document = await readExtensionSettings(paths.settingsPath);
  const selected =
    context.all || context.ids.length === 0
      ? new Set(document.extensions.map((entry) => entry.id))
      : new Set(context.ids);
  assertIdsExist(document.extensions, selected);
  const { packageUpdates, updated } = await prepareExtensionUpdates(
    context,
    document.extensions,
    selected,
    paths.installRoot
  );
  const byId = new Map(updated.map((entry) => [entry.id, entry]));
  const commitSettings = () =>
    updateExtensionSettings(paths.settingsPath, (latest) => ({
      ...latest,
      extensions: latest.extensions.map((entry) => byId.get(entry.id) ?? entry),
    }));
  if (packageUpdates.length === 0) {
    await commitSettings();
    return updated;
  }

  const backup = await snapshotInstallRoot(paths.installRoot);
  try {
    for (const update of packageUpdates) {
      await applyManagedPackageUpdate(
        context,
        update.entry.id,
        update.target,
        update.installSpec,
        paths.installRoot
      );
    }
    await commitSettings();
  } catch (error) {
    try {
      await restoreInstallRoot(paths.installRoot, backup.root);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Extension update and package root restore both failed"
      );
    }
    throw error;
  } finally {
    await rm(backup.parent, { force: true, recursive: true });
  }
  return updated;
}

interface PreparedPackageUpdate {
  readonly entry: ExtensionSettingsEntry;
  readonly installSpec: string;
  readonly target: { readonly kind: "package"; readonly packageName: string };
}

async function prepareExtensionUpdates(
  context: ExtensionManagerContext,
  entries: readonly ExtensionSettingsEntry[],
  selected: ReadonlySet<string>,
  installRoot: string
): Promise<{
  readonly packageUpdates: readonly PreparedPackageUpdate[];
  readonly updated: readonly ExtensionSettingsEntry[];
}> {
  const packageUpdates: PreparedPackageUpdate[] = [];
  const updated: ExtensionSettingsEntry[] = [];
  for (const entry of entries) {
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
      await validatePackageUpdate(
        context,
        entry.id,
        entry.target,
        parsedSource.installSpec
      );
      packageUpdates.push({
        entry,
        installSpec: parsedSource.installSpec,
        target: entry.target,
      });
    } else {
      await loadExtensionTarget({
        cacheBust: (context.now?.() ?? new Date()).toISOString(),
        id: entry.id,
        ...(context.importer === undefined
          ? {}
          : { importer: context.importer }),
        installRoot,
        target: entry.target,
      });
    }
    updated.push({
      ...entry,
      updatedAt: (context.now?.() ?? new Date()).toISOString(),
    });
  }
  return { packageUpdates, updated };
}

async function applyManagedPackageUpdate(
  context: ExtensionManagerContext,
  id: string,
  target: { readonly kind: "package"; readonly packageName: string },
  installSpec: string,
  installRoot: string
): Promise<void> {
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
}

async function snapshotInstallRoot(
  installRoot: string
): Promise<{ readonly parent: string; readonly root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "pss-extension-backup-"));
  const root = join(parent, "managed");
  await cp(installRoot, root, { recursive: true });
  return { parent, root };
}

async function restoreInstallRoot(
  installRoot: string,
  backupRoot: string
): Promise<void> {
  await rm(installRoot, { force: true, recursive: true });
  await cp(backupRoot, installRoot, { recursive: true });
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
