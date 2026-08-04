import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { WorkspaceFileSet } from "../workspace";

export const setupWorkspace = async (
  initialFiles: WorkspaceFileSet
): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), "pss-edit-bench-"));
  for (const [path, content] of Object.entries(initialFiles)) {
    const absolutePath = join(workspace, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }
  return workspace;
};

export const cleanupWorkspace = async (workspace: string): Promise<void> => {
  await rm(workspace, { force: true, recursive: true });
};
