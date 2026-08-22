import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { assistantMessage } from "../../testing/test-fixtures";
import type {
  CommitResult,
  ThreadStore,
  ThreadStoreCommit,
} from "../store/types";
import { ThreadState } from "./thread-state";

class FailingCompactionStore implements ThreadStore {
  commitCalls = 0;

  commit(
    _key: string,
    _next: ThreadStoreCommit,
    _options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitCalls += 1;
    if (this.commitCalls > 1) {
      return Promise.reject(new Error("compaction commit failed"));
    }
    return Promise.resolve({ ok: true, version: String(this.commitCalls) });
  }

  delete(): Promise<void> {
    return Promise.resolve();
  }

  load(): Promise<null> {
    return Promise.resolve(null);
  }
}

describe("ThreadState compaction", () => {
  it("removes only the failed compaction record after a non-conflict store failure", async () => {
    const store = new FailingCompactionStore();
    const state = new ThreadState({ key: "exact-compaction-rollback", store });
    const initial: readonly ModelMessage[] = [
      { content: "old", role: "user" },
      assistantMessage("done"),
      { content: "tail", role: "user" },
    ];
    for (const message of initial) {
      state.history.appendModelMessage(message);
    }
    await state.commit();
    state.history.recordCompaction({
      endSeqExclusive: 2,
      schemaVersion: 1,
      startSeq: 0,
      summary: { content: "existing", role: "system" },
    });
    const existingCompactions = state.compactionSnapshot();
    state.history.appendModelMessage({
      content: "concurrent tail",
      role: "user",
    });

    await expect(
      state.compact({ endSeqExclusive: 3, startSeq: 1, summary: "failed" })
    ).rejects.toThrow("compaction commit failed");

    expect(state.modelSnapshot()).toEqual([
      ...initial,
      { content: "concurrent tail", role: "user" },
    ]);
    expect(state.compactionSnapshot()).toEqual(existingCompactions);
    expect(state.threadCheckpointReference().threadVersion).toBe("1");
  });
});
