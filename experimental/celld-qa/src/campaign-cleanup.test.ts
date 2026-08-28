import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCompleteEvent,
  readCleanupReceipt,
  writeCleanupReceipt,
} from "./campaign-cleanup";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true }))
  );
});

describe("campaign cleanup receipt", () => {
  it("writes a machine-readable terminal absence row", async () => {
    const directory = await mkdtemp(
      join("/var/tmp", "pss-celld-cleanup-test-")
    );
    directories.push(directory);
    const path = join(directory, "cleanup.txt");
    const terminal = cleanupCompleteEvent({
      containers: 0,
      ports: 0,
      prefixObjects: 0,
      processes: 0,
      proxyFaults: 0,
      watchPaths: 0,
    });

    await writeCleanupReceipt(path, [
      { kind: "cleanup-check", name: "processes", remaining: 0 },
      terminal,
    ]);

    await expect(readCleanupReceipt(path)).resolves.toEqual([
      { kind: "cleanup-check", name: "processes", remaining: 0 },
      {
        kind: "cleanup-complete",
        passed: true,
        remaining: {
          containers: 0,
          ports: 0,
          prefixObjects: 0,
          processes: 0,
          proxyFaults: 0,
          watchPaths: 0,
        },
      },
    ]);
  });

  it("fails the terminal row when one resource remains", () => {
    expect(
      cleanupCompleteEvent({
        containers: 0,
        ports: 1,
        prefixObjects: 0,
        processes: 0,
        proxyFaults: 0,
        watchPaths: 0,
      }).passed
    ).toBe(false);
  });
});
