import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensionTarget } from "./module-loader";
import {
  discardInstallRootSnapshot,
  installExtensionPackage,
  removeExtensionPackage,
  restoreInstallRoot,
  snapshotInstallRoot,
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
  const document = await readExtensionSettings(paths.settingsPath);
  const entry = document.extensions.find((item) => item.id === context.id);
  if (entry === undefined) {
    throw new Error(`Extension "${context.id}" is not installed`);
  }
  const remainingPackages = document.extensions.filter(
    (item) => item.id !== entry.id
  );
  const packageName =
    entry.target.kind === "package" ? entry.target.packageName : undefined;
  const removePackage =
    packageName !== undefined &&
    !remainingPackages.some(
      (item) =>
        item.target.kind === "package" &&
        item.target.packageName === packageName
    );
  const backup = removePackage
    ? await snapshotInstallRoot(paths.installRoot)
    : undefined;
  let settingsRemoved = false;
  try {
    await updateExtensionSettings(paths.settingsPath, (latest) => {
      if (!latest.extensions.some((item) => item.id === entry.id)) {
        throw new Error(`Extension "${entry.id}" is not installed`);
      }
      return {
        ...latest,
        extensions: latest.extensions.filter((item) => item.id !== entry.id),
      };
    });
    settingsRemoved = true;
    if (removePackage && packageName !== undefined) {
      await removeExtensionPackage({
        installRoot: paths.installRoot,
        packageName,
        ...(context.runCommand === undefined
          ? {}
          : { runCommand: context.runCommand }),
      });
    }
  } catch (error) {
    if (!(settingsRemoved && backup)) {
      throw error;
    }
    try {
      await restoreInstallRoot(paths.installRoot, backup);
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
    if (backup) {
      await discardInstallRootSnapshot(backup);
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
      await restoreInstallRoot(paths.installRoot, backup);
    } catch (restoreError) {
      throw new AggregateError(
        [error, restoreError],
        "Extension update and package root restore both failed"
      );
    }
    throw error;
  } finally {
    await discardInstallRootSnapshot(backup);
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
