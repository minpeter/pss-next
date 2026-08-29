import { describe, expect, it } from "vitest";
import { InMemorySqlStorage } from "../../sql/node-test/node-sqlite-storage";
import { InMemoryDurableObjectStorage } from "../durable-object/durable-object-storage";
import { DurableObjectExecutionStore } from "./store";

describe("DurableObjectExecutionStore thread inputs", () => {
  it("rejects thread input records with the thread-input payload kind when the chunk marker exceeds the budget", async () => {
    const store = new DurableObjectExecutionStore({
      maxPayloadBytes: 1,
      prefix: "input-payload-test",
      storage: new InMemoryDurableObjectStorage({
        sql: new InMemorySqlStorage(),
      }),
    });

    await expect(
      store.inputs.admit({
        input: { text: "x".repeat(32), type: "user-input" },
        kind: "send",
        messageId: "input-too-large",
        threadKey: "thread-1",
      })
    ).rejects.toMatchObject({
      byteLength: expect.any(Number),
      maxBytes: 1,
      payloadKind: "thread-input",
    });
    await expect(store.inputs.claimNext("thread-1", "turn-idle")).resolves.toBe(
      null
    );
  });

  it("stores thread input records in SQLite rows with chunked payloads and debug columns", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      maxPayloadBytes: 180,
      prefix: "input-sql-test",
      storage,
    });

    await store.inputs.admit({
      admittedAtMs: 10,
      input: { text: "x".repeat(320), type: "user-input" },
      kind: "send",
      messageId: "input-sql",
      threadKey: "thread-1",
    });
    const pendingRows = storage.sql
      .exec<{
        readonly admitted_seq: number;
        readonly message_id: string;
        readonly status: string;
      }>(
        "SELECT message_id, status, admitted_seq FROM pss_thread_input WHERE prefix = ? AND thread_key = ? AND status = ?",
        "input-sql-test",
        "thread-1",
        "pending"
      )
      .toArray();

    expect(pendingRows).toEqual([
      { admitted_seq: 1, message_id: "input-sql", status: "pending" },
    ]);
    expect(
      storage.sql
        .exec<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM pss_payload_chunk WHERE scope = ?",
          "thread-input"
        )
        .toArray()[0]?.count
    ).toBeGreaterThan(0);

    const claimed = await store.inputs.claimNext("thread-1", "turn-idle");
    if (!claimed) {
      throw new Error("Expected claimed thread input.");
    }
    const promoted = await store.inputs.markPromoted(claimed);
    if (!promoted) {
      throw new Error("Expected promoted thread input.");
    }
    await store.inputs.ack(promoted);

    expect(
      storage.sql
        .exec<{ readonly count: number }>(
          "SELECT COUNT(*) AS count FROM pss_thread_input WHERE prefix = ? AND thread_key = ? AND status = ?",
          "input-sql-test",
          "thread-1",
          "pending"
        )
        .toArray()[0]?.count
    ).toBe(0);
    expect(
      storage.sql
        .exec<{ readonly status: string }>(
          "SELECT status FROM pss_thread_input WHERE prefix = ? AND thread_key = ? AND message_id = ?",
          "input-sql-test",
          "thread-1",
          "input-sql"
        )
        .toArray()
    ).toEqual([{ status: "acked" }]);
  });

  it("rejects malformed stored thread input records at the JSON parse boundary", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      prefix: "input-malformed-test",
      storage,
    });

    await store.inputs.admit({
      input: { text: "valid", type: "user-input" },
      kind: "send",
      messageId: "input-malformed",
      threadKey: "thread-1",
    });
    storage.sql.exec(
      "UPDATE pss_thread_input SET record = ? WHERE prefix = ? AND thread_key = ? AND message_id = ?",
      JSON.stringify({ messageId: "input-malformed" }),
      "input-malformed-test",
      "thread-1",
      "input-malformed"
    );

    await expect(
      store.inputs.claimNext("thread-1", "turn-idle")
    ).rejects.toThrow("Malformed DurableObject thread input record.");
  });

  it("rejects malformed stored content when text is also present", async () => {
    const storage = new InMemoryDurableObjectStorage({
      sql: new InMemorySqlStorage(),
    });
    const store = new DurableObjectExecutionStore({
      prefix: "input-mixed-malformed-test",
      storage,
    });

    await store.inputs.admit({
      input: { text: "valid", type: "user-input" },
      kind: "send",
      messageId: "input-mixed-malformed",
      threadKey: "thread-1",
    });
    storage.sql.exec(
      "UPDATE pss_thread_input SET record = ? WHERE prefix = ? AND thread_key = ? AND message_id = ?",
      JSON.stringify({
        admittedAtMs: 10,
        admittedSeq: 1,
        input: { content: [42], text: "ok", type: "user-input" },
        kind: "send",
        messageId: "input-mixed-malformed",
        status: "pending",
        threadKey: "thread-1",
      }),
      "input-mixed-malformed-test",
      "thread-1",
      "input-mixed-malformed"
    );

    await expect(
      store.inputs.claimNext("thread-1", "turn-idle")
    ).rejects.toThrow("Malformed DurableObject thread input record.");
  });
});
