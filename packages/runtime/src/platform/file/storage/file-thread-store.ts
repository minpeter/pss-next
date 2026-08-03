import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  CommitResult,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../../../thread/store/types";
import { withProcessFileLock } from "./file-lock";

/**
 * A file-backed store for processes on one host using a local filesystem.
 * Its locking relies on host PIDs and local atomic filesystem operations; do
 * not share the directory between hosts or over a network filesystem.
 */
export class FileThreadStore implements ThreadStore {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async load(key: string): Promise<StoredThread | null> {
    const file = this.#fileForKey(key);

    try {
      const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
      return parseStoredFileThread(parsed, file);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      if (error instanceof SyntaxError) {
        throw new Error(
          `Invalid FileThreadStore file ${JSON.stringify(
            file
          )}: invalid JSON (${error.message})`
        );
      }
      throw error;
    }
  }

  async commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    const file = this.#fileForKey(key);
    const lockDirectory = `${file}.lock`;
    await mkdir(dirname(file), { recursive: true });
    return await withProcessFileLock(
      lockDirectory,
      "FileThreadStore",
      async () => {
        const current = await this.load(key);
        const currentVersion = current?.version ?? null;

        if (options.expectedVersion !== currentVersion) {
          return { ok: false, reason: "conflict" };
        }

        const version = String((Number(current?.version ?? "0") || 0) + 1);
        const payload: StoredThread = structuredClone({
          state: next.state,
          version,
        });
        const tempFile = `${file}.${process.pid}.${randomUUID()}.tmp`;

        try {
          await writeFile(
            tempFile,
            `${JSON.stringify(payload, null, 2)}\n`,
            "utf8"
          );
          await rename(tempFile, file);
        } catch (error) {
          await rm(tempFile, { force: true }).catch(() => undefined);
          throw error;
        }

        return { ok: true, version };
      }
    );
  }

  async delete(key: string): Promise<void> {
    const file = this.#fileForKey(key);
    const lockDirectory = `${file}.lock`;
    await mkdir(dirname(file), { recursive: true });
    await withProcessFileLock(lockDirectory, "FileThreadStore", async () => {
      await rm(file, { force: true });
    });
  }

  #fileForKey(key: string): string {
    return join(
      this.#directory,
      `${Buffer.from(key).toString("base64url")}.json`
    );
  }
}

function parseStoredFileThread(value: unknown, file: string): StoredThread {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid FileThreadStore file ${JSON.stringify(file)}: expected an object`
    );
  }

  if (typeof value.version !== "string" || !("state" in value)) {
    throw new Error(
      `Invalid FileThreadStore file ${JSON.stringify(
        file
      )}: expected state and string version`
    );
  }

  return structuredClone({
    state: value.state,
    version: value.version,
  });
}

import {
  isNodeError,
  isPlainRecord as isRecord,
} from "../../../internal/guards";
