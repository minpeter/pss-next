import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { isNodeError } from "../../../internal/guards";

const POLL_INTERVAL_MS = 10;
const LOCK_TIMEOUT_MS = 5000;

interface LockOwner {
  readonly pid: number;
  readonly token: string;
}

/**
 * A process-owned lock for a single host and local filesystem. This is not a
 * distributed lock: PID liveness and local atomic link/unlink semantics are
 * required. Locks never expire; a live (including stopped) process retains
 * ownership, and only an owner whose PID is definitely absent is reclaimed.
 */
export async function withProcessFileLock<T>(
  lockFile: string,
  label: string,
  fn: () => Promise<T>,
  options: { readonly timeoutMs?: number } = {}
): Promise<T> {
  const owner = await acquireProcessFileLock(
    lockFile,
    label,
    options.timeoutMs ?? LOCK_TIMEOUT_MS
  );
  try {
    return await fn();
  } finally {
    await releaseProcessFileLock(lockFile, owner);
  }
}

async function acquireProcessFileLock(
  lockFile: string,
  label: string,
  timeoutMs: number
): Promise<LockOwner> {
  const owner = { pid: process.pid, token: randomUUID() };
  const startedAt = Date.now();
  await mkdir(dirname(lockFile), { recursive: true });

  while (Date.now() - startedAt < timeoutMs) {
    const reapingFile = `${lockFile}.reaping`;
    if (await lockIsOwned(reapingFile)) {
      await setTimeout(POLL_INTERVAL_MS);
      continue;
    }
    try {
      await publishOwner(lockFile, owner);
      // A reaper which was already in flight excludes this acquisition. The
      // token check makes dropping this attempt owner-safe.
      if (await lockIsOwned(reapingFile)) {
        await releaseProcessFileLock(lockFile, owner);
      } else {
        return owner;
      }
    } catch (error) {
      if (!(isNodeError(error) && error.code === "EEXIST")) {
        throw error;
      }
      await reclaimDeadOwner(lockFile);
    }
    await setTimeout(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Timed out waiting for ${label} lock ${JSON.stringify(lockFile)}`
  );
}

async function reclaimDeadOwner(lockFile: string): Promise<void> {
  const observed = await readOwner(lockFile);
  if (!observed || isProcessPossiblyAlive(observed.pid)) {
    return;
  }

  const reapingFile = `${lockFile}.reaping`;
  const reaper = { pid: process.pid, token: randomUUID() };
  try {
    await publishOwner(reapingFile, reaper);
  } catch (error) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  }

  try {
    const current = await readOwner(lockFile);
    if (
      current?.token === observed.token &&
      current.pid === observed.pid &&
      !isProcessPossiblyAlive(current.pid)
    ) {
      await rm(lockFile, { force: true });
    }
  } finally {
    await releaseProcessFileLock(reapingFile, reaper);
  }
}

async function publishOwner(lockFile: string, owner: LockOwner): Promise<void> {
  const tempFile = `${lockFile}.${owner.pid}.${owner.token}.tmp`;
  try {
    await writeFile(tempFile, JSON.stringify(owner), { flag: "wx" });
    await link(tempFile, lockFile);
  } finally {
    await rm(tempFile, { force: true }).catch(() => undefined);
  }
}

async function lockIsOwned(lockFile: string): Promise<boolean> {
  const owner = await readOwner(lockFile);
  if (!owner) {
    return false;
  }
  if (isProcessPossiblyAlive(owner.pid)) {
    return true;
  }
  await releaseProcessFileLock(lockFile, owner);
  return false;
}

async function releaseProcessFileLock(
  lockFile: string,
  owner: LockOwner
): Promise<void> {
  const current = await readOwner(lockFile);
  if (current?.pid === owner.pid && current.token === owner.token) {
    await rm(lockFile, { force: true });
  }
}

async function readOwner(lockFile: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(
      await readFile(lockFile, "utf8")
    ) as Partial<LockOwner>;
    return typeof value.pid === "number" && typeof value.token === "string"
      ? { pid: value.pid, token: value.token }
      : null;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

function isProcessPossiblyAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(isNodeError(error) && error.code === "ESRCH");
  }
}
