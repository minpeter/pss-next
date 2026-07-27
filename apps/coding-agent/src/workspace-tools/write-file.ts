import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { type Tool, tool } from "ai";
import { z } from "zod";
import { computeFileHash } from "./hashline";
import { resolveWorkspacePath, workspaceRelativePath } from "./path-safety";

const inputSchema = z
  .object({
    path: z.string().min(1),
    content: z.string(),
    expected_file_hash: z.string().length(8).optional(),
  })
  .strict();

async function assertExpectedHash(
  path: string,
  expectedHash: string | undefined
): Promise<void> {
  if (expectedHash === undefined) {
    return;
  }
  const current = await readFile(path, "utf8");
  const currentHash = computeFileHash(current);
  if (currentHash !== expectedHash) {
    throw new Error(
      `Stale file hash ${expectedHash}; current hash is ${currentHash}.`
    );
  }
}

async function existingMode(path: string): Promise<number | undefined> {
  try {
    return (await lstat(path)).mode;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export async function atomicWrite(
  path: string,
  content: string,
  expectedHash?: string
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const mode = await existingMode(path);
  const permissions = mode === undefined ? undefined : mode % 0o1000;
  const temporaryPath = `${path}.pss-${process.pid}-${randomUUID()}.tmp`;
  try {
    // Create the temp file with the target permissions from the outset so a
    // concurrent reader never sees a broader-mode replacement.
    await writeFile(temporaryPath, content, {
      encoding: "utf8",
      ...(permissions === undefined ? {} : { mode: permissions }),
    });
    if (permissions !== undefined) {
      await chmod(temporaryPath, permissions);
    }
    // Re-verify immediately before the rename; the earlier caller-side check
    // is separated from the swap by real I/O.
    await assertExpectedHash(path, expectedHash);
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function createWriteFileTool(
  workspace: string
): Tool<z.infer<typeof inputSchema>, string> {
  return tool({
    description:
      "Create or replace a UTF-8 file atomically. Prefer edit_file for surgical changes. Pass expected_file_hash when overwriting a file you read.",
    inputSchema,
    execute: async ({ path, content, expected_file_hash: expectedHash }) => {
      const resolved = await resolveWorkspacePath(workspace, path);
      await assertExpectedHash(resolved.path, expectedHash);
      await atomicWrite(resolved.path, content, expectedHash);
      return [
        "OK - wrote file",
        `path: ${workspaceRelativePath(resolved.root, resolved.path)}`,
        `bytes: ${Buffer.byteLength(content)}`,
        `file_hash: ${computeFileHash(content)}`,
      ].join("\n");
    },
  });
}
