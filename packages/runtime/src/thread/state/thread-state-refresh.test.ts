import { describe, expect, it } from "vitest";
import { MemoryThreadStore } from "../../platform/memory";
import { assistantMessage } from "../../testing/test-fixtures";
import type {
  CommitResult,
  StoredThread,
  ThreadStore,
  ThreadStoreCommit,
} from "../store/types";
import { ThreadState } from "./thread-state";

class DeferredLoad {
  readonly promise: Promise<void>;
  reject: (error: unknown) => void = () => undefined;
  resolve: () => void = () => undefined;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class CapturingLoadStore implements ThreadStore {
  readonly #backing: ThreadStore;
  readonly #loadWaiters: Array<(load: DeferredLoad) => void> = [];
  readonly commitStarted = new DeferredLoad();
  commitGate?: DeferredLoad;

  constructor(backing: ThreadStore) {
    this.#backing = backing;
  }

  nextLoad(): Promise<DeferredLoad> {
    return new Promise((resolve) => {
      this.#loadWaiters.push(resolve);
    });
  }

  async commit(
    key: string,
    next: ThreadStoreCommit,
    options: { readonly expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitStarted.resolve();
    await this.commitGate?.promise;
    return await this.#backing.commit(key, next, options);
  }

  delete(key: string): Promise<void> {
    return this.#backing.delete(key);
  }

  load(key: string): Promise<StoredThread | null> {
    const captured = this.#backing.load(key);
    const pending = new DeferredLoad();
    this.#loadWaiters.shift()?.(pending);
    return pending.promise.then(() => captured);
  }
}

describe("ThreadState refresh fencing", () => {
  it("discards stale success after a newer owner refreshes and compacts", async () => {
    // Given: the first refresh captured version 1 and remains blocked.
    const key = "stale-success";
    const backing = new MemoryThreadStore();
    await seedHistory(backing, key);
    const store = new CapturingLoadStore(backing);
    const staleOwner = new ThreadState({ key, store });
    await load(staleOwner, store);
    const staleLoad = store.nextLoad();
    const staleRefresh = staleOwner.refresh();

    // When: another owner commits version 2 and a newer refresh applies it.
    const newerOwner = new ThreadState({ key, store: backing });
    await newerOwner.ensureLoaded();
    await newerOwner.compact(compaction("newer"));
    const newerLoad = store.nextLoad();
    const newerRefresh = staleOwner.refresh();
    (await newerLoad).resolve();
    await newerRefresh;
    (await staleLoad).resolve();
    await staleRefresh;

    // Then: late version 1 cannot remove version 2's compaction.
    expect(staleOwner.compactionSnapshot()).toEqual([
      expect.objectContaining({
        summary: { content: "newer", role: "system" },
      }),
    ]);
    expect(staleOwner.threadCheckpointReference().threadVersion).toBe("2");
  });

  it("keeps newer state when a stale refresh rejects", async () => {
    // Given: two overlapping refreshes captured different store versions.
    const key = "stale-error";
    const backing = new MemoryThreadStore();
    await seedHistory(backing, key);
    const store = new CapturingLoadStore(backing);
    const state = new ThreadState({ key, store });
    await load(state, store);
    const staleLoad = store.nextLoad();
    const staleRefresh = state.refresh();
    await state.compact(compaction("committed"));
    const newerLoad = store.nextLoad();
    const newerRefresh = state.refresh();
    (await newerLoad).resolve();
    await newerRefresh;

    // When: the older refresh fails after the newer result applied.
    const staleError = new Error("stale load failed");
    (await staleLoad).reject(staleError);

    // Then: its caller sees the error without rolling state back.
    await expect(staleRefresh).rejects.toBe(staleError);
    expect(state.compactionSnapshot()).toHaveLength(1);
    expect(state.threadCheckpointReference().threadVersion).toBe("2");
  });

  it("lets only the latest overlapping refresh apply", async () => {
    // Given: one refresh captured version 1 before an external version 2 commit.
    const key = "overlapping-refreshes";
    const backing = new MemoryThreadStore();
    await seedHistory(backing, key);
    const store = new CapturingLoadStore(backing);
    const state = new ThreadState({ key, store });
    await load(state, store);
    const firstLoad = store.nextLoad();
    const first = state.refresh();
    const external = new ThreadState({ key, store: backing });
    await external.ensureLoaded();
    await external.compact(compaction("external"));

    // When: the newer refresh applies before the first refresh settles.
    const secondLoad = store.nextLoad();
    const second = state.refresh();
    (await secondLoad).resolve();
    await second;
    (await firstLoad).resolve();
    await first;

    // Then: completion order cannot make version 1 authoritative again.
    expect(state.compactionSnapshot()).toHaveLength(1);
    expect(state.threadCheckpointReference().threadVersion).toBe("2");
  });

  it("does not let an older refresh overwrite a newer local commit", async () => {
    // Given: a local compaction is inside its store commit boundary.
    const key = "local-commit";
    const backing = new MemoryThreadStore();
    await seedHistory(backing, key);
    const store = new CapturingLoadStore(backing);
    const state = new ThreadState({ key, store });
    await load(state, store);
    const commitGate = new DeferredLoad();
    store.commitGate = commitGate;
    const compacting = state.compact(compaction("local"));
    await store.commitStarted.promise;

    // When: a refresh captures version 1, then the local commit accepts version 2.
    const capturedLoad = store.nextLoad();
    const refresh = state.refresh();
    const pending = await capturedLoad;
    commitGate.resolve();
    await compacting;
    pending.resolve();
    await refresh;

    // Then: the load cannot erase the locally committed compaction or version.
    expect(state.compactionSnapshot()).toHaveLength(1);
    expect(state.threadCheckpointReference().threadVersion).toBe("2");
  });

  it("applies a healthy refresh after discarding a stale result", async () => {
    // Given: a stale refresh loses to a local version 2 commit.
    const key = "later-healthy-refresh";
    const backing = new MemoryThreadStore();
    await seedHistory(backing, key);
    const store = new CapturingLoadStore(backing);
    const state = new ThreadState({ key, store });
    await load(state, store);
    const staleLoad = store.nextLoad();
    const staleRefresh = state.refresh();
    await state.compact(compaction("local"));
    (await staleLoad).resolve();
    await staleRefresh;

    // When: an external owner commits version 3 and a later refresh completes.
    const external = new ThreadState({ key, store: backing });
    await external.ensureLoaded();
    external.history.appendModelMessage({ content: "version 3", role: "user" });
    await external.commit();
    const healthyLoad = store.nextLoad();
    const healthyRefresh = state.refresh();
    (await healthyLoad).resolve();
    await healthyRefresh;

    // Then: fencing does not prevent ordinary later refresh progress.
    expect(state.modelSnapshot()).toEqual(
      expect.arrayContaining([{ content: "version 3", role: "user" }])
    );
    expect(state.compactionSnapshot()).toHaveLength(1);
    expect(state.threadCheckpointReference().threadVersion).toBe("3");
  });
});

async function seedHistory(store: ThreadStore, key: string): Promise<void> {
  const state = new ThreadState({ key, store });
  state.history.appendModelMessage({ content: "history", role: "user" });
  state.history.appendModelMessage(assistantMessage("answer"));
  await state.commit();
}

function compaction(summary: string) {
  return { endSeqExclusive: 2, startSeq: 0, summary };
}

async function load(
  state: ThreadState,
  store: CapturingLoadStore
): Promise<void> {
  const capturedLoad = store.nextLoad();
  const loading = state.ensureLoaded();
  (await capturedLoad).resolve();
  await loading;
}
