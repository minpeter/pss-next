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
import {
  assertWorkspacePathContained,
  resolveWorkspacePath,
  workspaceRelativePath,
} from "./path-safety";

const inputSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .describe(
        "File path relative to the workspace, or an absolute path under it."
      ),
    content: z
      .string()
      .describe(
        "Complete UTF-8 file content to write, replacing any existing content."
      ),
    expected_file_hash: z
      .string()
      .regex(
        /^[0-9a-f]{8}$/,
        "expected_file_hash must be exactly 8 lowercase hex characters; uppercase is not accepted. Copy the exact file_hash from the latest successful read_file for this existing path, or omit expected_file_hash entirely to intentionally create a new file. Never invent a hash."
      )
      .optional()
      .describe(
        "Optional overwrite guard: copy the exact 8-character lowercase hex file_hash from the latest successful read_file for this same existing path. OMIT this field entirely for a new file. Never invent hashes or use placeholders, sentinels, or null."
      ),
  })
  .strict();

class FileHashPreconditionError extends Error {
  readonly code: "FILE_HASH_MISMATCH" | "FILE_HASH_TARGET_MISSING";

  constructor(
    code: FileHashPreconditionError["code"],
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "FileHashPreconditionError";
    this.code = code;
  }
}

async function assertExpectedHash(
  path: string,
  expectedHash: string | undefined
): Promise<void> {
  if (expectedHash === undefined) {
    return;
  }
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new FileHashPreconditionError(
        "FILE_HASH_TARGET_MISSING",
        "Cannot validate expected_file_hash: a guarded overwrite requires an existing file, but the target does not exist and has no file hash. Omit expected_file_hash entirely only if you intentionally want to create a new file. Do not invent a hash or create an empty file to satisfy the guard.",
        { cause: error }
      );
    }
    throw error;
  }
  const currentHash = computeFileHash(current);
  if (currentHash !== expectedHash) {
    throw new FileHashPreconditionError(
      "FILE_HASH_MISMATCH",
      `Stale file hash ${expectedHash}; current hash is ${currentHash}. Read this existing file again with read_file and use its fresh file_hash before overwriting.`
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
  root: string,
  path: string,
  content: string,
  expectedHash?: string
): Promise<void> {
  // Fail closed before ANY filesystem mutation: when an intermediate
  // directory was swapped for an escaping symlink after resolution, neither
  // parent directories nor the temp file may be created outside the
  // workspace. Node offers no fd-relative rename, so containment is asserted
  // immediately before each mutation phase instead.
  await assertWorkspacePathContained(root, path);
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
    await assertWorkspacePathContained(root, path);
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
      "Create or replace a UTF-8 file atomically, creating missing parent directories. Prefer edit_file for surgical changes. For a new file, OMIT expected_file_hash entirely. For a guarded overwrite, copy the exact file_hash from the latest successful read_file for the same existing path. Never invent hashes or use placeholders, sentinels, or null.",
    inputSchema,
    strict: false,
    execute: async ({ path, content, expected_file_hash: expectedHash }) => {
      const resolved = await resolveWorkspacePath(workspace, path);
      await assertExpectedHash(resolved.path, expectedHash);
      await atomicWrite(resolved.root, resolved.path, content, expectedHash);
      return [
        "OK - wrote file",
        `path: ${workspaceRelativePath(resolved.root, resolved.path)}`,
        `bytes: ${Buffer.byteLength(content)}`,
        `file_hash: ${computeFileHash(content)}`,
      ].join("\n");
    },
  });
}
