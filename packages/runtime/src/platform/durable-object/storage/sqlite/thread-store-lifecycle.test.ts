import { describe, expect, it } from "vitest";
import { decodeStoredThreadSnapshot } from "../../../../thread/state/snapshot";
import {
  createStore,
  readChunkRows,
  readCompactionRows,
  readRows,
  snapshot,
} from "./thread-store.test-support";

describe("DurableObjectSqliteThreadStore lifecycle", () => {
  it("hard-deletes thread-local rows for chunked v2 snapshots", async () => {
    const { storage, store } = createStore({ maxPayloadBytes: 80 });
    const bigMessage = { content: "x".repeat(120), role: "user" };

    await expect(
      store.commit(
        "delete-rows",
        {
          state: {
            compactions: [
              {
                endSeqExclusive: 1,
                schemaVersion: 1,
                startSeq: 0,
                summary: { content: "summary", role: "system" },
              },
            ],
            history: [bigMessage],
            schemaVersion: 2,
          },
        },
        { expectedVersion: null }
      )
    ).resolves.toEqual({ ok: true, version: "1" });
    expect(readRows(storage, "delete-rows")).toHaveLength(1);
    expect(readChunkRows(storage, "delete-rows")).toHaveLength(2);
    expect(readCompactionRows(storage, "delete-rows")).toHaveLength(1);

    await store.delete("delete-rows");

    await expect(store.load("delete-rows")).resolves.toBeNull();
    expect(readRows(storage, "delete-rows")).toEqual([]);
    expect(readChunkRows(storage, "delete-rows")).toEqual([]);
    expect(readCompactionRows(storage, "delete-rows")).toEqual([]);
  });

  it("protects committed state from caller mutation", async () => {
    const { store } = createStore();
    const history = [{ nested: { value: 1 } }];
    await store.commit("key", snapshot(history), { expectedVersion: null });
    const [firstHistory] = history;
    if (!firstHistory) {
      throw new Error("Expected caller history.");
    }
    firstHistory.nested.value = 2;

    const loaded = await store.load("key");
    expect(loaded).toEqual({
      state: { history: [{ nested: { value: 1 } }], schemaVersion: 1 },
      version: "1",
    });

    const loadedState = loaded?.state;
    if (
      typeof loadedState !== "object" ||
      loadedState === null ||
      !("history" in loadedState) ||
      !Array.isArray(loadedState.history)
    ) {
      throw new Error("Expected loaded history.");
    }
    const [loadedFirst] = loadedState.history;
    if (
      typeof loadedFirst !== "object" ||
      loadedFirst === null ||
      !("nested" in loadedFirst) ||
      typeof loadedFirst.nested !== "object" ||
      loadedFirst.nested === null ||
      !("value" in loadedFirst.nested) ||
      typeof loadedFirst.nested.value !== "number"
    ) {
      throw new Error("Expected loaded nested history value.");
    }
    loadedFirst.nested.value = 3;
    await expect(store.load("key")).resolves.toEqual({
      state: { history: [{ nested: { value: 1 } }], schemaVersion: 1 },
      version: "1",
    });
  });

  it("serializes expectedVersion checks across concurrent writers", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    const results = await Promise.all([
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: "1" }),
      store.commit("key", snapshot([{ i: 2 }]), { expectedVersion: "1" }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "conflict" },
    ]);
    await expect(store.load("key")).resolves.toMatchObject({ version: "2" });
  });

  it("serializes first-write expectedVersion checks", async () => {
    const { store } = createStore();

    const results = await Promise.all([
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null }),
      store.commit("key", snapshot([{ i: 2 }]), { expectedVersion: null }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "conflict" },
    ]);
  });

  it("round-trips a thread whose total size exceeds the 2MB blob limit", async () => {
    const { store } = createStore();
    const big = "x".repeat(60_000);
    const history = Array.from({ length: 50 }, (_, index) => ({
      content: `${index}:${big}`,
      role: "assistant",
    }));

    await expect(
      store.commit("big", snapshot(history), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });

    const loaded = await store.load("big");
    const bigState = loaded?.state;
    if (
      typeof bigState !== "object" ||
      bigState === null ||
      !("history" in bigState) ||
      !Array.isArray(bigState.history)
    ) {
      throw new Error("Expected large loaded history.");
    }
    expect(bigState.history).toHaveLength(50);
  });

  it("load output decodes via decodeStoredThreadSnapshot", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ content: "hi", role: "user" }]), {
      expectedVersion: null,
    });
    const loaded = await store.load("key");
    expect(decodeStoredThreadSnapshot(loaded)).toEqual([
      { content: "hi", role: "user" },
    ]);
  });

  it("treats a deleted and re-created thread as a brand-new thread", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });
    await store.delete("key");
    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });
  });
});
