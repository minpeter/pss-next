import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const lockDirectories = vi.hoisted<string[]>(() => []);

vi.mock("../storage/file-execution-store/lock", () => ({
  withFileLock: async (
    lockDirectory: string,
    _owner: string,
    operation: () => Promise<unknown>
  ) => {
    lockDirectories.push(lockDirectory);
    return await operation();
  },
}));

import {
  ackScheduledNodeRun,
  ackScheduledNodeThreadPrompt,
  appendScheduledNodeRun,
  appendScheduledNodeThreadPrompt,
  listScheduledNodeRuns,
  listScheduledNodeThreadPrompts,
} from "./scheduled-work-store";

afterEach(() => {
  lockDirectories.length = 0;
});

it("serializes complete scheduled-work operations with generation swaps", async () => {
  // Given: every run and prompt operation shares one execution directory.
  const directory = await mkdtemp(join(tmpdir(), "pss-scheduled-lock-"));
  const prompt = {
    idempotencyKey: "notification",
    notificationId: "notification",
    runId: "run",
    threadKey: "thread",
  };
  try {
    // When: every scheduled-work operation crosses the generation boundary.
    await appendScheduledNodeRun(directory, "run");
    await listScheduledNodeRuns(directory);
    await ackScheduledNodeRun(directory, "run");
    await appendScheduledNodeThreadPrompt(directory, prompt);
    await listScheduledNodeThreadPrompts(directory);
    await ackScheduledNodeThreadPrompt(directory, prompt);

    // Then: each complete operation uses the store's generation-swap lock.
    expect(lockDirectories).toEqual(
      Array.from({ length: 6 }, () => join(directory, ".execution.lock"))
    );
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
