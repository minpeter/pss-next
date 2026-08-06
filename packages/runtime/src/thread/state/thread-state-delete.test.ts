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
