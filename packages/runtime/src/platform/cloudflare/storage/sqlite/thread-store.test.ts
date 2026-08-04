import { describe, expect, it } from "vitest";
import { decodeStoredThreadSnapshot } from "../../../../thread/state/snapshot";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import type { CloudflareDurableObjectStorage } from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import { DurableObjectSqliteThreadStore } from "./thread-store";
import {
  createStore,
  PREFIX,
  REQUIRES_SQLITE,
  readChunkRows,
  readCompactionRows,
  readRows,
  snapshot,
} from "./thread-store.test-support";
import { ensureThreadSchema } from "./thread-store-sql";

describe("DurableObjectSqliteThreadStore", () => {
  it("migrates old thread meta schemas once and keeps repeated ensure idempotent", () => {
    const storage = new InMemorySqlStorage();
    storage.exec(
      "CREATE TABLE pss_thread_meta (thread_key TEXT PRIMARY KEY, version TEXT NOT NULL, message_count INTEGER NOT NULL, next_seq INTEGER NOT NULL, state_blob TEXT)"
    );

    ensureThreadSchema(storage);
    ensureThreadSchema(storage);

    expect(
      storage
        .exec<{ readonly name: string }>("PRAGMA table_info(pss_thread_meta)")
        .toArray()
        .filter((column) => column.name === "applied_migrations")
    ).toHaveLength(1);
  });

  it("throws when the Durable Object is not SQLite-backed", () => {
    expect(
      () =>
        new DurableObjectSqliteThreadStore(
          {} as CloudflareDurableObjectStorage,
          PREFIX
        )
    ).toThrow(REQUIRES_SQLITE);
  });

  it("loads null for unknown threads", async () => {
    const { store } = createStore();
    await expect(store.load("missing")).resolves.toBeNull();
  });

  it("commits a v1 snapshot and increments versions", async () => {
    const { store } = createStore();

    const first = await store.commit(
      "key",
      snapshot([{ content: "hi", role: "user" }]),
      { expectedVersion: null }
    );
    expect(first).toEqual({ ok: true, version: "1" });
    await expect(store.load("key")).resolves.toEqual({
      state: { history: [{ content: "hi", role: "user" }], schemaVersion: 1 },
      version: "1",
    });

    const second = await store.commit(
      "key",
      snapshot([
        { content: "hi", role: "user" },
        { content: "yo", role: "assistant" },
      ]),
      { expectedVersion: "1" }
    );
    expect(second).toEqual({ ok: true, version: "2" });
  });

  it("stores v2 compactions in rows while preserving full message rows", async () => {
    const { storage, store } = createStore();
    const fullHistory = [
      { content: "old", role: "user" },
      { content: "answer", role: "assistant" },
      { content: "tail", role: "user" },
    ];

    await expect(
      store.commit(
        "compact",
        {
          state: {
            compactions: [
              {
                endSeqExclusive: 2,
                schemaVersion: 1,
                startSeq: 0,
                summary: { content: "old summary", role: "system" },
              },
            ],
            history: fullHistory,
            schemaVersion: 2,
          },
        },
        { expectedVersion: null }
      )
    ).resolves.toEqual({ ok: true, version: "1" });

    expect(readRows(storage, "compact")).toHaveLength(3);
    expect(readCompactionRows(storage, "compact")).toEqual([
      {
        end_seq_exclusive: 2,
        ordinal: 0,
        start_seq: 0,
        summary: JSON.stringify({ content: "old summary", role: "system" }),
      },
    ]);
    await expect(store.load("compact")).resolves.toEqual({
      state: {
        compactions: [
          {
            endSeqExclusive: 2,
            schemaVersion: 1,
            startSeq: 0,
            summary: { content: "old summary", role: "system" },
          },
        ],
        history: fullHistory,
        schemaVersion: 2,
      },
      version: "1",
    });
  });

  it("round-trips v3 migration metadata without reapplying migrations", async () => {
    // Given
    const { storage, store } = createStore();
    const state = {
      appliedMigrations: { "workspace/sanitize": 2 },
      compactions: [],
      history: [{ content: "sanitized", role: "user" }],
      schemaVersion: 3,
    } as const;

    // When
    await expect(
      store.commit("migrated", { state }, { expectedVersion: null })
    ).resolves.toEqual({ ok: true, version: "1" });

    // Then
    await expect(store.load("migrated")).resolves.toEqual({
      state,
      version: "1",
    });
    expect(readRows(storage, "migrated")).toEqual([
      {
        active: 1,
        message: JSON.stringify({ content: "sanitized", role: "user" }),
        seq: 0,
      },
    ]);
  });

  it("keeps the previous durable rows when compaction payload validation rejects", async () => {
    const { storage, store } = createStore({ maxPayloadBytes: 120 });
    const initialHistory = [
      { content: "old", role: "user" },
      { content: "answer", role: "assistant" },
    ];

    await expect(
      store.commit("compact-too-large", snapshot(initialHistory), {
        expectedVersion: null,
      })
    ).resolves.toEqual({ ok: true, version: "1" });

    await expect(
      store.commit(
        "compact-too-large",
        {
          state: {
            compactions: [
              {
                endSeqExclusive: 2,
                schemaVersion: 1,
                startSeq: 0,
                summary: {
                  content: "x".repeat(180),
                  role: "system",
                },
              },
            ],
            history: [...initialHistory, { content: "tail", role: "user" }],
            schemaVersion: 2,
          },
        },
        { expectedVersion: "1" }
      )
    ).rejects.toMatchObject({
      maxBytes: 120,
      payloadKind: "thread-compaction",
    });

    expect(readRows(storage, "compact-too-large")).toEqual([
      {
        active: 1,
        message: JSON.stringify(initialHistory[0]),
        seq: 0,
      },
      {
        active: 1,
        message: JSON.stringify(initialHistory[1]),
        seq: 1,
      },
    ]);
    expect(readCompactionRows(storage, "compact-too-large")).toEqual([]);
    await expect(store.load("compact-too-large")).resolves.toEqual({
      state: { history: initialHistory, schemaVersion: 1 },
      version: "1",
    });
  });

  it("appends only the new messages (delta-append, unchanged prefix kept)", async () => {
    const { storage, store } = createStore();
    await store.commit("k", snapshot([{ i: 0 }, { i: 1 }]), {
      expectedVersion: null,
    });
    await store.commit(
      "k",
      snapshot([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]),
      { expectedVersion: "1" }
    );

    const rows = readRows(storage, "k");
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.active === 1)).toBe(true);
    expect(rows.map((row) => row.seq)).toEqual([0, 1, 2, 3]);
    expect(rows[0].message).toBe(JSON.stringify({ i: 0 }));
    expect(rows[1].message).toBe(JSON.stringify({ i: 1 }));
  });

  it("soft-deletes the trailing rows on rollback (history shrank)", async () => {
    const { storage, store } = createStore();
    await store.commit(
      "k",
      snapshot([{ i: 0 }, { i: 1 }, { i: 2 }, { i: 3 }]),
      {
        expectedVersion: null,
      }
    );
    await store.commit("k", snapshot([{ i: 0 }, { i: 1 }]), {
      expectedVersion: "1",
    });

    await expect(store.load("k")).resolves.toEqual({
      state: { history: [{ i: 0 }, { i: 1 }], schemaVersion: 1 },
      version: "2",
    });
    const rows = readRows(storage, "k");
    expect(
      rows.filter((row) => row.active === 1).map((row) => row.seq)
    ).toEqual([0, 1]);
    expect(
      rows.filter((row) => row.active === 0).map((row) => row.seq)
    ).toEqual([2, 3]);
  });

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
    await store.commit(
      "key",
      {
        ignored: true,
        state: { value: 1 },
        version: "caller",
      } as never,
      { expectedVersion: null }
    );

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
    const sql = storage.sql as InMemorySqlStorage;
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
    (history[0].nested as { value: number }).value = 2;

    const loaded = await store.load("key");
    expect(loaded).toEqual({
      state: { history: [{ nested: { value: 1 } }], schemaVersion: 1 },
      version: "1",
    });

    const loadedState = loaded?.state as {
      history: { nested: { value: number } }[];
    };
    const loadedHistory = loadedState.history;
    loadedHistory[0].nested.value = 3;
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
    const bigState = loaded?.state as { history: unknown[] };
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
