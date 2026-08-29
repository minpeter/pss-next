import { describe, expect, it } from "vitest";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { DurableObjectSqliteThreadStore } from "./thread-store";
import {
  createStore,
  PREFIX,
  REQUIRES_SQLITE,
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
    expect(() =>
      Reflect.construct(DurableObjectSqliteThreadStore, [{}, PREFIX])
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
});
