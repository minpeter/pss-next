import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const DEFAULT_STALE_MS = 10 * 60 * 1000;
// Complete owner-token shape; anything else counts as malformed and follows
// the mtime-based stale path instead of the liveness check.
const lockTokenPattern = /^(\d+)-[0-9a-f]{12}$/u;

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return Boolean(
      error && typeof error === "object" && error.code === "EPERM"
    );
  }
}

/**
 * A cross-process directory lock for benchmark maintenance tasks (fixture
 * syncs, artifact packs) that share mutable state under a benchmark root.
 *
 * Protocol: mkdir is atomic on POSIX, so exactly one contender wins. The
 * winner records a unique owner token (`<pid>-<12 hex>`) with an exclusive
 * create; a stale lock (dead owner, or ownerless/malformed and older than
 * staleMs) is reclaimed by atomically renaming the exact instance that was
 * validated, identity-checking it, then recreating the lock.
 */
export function createDirectoryLock({
  contentionMessage,
  lockPath,
  staleMs = DEFAULT_STALE_MS,
  tombstoneRoot,
}) {
  const lockPidPath = resolve(lockPath, "pid");
  // Unique owner token: pid for liveness and release checks plus randomness
  // so owners of successive lock instances can always be told apart.
  const lockToken = `${process.pid}-${randomBytes(6).toString("hex")}`;

  function contentionError() {
    return new Error(contentionMessage);
  }

  async function reclaimStaleLock(expectedIdentity) {
    // The takeover rename is atomic, so exactly one concurrent reclaimer
    // wins.
    // Per-instance token in the name: concurrent reclaims within one
    // process never collide on the same tombstone path.
    const tombstone = resolve(tombstoneRoot, `.bench-lock.stale-${lockToken}`);
    await rm(tombstone, { force: true, recursive: true });
    try {
      await rename(lockPath, tombstone);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        throw contentionError();
      }
      throw error;
    }
    // Identity check: only remove the exact instance we validated. If
    // another process replaced the lock between validation and claim,
    // restore the replacement intact and back off.
    const found = (
      await readFile(resolve(tombstone, "pid"), "utf8").catch(() => "")
    ).trim();
    if (found !== expectedIdentity) {
      try {
        await rename(tombstone, lockPath);
      } catch {
        // A new lock already exists; leave the tombstone rather than
        // deleting a lock we did not validate.
      }
      throw contentionError();
    }
    await rm(tombstone, { force: true, recursive: true });
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw contentionError();
      }
      throw error;
    }
  }

  // The lock already exists: decide whether the existing instance is
  // reclaimable, then atomically take it over.
  async function claimExisting() {
    const identity = (
      await readFile(lockPidPath, "utf8").catch(() => "")
    ).trim();
    const ownerMatch = lockTokenPattern.exec(identity);
    const ownerPid = ownerMatch ? Number.parseInt(ownerMatch[1], 10) : 0;
    // PID 0 is excluded: process.kill(0, 0) probes the whole process group
    // and would pin a malformed lock as permanently alive.
    if (ownerPid > 0) {
      if (isProcessAlive(ownerPid)) {
        throw contentionError();
      }
    } else {
      // Ownerless or malformed identity: reclaimable once clearly stale,
      // so a corrupted or interrupted owner write cannot block every
      // later acquisition forever.
      const { mtimeMs } = await stat(lockPath);
      if (Date.now() - mtimeMs < staleMs) {
        throw contentionError();
      }
    }
    await reclaimStaleLock(identity);
  }

  async function acquire() {
    try {
      await mkdir(lockPath);
    } catch (error) {
      if (!error || typeof error !== "object" || error.code !== "EEXIST") {
        throw error;
      }
      await claimExisting();
    }
    // First writer wins: if our lock instance was reclaimed and recreated
    // while we were suspended, the replacement already has an owner and the
    // exclusive create fails instead of overwriting it.
    try {
      await writeFile(lockPidPath, lockToken, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error && typeof error === "object" && error.code === "EEXIST") {
        throw contentionError();
      }
      throw error;
    }
  }

  async function release() {
    const owner = (await readFile(lockPidPath, "utf8").catch(() => "")).trim();
    // Only remove the lock while this instance still owns it: comparing the
    // full token (not just the pid) keeps a stale release handle from
    // deleting a newer lock owned by the same process.
    if (owner === lockToken) {
      await rm(lockPath, { force: true, recursive: true });
    }
  }

  return { acquire, release };
}
