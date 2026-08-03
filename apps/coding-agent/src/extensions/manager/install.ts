import { trustProject } from "./activation";
import { loadExtensionTarget } from "./module-loader";
import {
  type InstalledExtensionPackage,
  installExtensionPackage,
  rollbackExtensionPackage,
} from "./package-installer";
import { extensionScopePaths } from "./paths";
import {
  type ExtensionSettingsDocument,
  readExtensionSettings,
  updateExtensionSettings,
  withExtensionOperationLock,
  writeExtensionSettings,
} from "./settings";
import { type ParsedExtensionSource, parseExtensionSource } from "./source";
import type {
  ExtensionManagerContext,
  ExtensionScope,
  ExtensionSettingsEntry,
} from "./types";

const EXTENSION_ID_PATTERN =
  /^(?:[a-z0-9][a-z0-9._-]*|@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*)$/;

type InstallExtensionContext = ExtensionManagerContext & {
  readonly enabled: boolean;
  readonly id?: string;
  readonly scope: ExtensionScope;
  readonly settingsWriter?: typeof writeExtensionSettings;
  readonly source: string;
};

export async function installExtension(
  context: InstallExtensionContext
): Promise<ExtensionSettingsEntry> {
  const paths = await extensionScopePaths(context);
  return await withExtensionOperationLock(paths.installRoot, async () =>
    installExtensionOwned(context, paths)
  );
}

async function installExtensionOwned(
  context: InstallExtensionContext,
  paths: Awaited<ReturnType<typeof extensionScopePaths>>
): Promise<ExtensionSettingsEntry> {
  const document = await readExtensionSettings(paths.settingsPath);
  const parsedSource = await parseExtensionSource(context.source, context.cwd);
  const knownId =
    context.id ??
    (parsedSource.kind === "package" ? parsedSource.packageName : undefined);
  if (knownId !== undefined) {
    validateAvailableExtensionId(knownId, document.extensions);
  }
  const installation = await installManagedExtensionPackage(
    context,
    parsedSource,
    paths.installRoot
  );
  try {
    return await recordExtensionInstallation({
      context,
      document,
      installRoot: paths.installRoot,
      installation,
      parsedSource,
      settingsPath: paths.settingsPath,
    });
  } catch (error) {
    return await rollbackFailedInstallation(
      context,
      paths.installRoot,
      installation,
      error
    );
  }
}

async function installManagedExtensionPackage(
  context: ExtensionManagerContext,
  source: ParsedExtensionSource,
  installRoot: string
): Promise<InstalledExtensionPackage | undefined> {
  if (source.kind !== "package") {
    return;
  }
  return await installExtensionPackage({
    installRoot,
    installSpec: source.installSpec,
    ...(source.packageName === undefined
      ? {}
      : { packageName: source.packageName }),
    ...(context.runCommand === undefined
      ? {}
      : { runCommand: context.runCommand }),
  });
}

async function recordExtensionInstallation({
  context,
  document,
  installation,
  installRoot,
  parsedSource,
  settingsPath,
}: {
  readonly context: InstallExtensionContext;
  readonly document: ExtensionSettingsDocument;
  readonly installation: InstalledExtensionPackage | undefined;
  readonly installRoot: string;
  readonly parsedSource: ParsedExtensionSource;
  readonly settingsPath: string;
}): Promise<ExtensionSettingsEntry> {
  const id = context.id ?? installation?.packageName;
  if (id === undefined) {
    throw new TypeError("Loose extension modules require --id");
  }
  validateAvailableExtensionId(id, document.extensions);
  const target =
    parsedSource.kind === "module"
      ? { kind: "module" as const, path: parsedSource.path }
      : {
          kind: "package" as const,
          packageName: requirePackageName(installation?.packageName),
        };
  await loadExtensionTarget({
    id,
    ...(context.importer === undefined ? {} : { importer: context.importer }),
    installRoot,
    target,
  });
  const entry: ExtensionSettingsEntry = {
    enabled: context.enabled,
    id,
    installedAt: (context.now?.() ?? new Date()).toISOString(),
    source: installedSource(parsedSource, context.source),
    sourceKind:
      parsedSource.kind === "module" ? "local" : parsedSource.sourceKind,
    target,
  };
  const writeSettings = context.settingsWriter ?? writeExtensionSettings;
  // Re-read under the settings lock so concurrent installs cannot drop entries.
  if (context.settingsWriter === undefined) {
    await updateExtensionSettings(settingsPath, (latest) => {
      validateAvailableExtensionId(entry.id, latest.extensions);
      return {
        ...latest,
        extensions: [...latest.extensions, entry],
      };
    });
  } else {
    await writeSettings(settingsPath, {
      ...document,
      extensions: [...document.extensions, entry],
    });
  }
  if (context.scope === "project") {
    try {
      await trustProject(context);
    } catch (error) {
      try {
        if (context.settingsWriter === undefined) {
          await updateExtensionSettings(settingsPath, (latest) => ({
            ...latest,
            extensions: latest.extensions.filter(
              (item) => item.id !== entry.id
            ),
          }));
        } else {
          await writeSettings(settingsPath, document);
        }
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Project trust and extension settings restore both failed"
        );
      }
      throw error;
    }
  }
  return entry;
}

async function rollbackFailedInstallation(
  context: ExtensionManagerContext,
  installRoot: string,
  installation: InstalledExtensionPackage | undefined,
  error: unknown
): Promise<never> {
  if (installation === undefined) {
    throw error;
  }
  try {
    await rollbackExtensionPackage({
      installRoot,
      installed: installation,
      ...(context.runCommand === undefined
        ? {}
        : { runCommand: context.runCommand }),
    });
  } catch (rollbackError) {
    throw new AggregateError(
      [error, rollbackError],
      "Extension installation and rollback both failed"
    );
  }
  throw error;
}

function validateAvailableExtensionId(
  id: string,
  entries: readonly ExtensionSettingsEntry[]
): void {
  if (!EXTENSION_ID_PATTERN.test(id)) {
    throw new TypeError(`Invalid extension id: ${id}`);
  }
  if (entries.some((entry) => entry.id === id)) {
    throw new Error(`Extension "${id}" is already installed`);
  }
}

function installedSource(
  source: ParsedExtensionSource,
  requested: string
): string {
  if (source.kind === "module") {
    return source.path;
  }
  return source.sourceKind === "local" ? source.installSpec : requested;
}

function requirePackageName(name: string | undefined): string {
  if (name === undefined) {
    throw new Error("Could not determine installed extension package name");
  }
  return name;
}
