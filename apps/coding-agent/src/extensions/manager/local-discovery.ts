import { readdir } from "node:fs/promises";
import { join } from "node:path";

const LOCAL_EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const MODULE_FILE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"] as const;
const RESERVED_ENTRY_NAMES = new Set([
  "node_modules",
  "package.json",
  "package-lock.json",
]);

/** One loose extension module found in a local extensions directory. */
export interface LocalExtensionCandidate {
  readonly id: string;
  readonly path: string;
}

export interface LocalExtensionDiscovery {
  readonly candidates: readonly LocalExtensionCandidate[];
  readonly notices: readonly string[];
}

/**
 * Discover loose extension modules in one extensions directory.
 *
 * Loads `<dir>/<name>.<ts|mts|js|mjs>` files and `<dir>/<name>/index.*`
 * directories. Managed npm metadata (`node_modules`, package manifests),
 * dotfiles, and symbolic links are ignored; symlinks and invalid names
 * produce notices instead of failing startup.
 */
export async function discoverLocalExtensions(
  directory: string
): Promise<LocalExtensionDiscovery> {
  const entries = await readDirectoryEntries(directory);
  if (entries === undefined) {
    return { candidates: [], notices: [] };
  }
  const candidates: LocalExtensionCandidate[] = [];
  const notices: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || RESERVED_ENTRY_NAMES.has(entry.name)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      notices.push(
        `Skipped local extension entry "${join(directory, entry.name)}": symbolic links are not loaded.`
      );
      continue;
    }
    if (entry.isFile()) {
      collectFileCandidate(directory, entry.name, candidates, notices);
      continue;
    }
    if (entry.isDirectory()) {
      await collectDirectoryCandidate(
        directory,
        entry.name,
        candidates,
        notices
      );
    }
  }
  return { candidates, notices };
}

/**
 * Report whether a directory contains loose extension candidates without
 * loading them. Read failures count as present so untrusted projects fail
 * toward the blocked-extensions notice instead of silently loading nothing.
 */
export async function hasLocalExtensionCandidates(
  directory: string
): Promise<boolean> {
  try {
    const discovered = await discoverLocalExtensions(directory);
    return discovered.candidates.length > 0 || discovered.notices.length > 0;
  } catch {
    return true;
  }
}

/** Derive the stable extension id used for one loose module path. */
export function localExtensionIdFromName(name: string): string | undefined {
  return LOCAL_EXTENSION_ID_PATTERN.test(name) ? name : undefined;
}

async function readDirectoryEntries(directory: string) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
      return;
    }
    throw error;
  }
}

function collectFileCandidate(
  directory: string,
  fileName: string,
  candidates: LocalExtensionCandidate[],
  notices: string[]
): void {
  const moduleExtension = MODULE_FILE_EXTENSIONS.find((extension) =>
    fileName.endsWith(extension)
  );
  if (moduleExtension === undefined) {
    return;
  }
  const path = join(directory, fileName);
  const id = localExtensionIdFromName(
    fileName.slice(0, -moduleExtension.length)
  );
  if (id === undefined) {
    notices.push(
      `Skipped local extension "${path}": file name must match ${LOCAL_EXTENSION_ID_PATTERN}.`
    );
    return;
  }
  candidates.push({ id, path });
}

async function collectDirectoryCandidate(
  directory: string,
  directoryName: string,
  candidates: LocalExtensionCandidate[],
  notices: string[]
): Promise<void> {
  const indexPath = await directoryIndexModule(join(directory, directoryName));
  if (indexPath === undefined) {
    return;
  }
  const id = localExtensionIdFromName(directoryName);
  if (id === undefined) {
    notices.push(
      `Skipped local extension "${indexPath}": directory name must match ${LOCAL_EXTENSION_ID_PATTERN}.`
    );
    return;
  }
  candidates.push({ id, path: indexPath });
}

/** Resolve `<dir>/index.*` for directory-shaped local extensions. */
export async function directoryIndexModule(
  directory: string
): Promise<string | undefined> {
  const entries = await readDirectoryEntries(directory);
  if (entries === undefined) {
    return;
  }
  for (const moduleExtension of MODULE_FILE_EXTENSIONS) {
    const indexName = `index${moduleExtension}`;
    const match = entries.find(
      (entry) =>
        entry.name === indexName && entry.isFile() && !entry.isSymbolicLink()
    );
    if (match !== undefined) {
      return join(directory, indexName);
    }
  }
  return;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
