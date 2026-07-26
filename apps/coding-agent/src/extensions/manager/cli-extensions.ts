import { lstat } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";
import type { CodingAgentExtensionInput } from "../types";
import {
  directoryIndexModule,
  localExtensionIdFromName,
} from "./local-discovery";
import { loadExtensionTarget } from "./module-loader";
import type { ImportExtensionModule } from "./types";

const MODULE_FILE_EXTENSIONS = new Set([".ts", ".mts", ".js", ".mjs"]);

/** One `-e <path>` argument resolved to a module path and stable id. */
export interface ResolvedCliExtension {
  readonly id: string;
  readonly path: string;
}

/**
 * Resolve `-e <path>` arguments to module paths and ids without importing.
 *
 * Paths may point at a loose module file or a directory containing an
 * `index.*` module. Resolution happens before configured extensions load so
 * overridden configured modules are never imported.
 */
export async function resolveCliExtensionTargets({
  cwd,
  paths,
}: {
  readonly cwd: string;
  readonly paths: readonly string[];
}): Promise<readonly ResolvedCliExtension[]> {
  const targets: ResolvedCliExtension[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const target = await resolveCliExtensionTarget(resolve(cwd, path));
    if (seen.has(target.id)) {
      throw new Error(
        `Duplicate --extension id "${target.id}" from "${path}".`
      );
    }
    seen.add(target.id);
    targets.push(target);
  }
  return targets;
}

/**
 * Import previously resolved CLI extensions.
 *
 * CLI extensions are an explicit user action, so they load without trust
 * gating and take precedence over configured extensions with the same id.
 */
export async function importCliExtensions({
  cacheBust,
  importer,
  signal,
  targets,
}: {
  /** Import-cache buster used by `/reload` to re-import changed modules. */
  readonly cacheBust?: string;
  readonly importer?: ImportExtensionModule;
  /** Aborting stops importing further modules, e.g. after a reload timeout. */
  readonly signal?: AbortSignal;
  readonly targets: readonly ResolvedCliExtension[];
}): Promise<readonly CodingAgentExtensionInput[]> {
  const extensions: CodingAgentExtensionInput[] = [];
  for (const target of targets) {
    if (signal?.aborted) {
      throw new Error(
        "Extension loading was cancelled; no further modules were imported"
      );
    }
    extensions.push(
      await loadExtensionTarget({
        ...(cacheBust === undefined ? {} : { cacheBust }),
        id: target.id,
        ...(importer === undefined ? {} : { importer }),
        installRoot: dirname(target.path),
        target: { kind: "module", path: target.path },
      })
    );
  }
  return extensions;
}

/** Resolve and import `-e <path>` extensions in one step. */
export async function loadCliExtensions({
  cwd,
  importer,
  paths,
}: {
  readonly cwd: string;
  readonly importer?: ImportExtensionModule;
  readonly paths: readonly string[];
}): Promise<readonly CodingAgentExtensionInput[]> {
  return await importCliExtensions({
    ...(importer === undefined ? {} : { importer }),
    targets: await resolveCliExtensionTargets({ cwd, paths }),
  });
}

/** Drop configured extensions that a CLI extension with the same id replaces. */
export function mergeCliExtensions(
  configured: readonly CodingAgentExtensionInput[],
  cli: readonly CodingAgentExtensionInput[]
): readonly CodingAgentExtensionInput[] {
  const cliIds = new Set(cli.map((extension) => extension.id));
  return [
    ...configured.filter((extension) => !cliIds.has(extension.id)),
    ...cli,
  ];
}

async function resolveCliExtensionTarget(
  path: string
): Promise<ResolvedCliExtension> {
  const details = await lstat(path).catch(() => {
    throw new Error(`--extension path not found: ${path}`);
  });
  if (details.isDirectory()) {
    const index = await directoryIndexModule(path);
    if (index === undefined) {
      throw new Error(`--extension directory has no index module: ${path}`);
    }
    return { id: cliExtensionId(basename(path), path), path: index.path };
  }
  const moduleExtension = extname(path);
  if (!MODULE_FILE_EXTENSIONS.has(moduleExtension)) {
    throw new Error(
      `--extension path must be a .ts, .mts, .js, or .mjs module: ${path}`
    );
  }
  return {
    id: cliExtensionId(basename(path, moduleExtension), path),
    path,
  };
}

function cliExtensionId(name: string, path: string): string {
  const id = localExtensionIdFromName(name);
  if (id === undefined) {
    throw new Error(
      `--extension name "${name}" is not a valid extension id (${path}). Use lowercase letters, digits, ".", "_", or "-".`
    );
  }
  return id;
}
