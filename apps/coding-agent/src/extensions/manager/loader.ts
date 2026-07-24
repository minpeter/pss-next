import { realpath } from "node:fs/promises";
import type { CodingAgentExtensionInput } from "../types";
import { loadExtensionTarget } from "./module-loader";
import { extensionScopePaths, extensionTrustPath } from "./paths";
import { readExtensionSettings, readTrustedProjects } from "./settings";
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
  const [globalPaths, projectPaths] = await Promise.all([
    extensionScopePaths({ cwd, home, scope: "global" }),
    extensionScopePaths({ cwd, home, scope: "project" }),
  ]);
  const [globalSettings, projectSettings, trustedProjects, project] =
    await Promise.all([
      readExtensionSettings(globalPaths.settingsPath),
      readExtensionSettings(projectPaths.settingsPath),
      readTrustedProjects(extensionTrustPath(home)),
      realpath(cwd),
    ]);
  const projectTrusted = trustedProjects.includes(project);
  const globalExtensions = await loadEnabledExtensions({
    entries: globalSettings.extensions,
    ...(importer === undefined ? {} : { importer }),
    installRoot: globalPaths.installRoot,
  });
  const projectExtensions = projectTrusted
    ? await loadEnabledExtensions({
        entries: projectSettings.extensions,
        ...(importer === undefined ? {} : { importer }),
        installRoot: projectPaths.installRoot,
      })
    : [];
  const hasBlockedProjectExtension =
    !projectTrusted &&
    projectSettings.extensions.some((entry) => entry.enabled);
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
