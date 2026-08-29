import { describe, expect, it } from "vitest";
import { storeKey } from "../execution/records";
import {
  createStore,
  inMemorySql,
  PREFIX,
  readChunkRows,
  readRows,
  snapshot,
} from "./thread-store.test-support";
import { ensureThreadSchema } from "./thread-store-sql";

describe("DurableObjectSqliteThreadStore conflicts and compatibility", () => {
  it("regrows with divergent content without reusing soft-deleted seqs", async () => {
    const { storage, store } = createStore();
    await store.commit("k", snapshot([{ i: 0 }, { i: 1 }, { i: 2 }]), {
      expectedVersion: null,
    });
    // Rollback to 1 message.
    await store.commit("k", snapshot([{ i: 0 }]), { expectedVersion: "1" });
    // Regrow with new, different content at index 1.
    await store.commit("k", snapshot([{ i: 0 }, { x: 9 }]), {
      expectedVersion: "2",
    });

    await expect(store.load("k")).resolves.toEqual({
      state: { history: [{ i: 0 }, { x: 9 }], schemaVersion: 1 },
      version: "3",
    });
    const activeSeqs = readRows(storage, "k")
      .filter((row) => row.active === 1)
      .map((row) => row.seq);
    // seq 1 was soft-deleted; the new message must take a fresh seq (3), not reuse 1.
    expect(activeSeqs).toEqual([0, 3]);
  });

  it("does not persist extra runtime payload fields", async () => {
    const { store } = createStore();
    const payloadWithExtraFields = {
      ignored: true,
      state: { value: 1 },
      version: "caller",
    };
    await store.commit("key", payloadWithExtraFields, {
      expectedVersion: null,
    });

    await expect(store.load("key")).resolves.toEqual({
      state: { value: 1 },
      version: "1",
    });
  });

  it("detects stale expectedVersion conflicts", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: "stale" })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("detects expectedVersion null conflicts for existing threads", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null })
    ).resolves.toEqual({ ok: false, reason: "conflict" });
  });

  it("chunks snapshot message rows that exceed the serialized payload budget", async () => {
    const { storage, store } = createStore({ maxPayloadBytes: 80 });
    const bigMessage = { content: "x".repeat(120), role: "user" };

    await expect(
      store.commit("key", snapshot([bigMessage]), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });

    const [row] = readRows(storage, "key");
    expect(row?.message).toBe("\u001epss-thread-chunk:2");
    expect(readChunkRows(storage, "key")).toHaveLength(2);
    await expect(store.load("key")).resolves.toEqual({
      state: { history: [bigMessage], schemaVersion: 1 },
      version: "1",
    });
  });

  it("round-trips user JSON that resembles the legacy chunk marker", async () => {
    const { store } = createStore();
    const markerLikeMessage = { $pss: "chunk", n: 2 };

    await expect(
      store.commit("key", snapshot([markerLikeMessage]), {
        expectedVersion: null,
      })
    ).resolves.toEqual({ ok: true, version: "1" });
    await expect(store.load("key")).resolves.toEqual({
      state: { history: [markerLikeMessage], schemaVersion: 1 },
      version: "1",
    });
  });

  it("does not treat legacy JSON chunk markers as chunk pointers", async () => {
    const { storage, store } = createStore();
    const threadKey = storeKey(PREFIX, "thread", "legacy");
    const serializedMessage = JSON.stringify({
      content: "legacy chunked message",
      role: "user",
    });
    const midpoint = Math.floor(serializedMessage.length / 2);
    const sql = inMemorySql(storage);
    ensureThreadSchema(sql);

    sql.exec(
      "INSERT INTO pss_thread_meta (thread_key, version, message_count, next_seq, state_blob) VALUES (?, ?, ?, ?, ?)",
      threadKey,
      "1",
      1,
      1,
      null
    );
    sql.exec(
      "INSERT INTO pss_thread_message (thread_key, seq, message, active) VALUES (?, ?, ?, ?)",
      threadKey,
      0,
      JSON.stringify({ $pss: "chunk", n: 2 }),
      1
    );
    sql.exec(
      "INSERT INTO pss_thread_message_chunk (thread_key, seq, chunk_index, chunk) VALUES (?, ?, ?, ?), (?, ?, ?, ?)",
      threadKey,
      0,
      0,
      serializedMessage.slice(0, midpoint),
      threadKey,
      0,
      1,
      serializedMessage.slice(midpoint)
    );

    // Current format only: `$pss:chunk` JSON is ordinary payload, not a marker.
    await expect(store.load("legacy")).resolves.toEqual({
      state: {
        history: [{ $pss: "chunk", n: 2 }],
        schemaVersion: 1,
      },
      version: "1",
    });
  });

  it("rejects opaque thread state blobs that exceed the serialized payload budget", async () => {
    const { store } = createStore({ maxPayloadBytes: 80 });

    await expect(
      store.commit(
        "opaque",
        { state: { notes: "x".repeat(120) } },
        { expectedVersion: null }
      )
    ).rejects.toMatchObject({
      maxBytes: 80,
      payloadKind: "thread-state",
    });
    await expect(store.load("opaque")).resolves.toBeNull();
  });

  it("deletes thread state and resets the version counter", async () => {
    const { store } = createStore();
    await store.commit("key", snapshot([{ i: 0 }]), { expectedVersion: null });

    await store.delete("key");

    await expect(store.load("key")).resolves.toBeNull();
    await expect(
      store.commit("key", snapshot([{ i: 1 }]), { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });
  });
});
