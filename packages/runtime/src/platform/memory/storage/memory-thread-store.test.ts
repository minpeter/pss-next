import { describe, expect, expectTypeOf, it } from "vitest";
import type { ThreadStoreCommit } from "../../../thread/store/types";
import { MemoryThreadStore } from "./memory-thread-store";

describe("MemoryThreadStore", () => {
  it("loads null for unknown threads", async () => {
    await expect(new MemoryThreadStore().load("missing")).resolves.toBeNull();
  });

  it("commits opaque state and increments versions", async () => {
    const store = new MemoryThreadStore();

    const first = await store.commit(
      "key",
      { state: { value: 1 } },
      { expectedVersion: null }
    );
    expect(first).toEqual({ ok: true, version: "1" });
    await expect(store.load("key")).resolves.toEqual({
      state: { value: 1 },
      version: "1",
    });

    const second = await store.commit(
      "key",
      { state: { value: 2 } },
      { expectedVersion: "1" }
    );
    expect(second).toEqual({ ok: true, version: "2" });
  });

  it("types commit payloads as state only", () => {
    type CommitPayloadHasVersion = "version" extends keyof ThreadStoreCommit
      ? true
      : false;

    expectTypeOf<CommitPayloadHasVersion>().toEqualTypeOf<false>();
    expectTypeOf<
      Parameters<MemoryThreadStore["commit"]>[1]
    >().toEqualTypeOf<ThreadStoreCommit>();
  });

  it("does not persist extra runtime payload fields", async () => {
    const store = new MemoryThreadStore();
    const payload = {
      state: { value: 1 },
      ignored: true,
      version: "caller",
    } as ThreadStoreCommit;

    await store.commit("key", payload, { expectedVersion: null });

    await expect(store.load("key")).resolves.toEqual({
      state: { value: 1 },
      version: "1",
    });
  });

  it("detects expectedVersion conflicts", async () => {
    const store = new MemoryThreadStore();
    await store.commit(
      "key",
      { state: { value: 1 } },
      { expectedVersion: null }
    );

    await expect(
      store.commit("key", { state: { value: 2 } }, { expectedVersion: "stale" })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("detects expectedVersion null conflicts for existing threads", async () => {
    const store = new MemoryThreadStore();
    await store.commit(
      "key",
      { state: { value: 1 } },
      { expectedVersion: null }
    );

    await expect(
      store.commit("key", { state: { value: 2 } }, { expectedVersion: null })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("deletes committed thread state", async () => {
    const store = new MemoryThreadStore();
    await store.commit(
      "key",
      { state: { value: 1 } },
      { expectedVersion: null }
    );

    await store.delete("key");

    await expect(store.load("key")).resolves.toBeNull();
    await expect(
      store.commit("key", { state: { value: 2 } }, { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });
  });

  it("protects committed state from caller mutation", async () => {
    const store = new MemoryThreadStore();
    const state = { nested: { value: 1 } };
    await store.commit("key", { state }, { expectedVersion: null });
    state.nested.value = 2;

    const loaded = await store.load("key");
    expect(loaded).toEqual({ state: { nested: { value: 1 } }, version: "1" });

    const loadedState = loaded?.state as { nested: { value: number } };
    loadedState.nested.value = 3;
    await expect(store.load("key")).resolves.toEqual({
      state: { nested: { value: 1 } },
      version: "1",
    });
  });
});
