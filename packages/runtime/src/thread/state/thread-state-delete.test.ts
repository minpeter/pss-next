import { describe, expect, it } from "vitest";
import { userText } from "../../testing/test-fixtures";
import {
  SpyStore as BaseSpyStore,
  type SpyStore,
} from "../handle/test-support";
import type {
  CommitResult,
  StoredThread,
  ThreadStoreCommit,
} from "../store/types";
import { ThreadState } from "./thread-state";

class RejectingDeleteStore extends BaseSpyStore {
  override delete(_key: string): Promise<void> {
    return Promise.reject(new Error("delete failed"));
  }
}

class DelayedCommitStore extends BaseSpyStore {
  readonly commitStarted = createDeferred<void>();
  readonly allowCommit = createDeferred<void>();

  override async commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    this.commitStarted.resolve();
    await this.allowCommit.promise;
    return super.commit(key, next, options);
  }
}

class DelayedCommitRejectingDeleteStore extends BaseSpyStore {
  readonly commitStarted = createDeferred<void>();
  readonly allowCommit = createDeferred<void>();

  override async commit(
    key: string,
    next: ThreadStoreCommit,
    options: { expectedVersion: string | null }
  ): Promise<CommitResult> {
    if (this.threads.has(key)) {
      this.commitStarted.resolve();
      await this.allowCommit.promise;
    }
    return super.commit(key, next, options);
  }

  override delete(_key: string): Promise<void> {
    return Promise.reject(new Error("delete failed"));
  }
}

class GatedRejectingDeleteStore extends BaseSpyStore {
  readonly allowDelete = createDeferred<void>();
  readonly deleteStarted = createDeferred<void>();
  #nextLoadStarted?: ReturnType<typeof createDeferred<void>>;

  nextLoadStarted(): Promise<void> {
    const started = createDeferred<void>();
    this.#nextLoadStarted = started;
    return started.promise;
  }

  override load(key: string): Promise<StoredThread | null> {
    this.#nextLoadStarted?.resolve();
    this.#nextLoadStarted = undefined;
    return super.load(key);
  }

  override async delete(_key: string): Promise<void> {
    this.deleteStarted.resolve();
    await this.allowDelete.promise;
    throw new Error("delete failed");
  }
}

class CountingDeleteStore extends BaseSpyStore {
  deleteCalls = 0;
  deleteGate?: Promise<void>;

  override async delete(key: string): Promise<void> {
    this.deleteCalls += 1;
    await this.deleteGate;
    await super.delete(key);
  }
}

