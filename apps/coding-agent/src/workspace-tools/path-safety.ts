import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

export function isInsideWorkspace(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return offset === "" || !(offset.startsWith("..") || isAbsolute(offset));
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      await lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const parent = dirname(current);
      if (parent === current) {
        return current;
      }
      current = parent;
    }
  }
}

export interface ResolvedWorkspacePath {
  /** Canonical absolute path inside the workspace. */
  readonly path: string;
  /** Canonical workspace root. */
  readonly root: string;
}

interface ResolveWorkspacePathOptions {
  /**
   * Resolve a final path component that is a symlink to its target. Mutating
   * tools keep this enabled so writes update the target instead of replacing
   * the symlink; delete_file disables it so the link itself is removed.
   */
  readonly followFinalSymlink?: boolean;
}

export async function resolveWorkspacePath(
  workspace: string,
  inputPath: string,
  options: ResolveWorkspacePathOptions = {}
): Promise<ResolvedWorkspacePath> {
  const { followFinalSymlink = true } = options;
  const root = await realpath(resolve(workspace));
  const lexical = resolve(
    isAbsolute(inputPath) ? inputPath : resolve(root, inputPath)
  );

  // Accept absolute paths spelled through a symlinked workspace alias by
  // rebasing them onto the canonical root.
  const lexicalRoot = resolve(workspace);
  const candidate =
    !isInsideWorkspace(root, lexical) && isInsideWorkspace(lexicalRoot, lexical)
      ? resolve(root, relative(lexicalRoot, lexical))
      : lexical;
  if (!isInsideWorkspace(root, candidate)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }

  const existingPath = await nearestExistingPath(candidate);

  // No-follow mode removes or inspects the link node itself, so a dangling
  // target or a target outside the workspace must not fail resolution; only
  // the link's parent needs canonical containment.
  if (existingPath === candidate && !followFinalSymlink) {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) {
      const parent = await realpath(dirname(candidate));
      if (!isInsideWorkspace(root, parent)) {
        throw new Error(
          `Path resolves outside workspace through a symlink: ${inputPath}`
        );
      }
      return { path: resolve(parent, basename(candidate)), root };
    }
  }

  const resolvedExisting = await realpath(existingPath);
  if (!isInsideWorkspace(root, resolvedExisting)) {
    throw new Error(
      `Path resolves outside workspace through a symlink: ${inputPath}`
    );
  }

  const path =
    existingPath === candidate
      ? resolvedExisting
      : resolve(resolvedExisting, relative(existingPath, candidate));
  if (!isInsideWorkspace(root, path)) {
    throw new Error(
      `Path resolves outside workspace through a symlink: ${inputPath}`
    );
  }
  return { path, root };
}

/** Root must be the canonical root returned by resolveWorkspacePath. */
export function workspaceRelativePath(root: string, path: string): string {
  const relativePath = relative(root, path);
  return relativePath === "" ? "." : relativePath;
}

const DEFAULT_IGNORED_SEGMENTS = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);

export function isIgnoredWorkspacePath(relativePath: string): boolean {
  return relativePath
    .split("/")
    .some((segment) => DEFAULT_IGNORED_SEGMENTS.has(segment));
}
