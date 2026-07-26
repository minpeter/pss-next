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

/**
 * Load extensions passed explicitly on the command line via `-e <path>`.
 *
 * Paths may point at a loose module file or a directory containing an
 * `index.*` module. CLI extensions are an explicit user action, so they load
 * without trust gating and take precedence over configured extensions with
 * the same id.
 */
export async function loadCliExtensions({
  cwd,
  importer,
  paths,
}: {
  readonly cwd: string;
  readonly importer?: ImportExtensionModule;
  readonly paths: readonly string[];
}): Promise<readonly CodingAgentExtensionInput[]> {
  const extensions: CodingAgentExtensionInput[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const target = await resolveCliExtensionTarget(resolve(cwd, path));
    if (seen.has(target.id)) {
      throw new Error(
        `Duplicate --extension id "${target.id}" from "${path}".`
      );
    }
    seen.add(target.id);
    extensions.push(
      await loadExtensionTarget({
        id: target.id,
        ...(importer === undefined ? {} : { importer }),
        installRoot: dirname(target.path),
        target: { kind: "module", path: target.path },
      })
    );
  }
  return extensions;
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
): Promise<{ readonly id: string; readonly path: string }> {
  const details = await lstat(path).catch(() => {
    throw new Error(`--extension path not found: ${path}`);
  });
  if (details.isDirectory()) {
    const indexPath = await directoryIndexModule(path);
    if (indexPath === undefined) {
      throw new Error(`--extension directory has no index module: ${path}`);
    }
    return { id: cliExtensionId(basename(path), path), path: indexPath };
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
