import { realpath } from "node:fs/promises";
import type { CodingAgentExtensionInput } from "../types";
import {
  discoverLocalExtensions,
  hasLocalExtensionCandidates,
  type LocalExtensionCandidate,
} from "./local-discovery";
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
  excludeIds,
  home,
  importer,
}: {
  readonly cwd: string;
  /** IDs supplied via `-e`; matching configured modules are never imported. */
  readonly excludeIds?: ReadonlySet<string>;
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
      hasBlockedProjectExtension =
        settings.extensions.some((entry) => entry.enabled) ||
        (await hasLocalExtensionCandidates(paths.installRoot));
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
  const skippedIds = excludeIds ?? new Set<string>();
  const globalExtensions = await loadEnabledExtensions({
    entries: globalSettings.extensions.filter(
      (entry) => !(enabledProjectIds.has(entry.id) || skippedIds.has(entry.id))
    ),
    ...(importer === undefined ? {} : { importer }),
    installRoot: globalPaths.installRoot,
  });
  const projectExtensions =
    projectConfiguration === undefined
      ? []
      : await loadEnabledExtensions({
          entries: projectConfiguration.settings.extensions.filter(
            (entry) => !skippedIds.has(entry.id)
          ),
          ...(importer === undefined ? {} : { importer }),
          installRoot: projectConfiguration.paths.installRoot,
        });
  const local = await loadLocalExtensions({
    excludeIds: skippedIds,
    globalInstallRoot: globalPaths.installRoot,
    ...(importer === undefined ? {} : { importer }),
    managedIds: new Set(
      [
        ...globalSettings.extensions,
        ...(projectConfiguration?.settings.extensions ?? []),
      ].map((entry) => entry.id)
    ),
    projectInstallRoot: projectConfiguration?.paths.installRoot,
  });
  return {
    extensions: [
      ...globalExtensions,
      ...local.globalExtensions,
      ...projectExtensions,
      ...local.projectExtensions,
    ],
    notices: [
      ...(hasBlockedProjectExtension
        ? [
            "Project extensions are blocked until explicitly enabled or installed for this project.",
          ]
        : []),
      ...local.notices,
    ],
  };
}

async function loadLocalExtensions(options: {
  readonly excludeIds: ReadonlySet<string>;
  readonly globalInstallRoot: string;
  readonly importer?: ImportExtensionModule;
  readonly managedIds: ReadonlySet<string>;
  readonly projectInstallRoot?: string | undefined;
}): Promise<{
  readonly globalExtensions: readonly CodingAgentExtensionInput[];
  readonly notices: readonly string[];
  readonly projectExtensions: readonly CodingAgentExtensionInput[];
}> {
  const globalDiscovery = await discoverLocalExtensions(
    options.globalInstallRoot
  );
  const projectDiscovery =
    options.projectInstallRoot === undefined
      ? { candidates: [], notices: [] }
      : await discoverLocalExtensions(options.projectInstallRoot);
  const notices: string[] = [
    ...globalDiscovery.notices,
    ...projectDiscovery.notices,
  ];
  const projectCandidates = selectLocalCandidates(
    projectDiscovery.candidates.filter(
      (candidate) => !options.excludeIds.has(candidate.id)
    ),
    options.managedIds,
    notices
  );
  const projectLocalIds = new Set(
    projectCandidates.map((candidate) => candidate.id)
  );
  const globalCandidates = selectLocalCandidates(
    globalDiscovery.candidates.filter(
      (candidate) =>
        !(
          projectLocalIds.has(candidate.id) ||
          options.excludeIds.has(candidate.id)
        )
    ),
    options.managedIds,
    notices
  );
  return {
    globalExtensions: await loadLocalCandidates({
      candidates: globalCandidates,
      ...(options.importer === undefined ? {} : { importer: options.importer }),
      installRoot: options.globalInstallRoot,
    }),
    notices,
    projectExtensions:
      options.projectInstallRoot === undefined
        ? []
        : await loadLocalCandidates({
            candidates: projectCandidates,
            ...(options.importer === undefined
              ? {}
              : { importer: options.importer }),
            installRoot: options.projectInstallRoot,
          }),
  };
}

function selectLocalCandidates(
  candidates: readonly LocalExtensionCandidate[],
  managedIds: ReadonlySet<string>,
  notices: string[]
): readonly LocalExtensionCandidate[] {
  return candidates.filter((candidate) => {
    if (managedIds.has(candidate.id)) {
      notices.push(
        `Skipped local extension "${candidate.path}": id "${candidate.id}" conflicts with an installed extension.`
      );
      return false;
    }
    return true;
  });
}

async function loadLocalCandidates(options: {
  readonly candidates: readonly LocalExtensionCandidate[];
  readonly importer?: ImportExtensionModule;
  readonly installRoot: string;
}): Promise<readonly CodingAgentExtensionInput[]> {
  const extensions: CodingAgentExtensionInput[] = [];
  for (const candidate of options.candidates) {
    extensions.push(
      await loadExtensionTarget({
        id: candidate.id,
        ...(options.importer === undefined
          ? {}
          : { importer: options.importer }),
        installRoot: options.installRoot,
        target: { kind: "module", path: candidate.path },
      })
    );
  }
  return extensions;
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
