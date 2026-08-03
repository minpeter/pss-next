import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withProcessFileLock } from "./file-lock";

describe("process file lock", () => {
  it("reclaims a definitely dead owner", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-lock-"));
    const lock = join(directory, "lock");
    await writeFile(
      lock,
      JSON.stringify({ pid: 2_147_483_647, token: "dead" })
    );

    await expect(
      withProcessFileLock(lock, "test", async () => "acquired")
    ).resolves.toBe("acquired");
  });

  it("does not release a successor whose acquisition token differs", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-lock-"));
    const lock = join(directory, "lock");
    const successor = { pid: process.pid, token: "successor" };

    await withProcessFileLock(lock, "test", async () => {
      await rm(lock);
      await writeFile(lock, JSON.stringify(successor));
    });

    await expect(readFile(lock, "utf8")).resolves.toBe(
      JSON.stringify(successor)
    );
  });

  it("recovers a reaping marker whose owner is dead", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pss-lock-"));
    const lock = join(directory, "lock");
    await writeFile(
      `${lock}.reaping`,
      JSON.stringify({ pid: 2_147_483_647, token: "dead-reaper" })
    );

    await expect(
      withProcessFileLock(lock, "test", async () => "acquired")
    ).resolves.toBe("acquired");
  });
});
