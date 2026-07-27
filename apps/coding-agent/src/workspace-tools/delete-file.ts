import { lstat, readFile, realpath, rm } from "node:fs/promises";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { computeFileHash } from "./hashline";
import {
  isInsideWorkspace,
  resolveWorkspacePath,
  workspaceRelativePath,
} from "./path-safety";

const inputSchema = z
  .object({
    path: z.string().min(1),
    recursive: z.boolean().optional(),
    expected_file_hash: z.string().length(8).optional(),
  })
  .strict();

async function assertExpectedFileHash(
  metadata: { isSymbolicLink: () => boolean },
  absolutePath: string,
  root: string,
  expectedHash: string
): Promise<void> {
  // read_file follows a final symlink and reports the target's hash, so
  // verify against the target even though rm removes the link. The target
  // must stay inside the workspace: otherwise the hash check would read a
  // file the file tools are not allowed to touch.
  let hashPath = absolutePath;
  if (metadata.isSymbolicLink()) {
    const target = await realpath(absolutePath);
    if (!isInsideWorkspace(root, target)) {
      throw new Error(
        "expected_file_hash cannot be validated: link target is outside the workspace."
      );
    }
    hashPath = target;
  }
  const currentHash = computeFileHash(await readFile(hashPath, "utf8"));
  if (currentHash !== expectedHash) {
    throw new Error(
      `Stale file hash ${expectedHash}; current hash is ${currentHash}.`
    );
  }
}

export function createDeleteFileTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Delete a file or, with recursive=true, a directory. Prefer this over shell rm. Pass expected_file_hash for a file you read.",
    inputSchema,
    execute: async ({
      path,
      recursive = false,
      expected_file_hash: expectedHash,
    }) => {
      const resolved = await resolveWorkspacePath(workspace, path, {
        followFinalSymlink: false,
      });
      const absolutePath = resolved.path;
      if (absolutePath === resolved.root) {
        throw new Error("Refusing to delete the workspace root.");
      }
      const metadata = await lstat(absolutePath);
      if (metadata.isDirectory() && !recursive) {
        throw new Error("Directory deletion requires recursive=true.");
      }
      if (expectedHash !== undefined) {
        if (!(metadata.isFile() || metadata.isSymbolicLink())) {
          throw new Error("expected_file_hash is only valid for files.");
        }
        await assertExpectedFileHash(
          metadata,
          absolutePath,
          resolved.root,
          expectedHash
        );
      }
      await rm(absolutePath, { recursive, force: false });
      return `OK - deleted\npath: ${workspaceRelativePath(resolved.root, absolutePath)}`;
    },
  });
}
