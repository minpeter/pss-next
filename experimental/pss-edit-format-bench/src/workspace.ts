import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export interface WorkspaceFileSet {
  readonly [path: string]: string;
}

export interface WorkspaceVerification {
  readonly actualFiles: WorkspaceFileSet;
  readonly changedFiles: readonly string[];
  readonly diagnostics: readonly string[];
  readonly passed: boolean;
}

export const verifyWorkspace = async (
  root: string,
  initialFiles: WorkspaceFileSet,
  expectedFiles: WorkspaceFileSet
): Promise<WorkspaceVerification> => {
  const actualFiles = await readWorkspaceFiles(root);
  const expectedPaths = new Set(Object.keys(expectedFiles));
  const actualPaths = new Set(Object.keys(actualFiles));
  const diagnostics: string[] = [];

  for (const path of [...expectedPaths].sort()) {
    if (!actualPaths.has(path)) {
      diagnostics.push(`missing expected file: ${path}`);
      continue;
    }
    if (actualFiles[path] !== expectedFiles[path]) {
      diagnostics.push(`content mismatch: ${path}`);
    }
  }
  for (const path of [...actualPaths].sort()) {
    if (!expectedPaths.has(path)) {
      diagnostics.push(`unexpected file: ${path}`);
    }
  }

  const changedFiles = [
    ...new Set([...Object.keys(initialFiles), ...actualPaths]),
  ]
    .filter((path) => initialFiles[path] !== actualFiles[path])
    .sort((left, right) => left.localeCompare(right));

  return {
    actualFiles,
    changedFiles,
    diagnostics,
    passed: diagnostics.length === 0,
  };
};

const readWorkspaceFiles = async (root: string): Promise<WorkspaceFileSet> => {
  const files: Record<string, string> = {};
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) {
      break;
    }
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const path = relative(root, absolutePath).split(sep).join("/");
      files[path] = await readFile(absolutePath, "utf8");
    }
  }
  return files;
};
