import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createDirectoryLock } from "../src/lock.mjs";

const CONTENTION_MESSAGE = "lock contention";
const contentionPattern = /lock contention/u;
const DEAD_OWNER_TOKEN = "999999999-aaaaaaaaaaaa";

let root;
let lockPath;

function makeLock(options = {}) {
  return createDirectoryLock({
    contentionMessage: CONTENTION_MESSAGE,
    lockPath,
    tombstoneRoot: root,
    ...options,
  });
}

async function seedLockDir(identity) {
  await mkdir(lockPath, { recursive: true });
  if (identity !== undefined) {
    await writeFile(join(lockPath, "pid"), identity, "utf8");
  }
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), "pss-bench-lock-"));
  lockPath = join(root, "task.lock");
});

after(async () => {
  await rm(root, { force: true, recursive: true });
});

test("acquire and release round-trips and records an owner token", async () => {
  const lock = makeLock();
  await lock.acquire();
  const stats = await lstat(lockPath);
  assert.equal(stats.isDirectory(), true);
  await lock.release();
  await assert.rejects(lstat(lockPath), { code: "ENOENT" });
});

test("a live owner's lock refuses a second acquisition", async () => {
  const first = makeLock();
  await first.acquire();
  const second = makeLock();
  await assert.rejects(second.acquire(), contentionPattern);
  await first.release();
});

test("a dead owner's lock is reclaimed", async () => {
  await seedLockDir(DEAD_OWNER_TOKEN);
  const lock = makeLock();
  await lock.acquire();
  await lock.release();
});

test("an ownerless lock refuses while fresh and reclaims once stale", async () => {
  await seedLockDir(undefined);
  await assert.rejects(makeLock().acquire(), contentionPattern);
  // staleMs: 0 makes every existing lock immediately reclaimable.
  const impatient = makeLock({ staleMs: 0 });
  await impatient.acquire();
  await impatient.release();
});

test("a malformed identity follows the same fresh/stale rule", async () => {
  await seedLockDir(`${process.pid}-garbage`);
  await assert.rejects(makeLock().acquire(), contentionPattern);
  const impatient = makeLock({ staleMs: 0 });
  await impatient.acquire();
  await impatient.release();
});

test("a stale release handle cannot delete a newer same-process lock", async () => {
  const first = makeLock();
  await first.acquire();
  await first.release();
  const second = makeLock();
  await second.acquire();
  // A duplicate/stale release from the first instance must not delete the
  // second instance's lock even though both share this process's PID.
  await first.release();
  const stats = await lstat(lockPath);
  assert.equal(stats.isDirectory(), true);
  await second.release();
});

test("a zero-pid owner token follows the stale path, not liveness", async () => {
  await seedLockDir("0-aaaaaaaaaaaa");
  // PID 0 must not count as a live owner; a fresh lock still refuses.
  await assert.rejects(makeLock().acquire(), contentionPattern);
  const impatient = makeLock({ staleMs: 0 });
  await impatient.acquire();
  await impatient.release();
});

test("release does not remove a lock owned by another token", async () => {
  const lock = makeLock();
  await lock.acquire();
  // Simulate a reclaimer replacing the instance while we were suspended.
  await writeFile(join(lockPath, "pid"), DEAD_OWNER_TOKEN, "utf8");
  await lock.release();
  const stats = await lstat(lockPath);
  assert.equal(stats.isDirectory(), true);
  await rm(lockPath, { force: true, recursive: true });
});
