import { realpath } from "node:fs/promises";
import type { CodingAgentExtensionInput } from "../types";
import { loadExtensionTarget } from "./module-loader";
import {
  type ExtensionScopePaths,
  extensionScopePaths,
  extensionTrustPath,
} from "./paths";
import {
  type ExtensionSettingsDocument,
  readExtensionSettings,
  readTrustedProjects,
} from "./settings";
import type {
  ExtensionSettingsEntry,
  ImportExtensionModule,
  LoadedConfiguredExtensions,
} from "./types";

export async function loadConfiguredCodingAgentExtensions({
  cwd,
  home,
  importer,
}: {
  readonly cwd: string;
  readonly home: string;
  readonly importer?: ImportExtensionModule;
}): Promise<LoadedConfiguredExtensions> {
  const [globalPaths, trustedProjects, project] = await Promise.all([
    extensionScopePaths({ cwd, home, scope: "global" }),
    readTrustedProjects(extensionTrustPath(home)),
    realpath(cwd),
  ]);
  const projectTrusted = trustedProjects.includes(project);
  const globalSettings = await readExtensionSettings(globalPaths.settingsPath);
  let projectConfiguration:
    | {
        readonly paths: ExtensionScopePaths;
        readonly settings: ExtensionSettingsDocument;
      }
    | undefined;
  let hasBlockedProjectExtension = false;
  if (projectTrusted) {
    const paths = await extensionScopePaths({
      cwd,
      home,
      scope: "project",
    });
    projectConfiguration = {
      paths,
      settings: await readExtensionSettings(paths.settingsPath),
    };
  } else {
    try {
      const paths = await extensionScopePaths({
        cwd,
        home,
        scope: "project",
      });
      const settings = await readExtensionSettings(paths.settingsPath);
      hasBlockedProjectExtension = settings.extensions.some(
        (entry) => entry.enabled
      );
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
      hasBlockedProjectExtension = true;
    }
  }
  const enabledProjectIds = new Set(
    projectConfiguration?.settings.extensions
      .filter((entry) => entry.enabled)
      .map((entry) => entry.id) ?? []
  );
  const globalExtensions = await loadEnabledExtensions({
    entries: globalSettings.extensions.filter(
      (entry) => !enabledProjectIds.has(entry.id)
    ),
    ...(importer === undefined ? {} : { importer }),
    installRoot: globalPaths.installRoot,
  });
  const projectExtensions =
    projectConfiguration === undefined
      ? []
      : await loadEnabledExtensions({
          entries: projectConfiguration.settings.extensions,
          ...(importer === undefined ? {} : { importer }),
          installRoot: projectConfiguration.paths.installRoot,
        });
  return {
    extensions: [...globalExtensions, ...projectExtensions],
    notices: hasBlockedProjectExtension
      ? [
          "Project extensions are blocked until explicitly enabled or installed for this project.",
        ]
      : [],
  };
}

async function loadEnabledExtensions(options: {
  readonly entries: readonly ExtensionSettingsEntry[];
  readonly importer?: ImportExtensionModule;
  readonly installRoot: string;
}): Promise<readonly CodingAgentExtensionInput[]> {
  const extensions: CodingAgentExtensionInput[] = [];
  for (const entry of options.entries) {
    if (!entry.enabled) {
      continue;
    }
    extensions.push(
      await loadExtensionTarget({
        ...(entry.config === undefined ? {} : { config: entry.config }),
        id: entry.id,
        ...(options.importer === undefined
          ? {}
          : { importer: options.importer }),
        installRoot: options.installRoot,
        target: entry.target,
      })
    );
  }
  return extensions;
}