describe("ThreadState deletion", () => {
  it("restores a successful queued commit when the following delete fails", async () => {
    // Given: version 1 is durable and a version 2 commit is blocked in the store.
    const store = new DelayedCommitRejectingDeleteStore();
    const state = new ThreadState({ key: "queued-delete-failure", store });
    state.appendUserInput(userText("version 1"));
    await state.commit();
    state.appendUserInput(userText("version 2"));
    const commit = state.commit();
    await store.commitStarted.promise;

    // When: delete queues behind the commit, then fails after version 2 lands.
    const deletion = state.delete();
    store.allowCommit.resolve();
    await commit;
    await expect(deletion).rejects.toThrow("delete failed");

    // Then: rollback keeps version 2, so the next commit does not conflict.
    expect(state.threadCheckpointReference().threadVersion).toBe("2");
    expect(state.modelSnapshot()).toEqual([
      expect.objectContaining({ content: "version 1" }),
      expect.objectContaining({ content: "version 2" }),
    ]);
    state.appendUserInput(userText("version 3"));
    await expect(state.commit()).resolves.toBeUndefined();
    expect(store.commits.at(-1)?.expectedVersion).toBe("2");
  });

  it("restores conflict reconciliation when the following delete fails", async () => {
    // Given: this owner has version 1 while another owner advances to version 2.
    const store = new RejectingDeleteStore();
    const state = new ThreadState({ key: "conflict-delete-failure", store });
    state.appendUserInput(userText("version 1"));
    await state.commit();
    const winner = new ThreadState({
      key: "conflict-delete-failure",
      store,
    });
    await winner.ensureLoaded();
    winner.appendUserInput(userText("external version 2"));
    await winner.commit();
    const commitStarted = createDeferred<void>();

    // When: the stale commit reconciles its conflict before queued delete fails.
    const conflict = state.commitWith(
      (input) =>
        store.commit(input.key, input.next, {
          expectedVersion: input.expectedVersion,
        }),
      { enterCommitBoundary: commitStarted.resolve }
    );
    await commitStarted.promise;
    const deletion = state.delete();
    await expect(conflict).rejects.toThrow("commit conflict");
    await expect(deletion).rejects.toThrow("delete failed");

    // Then: rollback retains the winner loaded during conflict reconciliation.
    expect(state.threadCheckpointReference().threadVersion).toBe("2");
    expect(state.modelSnapshot()).toEqual([
      expect.objectContaining({ content: "version 1" }),
      expect.objectContaining({ content: "external version 2" }),
    ]);
    await expect(state.commit()).resolves.toBeUndefined();
    expect(store.commits.at(-1)?.expectedVersion).toBe("2");
  });

  it("keeps a newer commit while a stale refresh and delete are in flight", async () => {
    // Given: a refresh has started loading version 1 but has not completed.
    const store = new GatedRejectingDeleteStore();
    const state = new ThreadState({ key: "refresh-delete-failure", store });
    state.appendUserInput(userText("version 1"));
    await state.commit();
    await state.ensureLoaded();
    const loadGate = createDeferred<void>();
    store.loadGate = loadGate.promise;
    const loadStarted = store.nextLoadStarted();
    const refresh = state.refresh();
    await loadStarted;

    // When: version 2 commits, delete starts, then the stale load completes.
    state.appendUserInput(userText("version 2"));
    await state.commit();
    const deletion = state.delete();
    await store.deleteStarted.promise;
    loadGate.resolve();
    await refresh;
    store.allowDelete.resolve();
    await expect(deletion).rejects.toThrow("delete failed");

    // Then: neither stale load generation nor rollback erases version 2.
    expect(state.threadCheckpointReference().threadVersion).toBe("2");
    expect(state.modelSnapshot()).toEqual([
      expect.objectContaining({ content: "version 1" }),
      expect.objectContaining({ content: "version 2" }),
    ]);
  });

  it("keeps in-memory state usable when persistence deletion fails", async () => {
    const store = new RejectingDeleteStore();
    const state = new ThreadState({ key: "delete-failure", store });

    state.appendUserInput(userText("before"));
    await state.commit();

    await expect(state.delete()).rejects.toThrow("delete failed");

    state.appendUserInput(userText("after"));
    await state.commit();

    expect(store.commits).toHaveLength(2);
  });

  it("shares one in-flight store delete across concurrent delete calls", async () => {
    const store = new CountingDeleteStore();
    const state = new ThreadState({ key: "dedupe-delete", store });
    state.appendUserInput(userText("before"));
    await state.commit();

    const gate = createDeferred<void>();
    store.deleteGate = gate.promise;
    const first = state.delete();
    const second = state.delete();
    gate.resolve();
    await Promise.all([first, second]);

    expect(store.deleteCalls).toBe(1);
    expect(loadStored(store, "dedupe-delete")).toBeNull();
  });

  it("does not let a slow load resurrect deleted state in memory", async () => {
    const store = new BaseSpyStore();
    const seed = new ThreadState({ key: "race-load", store });
    seed.appendUserInput(userText("persisted"));
    await seed.commit();

    const loadGate = createDeferred<void>();
    store.loadGate = loadGate.promise;
    const state = new ThreadState({ key: "race-load", store });
    const load = state.ensureLoaded();
    const deletion = state.delete();
    loadGate.resolve();
    await deletion;
    await load;

    // The late-arriving snapshot is discarded, not applied.
    expect(state.modelSnapshot()).toEqual([]);
    expect(state.threadCheckpointReference().threadVersion).toBeNull();
    expect(loadStored(store, "race-load")).toBeNull();

    // The state stays terminal: commits are no-ops.
    const commitsBefore = store.commits.length;
    state.appendUserInput(userText("late"));
    await state.commit();
    expect(store.commits).toHaveLength(commitsBefore);
  });

  it("does not let a refresh resurrect a deleted snapshot", async () => {
    const store = new BaseSpyStore();
    const seed = new ThreadState({ key: "race-refresh", store });
    seed.appendUserInput(userText("persisted"));
    await seed.commit();

    const state = new ThreadState({ key: "race-refresh", store });
    await state.ensureLoaded();
    const loadGate = createDeferred<void>();
    store.loadGate = loadGate.promise;
    const refresh = state.refresh();
    const deletion = state.delete();
    loadGate.resolve();
    await Promise.all([refresh, deletion]);

    expect(state.modelSnapshot()).toEqual([]);
    expect(loadStored(store, "race-refresh")).toBeNull();
  });

  it("does not resurrect a thread when delete wins a commit race", async () => {
    const store = new DelayedCommitStore();
    const state = new ThreadState({ key: "race", store });

    state.appendUserInput(userText("before"));
    const commit = state.commit();
    await store.commitStarted.promise;
    const deletion = state.delete();

    store.allowCommit.resolve();
    await Promise.all([commit, deletion]);

    expect(loadStored(store, "race")).toBeNull();
  });
});

function loadStored(store: SpyStore, key: string): StoredThread | null {
  return store.threads.get(key) ?? null;
}

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
