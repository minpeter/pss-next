import { realpath } from "node:fs/promises";
import { extensionScopePaths, extensionTrustPath } from "./paths";
import {
  addTrustedProject,
  readExtensionSettings,
  readTrustedProjects,
  updateExtensionSettings,
  withExtensionOperationLock,
} from "./settings";
import type {
  ExtensionManagerContext,
  ExtensionScope,
  ExtensionSettingsEntry,
  ListedExtension,
} from "./types";

export async function listExtensions(
  context: ExtensionManagerContext & {
    readonly scope?: ExtensionScope;
  }
): Promise<readonly ListedExtension[]> {
  const scopes: readonly ExtensionScope[] =
    context.scope === undefined ? ["global", "project"] : [context.scope];
  const projectTrusted = await isProjectTrusted(context);
  const listed: ListedExtension[] = [];
  for (const scope of scopes) {
    const document = await readExtensionSettings(
      (await extensionScopePaths({ ...context, scope })).settingsPath
    );
    for (const entry of document.extensions) {
      listed.push({
        ...entry,
        scope,
        status: extensionStatus(entry.enabled, scope, projectTrusted),
      });
    }
  }
  return listed;
}

function extensionStatus(
  enabled: boolean,
  scope: ExtensionScope,
  projectTrusted: boolean
): ListedExtension["status"] {
  if (!enabled) {
    return "disabled";
  }
  return scope === "project" && !projectTrusted ? "blocked" : "enabled";
}

export async function setExtensionEnabled(
  context: ExtensionManagerContext & {
    readonly all: boolean;
    readonly enabled: boolean;
    readonly ids: readonly string[];
    readonly scope: ExtensionScope;
  }
): Promise<readonly ExtensionSettingsEntry[]> {
  if (!context.all && context.ids.length === 0) {
    throw new TypeError("Provide extension ids or --all");
  }
  const paths = await extensionScopePaths(context);
  return await withExtensionOperationLock(paths.installRoot, async () =>
    setExtensionEnabledOwned(context, paths)
  );
}

async function setExtensionEnabledOwned(
  context: ExtensionManagerContext & {
    readonly all: boolean;
    readonly enabled: boolean;
    readonly ids: readonly string[];
    readonly scope: ExtensionScope;
  },
  paths: Awaited<ReturnType<typeof extensionScopePaths>>
): Promise<readonly ExtensionSettingsEntry[]> {
  const selected = context.all ? null : new Set(context.ids);
  const previousEnabled = new Map<string, boolean>();
  const next = await updateExtensionSettings(paths.settingsPath, (document) => {
    const ids =
      selected ?? new Set(document.extensions.map((entry) => entry.id));
    assertIdsExist(document.extensions, ids);
    for (const entry of document.extensions) {
      if (ids.has(entry.id)) {
        previousEnabled.set(entry.id, entry.enabled);
      }
    }
    return {
      ...document,
      extensions: document.extensions.map((entry) =>
        ids.has(entry.id) ? { ...entry, enabled: context.enabled } : entry
      ),
    };
  });
  if (context.enabled && context.scope === "project") {
    try {
      await trustProject(context);
    } catch (error) {
      try {
        await updateExtensionSettings(paths.settingsPath, (latest) => ({
          ...latest,
          extensions: latest.extensions.map((entry) =>
            previousEnabled.has(entry.id)
              ? { ...entry, enabled: previousEnabled.get(entry.id) ?? false }
              : entry
          ),
        }));
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          "Project trust and extension enable restore both failed"
        );
      }
      throw error;
    }
  }
  const ids = selected ?? new Set(next.extensions.map((entry) => entry.id));
  return next.extensions.filter((entry) => ids.has(entry.id));
}

export async function trustProject(
  context: ExtensionManagerContext
): Promise<void> {
  const project = await realpath(context.cwd);
  const path = extensionTrustPath(context.home);
  await addTrustedProject(path, project);
}

async function isProjectTrusted(
  context: ExtensionManagerContext
): Promise<boolean> {
  const project = await realpath(context.cwd);
  const projects = await readTrustedProjects(extensionTrustPath(context.home));
  return projects.includes(project);
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
