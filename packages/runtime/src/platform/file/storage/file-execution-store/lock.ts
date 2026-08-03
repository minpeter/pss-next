import { withProcessFileLock } from "../file-lock";
import type { FileExecutionLock } from "./types";

type LockMode = "auto" | "held";

export function createFileExecutionLock(
  lockDirectory: string,
  lockMode: LockMode
): FileExecutionLock {
  return async (fn) =>
    lockMode === "held"
      ? await fn()
      : await withFileLock(lockDirectory, "FileExecutionStore", fn);
}

export async function withFileLock<T>(
  lockDirectory: string,
  owner: string,
  fn: () => Promise<T>
): Promise<T> {
  return await withProcessFileLock(lockDirectory, owner, fn);
}
