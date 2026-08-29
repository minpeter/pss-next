import { describe, expect, it } from "vitest";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import {
  type DurableObjectStorage,
  InMemoryDurableObjectStorage,
} from "../durable-object/durable-object-storage";
import { storeKey } from "../execution/records";
import {
  DurableObjectSqliteEventStore,
  type DurableObjectSqliteEventStore as EventStoreType,
} from "./event-store";

const PREFIX = "pss-runtime";
const REQUIRES_SQLITE = /SQLite-backed/;

interface EventRowProbe {
  readonly event: string;
  readonly seq: number;
}

interface MetaRowProbe {
  readonly next_seq: number;
}

function createStore(options: { readonly maxPayloadBytes?: number } = {}) {
  const storage = new InMemoryDurableObjectStorage({
    sql: new InMemorySqlStorage(),
  });
  const store = new DurableObjectSqliteEventStore(storage, PREFIX, options);
  return { storage, store };
}

function collect(
  store: EventStoreType,
  runId: string
): Promise<readonly { cursor: { offset: number }; event: unknown }[]> {
  return (async () => {
    const out: { cursor: { offset: number }; event: unknown }[] = [];
    for await (const entry of store.read(runId)) {
      out.push(entry);
    }
    return out;
  })();
}

function readRows(
  storage: InMemoryDurableObjectStorage,
  runId: string
): EventRowProbe[] {
  return (storage.sql as InMemorySqlStorage)
    .exec<EventRowProbe>(
      "SELECT seq, event FROM pss_event WHERE run_key = ? ORDER BY seq",
      storeKey(PREFIX, "events", runId)
    )
    .toArray();
}

describe("DurableObjectSqliteEventStore", () => {
  it("throws when the Durable Object is not SQLite-backed", () => {
    expect(
      () =>
        new DurableObjectSqliteEventStore({} as DurableObjectStorage, PREFIX)
    ).toThrow(REQUIRES_SQLITE);
  });

  it("appends events as one row each and returns 1-based skip cursors", async () => {
    const { store, storage } = createStore();

    const first = await store.append("run-1", { type: "turn-start" });
    const second = await store.append("run-1", { type: "turn-end" });

    expect(first).toEqual({ offset: 1 });
    expect(second).toEqual({ offset: 2 });

    const rows = readRows(storage, "run-1");
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.seq)).toEqual([0, 1]);
    expect(rows[0].event).toBe(JSON.stringify({ type: "turn-start" }));
  });

  it("replays all events in order", async () => {
    const { store } = createStore();
    await store.append("run-1", { type: "turn-start" });
    await store.append("run-1", { type: "step-start" });
    await store.append("run-1", { type: "turn-end" });

    const events = await collect(store, "run-1");
    expect(events.map((entry) => entry.event)).toEqual([
      { type: "turn-start" },
      { type: "step-start" },
      { type: "turn-end" },
    ]);
    expect(events.map((entry) => entry.cursor.offset)).toEqual([1, 2, 3]);
  });

  it("replays from a cursor without duplicates", async () => {
    const { store } = createStore();
    const firstCursor = await store.append("run-1", { type: "turn-start" });
    await store.append("run-1", { type: "turn-end" });

    const replayed = await collect(store, "run-1");

    // New entries appended after the first cursor are returned from that cursor.
    await store.append("run-1", { type: "step-start" });
    const fromCursor: unknown[] = [];
    for await (const entry of store.read("run-1", firstCursor)) {
      fromCursor.push(entry.event);
    }
    expect(fromCursor).toEqual([{ type: "turn-end" }, { type: "step-start" }]);

    // Sanity: the full replay already matched the pre-step state.
    expect(replayed.map((entry) => entry.event)).toEqual([
      { type: "turn-start" },
      { type: "turn-end" },
    ]);
  });

  it("isolates events by run id", async () => {
    const { store } = createStore();
    await store.append("run-a", { type: "turn-start" });
    await store.append("run-b", { type: "turn-start" });
    await store.append("run-a", { type: "turn-end" });

    expect((await collect(store, "run-a")).map((e) => e.event)).toEqual([
      { type: "turn-start" },
      { type: "turn-end" },
    ]);
    expect((await collect(store, "run-b")).map((e) => e.event)).toEqual([
      { type: "turn-start" },
    ]);
  });

  it("reads nothing for an unknown run", async () => {
    const { store } = createStore();
    expect(await collect(store, "missing")).toEqual([]);
  });

  it("chunks event rows that exceed the serialized payload budget", async () => {
    const { storage, store } = createStore({ maxPayloadBytes: 80 });
    const event = {
      output: "x".repeat(120),
      toolCallId: "call_1",
      toolName: "web_search",
      type: "tool-result",
    } as const;

    await expect(store.append("run-1", event)).resolves.toEqual({
      offset: 1,
    });
    await expect(collect(store, "run-1")).resolves.toMatchObject([{ event }]);
    const chunkRows = (storage.sql as InMemorySqlStorage)
      .exec<{ readonly count: number }>(
        "SELECT COUNT(*) AS count FROM pss_payload_chunk WHERE scope = ?",
        "event"
      )
      .toArray()[0];
    expect(chunkRows?.count).toBeGreaterThan(0);
  });

  it("does not advance the cursor when event serialization fails", async () => {
    const { store } = createStore();
    const unserializableEvent = {
      toJSON: () => undefined,
      type: "turn-start",
    } satisfies {
      readonly toJSON: () => undefined;
      readonly type: "turn-start";
    };

    await expect(
      store.append("run-1", unserializableEvent)
    ).rejects.toMatchObject({ payloadKind: "event" });
    await expect(
      store.append("run-1", { type: "turn-start" })
    ).resolves.toEqual({ offset: 1 });
  });

  it("round-trips a run whose total event payload exceeds the 2MB blob limit", async () => {
    // Guards against SQLITE_TOOBIG-style accumulation failures:
    // many ~120KB tool/result events past the ~2.2MB threshold.
    const { store } = createStore();
    const big = "x".repeat(120_000);
    const event = {
      output: big,
      toolCallId: "call_1",
      toolName: "web_search",
      type: "tool-result",
    } as const;

    for (let index = 0; index < 20; index += 1) {
      await store.append("big-run", event);
    }

    const events = await collect(store, "big-run");
    expect(events).toHaveLength(20);
    // Events round-trip through JSON, so compare the decoded payload by value.
    expect(
      events.every(
        (entry) => (entry.event as { output: string }).output === big
      )
    ).toBe(true);
  });

  it("serializes concurrent appends without seq collisions", async () => {
    const { store, storage } = createStore();
    await Promise.all(
      Array.from({ length: 50 }, () =>
        store.append("run-1", { type: "step-start" })
      )
    );

    const rows = readRows(storage, "run-1");
    const seqs = rows.map((row) => row.seq);
    expect(seqs).toHaveLength(50);
    expect(new Set(seqs).size).toBe(50);
    expect(Math.max(...seqs)).toBe(49);

    // The monotonic next_seq counter never went backwards.
    const meta = (storage.sql as InMemorySqlStorage)
      .exec<MetaRowProbe>(
        "SELECT next_seq FROM pss_event_meta WHERE run_key = ?",
        storeKey(PREFIX, "events", "run-1")
      )
      .toArray()[0];
    expect(meta?.next_seq).toBe(50);
  });

  it("reports the 1-based offset after each append", async () => {
    const { store } = createStore();
    for (let index = 1; index <= 5; index += 1) {
      await expect(
        store.append("run-1", { type: "turn-start" })
      ).resolves.toEqual({ offset: index });
    }
  });
});
